# 采集适配器门面：按 config.mode 选择 模拟器(simulator) 或 真实BOSS(boss)。
# - simulator(默认)：离线合成脱敏候选，链路可无账号跑通；
# - boss：复用系统扫码登录的会话（凭证优先级：CDP 附着 > 扫码 cookie > profile_dir），
#         数据获取走 httpx 直调内部 API（geeks.json），失败回退页面 fetch 与 iframe 通道；受 SafetyLimiter 强节流。
import os

from safety import SafetyLimiter
from simulator import SimulatorAdapter
from boss_driver import BossDriver
import boss_chat
import boss_jobs


def _truthy(env_val, default=True):
    """布尔解析：env 字符串（'1/true/yes/on' 为真；'0/false/no/off' 为假）；未设则用 default。"""
    if env_val is None or str(env_val) == "":
        return bool(default)
    return str(env_val).strip().lower() not in ("0", "false", "no", "off")


class SourcingAdapter:
    """统一采集入口：产出符合 hr:schema:candidate 的候选列表。"""

    def __init__(self, config: dict):
        self.config = config
        mode = os.environ.get("HR_MODE") or config.get("mode", "simulator")
        self.mode = mode
        self.safety = SafetyLimiter(**config.get("safety", {}))
        if mode == "boss":
            acc = config.get("account") or {}
            cookies = os.environ.get("HR_BOSS_COOKIES") or acc.get("cookies")
            cdp = os.environ.get("HR_BOSS_CDP") or acc.get("cdp")
            pm = config.get("pre_match") or {}
            self.backend = BossDriver(
                account_name=acc.get("name", "boss"),
                profile_dir=acc.get("profile_dir"),
                cookies=cookies,
                cdp=cdp,
                selectors=config.get("selectors"),
                pages=config.get("pages"),
                apis=config.get("api"),
                headless=config.get("headless", False),
                use_edge=config.get("use_edge", True),
                greet_message=os.environ.get("HR_BOSS_GREET_MSG", ""),
                city=os.environ.get("HR_BOSS_CITY") or config.get("city", ""),
                max_greet=int(os.environ.get("HR_BOSS_MAX_GREET") or config.get("per_job_target") or 5),
                boss_job_id=os.environ.get("HR_BOSS_JOB_ID") or config.get("boss_job_id", ""),
                # M6 · 采集后保持扫码窗口在线（CDP 附着不关闭）
                keep_open=_truthy(os.environ.get("HR_KEEP_BROWSER_OPEN"), config.get("keep_browser_open", True)),
                # M6 · 前置 AI 匹配门禁：读JD·看在线简历→差距分析→高分才打招呼
                pre_match=_truthy(os.environ.get("HR_PRE_MATCH"), pm.get("enabled", True)),
                pre_threshold=int(os.environ.get("HR_PRE_MATCH_THRESHOLD") or pm.get("threshold") or 60),
                gateway_url=os.environ.get("HR_GATEWAY_URL") or config.get("gateway_url", "http://127.0.0.1:4700"),
                auth_token=os.environ.get("HR_AUTH_TOKEN") or pm.get("token") or "",
                pre_resume_url=os.environ.get("HR_PRE_RESUME_URL") or pm.get("resume_url") or "",
                pre_resume_selector=pm.get("resume_selector") or "",
            )
        else:
            self.backend = SimulatorAdapter(config)

    def safety_limits(self) -> dict:
        return self.safety.stats

    def produce_candidates(self, job_id: str, keyword: str) -> list[dict]:
        """采集指定岗位的候选列表（全程受风控节流）。
        boss 模式下若无会话凭证，将安全抛错（不静默抓取）。"""
        if not self.safety.allowed():
            raise RuntimeError(f"采集被节流拦截：{self.safety.reason()}")
        return self.backend.produce_candidates(job_id, keyword, self.safety)

    def sync_jobs(self) -> list[dict]:
        """拉取 BOSS 账号下的在招岗位列表（不节流：纯读取，一次一页）。

        API 直调（zpjob/job/data/list）优先，失败回退职位管理页 DOM 解析。
        在招状态码可用 config.json 的 job_status_open 覆盖（默认 [0, 1]）。
        """
        self.backend.session.open()
        try:
            return boss_jobs.list_jobs(
                self.backend.session,
                selectors=self.config.get("job_selectors"),
                pages=self.config.get("pages"),
                apis=self.config.get("api"),
                open_codes=self.config.get("job_status_open"),
            )
        finally:
            self.backend.session.close()

    def scan_chat(self, watch: list[dict]) -> list[dict]:
        """扫描 BOSS 沟通会话，识别关注名单内候选人的简历事件（不节流：纯读取，自带随机间隔）。

        watch = [{geekId, name}]（网关注入：已打招呼且尚未收简历的候选人）；
        返回 [{friendId, name, resumeSent, resumeSentAt, resumeAgreed, resumeAgreedAt, lastMsg}]。
        通道：被动捕获聊天页自身的 /wapi/ 数据响应（主，零主动试探）→ DOM 兜底；
        config.api.friendList / chatList 配置覆盖端点后启用 API 直调通道。
        """
        self.backend.session.open()
        try:
            return boss_chat.scan_chat(
                self.backend.session,
                selectors=self.config.get("selectors"),
                pages=self.config.get("pages"),
                apis=self.config.get("api"),
                watch=watch,
            )
        finally:
            self.backend.session.close()
