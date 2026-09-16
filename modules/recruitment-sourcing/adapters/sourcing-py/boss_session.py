# BOSS 会话桥：把系统「扫码登录」抓到的登录态交给 Playwright，让采集驱动复用真实账号。
# 凭证优先级（高→低）：
#   1. cdp        —— 附着到扫码登录后仍存活的浏览器（登录态最新鲜、stoken 有效，首选）
#   2. cookies    —— 扫码/手动粘贴的会话串（add_cookies 注入新开的浏览器）
#   3. profile_dir—— 持久会话目录兜底
# 浏览器：优先系统 Edge（channel="msedge"，无需下载 playwright 内置内核）。
import time

COOKIE_DOMAIN = ".zhipin.com"


def parse_cookie_string(cookie_str: str) -> list[dict]:
    """'name1=v1; name2=v2' → playwright add_cookies 列表（限定 zhipin 域）。"""
    out = []
    for pair in _or_empty(cookie_str).split(";"):
        name, _, value = pair.strip().partition("=")
        if name:
            out.append({"name": name, "value": value, "domain": COOKIE_DOMAIN, "path": "/"})
    return out


def _or_empty(s):
    return s or ""


def normalize_cdp(cdp) -> str:
    """9333 / 127.0.0.1:9333 / http://127.0.0.1:9333 → http://127.0.0.1:9333"""
    s = str(cdp or "").strip()
    if not s:
        return ""
    if s.isdigit():
        return f"http://127.0.0.1:{s}"
    if "://" not in s:
        return f"http://{s}"
    return s


class BossSession:
    """封装一个已注入登录态的浏览器会话。open()/close() 必须成对调用。

    cdp 模式（附着）：connect_over_cdp 连到扫码登录后未关闭的浏览器，
    复用其 default context 与已打开页面 —— 会话状态与人工操作完全一致，不做任何注入。
    """

    def __init__(self, cookies=None, profile_dir=None, cdp=None, headless=False, use_edge=True):
        self.cdp_url = normalize_cdp(cdp)
        self.cookie_str = _or_empty(cookies)
        self.profile_dir = profile_dir
        self.headless = headless
        self.use_edge = use_edge
        self._pw = None
        self._browser = None
        self._context = None
        self._owns_context = True  # 附着模式下 context 归浏览器所有，close 时不能强关
        self.page = None

        if not (self.cdp_url or self.cookie_str or self.profile_dir):
            raise RuntimeError(
                "未找到 BOSS 会话凭证：请先在系统「我的账号与 BOSS 绑定」里扫码登录，"
                "或在 config.json 的 account.profile_dir 配置持久会话目录"
            )

    @property
    def via_cdp(self) -> bool:
        return bool(self.cdp_url)

    @property
    def via_cookies(self) -> bool:
        return bool(self.cookie_str)

    def open(self):
        from playwright.sync_api import sync_playwright  # 延迟导入，仅 boss 模式需要
        self._pw = sync_playwright().start()
        channel = "msedge" if self.use_edge else None
        if self.via_cdp:
            self._browser = self._pw.chromium.connect_over_cdp(self.cdp_url)
            ctx = self._browser.contexts[0] if self._browser.contexts else self._browser.new_context()
            self._context = ctx
            self._owns_context = False  # 附着的 context 属于扫码浏览器，不随采集关闭
            self.page = next((p for p in ctx.pages if "zhipin.com" in (p.url or "")), None) or ctx.new_page()
        elif self.via_cookies:
            self._browser = self._pw.chromium.launch(channel=channel, headless=self.headless)
            self._context = self._browser.new_context(
                viewport={"width": 1380, "height": 900},
                locale="zh-CN",
            )
            self._context.add_cookies(parse_cookie_string(self.cookie_str))
            self.page = self._context.new_page()
        else:
            self._context = self._pw.chromium.launch_persistent_context(
                self.profile_dir, channel=channel, headless=self.headless,
                viewport={"width": 1380, "height": 900}, locale="zh-CN",
            )
            self.page = self._context.pages[0] if self._context.pages else self._context.new_page()
        return self

    def close(self, keep_window=False):
        # 附着/CDP 模式：完全不做浏览器清理（context/browser/playwright 均归扫码浏览器所有），
        # 只断开本对象引用。任何 browser.close()/pw.stop() 都会连带关闭用户的扫码窗口，必须避免。
        # keep_window=True（M6）：显式要求保持扫码窗口在线，连 playwright 也仅断开引用。
        if not self.via_cdp and self._owns_context:
            if keep_window:
                # 尽力保留浏览器进程：仅断开 playwright 引用，交由系统/进程回收（CDP 之外为尽力而为）
                self.page = None
                return
            try:
                self._context.close()
            except Exception:
                pass
            try:
                self._browser.close()
            except Exception:
                pass
            try:
                self._pw.stop()
            except Exception:
                pass
        self.page = None

    # ---- 页面辅助 ----
    def new_tab(self):
        """新开空白标签页：CDP 附着模式下供扫描等只读任务专用，避免抢占用户正在浏览的页面。"""
        if self._context is None:
            raise RuntimeError("会话未打开：请先调用 open()")
        return self._context.new_page()

    def goto(self, url, wait="domcontentloaded", timeout=30000, settle=1.0):
        """带一次重试的导航：前端路由偶尔在 domcontentloaded 前发起二次跳转，
        Playwright 会抛「interrupted by another navigation」，等待后重试一次即可恢复。"""
        for attempt in (1, 2):
            try:
                self.page.goto(url, wait_until=wait, timeout=timeout)
                break
            except Exception as e:
                if attempt >= 2 or "interrupted by another navigation" not in str(e):
                    raise
                time.sleep(1.5)
        time.sleep(settle)

    def is_logged_out(self) -> bool:
        """登录态失效特征：被重定向到登录页。"""
        url = self.page.url or ""
        return "/web/user/" in url or "login" in url.lower()

    def assert_login(self, where: str):
        if self.is_logged_out():
            raise RuntimeError(
                f"BOSS 登录态已失效（访问 {where} 被跳转到登录页）："
                "请到系统「我的账号与 BOSS 绑定」重新扫码登录后再试"
            )
