// 定时批量调度器：按岗位周期触发「一轮采集」，受全局最小间隔节流
// 持久化到 schedules.jsonl；每次执行后回写 lastRunAt/lastStatus/nextRunAt，重启后按 nextRunAt 续跑。
// runner: async (schedule) => any   —— 经由外部注入，默认触发 domain.runSourcingCycle（生产切 Python/BOSS 采集）。
export class SchedulingService {
  constructor({ store, audit, run, minGapMinutes = 1 }) {
    this.store = store;
    this.audit = audit;
    this.run = run;
    this.minGapMs = Math.max(1, Number(minGapMinutes) || 1) * 60 * 1000;
    this.timers = new Map(); // scheduleId -> timeout
    this._lastRunAt = 0;
  }

  list() {
    return [...this.store.readAll('schedules.jsonl')].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  create({ jobId, keyword, intervalMinutes, enabled = true, note = '' } = {}) {
    if (!jobId) throw new Error('jobId 必填');
    const s = {
      scheduleId: `sch_${Date.now()}`,
      jobId,
      keyword: String(keyword ?? ''),
      intervalMinutes: Math.max(1, Number(intervalMinutes) || 60),
      enabled: !!enabled,
      note: String(note ?? ''),
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      lastStatus: 'pending',
      nextRunAt: Date.now(),
    };
    this._upsert(s);
    if (s.enabled) this._arm(s);
    return s;
  }

  control(scheduleId, action) {
    const list = this.store.readAll('schedules.jsonl');
    const s = list.find((x) => x.scheduleId === scheduleId);
    if (!s) return { ok: false, error: 'schedule not found' };

    if (action === 'remove') {
      this._clear(scheduleId);
      this.store.writeAll('schedules.jsonl', list.filter((x) => x.scheduleId !== scheduleId));
      return { ok: true, action };
    }
    if (action === 'pause') {
      s.enabled = false;
      this._clear(scheduleId);
      this._upsert(s);
      return { ok: true, action };
    }
    if (action === 'resume') {
      s.enabled = true;
      s.nextRunAt = Date.now();
      this._upsert(s);
      this._arm(s);
      return { ok: true, action };
    }
    if (action === 'runNow') {
      this._upsert(s);
      setImmediate(() => this._tick(s));
      return { ok: true, action };
    }
    return { ok: false, error: `unknown action: ${action}` };
  }

  start() {
    for (const s of this.store.readAll('schedules.jsonl')) {
      if (s.enabled && !this.timers.has(s.scheduleId)) this._arm(s);
    }
  }

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // 删除某岗位时清理其全部定时任务（停止计时器 + 持久化移除）
  removeByJob(jobId) {
    const list = this.store.readAll('schedules.jsonl');
    const doomed = list.filter((x) => x.jobId === jobId);
    doomed.forEach((s) => this._clear(s.scheduleId));
    this.store.writeAll('schedules.jsonl', list.filter((x) => x.jobId !== jobId));
    return { removed: doomed.length };
  }

  _arm(s) {
    this._clear(s.scheduleId);
    const t = setTimeout(() => this._tick(s), this.#delay(s));
    t.unref?.();
    this.timers.set(s.scheduleId, t);
  }

  _clear(id) {
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
  }

  #delay(s) {
    const due = (s.nextRunAt || Date.now()) - Date.now();
    return Math.max(0, Math.min(due, 6 * 60 * 60 * 1000)); // 上限 6h，防超大 interval 的 setTimeout 溢出
  }

  async _tick(s) {
    this.timers.delete(s.scheduleId);
    if (!s.enabled) return;

    const now = Date.now();
    if (now - this._lastRunAt < this.minGapMs) { // 全局节流：距上次执行过近则推迟 1 分钟
      s.nextRunAt = now + 60 * 1000;
      this._upsert(s);
      this._arm(s);
      return;
    }
    this._lastRunAt = now;
    s.lastRunAt = new Date().toISOString();
    s.lastStatus = 'running';
    this._upsert(s);

    this.audit?.record({ actor: 'scheduler', action: 'schedule.tick', detail: { scheduleId: s.scheduleId, jobId: s.jobId } });
    try {
      await this.run(s);
      s.lastStatus = 'ok';
    } catch (e) {
      s.lastStatus = `error:${String(e?.message || e).slice(0, 80)}`;
      this.audit?.record({ actor: 'scheduler', action: 'schedule.error', detail: { scheduleId: s.scheduleId, error: String(e?.message || e) } });
    }
    s.nextRunAt = Date.now() + s.intervalMinutes * 60 * 1000;
    this._upsert(s);
    this._arm(s);
  }

  _upsert(s) {
    const list = this.store.readAll('schedules.jsonl');
    const i = list.findIndex((x) => x.scheduleId === s.scheduleId);
    if (i >= 0) list[i] = s;
    else list.push(s);
    this.store.writeAll('schedules.jsonl', list);
  }
}