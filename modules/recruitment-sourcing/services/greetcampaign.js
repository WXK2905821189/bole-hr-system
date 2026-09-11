// F-3 打招呼批次（GreetCampaign 契约）：
// ① 按 BOSS 发布的所有职位顺序逐个打招呼，每个职位额度可单独自定义；
// ② 按指定职位打招呼，额度可自定义；遍历完或到配额即批次结束；全程走风控护栏。
// 数据写入 greetcampaigns.jsonl，严格走 framework/schema/greet-campaign.schema.json 契约。
import { randomBytes } from 'node:crypto';

export class GreetCampaignService {
  constructor({ store, validate, audit, bus, domain, config }) {
    this.store = store;
    this.validate = validate;
    this.audit = audit;
    this.bus = bus;
    this.domain = domain;
    this.defaultQuota = Number(config?.engage?.defaultJobQuota ?? 20);
  }

  list() {
    const seen = new Map();
    for (const row of this.store.readAll('greetcampaigns.jsonl')) seen.set(row.campaignId, row);
    return [...seen.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  get(campaignId) {
    return this.list().find((c) => c.campaignId === campaignId) ?? null;
  }

  // 新建批次：mode=all_jobs（全部 open 职位按顺序，默认额度可 per-job 覆盖）| selected_jobs（指定职位+额度）
  create({ mode = 'all_jobs', jobs = [], recruiterId = 'A1' } = {}) {
    if (!['all_jobs', 'selected_jobs'].includes(mode)) throw new Error('mode 需为 all_jobs/selected_jobs');
    const openJobs = this.store.readAll('jobs.jsonl').filter((j) => j.status !== 'closed');
    let entries;
    if (mode === 'all_jobs') {
      const overrides = new Map((jobs ?? []).filter((j) => j?.jobId).map((j) => [j.jobId, Number(j.quota)]));
      entries = openJobs.map((j) => ({ jobId: j.jobId, quota: overrides.get(j.jobId) ?? this.defaultQuota }));
    } else {
      entries = (jobs ?? []).filter((j) => j?.jobId).map((j) => ({ jobId: j.jobId, quota: Number(j.quota ?? this.defaultQuota) }));
      const known = new Set(openJobs.map((j) => j.jobId));
      const unknown = entries.filter((e) => !known.has(e.jobId)).map((e) => e.jobId);
      if (unknown.length) throw new Error(`指定职位不存在或已关闭: ${unknown.join(',')}`);
    }
    if (!entries.length) throw new Error('无可用职位（需先创建岗位或传入指定职位）');
    entries.forEach((e) => { if (!Number.isInteger(e.quota) || e.quota < 0) throw new Error(`职位 ${e.jobId} 额度需为非负整数`); });

    const now = new Date().toISOString();
    const campaign = {
      campaignId: `gc_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
      recruiterId, mode,
      jobs: entries.map((e) => ({ ...e, greeted: 0, state: 'pending' })),
      status: 'running', cursor: 0, createdAt: now, meta: { createdAt: now, updatedAt: now },
    };
    this.validate.assertValid('greet-campaign', campaign);
    this.#save(campaign);
    this.audit?.record({ actor: recruiterId, action: 'campaign.create', detail: { campaignId: campaign.campaignId, mode, jobs: campaign.jobs.map((j) => ({ jobId: j.jobId, quota: j.quota })) } }).catch(() => {});
    return campaign;
  }

  control(campaignId, action) {
    const c = this.get(campaignId);
    if (!c) return { ok: false, error: '未找到批次' };
    if (action === 'pause') {
      if (c.status !== 'running') return { ok: false, error: '仅进行中的批次可暂停' };
      c.status = 'paused'; c.note = 'HR 手动暂停';
    } else if (action === 'resume') {
      if (c.status !== 'paused') return { ok: false, error: '仅暂停中的批次可恢复' };
      c.status = 'running'; c.note = '';
    } else if (action === 'finish') {
      c.status = 'finished'; c.finishedAt = new Date().toISOString(); c.note = c.note || 'HR 手动结束';
    } else {
      return { ok: false, error: 'action 需为 pause/resume/finish' };
    }
    this.#save(c);
    return { ok: true, campaign: c };
  }

  // 运行批次：从 cursor 起按职位顺序打招呼，到额切换下一职位；遍历完/到配额即结束；护栏拦截 → 暂停留痕
  async run(campaignId) {
    let c = this.get(campaignId);
    if (!c) return { ok: false, error: '未找到批次' };
    if (c.status === 'finished') return { ok: true, finished: true, campaign: c };
    if (c.status === 'paused') return { ok: true, paused: true, campaign: c };
    c.status = 'running';
    this.audit?.record({ actor: c.recruiterId, action: 'campaign.run', detail: { campaignId, cursor: c.cursor } }).catch(() => {});

    let pausedReason = null;
    while (c.cursor < c.jobs.length) {
      const entry = c.jobs[c.cursor];
      if (['done', 'quota_reached', 'exhausted'].includes(entry.state)) { c.cursor++; continue; }
      entry.state = 'running';

      // 该职位可打候选人：归属该职位、未打过招呼、未沉睡
      const pool = this.store.readAll('candidates.jsonl')
        .filter((x) => x.jobId === entry.jobId && !x.greetedAt && x.touchStatus !== 'sleeping');
      let idx = 0;
      while (idx < pool.length) {
        if (entry.quota > 0 && entry.greeted >= entry.quota) break; // 到配额 → 切换下一职位
        const cand = pool[idx++];
        const r = await this.domain.greetForCampaign(cand.candidateId, c.recruiterId);
        if (r.blocked) {
          pausedReason = r.reason;
          entry.state = 'pending'; // 保留进度，恢复后继续
          break;
        }
        if (r.ok && !r.already) entry.greeted++;
        // already=true 或 error=未找到 → 跳过不计数
      }
      if (pausedReason) break;
      // 到配额 → quota_reached；候选人遍历完 → exhausted；两者均为本职位结束态
      entry.state = (entry.quota > 0 && entry.greeted >= entry.quota) ? 'quota_reached' : 'exhausted';
      c.cursor++;
    }

    if (pausedReason) {
      c.status = 'paused';
      c.note = `护栏拦截：${pausedReason}`;
      this.#save(c);
      this.audit?.record({ actor: c.recruiterId, action: 'campaign.paused', detail: { campaignId, reason: pausedReason } }).catch(() => {});
      await this.bus?.emit('greet.campaign.finished', { campaign: c, reason: 'paused', stats: this.#stats(c) }, { actor: 'system' });
      return { ok: true, paused: true, reason: pausedReason, campaign: c };
    }

    c.status = 'finished';
    c.finishedAt = new Date().toISOString();
    c.note = '遍历完成（到配额或无可打候选人）';
    this.#save(c);
    this.audit?.record({ actor: c.recruiterId, action: 'campaign.finish', detail: { campaignId, stats: this.#stats(c) } }).catch(() => {});
    await this.bus?.emit('greet.campaign.finished', { campaign: c, reason: 'finished', stats: this.#stats(c) }, { actor: 'system' });
    return { ok: true, finished: true, campaign: c, stats: this.#stats(c) };
  }

  // F-4 数据复盘：口径与 PRD 3.2 一致（各职位打招呼量/已读未读/回复比例/索要交换转化/沉睡数/话术采用）
  // 来源：领域库 Engagement（engagements.jsonl）与候选人状态记录（candidates.jsonl）
  metrics(campaignId = null) {
    const campaign = campaignId ? this.get(campaignId) : null;
    const jobRows = this.store.readAll('jobs.jsonl').filter((j) => j.status !== 'closed');
    const scope = campaign ? campaign.jobs.map((j) => j.jobId) : jobRows.map((j) => j.jobId);
    const titleOf = Object.fromEntries(jobRows.map((j) => [j.jobId, j.jobTitle ?? j.jobId]));

    const cands = this.store.readAll('candidates.jsonl');
    const engs = this.store.readAll('engagements.jsonl');
    const perJob = [];
    const totals = { greeted: 0, read: 0, unread: 0, replied: 0, requested: 0, converted: 0, sleeping: 0, candidates: 0, templateUsage: {} };

    for (const jobId of scope) {
      const jobCands = cands.filter((c) => c.jobId === jobId);
      const ids = new Set(jobCands.map((c) => c.candidateId));
      const jobEngs = engs.filter((e) => ids.has(e.candidateId));
      const greets = jobEngs.filter((e) => e.action === 'greet');
      const templateUsage = {};
      for (const g of greets) templateUsage[g.messageVersion ?? 'unknown'] = (templateUsage[g.messageVersion ?? 'unknown'] ?? 0) + 1;

      const engagedIds = new Set(greets.map((g) => g.candidateId));
      let read = 0, replied = 0;
      for (const cid of engagedIds) {
        const mine = jobEngs.filter((e) => e.candidateId === cid);
        if (mine.some((e) => e.action === 'reply')) { read++; replied++; }
        else if (mine.some((e) => e.readStatus === 'read')) read++;
      }
      const requested = jobEngs.filter((e) => ['request_resume', 'request_phone', 'exchange_contact'].includes(e.action)).length;
      const converted = jobEngs.filter((e) => e.action === 'agree_resume').length
        + jobCands.filter((c) => c.contactResolved).length;
      const sleeping = jobCands.filter((c) => c.touchStatus === 'sleeping').length;

      const row = {
        jobId, jobTitle: titleOf[jobId] ?? jobId,
        greeted: greets.length, read, unread: greets.length ? engagedIds.size - read : 0, engaged: engagedIds.size,
        readRate: engagedIds.size ? +(read / engagedIds.size).toFixed(4) : 0,
        replied, replyRate: engagedIds.size ? +(replied / engagedIds.size).toFixed(4) : 0,
        requested, converted, convertRate: requested ? +(converted / requested).toFixed(4) : 0,
        sleeping, candidates: jobCands.length, templateUsage,
      };
      perJob.push(row);
      totals.greeted += row.greeted; totals.read += row.read; totals.unread += row.unread;
      totals.replied += row.replied; totals.requested += row.requested; totals.converted += row.converted;
      totals.sleeping += row.sleeping; totals.candidates += row.candidates;
      for (const [v, n] of Object.entries(templateUsage)) totals.templateUsage[v] = (totals.templateUsage[v] ?? 0) + n;
    }
    totals.readRate = totals.greeted ? +(totals.read / Math.max(1, totals.greeted)).toFixed(4) : 0;
    totals.replyRate = totals.greeted ? +(totals.replied / Math.max(1, totals.greeted)).toFixed(4) : 0;
    totals.convertRate = totals.requested ? +(totals.converted / totals.requested).toFixed(4) : 0;
    const campaignSummary = campaign ? {
      campaignId: campaign.campaignId, mode: campaign.mode, status: campaign.status,
      jobs: campaign.jobs.map((j) => ({ jobId: j.jobId, quota: j.quota, greeted: j.greeted, state: j.state })),
      totalGreeted: campaign.jobs.reduce((n, j) => n + (j.greeted ?? 0), 0),
    } : null;
    return { campaign: campaignSummary, perJob, totals };
  }

  #stats(c) {
    return { totalGreeted: c.jobs.reduce((n, j) => n + (j.greeted ?? 0), 0), jobs: c.jobs.length };
  }

  #save(campaign) {
    const rows = this.store.readAll('greetcampaigns.jsonl').filter((x) => x.campaignId !== campaign.campaignId);
    campaign.meta.updatedAt = new Date().toISOString();
    this.validate.assertValid('greet-campaign', campaign);
    rows.push(campaign);
    this.store.writeAll('greetcampaigns.jsonl', rows);
  }
}
