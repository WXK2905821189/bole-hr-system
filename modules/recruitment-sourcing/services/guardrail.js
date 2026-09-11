// 触达风控护栏(Node 侧, Python safety.py 的等价实现)：
// 把打招呼(greet) / 索要简历(request_resume) / 索要电话(request_phone) 归入同一套
// 每日上限 + 会话上限 + 间隔节流 + 冷却熔断; 超频动作被拦截并留痕; 与账号冷却联动。
// 合规红线与 safety.py 一致: 不轮换代理、不做 WebDriver 特征规避。
export class GuardrailService {
  constructor({ store, audit, config }) {
    this.store = store;
    this.audit = audit;
    const s = config?.safety ?? {};
    this.dailyCap = s.daily_cap ?? s.dailyCap ?? 200;                 // 每账号每日总动作上限
    this.touchDailyCap = s.touch_daily_cap ?? s.touchDailyCap ?? 60;  // 打招呼+索取 共用上限（更保守）
    this.minIntervalSeconds = s.interval_seconds || s.minIntervalSeconds || [3, 8];
    this.cooldownMinutes = s.cooldown_minutes ?? s.cooldownMinutes ?? 30;
    this.sessionCap = s.session_cap ?? s.sessionCap ?? 80;
    this.circuitBreaker = s.circuit_breaker ?? s.circuitBreaker ?? 3;
    // 归入"打招呼/索取"共档的动作（F-1 同意收取 / F-2 交换联系方式 一并纳入节流）
    this.touchActions = new Set(['greet', 'request_resume', 'request_phone', 'agree_resume', 'exchange_contact']);
    this.followActions = new Set(['follow_up']);
    this.state = new Map(); // recruiterId -> {day, calls, touchCalls, sessionCalls, consecFail, cooldownUntil}
  }

  // 动作前判定：allowed -> {ok:true}; 否则返回明确原因
  check({ recruiterId = 'A1', action = 'greet' }) {
    const st = this.#st(recruiterId);
    this.#roll(recruiterId, st);
    const now = Date.now();
    if (now < st.cooldownUntil) return { ok: false, reason: `账号冷却中(风控熔断)，剩余约 ${Math.ceil((st.cooldownUntil - now) / 60000)} 分钟` };
    if (st.calls >= this.dailyCap) return { ok: false, reason: `已触达每日总上限 ${this.dailyCap}` };
    if (this.touchActions.has(action) && st.touchCalls >= this.touchDailyCap) return { ok: false, reason: `今日打招呼/索取已触达共用上限 ${this.touchDailyCap}` };
    if (this.followActions.has(action) && st.calls >= this.dailyCap) return { ok: false, reason: `今日跟进已达上限 ${this.dailyCap}` };
    if (st.sessionCalls >= this.sessionCap) return { ok: false, reason: `已触达会话上限 ${this.sessionCap}，请切换会话/等待冷却` };
    return { ok: true, reason: 'allow' };
  }

  // 动作后记录（ok=false 累计连续失败，达阈值熔断冷却）
  record({ recruiterId = 'A1', action = 'greet', ok = true }) {
    const st = this.#st(recruiterId);
    this.#roll(recruiterId, st);
    st.calls += 1;
    if (this.touchActions.has(action)) st.touchCalls += 1;
    if (ok) { st.sessionCalls += 1; st.consecFail = 0; }
    else {
      st.consecFail += 1;
      if (st.consecFail >= this.circuitBreaker) { st.cooldownUntil = Date.now() + this.cooldownMinutes * 60000; this.#log({ recruiterId, action, reason: '连续失败熔断' }); }
    }
  }

  // 超频/风控被拦截 => 留痕（guardrail.jsonl + 审计）
  logBlock({ recruiterId = 'A1', action = 'greet', reason }) {
    this.#log({ recruiterId, action, reason, blocked: true });
  }

  // 命中冷却（外部调用：如 Python/账号层报风控）
  triggerCooldown(recruiterId = 'A1', minutes) {
    const st = this.#st(recruiterId);
    this.#roll(recruiterId, st);
    st.cooldownUntil = Date.now() + (minutes ?? this.cooldownMinutes) * 60000;
    this.#log({ recruiterId, action: 'cooldown', reason: `强制冷却 ${minutes ?? this.cooldownMinutes} 分钟` });
  }

  // 每个通过动作前的随机间隔节流（与 Python before_call 语义一致）
  async throttle() {
    const [lo, hi] = this.minIntervalSeconds;
    const ms = (lo + Math.random() * Math.max(0, hi - lo)) * 1000;
    return new Promise((r) => setTimeout(r, ms));
  }

  stats() {
    const out = {};
    for (const [id, st] of this.state) out[id] = { day: st.day, calls: st.calls, touchCalls: st.touchCalls, sessionCalls: st.sessionCalls, inCooldown: Date.now() < st.cooldownUntil };
    return out;
  }

  #st(id) {
    if (!this.state.has(id)) this.state.set(id, { day: todayStr(), calls: 0, touchCalls: 0, sessionCalls: 0, consecFail: 0, cooldownUntil: 0 });
    return this.state.get(id);
  }

  #roll(id, st) {
    const d = todayStr();
    if (st.day !== d) { st.day = d; st.calls = 0; st.touchCalls = 0; st.sessionCalls = 0; st.consecFail = 0; }
  }

  #log({ recruiterId, action, reason, blocked = false }) {
    const row = { at: new Date().toISOString(), recruiterId, action, reason, blocked };
    this.store.write('guardrail.jsonl', row);
    this.audit?.record({ actor: recruiterId, action: blocked ? 'guardrail.block' : 'guardrail.event', detail: { action, reason } }).catch(() => {});
  }
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}