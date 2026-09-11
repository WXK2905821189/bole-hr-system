# 账号风控护栏：随机化间隔 + 每日上限 + 冷却熔断 + 会话隔离
# 合规红线：不轮换代理、不做 WebDriver 特征规避；仅使用公司自有授权账号，遵守平台服务条款。
import random
import time
from datetime import date, datetime


class SafetyLimiter:
    """在所有采集动作前调用 before_call()/record_call()，命中平台风控后触发冷却。
    每一项可调（config.safety），默认值与 MVP 方案《非功能需求》一致。
    """

    def __init__(self, interval_seconds=(3, 8), daily_cap=200, cooldown_minutes=30,
                 session_cap=80, circuit_breaker=3, touch_daily_cap=60):
        self.interval_seconds = tuple(interval_seconds)
        self.daily_cap = daily_cap
        self.cooldown_minutes = cooldown_minutes
        self.session_cap = session_cap          # 单会话最大动作数（触发会话隔离/冷却）
        self.circuit_breaker = circuit_breaker  # 连续失败熔断阈值
        self.touch_daily_cap = touch_daily_cap  # 打招呼/索要简历/索要电话 共用每日上限（比总上限更保守）
        # 归入"打招呼+索取"共档的动作；换行仅为可读
        self.touch_actions = {"greet", "request_resume", "request_phone"}

        self._day = date.today()
        self._calls = 0
        self._touch_calls = 0
        self._session_calls = 0
        self._consec_fail = 0
        self._cooldown_until = 0.0
        self._fired_cooldown = False

    # ---- 判定 ----
    def allowed(self, action=None) -> bool:
        """是否允许下一次采集动作。action 传 greet/request_resume/request_phone 时额外受共档触达上限约束。"""
        return not self.reason(action) != "allow"

    # ---- 动作前 ----
    def before_call(self, action=None):
        """每次动作前调用：按随机间隔休眠，并展开禁止原因（若不允许则抛错）。"""
        if not self.allowed(action):
            raise RuntimeError(self.reason(action))
        time.sleep(random.uniform(*self.interval_seconds))

    def reason(self, action=None) -> str:
        self._roll_day()
        touch = action in self.touch_actions
        if time.time() < self._cooldown_until:
            return "账号冷却中(风控熔断), 剩余 %.0f 分钟" % ((self._cooldown_until - time.time()) / 60)
        if self._calls >= self.daily_cap:
            return f"已触达每日上限 {self.daily_cap}"
        if touch and self._touch_calls >= self.touch_daily_cap:
            return f"[打招呼/索取] 今日已触达共用上限 {self.touch_daily_cap}"
        if self._session_calls >= self.session_cap:
            return f"已触达会话上限 {self.session_cap}，请切换会话/等待冷却"
        return "allow"

    # ---- 动作后 ----
    def record_call(self, ok: bool = True, action=None):
        self._roll_day()
        self._calls += 1
        if action in self.touch_actions:
            self._touch_calls += 1
        if ok:
            self._session_calls += 1
            self._consec_fail = 0
        else:
            self._consec_fail += 1
            if self._consec_fail >= self.circuit_breaker:
                self.trigger_cooldown()

    def trigger_cooldown(self, minutes=None):
        self._cooldown_until = time.time() + (minutes or self.cooldown_minutes) * 60
        self._fired_cooldown = True

    def should_stop(self) -> bool:
        """调度器据此决定是否提前收工（冷却/达上限/连续熔断）。"""
        return (not self.allowed()) or self._consec_fail >= self.circuit_breaker

    @property
    def stats(self):
        self._roll_day()
        return {
            "day": self._day.isoformat(),
            "calls": self._calls,
            "daily_cap": self.daily_cap,
            "touch_calls": self._touch_calls,
            "touch_daily_cap": self.touch_daily_cap,
            "session_calls": self._session_calls,
            "session_cap": self.session_cap,
            "cooldown": bool(time.time() < self._cooldown_until),
        }

    def _roll_day(self):
        today = date.today()
        if today != self._day:
            self._day = today
            self._calls = 0
            self._touch_calls = 0
            self._session_calls = 0


def now_iso():
    return datetime.now().isoformat(timespec="seconds")