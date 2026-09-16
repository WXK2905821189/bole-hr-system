# BOSS直聘 真实采集驱动（强门控 · API 直调优先）
# ⚠️ 使用前提（合规红线）：
#   1. 仅使用公司自有/授权招聘账号的登录会话（扫码 cookie / CDP 附着 / profile_dir）；
#   2. 严格受 SafetyLimiter 节流（随机间隔/每日与会话上限/冷却熔断），不轮换代理、不做 WebDriver 特征规避；
#   3. 只对「线索列表里 HR 本身可查看的信息」做自动化，不越权抓取、不导出售卖。
# 数据获取（三通道，按序回退）：
#   1. httpx 直调内部 API（主）：从活会话导出 cookie+UA 独立客户端直发 geeks.json，结构化 geekList；
#   2. 页面上下文 fetch（兜底）：token/UA/cookie 由浏览器自动处理；
#   3. 搜索页 iframe 内 DOM 操作（boss-zhipin-mcp 同款选择器，API 被改版时最后兜底）。
# 去重：candidateId 主键 = expectId（cand_boss_{encryptExpectId}），同一牛人跨关键词/跨轮次天然幂等；
#   打招呼按本地 .greeted.json（expectId 集）跨 run 去重，避免重复触达。
# 会话凭证：HR_BOSS_CDP（扫码窗口保活的 CDP 地址，Node 网关探活后注入）> HR_BOSS_COOKIES > profile_dir。
import json
import os
import random
import time
import urllib.request as _urllib
from pathlib import Path
from urllib.parse import urljoin

import boss_api
from boss_api import ApiError, SecurityCheckError
from boss_session import BossSession
from safety import now_iso

HERE = Path(__file__).resolve().parent
GREETED_FILE = HERE / ".greeted.json"

# ---- OCR 兜底（图片型在线简历：DOM 抽不到有效正文时，对整页截图本地识图）----
# 惰性单例：仅当确实需要 OCR 时才加载 PaddleOCR，避免空跑下载模型。正文过短（很可能以图片渲染）才触发；
# OCR 初始化/识别失败仅告警，绝不中断采集主流程（与「三通道回退 + 如实报错」的护栏一致）。
OCR_MIN_CHARS = 50
_paddle_ocr = None  # PaddleOCR 惰性单例


def ocr_image_text(path):
    """截图 → OCR 全文（中文）。失败/不可用返回空串，不影响主流程。"""
    global _paddle_ocr
    try:
        if _paddle_ocr is None:
            from paddleocr import PaddleOCR
            # 用 onnxruntime 后端：PaddleOCR 3.x 默认走 Paddle 原生推理，在 Windows 上 PP-OCRv6 常报
            # json.parse_error(空输入)；切 engine=onnxruntime 走 ONNXRuntime，规避该兼容问题且更快。
            _paddle_ocr = PaddleOCR(
                lang="ch", engine="onnxruntime",
                use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False,
            )
    except Exception as e:
        print(f"[ocr ] PaddleOCR 初始化失败（本次跳过 OCR 兜底）：{e}", flush=True)
        return ""
    try:
        res = _paddle_ocr.predict(path)
        lines = []
        for r in res or []:
            words = None
            if isinstance(r, dict):
                words = r.get("rec_texts") or r.get("rec_text") or []
            else:
                try:
                    words = getattr(r, "rec_texts", None) or getattr(r, "rec_text", None) or []
                except Exception:
                    words = []
            if words:
                lines.extend(str(w) for w in words)
        return "\n".join(lines).strip()
    except Exception as e:
        print(f"[ocr ] OCR 识别失败 {path}：{e}", flush=True)
        return ""

# 招聘方（Boss）端页面；URL 与选择器均需真实账号校准，可被 config.pages / config.selectors 覆盖
# 2025 起 BOSS 招聘端迁至 /web/chat/ 新前端，旧 /web/boss/ 地址已被官方废弃（互跳重定向死循环）
DEFAULT_PAGES = {
    # 推荐牛人：默认落地页，JS 环境就绪后可直接 fetch 搜索 API
    "recommend": "https://www.zhipin.com/web/chat/recommend",
    # 职位管理：在招岗位列表（同步岗位用）
    "manage_job": "https://www.zhipin.com/web/chat/job/list",
    # 沟通列表：候选人会话页（打招呼后发送话术文本 / 简历附件下载用）
    "chat": "https://www.zhipin.com/web/chat/index",
}

# 聊天页选择器（与开源 boss-cli 的 DOM 共识一致，可被 config.selectors 覆盖）
CHAT_SELECTORS = {
    "chat_item": ".geek-item",            # 会话列表条目（选中态 .geek-item.selected）
    "chat_name": ".geek-name",            # 条目内候选人姓名
    "chat_detail": ".base-info-single-container",  # 点开后右侧候选人详情容器
    "chat_input": "#boss-chat-editor-input",       # 消息输入框（回车发送）
}

DEFAULT_SELECTORS = {
    # ---- 搜索页（iframe 内，与 boss-zhipin-mcp 同源校准值） ----
    "search_menu": "dl.menu-geeksearch",          # 主页面左侧「搜索牛人」菜单
    "search_frame": "#searchContent iframe",      # 搜索内容 iframe
    "search_input": "input.search-input",         # iframe 内搜索框
    "candidate_cards": "li.geek-info-card",       # iframe 内牛人卡片
    "card_link": "a[data-contact]",               # 卡片主链接（data-expect = expectId）
    "greet_button": 'button:has-text("打招呼"), .start-chat-btn, [class*="greet"]',
    # ---- 推荐牛人页·按岗位 采集调度（右上角选岗位 → 该岗位推荐 → 从上往下逐个看在线简历 → 差距分析 → 高分打招呼） ----
    "recommend_job_btn": "",          # 右上角岗位选择器触发元素（如顶部下拉触发器；待真实账号校准后填入）
    "recommend_job_option": "",       # 岗位下拉中目标项（按职位名文本匹配；待校准）
    "recommend_cards": "",            # 推荐页牛人卡片容器（从上到下依次扫描；留空则复用 candidate_cards，仍不行请校准）
    "candidate_link": "a[data-contact]",    # 卡片内可点开在线简历的主链接
    "resume_panel": "",               # 打开在线简历后的文本容器（留空则取 body 全文）
    "shot_dir": "resume_shots",       # 在线简历截图输出目录（相对 sourcing-py/）
}

# 推荐页牛人卡片常见选择器（自动发现用：按序尝试，命中即用）
RECOMMEND_CARD_HEURISTICS = [
    "li.geek-info-card",
    "li[class*='geek']",
    "li[class*='recommend']",
    "li[class*='card']",
    "[class*='candidate-list'] > li",
    "[class*='recommend'] li[class*='item']",
    "ul[class*='list'] > li",
    "li[data-animate]",
]


class BossDriver:
    """驱动 BOSS 招聘端：httpx 直调搜索牛人 → 逐个「打招呼」（addRelation，失败回退页面点击）→ 产出候选。"""

    def __init__(self, account_name, profile_dir=None, cookies=None, cdp=None, selectors=None,
                 pages=None, apis=None, headless=False, use_edge=True, greet_message="",
                 city="", max_greet=5, boss_job_id="", keep_open=True,
                 pre_match=True, pre_threshold=60, gateway_url="", auth_token="",
                 pre_resume_url="", pre_resume_selector=""):
        self.account = account_name or "boss"
        self.greet_message = greet_message or (
            "您好，看到您的经历与我们的岗位较为匹配，方便的话想和您聊聊，"
            "如果感兴趣可以发一份简历给我，期待交流！"
        )
        self.city = city or ""
        self.max_greet = max_greet
        # M6 · 采集后保持 BOSS 扫码窗口在线（CDP 附着时不关闭窗口，供多次采集复用）
        self.keep_open = keep_open
        # M6 · 前置 AI 匹配门禁：先读 JD · 逐个看牛人在线简历 → 差距分析 → 匹配分达标才打招呼
        self.pre_match = pre_match
        self.pre_threshold = max(0, int(pre_threshold or 60))
        self.gateway_url = (gateway_url or "").rstrip("/")
        self.auth_token = auth_token or ""
        self.pre_resume_url = pre_resume_url or ""
        self.pre_resume_selector = pre_resume_selector or ""
        # BOSS 端职位 ID（encryptJobId）：推荐流搜索与打招呼接口的必填参数；
        # 未注入时 produce 阶段按岗位标题自动匹配（对齐 Auto-Recruiting query_position）
        self.boss_job_id = boss_job_id or os.environ.get("HR_BOSS_JOB_ID", "")
        self.selectors = {**DEFAULT_SELECTORS, **CHAT_SELECTORS, **(selectors or {})}
        self.pages = {**DEFAULT_PAGES, **(pages or {})}
        self.apis = apis or {}
        self.proxy = str(self.apis.get("proxy") or "")
        self.headless = headless
        self.use_edge = use_edge
        self._greeted = self._load_greeted()
        self._client = None  # httpx 直调客户端（活会话构建，produce 期间持有）
        # 本轮运行评估明细（供 run.py 汇总成运行日志总结：每人分数/是否过线/是否打招呼）
        self.eval_log = []
        self.last_summary = None
        # 推荐页命中卡片/链接选择器（点开在线简历时复用，避免搜索页选择器在推荐页失效）
        self._recommend_cards_sel = None
        self._recommend_link_sel = None
        self.session = BossSession(cookies=cookies, profile_dir=profile_dir, cdp=cdp,
                                   headless=headless, use_edge=use_edge)

    # ---- 采集主流程（与 simulator 同签名） ----
    def produce_candidates(self, job_id: str, keyword: str, limiter):
        self.session.open()
        self.eval_log = []
        self.last_summary = None
        candidates = []
        try:
            self.session.goto(self.pages["recommend"], settle=2.0)
            self.session.assert_login("推荐牛人页")
            boss_api.assert_no_security(self.session.page)
            self._client = self._build_client()
            if not self.boss_job_id:
                self.boss_job_id = self._resolve_boss_job(keyword)
            if self.boss_job_id:
                print(f"[job ] 打招呼挂载 BOSS 职位: {self.boss_job_id}", flush=True)

            # M6 · 按岗位从「推荐牛人」页收集（右上角选岗位 → 该岗位推荐，从上往下）；失败回退搜索三通道
            geeks = self._collect_recommend_pool(keyword)
            if not geeks:
                raise RuntimeError(
                    "三条通道均未取到候选：推荐页 DOM / httpx / 页面 fetch 都为空。"
                    "请用真实账号打开「推荐牛人」页，在右上角岗位选择器选中目标岗位确认有候选；"
                    "再按 recommend_raw_sample.json 校准 config.json selectors 的 recommend_* 键"
                )
            print(f"[scan] 取到 {len(geeks)} 位牛人（推荐牛人·按岗位，顺序=页面上到下），开始打招呼（本轮上限 {self.max_greet}）", flush=True)

            greeted_pairs = []  # (candidate, geek)：已成功 addRelation 的对，收尾批量送达话术文本
            for geek in geeks:
                if len([c for c in candidates]) >= self.max_greet:
                    break
                if not limiter.allowed("greet"):
                    print("[stop] 已达节流边界，停止本轮打招呼", flush=True)
                    break
                expect_id = str(geek.get("encryptExpectId") or geek.get("expectId") or geek.get("expectid") or "")
                if not expect_id or expect_id in self._greeted:
                    continue  # 已打过招呼的牛人跳过（跨 run 去重）
                cand = boss_api.normalize_geek(geek, job_id, keyword, self.greet_message)
                eval_rec = {"name": cand.get("name") or geek.get("name") or "", "expectId": expect_id,
                            "score": None, "via": "no_resume", "passed": False, "greeted": False}
                # M6 · 前置 AI 匹配门禁：先读 JD · 逐个看在线简历 → 差距分析 → 匹配分达标才打招呼（省额度、降风控）
                if self.pre_match and self.gateway_url:
                    score, passed, via = self._prematch_score(geek, job_id)
                    eval_rec["score"] = score
                    eval_rec["via"] = via
                    eval_rec["passed"] = passed
                    if not passed:
                        eval_rec["greeted"] = False
                        self.eval_log.append(eval_rec)
                        print(f"  [skip] 差距分析未达标，跳过打招呼 {cand['name']}（匹配分 {score} < 阈值 {self.pre_threshold}）", flush=True)
                        continue
                    print(f"  [pm  ] {cand['name']} 匹配分 {score} ≥ 阈值 {self.pre_threshold}，准予打招呼", flush=True)
                limiter.before_call("greet")
                greeted = self._greet_one(geek)
                limiter.record_call(ok=greeted, action="greet")
                if greeted:
                    self._greeted.add(expect_id)
                    self._save_greeted()
                    cand["meta"]["greeted"] = True
                    candidates.append(cand)
                    greeted_pairs.append((cand, geek))
                    eval_rec["greeted"] = True
                    eval_rec["passed"] = True
                    print(f"  [+] 已打招呼 {cand['name']}（expect={expect_id[:10]}…）", flush=True)
                else:
                    print(f"  [~] 打招呼未成功 {cand['name']}（expect={expect_id[:10]}…）", flush=True)
                self.eval_log.append(eval_rec)
            # 打招呼全部完成 → 聊天页批量发送话术文本（addRelation 只建关系不带文本）
            if greeted_pairs:
                try:
                    self._deliver_greetings_batch(greeted_pairs)
                except SecurityCheckError as e:
                    # 风控验证：冷却并放弃剩余送达，但已打招呼的候选人仍正常入库
                    limiter.trigger_cooldown(minutes=30)
                    print(f"[security] 话术送达被风控中断（已打招呼记录仍入库）：{e}", flush=True)
                except Exception as e:
                    print(f"[!] 话术批量送达失败（不影响打招呼入库）：{e}", flush=True)
        except SecurityCheckError as err:  # 风控验证：立即冷却 + 停止，禁止重试
            limiter.trigger_cooldown(minutes=30)
            print(f"[security] {err}", flush=True)
            raise
        except Exception as err:
            limiter.trigger_cooldown(minutes=10)
            raise RuntimeError(f"BOSS 采集异常(已触发冷却): {err}")
        finally:
            self._close_client()
            self._build_summary(candidates)
            # M6 · 保持扫码窗口在线：CDP 附着（扫码窗口保活）时采集结束不关闭浏览器，仅断开连接引用
            if self.keep_open and self.session.via_cdp:
                print("[keep] BOSS 扫码窗口保持在线（CDP 附着，采集结束未关闭，可多次复用）", flush=True)
                self.session.close(keep_window=True)
            else:
                self.session.close()
        return candidates

    def _build_summary(self, candidates: list[dict]):
        """汇总本轮运行评估：打招呼人数 + 各候选人得分/是否过线/来源，供 run.py 输出运行日志总结。"""
        greeted = [c for c in candidates]
        scored = [r for r in self.eval_log if r.get("score") is not None]
        online = [r for r in self.eval_log if r.get("via") == "online"]
        no_resume = [r for r in self.eval_log if r.get("via") == "no_resume"]
        below = [r for r in self.eval_log if not r.get("passed")]
        self.last_summary = {
            "greeted": len(greeted),
            "greetedNames": [c.get("name") or "" for c in greeted],
            "evaluated": len(self.eval_log),
            "onlineScored": len(online),
            "noResumePassthrough": len(no_resume),
            "belowThreshold": len(below),
            "maxGreet": self.max_greet,
            "threshold": self.pre_threshold,
            "details": self.eval_log,
        }
        print(f"[summary] 本轮评估 {len(self.eval_log)} 人：在线简历打分 {len(online)}、无简历放行 {len(no_resume)}、"
              f"未过线 {len(below)}、成功打招呼 {len(greeted)}（上限 {self.max_greet}）", flush=True)

    # ---- httpx 客户端（主通道） ----
    def _build_client(self):
        """登录态校验通过后，从活会话导出 cookie+UA 构建 httpx 客户端。"""
        try:
            client = boss_api.build_client(self.session.page, referer=self.pages["recommend"],
                                           proxy=self.proxy)
            n = len(client.cookies)
            print(f"[api ] httpx 客户端就绪（携带 {n} 项 zhipin cookie，直调内部接口）", flush=True)
            return client
        except ApiError as e:
            print(f"[api ] httpx 客户端构建失败，降级页面 fetch 通道：{e}", flush=True)
            return None

    def _close_client(self):
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass
            self._client = None

    # ---- M6 · 按岗位从「推荐牛人」页收集（右上角选岗位 → 该岗位推荐，从上到下；失败回退搜索三通道） ----
    def _collect_recommend_pool(self, job_title: str) -> list[dict]:
        self._pick_recommend_job(job_title)
        cards = self._collect_recommend_cards()
        if cards:
            return cards
        # 推荐页取不到 → 回退搜索三通道（httpx / 页面 fetch / iframe DOM）
        print("[rec ] 推荐页无候选，回退搜索三通道…", flush=True)
        return self._search_geeks(job_title)

    def _pick_recommend_job(self, job_title: str):
        """右上角岗位选择器切换到目标岗位（校准键 recommend_job_btn / recommend_job_option）。

        未配置选择器时，自动在页面内查找与职位名精确匹配的可点击项并点击，实现「点推荐牛人→选系统所选岗位」。
        """
        btn = str(self.selectors.get("recommend_job_btn") or "").strip()
        opt = str(self.selectors.get("recommend_job_option") or "").strip()
        p = self.session.page
        # 1) 配置了选择器：按选择器交互
        if btn or opt:
            try:
                if btn:
                    b = p.locator(btn)
                    if b.count() == 0:
                        print(f"[job ] 岗位选择器未命中（{btn}），尝试文本匹配选岗", flush=True)
                    else:
                        b.first.click()
                        time.sleep(1.2)
                if opt:
                    targets = p.locator(opt)
                    for i in range(targets.count()):
                        el = targets.nth(i)
                        if job_title and job_title in (el.inner_text() or ""):
                            el.click()
                            time.sleep(1.5)
                            print(f"[job ] 已选择岗位：{job_title}", flush=True)
                            return
                print(f"[job ] 岗位下拉未命中「{job_title}」文案，尝试文本匹配", flush=True)
            except Exception as e:
                print(f"[job ] 选择器选岗失败，尝试文本匹配：{e}", flush=True)
        # 2) 文本匹配兜底：页面内精确文本命中职位名则点击（岗位切换器/标签/列表条目）
        if job_title:
            try:
                tgt = p.get_by_role("listitem", name=job_title, exact=True)
                if tgt.count():
                    tgt.first.click()
                    time.sleep(1.5)
                    print(f"[job ] 已按职位名文本选择岗位：{job_title}", flush=True)
                    return
                tgt = p.get_by_text(job_title, exact=True)
                if tgt.count():
                    tgt.first.click()
                    time.sleep(1.5)
                    print(f"[job ] 已按职位名文本选择岗位：{job_title}", flush=True)
                    return
            except Exception as e:
                print(f"[job ] 文本选岗失败（沿用当前推荐）：{e}", flush=True)
        print("[job ] 未命中目标岗位，沿用推荐页当前已选岗位开始工作流", flush=True)

    def _maybe_stale_login(self):
        """推荐页取不到候选时，先排除「安全验证 / IP与账号被限流 / 会话失效跳登录页」，
        给出可执行报错而非误导性的『无候选』。命中安全限制会抛 SecurityCheckError（由上冷却）。"""
        boss_api.assert_no_security(self.session.page)
        if self.session.is_logged_out():
            raise RuntimeError(
                "BOSS 登录态已失效（访问推荐牛人页被跳转到登录页）："
                "请到系统「我的账号与 BOSS 绑定」重新扫码登录后，再运行采集"
            )

    def _collect_recommend_cards(self) -> list[dict]:
        """推荐页牛人卡片（DOM，顺序=页面上到下）。

        优先用配置 recommend_cards；未配置则按 RECOMMEND_CARD_HEURISTICS 自动发现；
        仍取不到时导出样本供校准。自动发现使真实推荐页无需手工填选择器即可启动。
        """
        p = self.session.page
        sel = self.selectors
        cards_sel = str(sel.get("recommend_cards") or "").strip()
        if cards_sel:
            hits = p.locator(cards_sel)
            if hits.count() == 0:
                self._maybe_stale_login()
                self._dump_dom_sample()
                print(f"[rec ] 推荐页未命中牛人卡片（{cards_sel}）：已导出 recommend_raw_sample.json 供校准", flush=True)
                return []
        else:
            # 自动发现：先按常见选择器，再按「文本特征」扫描（名字+薪资+多行），无需校准即可用
            for cand in ([sel["candidate_cards"]] + RECOMMEND_CARD_HEURISTICS):
                try:
                    if cand and p.locator(cand).count() > 0:
                        cards_sel = cand
                        break
                except Exception:
                    continue
            if not cards_sel:
                cards_sel = self._discover_cards_selector()
            if not cards_sel:
                self._maybe_stale_login()
                self._dump_dom_sample()
                print("[rec ] 推荐页未能识别候选卡片：已导出 recommend_raw_sample.json 供校准", flush=True)
                return []
        cards = BossDriver._extract_cards_dom(p, cards_sel, sel["candidate_link"])
        print(f"[rec ] 推荐牛人·按岗位：取到 {len(cards)} 张卡片（上→下，{cards_sel}）", flush=True)
        # 记录本次命中的卡片/链接选择器，供「点开在线简历」复用（搜索页选择器在推荐页无效）
        self._recommend_cards_sel = cards_sel
        self._recommend_link_sel = sel["candidate_link"]
        return cards

    def _discover_cards_selector(self) -> str:
        """启发式：扫描页面里同时含「薪资 + 多行 + <a>」的可重复卡片块，返回其公共选择器。"""
        js = """() => {
            const salRe = /\\d+-\\d+K|\\d+K|元\\/天/;
            const isCard = el => {
                const t = (el.innerText || "").trim();
                if (!t || t.length > 500) return false;
                if (!salRe.test(t)) return false;
                return el.querySelectorAll("a").length > 0 && t.split("\\n").length >= 3;
            };
            const all = Array.from(document.querySelectorAll(
                "li, div[class*='card'], div[class*='geek'], div[class*='item'], div[class*='list'] > div"));
            const cards = all.filter(isCard);
            const groups = {};
            for (const el of cards) {
                const cls = (el.className || "").toString().trim();
                const key = el.tagName.toLowerCase() + (cls ? "." + cls.split(/\\s+/).filter(Boolean).join(".") : "");
                (groups[key] = groups[key] || []).push(el);
            }
            let best = null;
            for (const key in groups) {
                if (groups[key].length >= 3 && (!best || groups[key].length > groups[best].length)) best = key;
            }
            return best;
        }"""
        try:
            sel = self.session.page.evaluate(js)
            if sel:
                print(f"[rec ] 已自动识别推荐页卡片选择器：{sel}", flush=True)
            return str(sel or "")
        except Exception as e:
            print(f"[rec ] 卡片自动发现异常：{e}", flush=True)
            return ""

    def _dump_dom_sample(self):
        """导出推荐页 DOM 摘要（选择器/正文/卡片类），供校准 recommend_* 键。"""
        try:
            sample = self.session.page.evaluate("""() => {
                const cls = new Set();
                document.querySelectorAll('li, ul, [class*="card"], [class*="geek"], [class*="recommend"], [class*="list"]')
                    .forEach(el => { const c=(el.className||'').toString(); if(c) cls.add(c.slice(0,120)); });
                return { url: location.href, title: document.title,
                         bodyHead: (document.body.innerText||'').slice(0,1500),
                         classCandidates: Array.from(cls).slice(0,40) };
            }""")
            sample.update({"capturedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
                           "_hint": "依据此项校准 config.json: selectors.recommend_job_btn / recommend_job_option / recommend_cards / candidate_link / resume_panel"})
            (HERE / "recommend_raw_sample.json").write_text(json.dumps(sample, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:
            print(f"[rec ] DOM 样本导出失败：{e}", flush=True)

    @staticmethod
    def _extract_cards_dom(evaluable, cards_sel: str, link_sel: str) -> list[dict]:
        """在页面/iframe 主文档上按选择器提取牛人卡片（保持 DOM 顺序），字段与搜索流对齐。"""
        js = """(cardsSel, linkSel) => {
            const cards = document.querySelectorAll(cardsSel);
            const res = [];
            for (const card of cards) {
                const text = card.innerText || "";
                const link = card.querySelector(linkSel);
                const lines = text.split("\\n").map(l => l.trim()).filter(Boolean);
                const name = lines[0] || "未知";
                let salary="", workExpDesc="", eduLevel="";
                for (const line of lines) {
                    if (/\\d+(-\\d+)?K|面议/.test(line) && !salary) salary = line;
                    else if (/\\d+年|应届|经验/.test(line) && !workExpDesc) workExpDesc = line;
                    else if (/本科|硕士|博士|大专|高中/.test(line) && !eduLevel) eduLevel = line;
                }
                const skills = Array.from(card.querySelectorAll('.rcd-tags span, .tag-item, [class*="tag"]'))
                    .map(el => el.innerText.trim()).filter(s => s && s.length < 20).slice(0, 8);
                const href = link ? (link.getAttribute('href') || "") : "";
                res.push({
                    geekName: name, salaryDesc: salary, workExpDesc, eduLevel, skills,
                    encryptExpectId: link ? (link.getAttribute('data-expect') || href.split("?")[0].split("/").pop() || "") : "",
                    securityId: link ? (link.getAttribute('data-securityid') || "") : "",
                    lid: link ? (link.getAttribute('data-lid') || "") : "",
                    resumeHref: href,
                    advantage: lines.slice(1, 6).join(" "),
                });
            }
            return res;
        }"""
        try:
            return evaluable.evaluate(js, [cards_sel, link_sel]) or []
        except Exception:
            return []

    # ---- 搜索：httpx 主路径 → 页面 fetch → iframe DOM 兜底 ----
    def _search_geeks(self, keyword: str) -> list[dict]:
        # M6 修复问题1：三通道都只收集自己结果，前面通道拿到非零就不抛出异常，最后汇总去重；DOM失败不熔断
        geeks_collected = []
        seen_eids = set()
        def add_uniq(candidate_list):
            added = 0
            for g in candidate_list:
                eid = str(g.get("encryptExpectId") or g.get("expectId") or g.get("expectid") or "")
                if eid and eid not in seen_eids:
                    seen_eids.add(eid)
                    geeks_collected.append(g)
                    added += 1
            return added
        # 通道1：httpx 直调内部 API（独立客户端，结构化 geekList）；带 BOSS 职位 ID 时首选按职位推荐
        if self._client is not None:
            try:
                geeks = boss_api.search_geeks(self._client, keyword, self.city,
                                              job_id=self.boss_job_id, apis=self.apis)
                add_uniq(geeks)
                print(f"[api ] 搜索「{keyword}」httpx 直调：已收集 {len(geeks_collected)} 条", flush=True)
                if geeks_collected:
                    return geeks_collected
            except SecurityCheckError:
                raise
            except ApiError as e:
                print(f"[api ] httpx 直调失败，回退页面 fetch 通道：{e}", flush=True)
        # 通道2：页面上下文 fetch（token/UA/cookie 由浏览器自动携带）
        try:
            geeks = boss_api.search_geeks(self.session.page, keyword, self.city,
                                          job_id=self.boss_job_id, apis=self.apis)
            add_uniq(geeks)
            print(f"[api ] 搜索「{keyword}」页面 fetch：已收集 {len(geeks_collected)} 条", flush=True)
            if geeks_collected:
                return geeks_collected
        except SecurityCheckError:
            raise
        except ApiError as e:
            print(f"[api ] 页面 fetch 失败，回退 iframe DOM 通道：{e}", flush=True)
        except Exception as e:
            print(f"[api ] 页面通道异常，回退 iframe DOM 通道：{e}", flush=True)
        # 通道3：iframe 内 DOM 搜索（选择器同 boss-zhipin-mcp），失败仅返回空而非熔断
        try:
            geeks = self._iframe_search(keyword)
            add_uniq(geeks)
            print(f"[dom ] 搜索「{keyword}」iframe DOM：已收集 {len(geeks_collected)} 条", flush=True)
        except SecurityCheckError:
            raise
        except Exception as e:
            print(f"[dom ] iframe 搜索失败，仅收集已有通道：{e}", flush=True)
        return geeks_collected

    def _resolve_boss_job(self, keyword: str) -> str:
        """按关键词匹配 BOSS 在招职位的 encryptJobId（对齐 Auto-Recruiting query_position）。

        精确匹配职位名 → 退化首个在招职位；拿不到则返回空（后续走关键词搜索链，
        但打招呼将因缺 jid 失败——此时应先在系统里同步 BOSS 岗位）。
        """
        hub = self._client or self.session.page
        try:
            jobs = boss_api.list_jobs_api(hub, self.apis)
        except SecurityCheckError:
            raise
        except Exception as e:
            print(f"[job ] 拉取 BOSS 职位列表失败（跳过自动挂载）：{e}", flush=True)
            return ""
        for j in jobs:
            if j.get("jobName") == keyword and j.get("encryptJobId"):
                print(f"[job ] 职位名精确匹配：{keyword}", flush=True)
                return str(j["encryptJobId"])
        first_open = next((j for j in jobs
                           if str(j.get("jobStatus")) == "0" and j.get("encryptJobId")), None)
        if first_open:
            print(f"[job ] 无同名职位，挂载首个在招职位：{first_open.get('jobName')}", flush=True)
            return str(first_open["encryptJobId"])
        return ""

    def _iframe_search(self, keyword: str) -> list[dict]:
        """搜索页 iframe 内 DOM 操作：点菜单 → 进 iframe → 填关键词 → 回车 → 抓卡片。"""
        p = self.session.page
        sel = self.selectors
        # 进入搜索 tab（推荐页左侧菜单）
        menu = p.locator(sel["search_menu"])
        if menu.count():
            menu.first.click()
            time.sleep(2.0)
        frame_el = p.locator(sel["search_frame"])
        if frame_el.count() == 0:
            # 直接导航搜索入口再试一次（旧版 /web/boss/searchgeek 已废弃，新版从推荐页菜单进入）
            p.goto(self.pages["recommend"], wait_until="domcontentloaded")
            time.sleep(3.0)
            boss_api.assert_no_security(p)
            menu = p.locator(sel["search_menu"])
            if menu.count():
                menu.first.click()
                time.sleep(2.0)
            frame_el = p.locator(sel["search_frame"])
        if frame_el.count() == 0:
            raise RuntimeError(f"搜索 iframe 未命中（{sel['search_frame']}）：请校准 config.json selectors")
        frame = frame_el.first.content_frame()
        inp = frame.locator(sel["search_input"])
        if inp.count() == 0:
            raise RuntimeError(f"搜索框未命中（iframe 内 {sel['search_input']}）：请校准 selectors")
        inp.first.click()
        inp.first.fill("")
        inp.first.type(keyword, delay=80)
        time.sleep(0.5)
        inp.first.press("Enter")
        time.sleep(3.0)
        boss_api.assert_no_security(p)
        try:
            frame.wait_for_selector(sel["candidate_cards"], timeout=10000)
        except Exception:
            raise RuntimeError("搜索超时：iframe 内未出现牛人卡片（关键词无结果或选择器漂移）")
        cards = self._extract_cards(frame)
        print(f"[dom ] iframe 搜索「{keyword}」：{len(cards)} 张卡片", flush=True)
        return cards

    @staticmethod
    def _extract_cards(frame) -> list[dict]:
        """iframe 内解析牛人卡片（boss-zhipin-mcp 的 EXTRACT_CARDS_JS 等价移植）。"""
        js = """() => {
            const cards = document.querySelectorAll("li.geek-info-card");
            const results = [];
            for (const card of cards) {
                const text = card.innerText || "";
                const link = card.querySelector("a[data-contact]");
                const lines = text.split("\\n").map(l => l.trim()).filter(l => l);
                const name = lines[0] || "未知";
                let salary = "", workExpDesc = "", eduLevel = "", securityId = "", lid = "";
                for (const line of lines) {
                    if (/\\d+(-\\d+)?K|面议/.test(line) && !salary) salary = line;
                    else if (/\\d+年|应届|经验/.test(line) && !workExpDesc) workExpDesc = line;
                    else if (/本科|硕士|博士|大专|高中/.test(line) && !eduLevel) eduLevel = line;
                }
                const skillEls = card.querySelectorAll(".rcd-tags span, .tag-item, [class*='tag']");
                const skills = Array.from(skillEls).map(el => el.innerText.trim())
                    .filter(s => s && s.length < 20).slice(0, 8);
                results.push({
                    geekName: name, salaryDesc: salary, workExpDesc, eduLevel, skills,
                    encryptExpectId: link ? link.getAttribute("data-expect") : "",
                    securityId: link ? (link.getAttribute("data-securityid") || link.getAttribute("data-sec")) : "",
                    lid: link ? link.getAttribute("data-lid") : "",
                    advantage: lines.slice(1, 6).join(" "),
                });
            }
            return results;
        }"""
        try:
            return frame.evaluate(js) or []
        except Exception:
            return []

    # ---- 前置 AI 匹配门禁（读JD·看在线简历 → 差距分析 → 高分才打招呼） ----
    def _prematch_score(self, geek, job_id):
        """调用网关 /api/ai/pre-match 做「岗位 JD × 牛人简历」差距分析，返回 (score, passed, via)。

        passed = 匹配分达标（>= pre_threshold）；via ∈ {'online'} 取到在线简历打分，
        {'no_resume'} 表示评估材料缺失按门禁放行。via 用于运行日志总结区分「真实打分 vs 放行触达」。
        门禁策略（防「全部候选被拦、零打招呼」的死锁）：
          - 拿到「真实在线简历文本」→ 照常打分门禁；
          - 拿不到在线简历（推荐页无对应卡片 / 链接打不开）→ 评估材料缺失：只拿稀疏卡片
            文本打分没有区分度，会把本可触达的牛人全部拦住。故按放行策略直接进入打招呼，
            由节流与 max_greet 控制规模——不伪造数据、也不漏掉真实触达机会。
        """
        resume = (self._extract_online_resume(geek) or "").strip()
        if not resume:
            print("[pm  ] 候选无在线简历可评估，按门禁放行策略直接进入打招呼（交节流/上限控制规模）", flush=True)
            return self.pre_threshold, True, "no_resume"
        try:
            body = json.dumps({"jobId": job_id, "resumeText": resume}).encode("utf-8")
            headers = {"Content-Type": "application/json"}
            if self.auth_token:
                headers["x-auth"] = self.auth_token
            req = _urllib.Request(self.gateway_url + "/api/ai/pre-match", data=body, headers=headers, method="POST")
            with _urllib.urlopen(req, timeout=30) as r:
                data = json.loads(r.read().decode("utf-8"))
            if data.get("ok"):
                score = int(data.get("score") or 0)
                return score, score >= self.pre_threshold, "online"
            print(f"[pm  ] 前置匹配未返回分数：{data.get('error','')}", flush=True)
        except Exception as e:
            print(f"[pm  ] 前置匹配网关调用失败，按放行处理：{e}", flush=True)
        return 0, True, "online"

    def _extract_online_resume(self, geek):
        """逐个打开牛人在线简历页，抽取简历文本作为差距分析素材。

        打开方式（按优先级）：
          1. resumeHref（推荐页 DOM 卡片已携带点开链接）：resolve 后直接导航打开 → 截正文
          2. 模板（pre_resume_url）：新开导航到 {lid}/{expect} 替换后的 URL
          3. 内联点击（兜底）：用本次命中的卡片选择器重新定位并对点目标（打开侧边简历面板）
        抽取：容器选择器 resume_panel/pre_resume_selector 留空则取 body 全文。
        截图：始终截图存 `resume_shots/expect_{eid}.png`，供人工核验差距分析素材。
        """
        p = self.session.page
        back_url = p.url
        txt = ""
        expect_id = str(geek.get("encryptExpectId") or geek.get("expectId") or geek.get("expectid") or "")
        try:
            href = str(geek.get("resumeHref") or "").strip()
            if href:
                # 方式 1：直接打开卡片携带的简历链接（推荐页/搜索 DOM 均可用，无需重新定位卡片）
                full = urljoin(back_url, href) if not href.startswith(("http://", "https://")) else href
                p.goto(full, wait_until="domcontentloaded", timeout=30000)
                time.sleep(1.8)
            elif self.pre_resume_url:
                # 方式 2：模板占位 URL
                lid = str(geek.get("lid") or "")
                url = (self.pre_resume_url.replace("{lid}", lid).replace("{expect}", expect_id))
                if url and url != self.pre_resume_url:
                    p.goto(url, wait_until="domcontentloaded")
                    time.sleep(1.5)
            elif expect_id:
                # 方式 3：用本次命中的推荐页选择器（或配置）重新定位并对点目标卡片
                cards_sel = getattr(self, "_recommend_cards_sel", None) or self.selectors["candidate_cards"]
                link_sel = getattr(self, "_recommend_link_sel", None) or self.selectors["candidate_link"]
                cards = p.locator(cards_sel)
                target = None
                for i in range(cards.count()):
                    c = cards.nth(i)
                    lnk = c.locator(link_sel)
                    if lnk.count():
                        lnk_el = lnk.first
                        href_attr = str(lnk_el.get_attribute("href") or "").lower()
                        if (expect_id and expect_id in href_attr) or (href_attr and expect_id in href_attr):
                            target = lnk_el
                            break
                if not target:
                    print(f"[pm  ] 未找到目标卡片链接（expect={expect_id[:8]}），回退卡片文本", flush=True)
                    return ""
                target.click()
                time.sleep(2.0)  # 侧边面板动画+加载
            # 抽取文本
            sel = str(self.pre_resume_selector or self.selectors.get("resume_panel") or "").strip()
            if sel:
                els = p.locator(sel)
                if els.count():
                    txt = els.first.inner_text(timeout=7000)
            if not txt:
                txt = p.inner_text("body", timeout=5000)
            # 截图（总是存档，即使文本抽取得不完整）
            if expect_id:
                shot_dir = HERE / str(self.selectors.get("shot_dir", "resume_shots"))
                shot_dir.mkdir(exist_ok=True, parents=True)
                shot_path = shot_dir / f"expect_{expect_id}.png"
                try:
                    p.screenshot(path=shot_path, type="png", full_page=True)
                    print(f"[pm  ] 在线简历截图 {shot_path.name} 已存", flush=True)
                except Exception:
                    pass  # 截图失败不中断流程
                # OCR 兜底：正文过短（图片型简历，DOM 无有效文本）时，对刚存的整页截图识图，结果照常进入匹配
                if len(str(txt or "").strip()) < OCR_MIN_CHARS:
                    ocr_txt = ocr_image_text(str(shot_path))
                    if ocr_txt:
                        print(f"[pm  ] DOM 文本过短（{len(str(txt).strip())} 字），改用 OCR 兜底抽取 {len(ocr_txt)} 字", flush=True)
                        txt = ocr_txt
            # 返回推荐页
            if back_url:
                try:
                    p.goto(back_url, wait_until="domcontentloaded")
                except Exception:
                    pass
                time.sleep(1.0)
            return str(txt or "").strip()
        except Exception as e:
            print(f"[pm  ] 在线简历抽取失败，回退卡片语义片段：{e}", flush=True)
            if back_url:
                try:
                    p.goto(back_url, wait_until="domcontentloaded")
                except Exception:
                    pass
            return ""

    # ---- 打招呼：httpx 主路径 → 页面 fetch → iframe 点击兜底 ----
    def _greet_one(self, geek: dict) -> bool:
        # 通道1/2：addRelation API（httpx 直调 → 页面 fetch；无弹层、无 DOM 依赖）
        for hub, label in ((self._client, "httpx"), (self.session.page, "page")):
            if hub is None:
                continue
            try:
                if boss_api.greet_geek(hub, self.boss_job_id, geek, apis=self.apis):
                    return True
                print(f"  [api ] addRelation({label}) 未确认成功，尝试下一通道", flush=True)
            except SecurityCheckError:
                raise
            except Exception as e:
                print(f"  [api ] addRelation({label}) 失败，尝试下一通道：{e}", flush=True)
        # 通道3：iframe 卡片上直接点「打招呼」按钮
        return self._greet_dom(geek)

    def _greet_dom(self, geek: dict) -> bool:
        try:
            frame_el = self.session.page.locator(self.selectors["search_frame"])
            if frame_el.count() == 0:
                return False
            frame = frame_el.first.content_frame()
            expect = str(geek.get("encryptExpectId") or "")
            cards = frame.locator(self.selectors["candidate_cards"]).all()
            for card in cards:
                link = card.locator(self.selectors["card_link"])
                if link.count() and (link.first.get_attribute("data-expect") or "") == expect:
                    btn = card.locator(self.selectors["greet_button"])
                    if btn.count() == 0:
                        return False
                    btn.first.click()
                    time.sleep(1.0)
                    return True
        except Exception:
            pass
        return False

    # ---- 话术送达：addRelation 只建立沟通关系不带文本，需到聊天页把话术真正发出去 ----
    def _deliver_greetings_batch(self, pairs):
        """沟通列表页批量发送初次打招呼话术（pairs = [(candidate, geek), ...]）。

        会话按牛人真名（geek.geekName）在聊天列表定位（BOSS 端对招聘方显示真名）；
        选择器可被 config.selectors 的 chat_item/chat_name/chat_input 覆盖。
        单条失败仅跳过（沟通关系已建立，不影响候选入库）；命中风控抛 SecurityCheckError 由上层冷却。
        """
        if not pairs:
            return
        p = self.session.page
        sel = self.selectors
        self.session.goto(self.pages["chat"], settle=3.0)
        self.session.assert_login("沟通列表页")
        boss_api.assert_no_security(p)
        try:
            p.wait_for_selector(sel["chat_item"], timeout=8000)
        except Exception:
            print(f"[chat] 会话列表未加载（{sel['chat_item']}）：话术送达跳过，请校准 config.json selectors.chat_item", flush=True)
            return
        sent = 0
        for cand, geek in pairs:
            # 话术取候选 meta 里入库的话术库文本（与手动打招呼/跟进共用同一来源）
            message = str(cand.get("meta", {}).get("greetMessage") or self.greet_message or "").strip()
            name = str(geek.get("geekName") or geek.get("name") or "").strip()
            if not message or not name:
                continue
            target = None
            try:
                for item in p.locator(sel["chat_item"]).all():
                    if name in item.inner_text(timeout=2000):
                        target = item
                        break
            except Exception:
                pass
            if target is None:
                print(f"  [skip] 沟通列表未找到「{cand.get('name', name)}」会话（关系已建立，话术未送出）", flush=True)
                continue
            try:
                target.click()
                p.wait_for_selector(sel["chat_input"], timeout=6000)
                editor = p.locator(sel["chat_input"]).first
                editor.click()
                # 逐字输入：BOSS 编辑器为受控组件，fill 不触发其内部 onChange
                p.keyboard.type(message, delay=40)
                time.sleep(0.4)
                p.keyboard.press("Enter")
                sent += 1
                print(f"  [msg] 话术已发送 {cand.get('name', name)}：{message[:24]}…", flush=True)
            except Exception as e:
                print(f"  [skip] 「{cand.get('name', name)}」话术发送失败：{e}", flush=True)
            time.sleep(random.uniform(1.5, 2.5))  # 逐条间隔，避免连发触发风控
        print(f"[chat] 话术送达完成：{sent}/{len(pairs)} 条", flush=True)

    # ---- 打招呼去重记录（跨 run） ----
    def _load_greeted(self) -> set:
        try:
            if GREETED_FILE.exists():
                return set(json.loads(GREETED_FILE.read_text(encoding="utf-8")))
        except Exception:
            pass
        return set()

    def _save_greeted(self):
        try:
            GREETED_FILE.write_text(json.dumps(list(self._greeted)[:5000]), encoding="utf-8")
        except Exception:
            pass

    # ---- 简历附件下载（骨架，待真实账号校准聊天页结构后启用） ----
    def download_resumes(self, out_dir: str, limiter, since=None) -> list[str]:
        """扫描沟通列表里候选人发来的简历附件并下载到 out_dir。

        ⚠️ 骨架实现：聊天页附件卡片的选择器尚未用真实账号校准，
        调用会返回空列表并打印待校准提示；校准 selectors.chat_resume 后即可生效。
        """
        print("[warn] 简历附件下载为 T1 骨架：聊天页选择器待真实账号校准（selectors.chat_resume）", flush=True)
        return []
