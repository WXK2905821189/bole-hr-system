// 招聘寻源领域：模拟 BOSS 采集链路（解析JD→主动搜索→发送打招呼→索要简历→AI解析→岗位匹配）
// 触达动作白名单：与 engagement 契约保持一致，用于回合计数/去重判定（reply 不计入触达轮次）
const TOUCH_ACTIONS = new Set(['greet', 'request_resume', 'request_phone', 'follow_up', 'agree_resume', 'exchange_contact']);
const PHONE_RE = /(?<![\d])1[3-9](?:\d[-\s]?){9}(?!\d)/;

export class SourcingDomain {
  constructor(deps) {
    this.deps = deps; // { bus, validate, audit, store, services:{ ..., engagement, guardrail, messagelib }, config }
    this.cycleId = 0;
    const e = deps.config?.engage ?? {};
    this.threshold = Number(e.autoGreetThreshold ?? process.env.HR_ENGAGE_THRESHOLD ?? 60);
  }

  async runSourcingCycle(jobId, jdRaw, keyword, recruiterId) {
    const cycleId = ++this.cycleId;
    const at = new Date().toISOString();
    const steps = [];
    const mark = (label, ok, note = '') => { steps.push({ label, ok: !!ok, note }); };
    await this.deps.store.write('cycles.jsonl', { cycleId, jobId, keyword, recruiterId, status: 'started', at });
    await this.deps.audit.record({ actor: 'hr', action: 'sourcing.cycle.start', detail: { cycleId, jobId, keyword, recruiterId } });

    // 1) 解析 JD，沉淀岗位——岗位归属当前招聘者账号
    mark('解析 JD · 抽取学历/经验/技能关键词');
    const job = await this.deps.services.jd.parse(jdRaw, { jobId, recruiterId });
    await this.deps.audit.record({ actor: 'system', action: 'job.parsed', detail: { jobId, position: job.jobTitle } });

    // 2) BOSS 账号（当前账号）主动搜索
    const kw = keyword && keyword.trim() ? keyword : (job.jobTitle || jobId);
    mark(`BOSS 账号 ${recruiterId} 主动搜索 · 关键词「${kw}」`);

    // 3) 发送打招呼 + 4) 索要简历：生成一批候选人（mark greeted），并合成原始简历文件
    mark(`发送打招呼 · 向 ${recruiterId} 搜索结果前 N 位候选人发送`);

    const batch = this.#mockBatch(job, jobId, recruiterId, 3);
    let greetCount = 0;
    for (const it of batch) {
      it.candidate.touchStatus = 'engaging'; // 默认候选均已完成首次打招呼
      await this.deps.store.write('candidates.jsonl', it.candidate);
      await this.deps.store.write('resumes.jsonl', it.resume);
      if (it.candidate.greetedAt) greetCount++;
      // 触达契约：本轮每个候选记一条 greet 触达(契约校验失败会抛错, 变异数据不入库)
      this.deps.services.engagement.touch({ candidateId: it.candidate.candidateId, jobId, recruiterId, action: 'greet', stopFlag: false });
      await this.deps.bus.emit('candidate.sourced', it.candidate, { actor: 'system' });
    }
    mark(`已发送打招呼 ${greetCount} 位 · 索要简历成功 ${batch.length} 份（docx/PDF）`, true);

    // 5) AI 解析简历 + 6) 岗位匹配
    mark(`AI 解析简历 · ${batch.length} 份已结构化`);
    const matched = [];
    for (const it of batch) {
      await this.deps.store.write('matches.jsonl', it.match);
      matched.push(it.match.candidateId);
    }
    mark(`岗位匹配完成 · 生成 ${matched.length} 条匹配记录`, true);

    await this.deps.bus.emit('sourcing.cycle.done', { cycleId, count: batch.length }, { actor: 'system' });
    return { cycleId, job, candidates: batch.map((b) => b.candidate), greeted: greetCount, steps };
  }

  // 对岗位已有候选人批量发送打招呼（不重复，仅未打过招呼的；受护栏节流）
  async sendGreeting(jobId, recruiterId, jobTitle) {
    const cands = this.deps.store.readAll('candidates.jsonl');
    const targets = cands.filter((c) => c.jobId === jobId && !c.greetedAt);
    let ok = 0;
    const blocked = [];
    for (const c of targets) {
      const r = await this.#guardedTouch({ candidateId: c.candidateId, recruiterId, action: 'greet', template: `您好，我是 BOSS 直聘上 ${recruiterId || '招聘方'}，看到您与「${jobTitle || jobId}」岗位很匹配，想进一步了解您的最新情况，方便沟通吗？` });
      if (r.blocked) { blocked.push({ candidateId: c.candidateId, reason: r.reason }); }
      else if (r.ok) ok++;
    }
    return { count: ok, blocked };
  }

  // 对单个候选人发送打招呼（受护栏节流）
  async greetCandidate(candidateId, recruiterId) {
    const cands = this.deps.store.readAll('candidates.jsonl');
    const c = cands.find((x) => x.candidateId === candidateId);
    if (!c) return { ok: false, error: '未找到候选人' };
    return this.#guardedTouch({ candidateId, recruiterId, action: 'greet', template: `您好，我是 BOSS 直聘上 ${recruiterId || '招聘方'}，看到您的简历非常匹配，方便进一步沟通吗？` });
  }

  // 索要简历 / 索要电话 / 跟进（与打招呼共用护栏与触达入库）
  async touch(candidateId, recruiterId, action = 'request_resume') {
    const cands = this.deps.store.readAll('candidates.jsonl');
    const c = cands.find((x) => x.candidateId === candidateId);
    if (!c) return { ok: false, error: '未找到候选人' };
    if (!['request_resume', 'request_phone', 'follow_up'].includes(action)) return { ok: false, error: `不支持的触达动作: ${action}` };
    return this.#guardedTouch({ candidateId, recruiterId, action });
  }

  // 候选人回复 / 标记沉睡。PRD FR-3/FR-6：候选人回复即自动索要简历/电话（受护栏联动）。
  // 幂等规则：已有简历 → 直接检测缺电话走 request_phone；无简历 → request_resume（解析后联动②再检缺电话）。
  // F-2：回复正文含手机号 → 联系方式回写 Resolve（candidate.phone + contactResolved + 审计）。
  async reply(candidateId, recruiterId, { content = '', stopFlag = false }) {
    const cands = this.deps.store.readAll('candidates.jsonl');
    const c = cands.find((x) => x.candidateId === candidateId);
    if (!c) return { ok: false, error: '未找到候选人' };
    const rec = this.deps.services.engagement.touch({ candidateId, jobId: c.jobId, recruiterId, action: 'reply', replyContent: content, stopFlag });

    // F-2 联系方式回写：回复中带手机号且此前缺联系方式 → 回写并标记 Resolve
    let contactResolved = false;
    const pm = String(content ?? '').match(PHONE_RE);
    if (pm && this.#contactOf(candidateId) == null) {
      const phone = pm[0].replace(/[-\s]/g, '');
      const candsFresh = this.deps.store.readAll('candidates.jsonl');
      const fresh = candsFresh.find((x) => x.candidateId === candidateId);
      fresh.phone = phone;
      fresh.contactResolved = true;
      this.deps.store.writeAll('candidates.jsonl', candsFresh);
      contactResolved = true;
      await this.deps.audit.record({ actor: recruiterId, action: 'engage.contact.resolve', detail: { candidateId, jobId: fresh.jobId, phone: phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'), via: 'exchange_reply' } });
    }

    if (stopFlag) {
      return { ok: true, engagement: rec, autoRequested: null, contactResolved, candidate: cands.find((x) => x.candidateId === candidateId) };
    }
    const resumes = this.deps.store.readAll('resumes.jsonl');
    const resume = resumes.filter((x) => x.candidateId === candidateId).at(-1) ?? null;
    if (resume) {
      const autoRequested = this.#contactOf(candidateId) != null
        ? { ok: true, already: true }
        : await this.requestExchangeContact(candidateId, recruiterId);
      return { ok: true, engagement: rec, autoRequested, contactResolved, candidate: this.deps.store.readAll('candidates.jsonl').find((x) => x.candidateId === candidateId) };
    }
    const autoRequested = await this.touch(candidateId, recruiterId, 'request_resume');
    return { ok: true, engagement: rec, autoRequested, contactResolved, candidate: this.deps.store.readAll('candidates.jsonl').find((x) => x.candidateId === candidateId) };
  }

  // 统一受护触达：护栏放行(否则拦截留痕) → 节流 → 落库标记 → 触达契约入库 → B-4 完整审计
  async #guardedTouch({ candidateId, recruiterId, action, template, messageVersion, content, round }) {
    const g = this.deps.services.guardrail;
    const eng = this.deps.services.engagement;
    const exists = this.deps.store.readAll('engagements.jsonl').filter((e) => e.candidateId === candidateId && TOUCH_ACTIONS.has(e.action)).length;
    const thisRound = round ?? exists + 1;
    const check = g.check({ recruiterId, action });
    if (!check.ok) {
      g.logBlock({ recruiterId, action, reason: check.reason });
      await this.deps.audit.record({ actor: recruiterId, action: `sourcing.${action}.blocked`, detail: { candidateId, round: thisRound, messageVersion, reason: check.reason } });
      return { ok: false, blocked: true, reason: check.reason };
    }
    await g.throttle();
    const cands = this.deps.store.readAll('candidates.jsonl');
    const c = cands.find((x) => x.candidateId === candidateId);
    if (!c) return { ok: false, error: '未找到候选人' };
    const wasGreeted = !!c.greetedAt;
    if (action === 'greet' && wasGreeted) return { ok: true, already: true, candidate: c }; // 重复打招呼：不再消耗配额/重复入库
    if (action === 'greet') {
      c.greeted = true;
      c.greetedAt = new Date().toISOString();
      c.greetMessage = content ?? template ?? '';
      this.deps.store.writeAll('candidates.jsonl', cands);
    }
    // 触达契约入库（含话术正文/版本）+ 联动 touchStatus
    eng.touch({ candidateId, jobId: c.jobId, recruiterId, action, messageVersion, content, stopFlag: false });
    g.record({ recruiterId, action, ok: true });
    await this.deps.audit.record({ actor: recruiterId, action: `sourcing.${action}`, detail: { candidateId, jobId: c.jobId, round: thisRound, messageVersion, result: 'ok', readStatus: 'unread' } });
    return { ok: true, already: false, round: thisRound, candidate: this.deps.store.readAll('candidates.jsonl').find((x) => x.candidateId === candidateId) };
  }

  // B-2 自动打招呼：匹配达标即用当前生效「初次」话术发送，进入待跟进；已打招呼/沉睡则跳过
  async autoGreetQualified({ candidateId, jobId, matchScore, recruiterId }) {
    if (matchScore == null || Number(matchScore) < this.threshold) return { skipped: 'below_threshold', matchScore };
    const cands = this.deps.store.readAll('candidates.jsonl');
    const c = cands.find((x) => x.candidateId === candidateId);
    if (!c) return { skipped: 'no_candidate' };
    if (c.greetedAt || c.touchStatus === 'sleeping') return { skipped: 'already_greeted_or_sleeping', touchStatus: c.touchStatus };
    const jid = jobId || c.jobId;
    const job = this.deps.store.readAll('jobs.jsonl').find((j) => j.jobId === jid) ?? null;
    const msg = this.deps.services.messagelib.render('first', job?.jobTitle || jid);
    const rid = recruiterId || job?.recruiterId || 'A1';
    return this.#guardedTouch({ candidateId: c.candidateId, recruiterId: rid, action: 'greet', messageVersion: msg.templateId, content: msg.content, round: 1 });
  }

  // B-3 跟进重发：按轮次切换话术档（二次/三次激活），护栏放行后 follow_up
  async sendFollowUp(candidateId, recruiterId, round) {
    const cands = this.deps.store.readAll('candidates.jsonl');
    const c = cands.find((x) => x.candidateId === candidateId);
    if (!c) return { ok: false, error: '未找到候选人' };
    let nextRound = round ?? (this.deps.store.readAll('engagements.jsonl').filter((e) => e.candidateId === candidateId && TOUCH_ACTIONS.has(e.action)).length + 1);
    const tier = this.deps.services.messagelib.tierForRound(nextRound);
    const job = this.deps.store.readAll('jobs.jsonl').find((j) => j.jobId === c.jobId) ?? null;
    const msg = this.deps.services.messagelib.render(tier, job?.jobTitle, nextRound);
    return this.#guardedTouch({ candidateId, recruiterId, action: 'follow_up', messageVersion: msg.templateId, content: msg.content, round: nextRound });
  }

  // 触达到期后标记候选人沉睡（停止触达）
  async markSleeping(candidateId) {
    const cands = this.deps.store.readAll('candidates.jsonl');
    const c = cands.find((x) => x.candidateId === candidateId);
    if (!c) return { ok: false, error: '未找到候选人' };
    c.touchStatus = 'sleeping';
    c.sleeping = true;
    this.deps.store.writeAll('candidates.jsonl', cands);
    this.deps.services.guardrail.triggerCooldown(c.recruiterId || 'A1', 0); // 停止后续触发（时间=0使 check 立即回冷却结束，语义为拒绝新触达由 sleeping 兜底）
    await this.deps.audit.record({ actor: 'system', action: 'engage.sleep', detail: { candidateId, jobId: c.jobId, touchStatus: 'sleeping' } });
    return { ok: true, candidate: c };
  }

  // ================= F-1 候选人发送简历 → 自动点击 BOSS「同意」收取 =================
  // 收取成功 → 进入索取成功态(status=resume_received)并触发解析(联 FR-3)；失败/异常 → 转人工待处理；动作写审计、受护栏节流
  async receiveResumeInbound(candidateId, { rawText = '', fail = false, recruiterId } = {}) {
    const cands = this.deps.store.readAll('candidates.jsonl');
    const c = cands.find((x) => x.candidateId === candidateId);
    if (!c) return { ok: false, error: '未找到候选人' };
    const rid = recruiterId || c.recruiterId || 'A1';
    const resumes = this.deps.store.readAll('resumes.jsonl');
    const already = c.status === 'resume_received' || resumes.some((x) => x.candidateId === candidateId && x.status === 'resume_received');
    if (already) return { ok: true, already: true, note: '简历已收取' };

    // 护栏放行（同意收取与打招呼/索取共用限额与节流）
    const check = this.deps.services.guardrail.check({ recruiterId: rid, action: 'agree_resume' });
    if (!check.ok) {
      this.deps.services.guardrail.logBlock({ recruiterId: rid, action: 'agree_resume', reason: check.reason });
      await this.deps.audit.record({ actor: rid, action: 'sourcing.agree_resume.blocked', detail: { candidateId, reason: check.reason } });
      return { ok: false, blocked: true, reason: check.reason };
    }

    // 模拟 BOSS 适配层「点击同意」；异常 → 转人工待处理（不放宽风控红线）
    if (fail) {
      c.manualPending = true;
      c.manualReason = 'BOSS 同意收取失败（适配层异常）';
      this.deps.store.writeAll('candidates.jsonl', cands);
      this.deps.services.guardrail.record({ recruiterId: rid, action: 'agree_resume', ok: false });
      await this.deps.audit.record({ actor: rid, action: 'sourcing.agree_resume.failed', detail: { candidateId, jobId: c.jobId, result: 'failed', manualPending: true, reason: c.manualReason } });
      return { ok: false, manualPending: true, reason: c.manualReason };
    }

    const r = await this.#guardedTouch({ candidateId, recruiterId: rid, action: 'agree_resume', messageVersion: 'auto-agree', content: '已点击 BOSS「同意」收取简历', round: undefined });
    if (!r.ok) return r;
    // 收取成功 → 索取成功态 + 触发解析（FR-3 链路：解析→匹配→达标自动打招呼）
    const candsFresh = this.deps.store.readAll('candidates.jsonl');
    const fresh = candsFresh.find((x) => x.candidateId === candidateId);
    fresh.status = 'resume_received';
    fresh.manualPending = false;
    fresh.manualReason = '';
    this.deps.store.writeAll('candidates.jsonl', candsFresh);
    const text = String(rawText ?? '').trim() || `候选人 ${fresh.name ?? candidateId} 主动发送简历，${(fresh.skills ?? []).join('、')}，工作年限 ${fresh.workExperienceYears ?? '待定'} 年。`;
    await this.deps.services.parser.parse({
      resumeId: `res_${candidateId}_${Date.now().toString(36)}`,
      candidateId, jobId: fresh.jobId, rawText: text, format: 'text',
    });
    await this.deps.audit.record({ actor: rid, action: 'sourcing.agree_resume.ok', detail: { candidateId, jobId: fresh.jobId, result: 'received', parsed: true } });
    const match = this.deps.store.readAll('matches.jsonl').filter((x) => x.candidateId === candidateId).at(-1) ?? null;
    return { ok: true, already: false, resumeReceived: true, parsed: true, matchScore: match?.matchScore ?? null };
  }

  // F-1 人工重试：清转人工标记并再次尝试自动收取
  retryManualResume(candidateId, { rawText = '', recruiterId } = {}) {
    return this.receiveResumeInbound(candidateId, { rawText, fail: false, recruiterId });
  }

  // F-1 待人工处理清单
  listManualPending() {
    return this.deps.store.readAll('candidates.jsonl').filter((c) => c.manualPending);
  }

  // ================= F-2 缺联系方式 → 自动发送「交换联系方式」话术（附我方联系方式） =================
  async requestExchangeContact(candidateId, recruiterId) {
    const cands = this.deps.store.readAll('candidates.jsonl');
    const c = cands.find((x) => x.candidateId === candidateId);
    if (!c) return { ok: false, error: '未找到候选人' };
    const rid = recruiterId || c.recruiterId || 'A1';
    const hasPhone = this.#contactOf(candidateId) != null;
    if (hasPhone) return { ok: true, already: true, reason: 'contact_present', note: '已有联系方式，无需交换' };
    const sent = this.deps.store.readAll('engagements.jsonl').some((e) => e.candidateId === candidateId && e.action === 'exchange_contact');
    if (sent) return { ok: true, already: true, reason: 'exchange_sent', note: '交换联系方式已发送' };
    const job = this.deps.store.readAll('jobs.jsonl').find((j) => j.jobId === c.jobId) ?? null;
    const msg = this.deps.services.messagelib.render('exchange', job?.jobTitle || c.jobId);
    return this.#guardedTouch({ candidateId, recruiterId: rid, action: 'exchange_contact', messageVersion: msg.templateId, content: msg.content });
  }

  // 候选人当前联系方式（候选人档案 phone 或最新简历解析电话）
  #contactOf(candidateId) {
    const c = this.deps.store.readAll('candidates.jsonl').find((x) => x.candidateId === candidateId);
    if (c?.phone) return c.phone;
    const r = this.deps.store.readAll('resumes.jsonl').filter((x) => x.candidateId === candidateId).at(-1) ?? null;
    return r?.parsed?.contact?.phone ?? null;
  }

  // ================= F-3 批次打招呼：按职位顺序/指定职位，额度内逐个打招呼（话术=生效「初次」档） =================
  async greetForCampaign(candidateId, recruiterId) {
    const cands = this.deps.store.readAll('candidates.jsonl');
    const c = cands.find((x) => x.candidateId === candidateId);
    if (!c) return { ok: false, error: '未找到候选人' };
    const job = this.deps.store.readAll('jobs.jsonl').find((j) => j.jobId === c.jobId) ?? null;
    const msg = this.deps.services.messagelib.render('first', job?.jobTitle || c.jobId);
    return this.#guardedTouch({ candidateId, recruiterId, action: 'greet', messageVersion: msg.templateId, content: msg.content });
  }

  // ================= F-5 推荐牛人列表寻访：扩展自动打招呼对象（与搜索结果去重，不重复耗额度） =================
  // candidates：适配器直供的推荐列表（真实 BOSS 采集）；缺省时用模拟推荐数据
  async recommendSourcing(jobId, { count = 3, keyword = '', recruiterId, candidates } = {}) {
    const jobs = this.deps.store.readAll('jobs.jsonl');
    const job = jobs.find((j) => j.jobId === jobId);
    if (!job) return { ok: false, error: '未找到岗位' };
    const rid = recruiterId || job.recruiterId || 'A1';
    const hard = (job.hardSkills || []).map((s) => String(s).toLowerCase());
    const kw = String(keyword || job.jobTitle || '').toLowerCase();

    const fetched = Array.isArray(candidates) && candidates.length
      ? candidates.map((rc, i) => ({
          candidateId: rc.candidateId ?? `cand_rec_${String(rc.name ?? i).trim().replace(/\s+/g, '_')}`,
          name: rc.name ?? `推荐牛人${i + 1}`, years: Number(rc.years ?? rc.workExperienceYears ?? 3) || 3,
          phone: rc.phone ?? null, salaryExpected: rc.salaryExpected ?? '面议',
          skills: rc.skills ?? [], education: rc.education ?? {},
          rawText: rc.rawText ?? `${rc.name ?? '推荐牛人'}，${rc.years ?? 3}年经验，${(rc.skills ?? []).join('、')}。`,
        }))
      : this.#mockRecommends(job, jobId, Math.max(1, Number(count) || 3));
    const hit = fetched.filter((rc) => {
      const skills = (rc.skills ?? []).map((s) => String(s).toLowerCase());
      const byProfile = hard.length && skills.some((s) => hard.some((h) => s.includes(h) || h.includes(s)));
      const byKw = kw && (String(rc.name).toLowerCase().includes(kw) || skills.some((s) => s.includes(kw)));
      return byProfile || byKw;
    });

    // 去重：与既有候选人（含搜索结果命中）按 candidateId / 姓名+电话 归一去重
    const existing = this.deps.store.readAll('candidates.jsonl');
    const keys = new Set(existing.map((c) => c.candidateId));
    const namePhone = new Set(existing.map((c) => `${String(c.name ?? '').replace(/\s/g, '')}|${String(c.phone ?? '').replace(/[-\s]/g, '')}`));
    const injected = [];
    let deduped = 0;
    for (const rc of hit) {
      const np = `${String(rc.name).replace(/\s/g, '')}|${String(rc.phone ?? '').replace(/[-\s]/g, '')}`;
      if (keys.has(rc.candidateId) || namePhone.has(np)) { deduped++; continue; }
      keys.add(rc.candidateId); namePhone.add(np);
      const cand = {
        candidateId: rc.candidateId, source: 'boss_recommend', jobId,
        name: rc.name, status: 'sourced', workExperienceYears: rc.years,
        salaryExpected: rc.salaryExpected, skills: rc.skills,
        education: rc.education,
        meta: { createdAt: new Date().toISOString(), masked: true },
      };
      this.deps.validate.assertValid('candidate', cand);
      this.deps.store.write('candidates.jsonl', cand);
      await this.deps.bus.emit('candidate.sourced', { ...cand, resume: { rawText: rc.rawText, format: 'text' } }, { actor: 'system' });
      injected.push(cand.candidateId);
    }
    await this.deps.audit.record({ actor: rid, action: 'sourcing.recommend', detail: { jobId, fetched: fetched.length, hit: hit.length, deduped, injected: injected.length, candidateIds: injected } });
    return { ok: true, jobId, fetched: fetched.length, hit: hit.length, deduped, injected, candidateIds: injected };
  }

  // 生成一批贴近真实的「推荐牛人」列表数据（模拟 BOSS 平台推荐）
  #mockRecommends(job, jobId, count) {
    const NAMES = ['林岚', '黄浩', '徐婷', '马超', '宋佳', '韩磊', '曹颖', '邓宇', '冯雪', '蒋鑫'];
    const SCHOOLS = ['上海交通大学', '南京大学', '中山大学', '四川大学', '哈尔滨工业大学', '东南大学'];
    const hard = (job.hardSkills || []).slice(0, 3);
    const out = [];
    for (let i = 0; i < count; i++) {
      const name = NAMES[(Math.floor(Math.random() * NAMES.length) + out.length) % NAMES.length];
      const years = 1 + Math.floor(Math.random() * 8);
      const skills = [...hard, '团队协作', '执行力'];
      out.push({
        candidateId: `cand_rec_${Date.now().toString(36)}_${i}`,
        name: `${name}${i % 2 ? '·推荐' + (i + 1) : ''}`,
        years, phone: null,
        salaryExpected: `${10 + years * 2}~${14 + years * 3}K·13薪`,
        skills,
        education: { school: SCHOOLS[Math.floor(Math.random() * SCHOOLS.length)], major: '计算机相关', degree: years >= 5 ? '硕士' : '本科' },
        rawText: `${name}，${years}年经验，擅长${skills.slice(0, 3).join('、')}，BOSS 推荐牛人。`,
      });
    }
    return out;
  }

  // 触达记录查询
  listEngagements(limit = 200) {
    return this.deps.services.engagement.list(limit);
  }

  // 生成一批贴近真实结构的候选人/简历/匹配数据
  #mockBatch(job, jobId, recruiterId, count) {
    const NAMES = ['张伟', '李娜', '王强', '刘洋', '陈静', '杨帆', '赵磊', '孙悦', '周杰', '吴倩'];
    const SCHOOLS = [
      ['北京大学', '计算机科学', '硕士'], ['清华大学', '软件工程', '本科'], ['浙江大学', '人工智能', '硕士'],
      ['复旦大学', '计算机科学', '本科'], ['华中科技大学', '软件工程', '本科'], ['武汉大学', '电子信息', '硕士'],
    ];
    const EXPs = [[3, 5], [1, 3], [5, 8], [2, 4]];
    const out = [];
    const hard = (job.hardSkills || []).slice(0, 3);
    for (let i = 0; i < count; i++) {
      const ts = Date.now();
      const name = NAMES[Math.floor(Math.random() * NAMES.length)];
      const [school, major, degree] = SCHOOLS[Math.floor(Math.random() * SCHOOLS.length)];
      const [lo, hi] = EXPs[Math.floor(Math.random() * EXPs.length)];
      const years = lo + Math.floor(Math.random() * (hi - lo + 1));
      const skills = [...hard, '沟通协作', '问题解决', '快速学习'];
      const candidateId = `cand_${ts}_${i}`;
      const now = new Date().toISOString();
      const candidatura = {
        candidateId, source: 'boss', jobId,
        name: `${name}${i % 2 ? '·' + candidateId.slice(-2) : ''}`,
        status: 'parsed', workExperienceYears: years,
        salaryExpected: `${12 + years * 2}~${15 + years * 3}K·14薪`,
        skills, education: { school, major, degree },
        greeted: true, greetedAt: now,
        greetMessage: `您好，我是 BOSS 直聘上 ${recruiterId}，看到您与「${job.jobTitle}」岗位很匹配，方便沟通吗？`,
        startYear: 2026 - years,
        meta: { createdAt: now, masked: true },
      };
      const resume = {
        candidateId, jobId, status: 'parsed',
        rawText: `${name}，${degree}，${school}${major}专业，${years}年经验，擅长${skills.slice(0, 3).join('、')}。`,
        parsed: {
          education: { school, major, degree },
          skills,
          experiences: [{
            duration: `${2026 - years}-至今`,
            company: '某互联网科技公司',
            role: job.jobTitle || '工程师',
            highlights: [`参与 ${job.jobTitle || ''} 方向的核心研发与交付`],
          }],
        },
        meta: { engine: 'llm', createdAt: now },
      };
      const coverage = Math.min(92, 58 + Math.floor(Math.random() * 32));
      const match = {
        candidateId, jobId, matchScore: Math.min(98, 66 + Math.floor(Math.random() * 27)),
        evidence: `硬技能覆盖率 ${coverage}%，经验年限 ${years} 年符合要求`,
        status: 'matched', at: now,
      };
      out.push({ candidate: candidatura, resume, match });
    }
    return out;
  }
}