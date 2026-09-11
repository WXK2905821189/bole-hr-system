// B-3 智能跟进引擎：双轨（未读 / 已读未回复）统一「隔1天 → 累计≥5次降周频 → 满1月沉睡」流转。
// 跟进重发话术按轮次切换（第2轮二次激活 second / ≥3轮三次及以上 third）。
// 沉睡后停止触达；轮次/频次/状态实时可查（plan/status，无需等待真实时间）。
const DAY = 86400000;
const TOUCH_ACTIONS = new Set(['greet', 'request_resume', 'request_phone', 'follow_up']);

export class FollowUpEngine {
  constructor({ store, audit, domain, messagelib, config }) {
    this.store = store;
    this.audit = audit;
    this.domain = domain;      // 提供 sendFollowUp / markSleeping（复用护栏+审计）
    this.messagelib = messagelib;
    const e = config?.engage ?? {};
    this.dailyMs = (e.dailyFollowUpIntervalDays ?? 1) * DAY;
    this.weeklyMs = (e.weeklyFollowUpIntervalDays ?? 7) * DAY;
    this.weeklyAfterTouches = e.weeklyAfterTouches ?? 5;
    this.sleepAfterMs = (e.sleepAfterDays ?? 30) * DAY;
    this.plans = new Map(); // candidateId -> 最近一次 plan 快照
    this.timer = null;
  }

  #engs(candidateId) { return this.store.readAll('engagements.jsonl').filter((e) => e.candidateId === candidateId); }
  #touches(candidateId) { return this.#engs(candidateId).filter((e) => TOUCH_ACTIONS.has(e.action)); }

  // 计算候选人的跟进计划（纯判定，不发送）。双轨判定：有 reply 即「已读」轨，否则「未读」轨。
  plan(candidate, now = Date.now()) {
    const cid = candidate.candidateId;
    const touches = this.#touches(cid);
    const replyCount = this.#engs(cid).filter((e) => e.action === 'reply').length;
    const track = replyCount > 0 ? 'read' : 'unread';
    const touchCount = touches.length;
    const lastAt = touches.length ? Math.max(...touches.map((e) => new Date(e.timestamps?.sent ?? e.meta?.createdAt ?? 0).getTime())) : null;
    const createdMs = this.#engs(cid).map((e) => new Date(e.meta?.createdAt ?? 0).getTime());
    const created = createdMs.length ? Math.min(...createdMs) : null;
    const ageMs = created == null ? 0 : now - created;
    const sinceLastMs = lastAt == null ? 0 : now - lastAt;

    const base = {
      candidateId: cid, name: candidate.name ?? cid, recruiterId: candidate.recruiterId || 'A1',
      track, replyCount, touchCount, created: created ? new Date(created).toISOString() : null,
      lastTouchAt: lastAt ? new Date(lastAt).toISOString() : null,
    };
    // 尚未触达（待自动打招呼）→ 不动，等待上游触发
    if (lastAt == null || touchCount === 0) { const p = { ...base, status: 'wait', action: 'wait' }; this.plans.set(cid, p); return p; }
    const mode = touchCount >= this.weeklyAfterTouches ? 'weekly' : 'daily';
    const intervalMs = mode === 'weekly' ? this.weeklyMs : this.dailyMs;
    const nextDueAt = lastAt + intervalMs;
    // 满 1 月（自首次触达起）仍未读 / 未回复 → 置沉睡
    if (ageMs >= this.sleepAfterMs) {
      const p = { ...base, status: 'sleeping', mode, intervalDays: Math.round(intervalMs / DAY), nextDueAt: new Date(nextDueAt).toISOString(), action: 'sleep' };
      this.plans.set(cid, p); return p;
    }
    const p = { ...base, status: 'engaging', mode, intervalDays: Math.round(intervalMs / DAY), nextDueAt: new Date(nextDueAt).toISOString(), action: sinceLastMs >= intervalMs ? 'send' : 'wait' };
    this.plans.set(cid, p); return p;
  }

  // 执行一批到期计划：发跟进（话术随轮次切换）或置沉睡。返回执行明细。
  async tick(due, { now = Date.now() } = {}) {
    const sent = [], slept = [];
    for (const r of due) {
      const candidate = this.store.readAll('candidates.jsonl').find((c) => c.candidateId === r.candidateId) ?? r.candidate;
      if (!candidate) continue;
      if (r.action === 'send') {
        const round = r.touchCount + 1;
        const out = await this.domain.sendFollowUp(candidate.candidateId, candidate.recruiterId || 'A1', round);
        r.result = out.ok ? 'sent' : (out.blocked ? `blocked(${out.reason})` : `error(${out.error})`);
        sent.push(r);
      } else if (r.action === 'sleep') {
        await this.domain.markSleeping(candidate.candidateId);
        r.result = 'slept';
        slept.push(r);
      }
    }
    return { at: new Date(now).toISOString(), sent, slept };
  }

  // 全量扫描：评估所有未沉睡、已触达候选，执行到期动作并留痕。
  async sweep({ now = Date.now() } = {}) {
    const cands = this.store.readAll('candidates.jsonl').filter((c) => c.touchStatus !== 'sleeping' && !c.sleeping);
    const plans = cands.map((c) => this.plan(c, now));
    const due = plans.filter((p) => p.action === 'send' || p.action === 'sleep');
    const summary = await this.tick(due, { now });
    summary.candidates = plans;
    summary.totals = { read: plans.filter((p) => p.track === 'read').length, unread: plans.filter((p) => p.track === 'unread').length, engaging: plans.filter((p) => p.status === 'engaging').length, waiting: plans.filter((p) => p.status === 'wait').length };
    await this.audit?.record({ actor: 'system', action: 'engage.sweep', detail: { scanned: plans.length, sent: summary.sent.length, slept: summary.slept.length, read: summary.totals.read, unread: summary.totals.unread } });
    return summary;
  }

  status() { return [...this.plans.values()]; }

  planOf(candidateId) {
    const c = this.store.readAll('candidates.jsonl').find((x) => x.candidateId === candidateId);
    return c ? this.plan(c) : null;
  }

  // 周期调度：每隔 followSweepMinutes 分钟扫描一次到期跟进（真实 cadence 由 plan 判定，间隔通常按天/周）
  start(minutes = 1) {
    const ms = Math.max(1, Number(minutes) || 1) * 60000;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.sweep().catch(() => {}), ms);
    this.timer.unref?.();
    return this;
  }

  dispose() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}