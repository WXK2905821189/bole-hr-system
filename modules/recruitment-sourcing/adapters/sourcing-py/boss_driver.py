# BOSS直聘 真实采集驱动（强门控）
# ⚠️ 使用前提（合规红线）：
#   1. 仅使用公司自有/授权招聘账号的持久登录会话（profile_dir）；
#   2. 严格受 SafetyLimiter 节流（随机间隔/每日与会话上限/冷却熔断），不轮换代理、不做 WebDriver 规避；
#   3. 只对「线索列表里 HR 本身可查看的信息」做自动化，不越权抓取、不导出售卖。
# 平台页面结构会变，selectors 集中在 __init__，需在 T1(POC) 用真实账号校准。
import time
from datetime import datetime

from safety import now_iso


DEFAULT_SELECTORS = {
    "search_input": 'input[placeholder*="搜索"], input[data-el*="search"]',
    "search_button": 'button[type="button"]:has-text("搜索"), [class*="search-btn"]',
    "candidate_cards": '[class*="job-card"], [class*="candidate"], [class*="talent-list"] li',
    "resume_action": 'button:has-text("交换简历"), button:has-text("索要简历"), [class*="resume"] button',
}


class BossDriver:
    """驱动 BOSS 直聘网页端：搜索 → 命中候选 → 对每个候选执行「索取简历」。"""

    def __init__(self, account_name, profile_dir, selectors=None, headless=False):
        if not profile_dir:
            raise RuntimeError("boss 模式必须提供公司自有账号的持久会话目录(profile_dir)")
        self.account = account_name
        self.profile_dir = profile_dir
        self.selectors = {**DEFAULT_SELECTORS, **(selectors or {})}
        self.headless = headless
        self._browser = None
        self._page = None

    # ---- 会话 ----
    def open(self):
        from playwright.sync_api import sync_playwright  # 延迟导入，仅 boss 模式需要
        self._pw = sync_playwright().start()
        context = self._pw.chromium.launch_persistent_context(
            self.profile_dir, headless=self.headless,
        )
        self._page = context.new_page()
        return self

    def close(self):
        try:
            self._page.close()
        except Exception:
            pass
        try:
            self._pw.stop()
        except Exception:
            pass

    # ---- 采集主流程 ----
    def collect(self, job_id: str, keyword: str, limiter):
        """返回体与 simulator 相同的 candidate 列表；所有动作受 limiter 约束。"""
        self.open()
        candidates = []
        try:
            self._goto_search(keyword)
            cards = self._list_candidates()
            for idx, card in enumerate(cards):
                if not limiter.allowed():
                    break
                limiter.before_call()
                ok = self._request_resume(card)
                limiter.record_call(ok=ok)
                if ok:
                    candidates.append(self._to_candidate(job_id, keyword, idx, card))
        except Exception as err:  # 任何路径异常 → 触发冷却并停止，避免被平台风控
            limiter.trigger_cooldown(minutes=10)
            raise RuntimeError(f"BOSS 采集异常(已触发冷却): {err}")
        finally:
            self.close()
        return candidates

    # ---- 步骤 ----
    def _goto_search(self, keyword):
        p = self._page
        p.goto("https://www.zhipin.com/web/geek/job", wait_until="domcontentloaded", timeout=30000)
        time.sleep(1.0)
        inp = p.locator(self.selectors["search_input"])
        inp.fill(keyword)
        p.locator(self.selectors["search_button"]).first.click()
        p.wait_for_load_state("networkidle", timeout=15000)

    def _list_candidates(self):
        p = self._page
        return p.locator(self.selectors["candidate_cards"]).all()

    def _request_resume(self, card):
        """对单个命中候选点击『索取/交换简历』。返回是否成功；选择器未命中仅计失败并跳过。"""
        links = card.locator(self.selectors["resume_action"])
        if links.count() == 0:
            return False
        links.first.click()
        time.sleep(0.8)
        return True

    def _to_candidate(self, job_id, keyword, idx, card):
        text = card.inner_text()[:500]
        return {
            "candidateId": f"cand_boss_{self.account}_{int(datetime.now().timestamp()*1000)}",
            "source": "boss",
            "jobId": job_id,
            "name": self._masked_name(text),
            "status": "sourced",
            "workExperienceYears": self._years(text),
            "resume": {"status": "pending", "format": "html", "rawText": text},
            "meta": {"createdAt": now_iso(), "masked": True, "sourceLink": f"boss:{self.account}"},
        }

    @staticmethod
    def _masked_name(text):
        line = text.splitlines()[0] if text.splitlines() else ""
        return line[:2] + "*" if line else "候选*"

    @staticmethod
    def _years(text):
        import re as _re
        m = _re.search(r"(\d{1,2})\s*年", text)
        return int(m.group(1)) if m else 0