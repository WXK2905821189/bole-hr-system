# 采集适配器门面：按 config.mode 选择 模拟器(simulator) 或 真实BOSS(boss)。
# - simulator(默认)：离线合成脱敏候选，链路可无账号跑通；
# - boss：需公司自有账号持久会话(profile_dir)，受 SafetyLimiter 强节流。
from safety import SafetyLimiter
from simulator import SimulatorAdapter
from boss_driver import BossDriver


class SourcingAdapter:
    """统一采集入口：产出符合 hr:schema:candidate 的候选列表。"""

    def __init__(self, config: dict):
        self.config = config
        mode = config.get("mode", "simulator")
        self.mode = mode
        self.safety = SafetyLimiter(**config.get("safety", {}))
        if mode == "boss":
            acc = config.get("account") or {}
            self.backend = BossDriver(
                account_name=acc.get("name", "boss"),
                profile_dir=acc.get("profile_dir"),
                selectors=config.get("selectors"),
                headless=config.get("headless", False),
            )
        else:
            self.backend = SimulatorAdapter(config)

    def safety_limits(self) -> dict:
        return self.safety.stats

    def produce_candidates(self, job_id: str, keyword: str) -> list[dict]:
        """采集指定岗位的候选列表（全程受风控节流）。
        boss 模式下若未配置账号会话，将安全抛错（不静默抓取）。"""
        if not self.safety.allowed():
            raise RuntimeError(f"采集被节流拦截：{self.safety.reason()}")
        return self.backend.produce_candidates(job_id, keyword, self.safety)