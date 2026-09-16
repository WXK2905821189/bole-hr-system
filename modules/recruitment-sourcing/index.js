import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourcingDomain } from './domain/SourcingDomain.js';
import { LLMClient } from './services/llm.js';
import { JdService } from './services/jd.js';
import { ParserService } from './services/parser.js';
import { MatcherService } from './services/matcher.js';
import { EngagementService } from './services/engagement.js';
import { GuardrailService } from './services/guardrail.js';
import { SchedulingService } from './services/scheduler.js';
import { MessageLibraryService } from './services/messagelib.js';
import { FollowUpEngine } from './services/followup.js';
import { GreetCampaignService } from './services/greetcampaign.js';
import { NotificationService } from './services/notify.js';
import { AiBaseService } from './services/aiBase.js';
import { MatchingRulesService } from './services/rules.js';
import { OverallAbilityService } from './services/overall.js';
import { FileVault } from '../../infra/files/vault.js';
import { OriginalStore } from '../../infra/files/originals.js';
import { SourcingListeners } from './listeners/sourcingListeners.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const manifest = JSON.parse(readFileSync(join(__dirname, 'manifest.json'), 'utf8'));

// 组装模块实例：构造业务服务链（LLM → JD/解析/匹配）+ 事件分发供框架内核挂载
export async function loadModule(deps) {
  const llmConfig = deps.config?.llm ?? {};
  const llm = new LLMClient(llmConfig);
  // M4 · AI 基座：以设置页(持久化)/环境变量/启动配置 解析并应用倒共享 LLM 实例；jd/parser/matcher 均经此基座
  const aiBase = new AiBaseService({ store: deps.store, audit: deps.audit, llm, configLlm: llmConfig });
  aiBase.sync();
  const rules = new MatchingRulesService({ store: deps.store, audit: deps.audit });
  // 简历原文加密（合规红线），filesDir 沿用框架配置
  const vault = new FileVault(deps.config?.filesDir ?? 'infra/files', deps.config?.vaultKey ?? process.env.HR_VAULT_KEY ?? null);
  const originals = new OriginalStore(deps.config?.filesDir ?? 'infra/files');
  const store = deps.store;
  const services = {
    jd: new JdService({ llm, validate: deps.validate, store }),
    parser: new ParserService({ llm, validate: deps.validate, store, bus: deps.bus, vault }),
    matcher: new MatcherService({ llm, validate: deps.validate, store, rules }),
    overall: new OverallAbilityService({ llm, rules }),
    engagement: new EngagementService({ store, validate: deps.validate, audit: deps.audit, config: deps.config }),
    guardrail: new GuardrailService({ store, audit: deps.audit, config: deps.config }),
    messagelib: new MessageLibraryService({ store, validate: deps.validate, audit: deps.audit, config: deps.config }),
    rules,
  };
  const domain = new SourcingDomain({ ...deps, services });
  const followup = new FollowUpEngine({ store, audit: deps.audit, domain, messagelib: services.messagelib, config: deps.config });
  services.followup = followup;
  const notify = new NotificationService({ store, audit: deps.audit });
  services.notify = notify;
  const greetcampaign = new GreetCampaignService({ store, validate: deps.validate, audit: deps.audit, bus: deps.bus, domain, config: deps.config });
  services.greetcampaign = greetcampaign;
  const listeners = new SourcingListeners({ services, domain, bus: deps.bus });
  services.store = store;

  const scheduler = new SchedulingService({
    store,
    audit: deps.audit,
    minGapMinutes: deps.config?.scheduleMinGapMinutes ?? 1,
    // M1–M3 完整流水线：定时批量完成任务生命周期（寻访打招呼 → 自动收简历 → 智能跟进），全程受护栏无人工介入。
    run: async (s) => {
      const job = store.readAll('jobs.jsonl').find((j) => j.jobId === s.jobId) ?? null;
      return domain.runAutoPipeline(s.jobId, {
        count: s.count ?? 3,
        inbounds: Array.isArray(s.inbounds) ? s.inbounds : [],
        keyword: s.keyword || job?.jobTitle || s.jobId,
        recruiterId: job?.recruiterId || s.recruiterId || 'A1',
      });
    },
  });

  // 人才库检索：按 岗位/关键词/技能/学历 过滤，返回候选 + 解析 + 匹配分
  // 口径与前端候选人库/人才库一致：仅「已收到简历」（status ≠ sourced）的候选人可检索
  function searchCandidates({ jobId = '', keyword = '', skill = '', education = '', limit = 50 } = {}) {
    const resumes = store.readAll('resumes.jsonl');
    const matches = store.readAll('matches.jsonl');
    let rows = store.readAll('candidates.jsonl')
      .filter((c) => c.status && c.status !== 'sourced')
      .map((c) => {
      const r = resumes.filter((x) => x.candidateId === c.candidateId).at(-1) ?? null;
      const m = matches.filter((x) => x.candidateId === c.candidateId).at(-1) ?? null;
      return { ...c, resumeParsed: r?.parsed ?? null, storageRef: r?.storageRef ?? null, resumeRawPreview: r?.rawText ?? null, matchScore: m?.matchScore ?? null };
    });
    if (jobId) rows = rows.filter((x) => x.jobId === jobId);
    if (keyword) {
      const k = keyword.toLowerCase();
      rows = rows.filter((x) => `${x.name ?? ''} ${x.candidateId ?? ''} ${x.salaryExpected ?? ''}`.toLowerCase().includes(k));
    }
    if (skill) {
      const s = skill.toLowerCase();
      rows = rows.filter((x) => (x.skills ?? []).concat(x.resumeParsed?.skills ?? []).some((v) => String(v).toLowerCase().includes(s)));
    }
    if (education) {
      const e = education.toLowerCase();
      rows = rows.filter((x) => {
        const edu = x.education ?? x.resumeParsed?.education ?? {};
        return `${edu.school ?? ''} ${edu.degree ?? ''} ${edu.major ?? ''}`.toLowerCase().includes(e);
      });
    }
    return rows.slice(0, Math.max(1, Number(limit) || 50));
  }

  async function getResumeText(candidateId) {
    const r = store.readAll('resumes.jsonl').filter((x) => x.candidateId === candidateId).at(-1) ?? null;
    if (!r) return { found: false, text: null };
    // 新数据：storageRef=null，完整原文在 rawText；旧数据：storageRef 存在，完整原文在 legacy vault、rawText 仅脱敏预览
    let text = null;
    if (r.storageRef) { try { text = vault.get(r.storageRef); } catch { /* 回退 rawText */ } }
    if (!text || !String(text).trim()) text = r.rawText ?? null;
    if (!text || !String(text).trim()) return { found: false, text: null };
    return { found: true, text: String(text) };
  }

  // 原始简历文件（BOSS 要简历得到的 docx/PDF）：查询元数据 / 下载（无真实文件时按解析结果合成）
  function getOriginalInfo(candidateId) {
    return originals.info(candidateId);
  }
  function downloadOriginal(candidateId) {
    const existing = originals.load(candidateId);
    if (existing) return existing;
    const resume = store.readAll('resumes.jsonl').filter((x) => x.candidateId === candidateId).at(-1) ?? null;
    const meta = originals.synthesize(candidateId, resume || null);
    return originals.load(candidateId) ?? { meta, buffer: Buffer.alloc(0) };
  }
  function uploadOriginal(candidateId, { filename, data, mime }) {
    return originals.put(candidateId, filename, data, mime);
  }

  // ---------- C4 · 轨道二总体能力分 + 人工复核池 ----------
  const REVIEW_FILE = 'review.jsonl';
  function greetThreshold() {
    const cfg = rules.get().match?.greetThreshold;
    const t = cfg ?? Number(process.env.HR_ENGAGE_THRESHOLD ?? 60);
    return Number.isFinite(Number(t)) ? Number(t) : 60;
  }
  async function overallScoreFor(candidateId) {
    const resume = store.readAll('resumes.jsonl').filter((x) => x.candidateId === candidateId).at(-1) ?? null;
    if (!resume) return null;
    const { text } = await getResumeText(candidateId);
    return await services.overall.score({ resumeParsed: resume.parsed ?? null, resumeText: text ?? '' });
  }
  // 复核池：开启复核 && 已收简历 && 匹配分<打招呼阈值 && 总体能力分≥复核阈值 && 尚未处理
  async function reviewPoolRows() {
    const o = rules.get().overall ?? {};
    const th = greetThreshold();
    if (!o.enabled) return { enabled: false, threshold: o.reviewThreshold, greetThreshold: th, count: 0, rows: [] };
    const decided = new Map(store.readAll(REVIEW_FILE).map((x) => [x.candidateId, x]));
    const candidates = store.readAll('candidates.jsonl');
    const matches = store.readAll('matches.jsonl');
    const resumes = store.readAll('resumes.jsonl');
    const rows = [];
    for (const c of candidates) {
      if (!c.status || c.status === 'sourced') continue;   // 需「已收简历」
      if (decided.has(c.candidateId)) continue;             // 已处理
      const m = matches.filter((x) => x.candidateId === c.candidateId).at(-1) ?? null;
      const sc = m?.matchScore ?? null;
      if (sc == null || sc >= th) continue;                 // 未打出匹配分 或 已达自动打招呼门槛
      const resume = resumes.filter((x) => x.candidateId === c.candidateId).at(-1) ?? null;
      if (!resume) continue;
      const ov = await services.overall.score({ resumeParsed: resume.parsed ?? null, resumeText: resume.rawText ?? '' });
      if (ov.overallScore >= o.reviewThreshold) {
        rows.push({ candidateId: c.candidateId, jobId: c.jobId, name: c.name ?? '', source: c.source,
          matchScore: sc, overallScore: ov.overallScore, dimensionScores: ov.dimensionScores, evidence: ov.evidence,
          touchStatus: c.touchStatus, createdAt: c.meta?.createdAt ?? c.createdAt });
      }
    }
    rows.sort((a, b) => (b.overallScore - a.overallScore) || (b.matchScore - a.matchScore));
    return { enabled: true, threshold: o.reviewThreshold, greetThreshold: th, count: rows.length, rows };
  }
  // 复核动作：打招呼 / 放弃 / 登记期望岗位；打招呼走统一护栏，不经复核放行
  async function reviewDecide(candidateId, decision, recruiterId) {
    const allowed = new Set(['greet', 'discard', 'expect']);
    if (!allowed.has(decision)) return { ok: false, error: `不支持的复核动作: ${decision}` };
    if (!(rules.get().overall?.enabled)) return { ok: false, error: '人工复核未开启' };
    const cand = store.readAll('candidates.jsonl').find((c) => c.candidateId === candidateId);
    if (!cand) return { ok: false, error: '未找到候选人' };
    const existing = store.readAll(REVIEW_FILE);
    const prev = existing.find((x) => x.candidateId === candidateId);
    if (prev && prev.decision) return { ok: true, already: true, decision: prev.decision, candidate: cand };

    let greet = null;
    if (decision === 'greet') {
      greet = await domain.greetCandidate(candidateId, recruiterId ?? 'A1');
      if (greet?.blocked) return { ok: false, blocked: true, reason: greet.reason, candidate: cand }; // 超频拦截：不消耗复核项，可稍后重试
    }
    const matched = store.readAll('matches.jsonl').filter((x) => x.candidateId === candidateId).at(-1) ?? null;
    const ov = await overallScoreFor(candidateId);
    const rec = {
      candidateId, jobId: cand.jobId, decision,
      matchScore: matched?.matchScore ?? null,
      overallScore: ov?.overallScore ?? null,
      overallDims: ov?.dimensionScores ?? null,
      greeted: decision === 'greet',
      by: recruiterId ?? 'A1', decidedAt: new Date().toISOString(),
    };
    store.writeAll(REVIEW_FILE, existing.filter((x) => x.candidateId !== candidateId).concat([rec]));
    await deps.audit.record({ actor: recruiterId ?? 'A1', action: 'sourcing.review.decide', detail: { candidateId, jobId: cand.jobId, decision, matchScore: rec.matchScore, overallScore: rec.overallScore, blocked: greet?.blocked ?? false } });
    return { ok: true, already: false, decision, candidate: cand, greet };
  }

  const instance = {
    services,
    onEvent: async (evt, { payload }) => {
      if (evt === 'candidate.sourced') return await listeners.onCandidateSourced(evt, { payload });
      if (evt === 'resume.parsed') return await listeners.onResumeParsed(evt, { payload });
      if (evt === 'match.score') return await listeners.onMatchScore(evt, { payload });
      if (evt === 'greet.campaign.finished') return await listeners.onCampaignFinished(evt, { payload });
    },
    api: {
      runSourcingCycle: async (jobId, jdRaw, keyword, recruiterId) => {
        const r = await domain.runSourcingCycle(jobId, jdRaw, keyword, recruiterId);
        if (r.candidates) {
          for (const c of r.candidates) {
            const resume = store.readAll('resumes.jsonl').filter((x) => x.candidateId === c.candidateId).at(-1) ?? null;
            originals.synthesize(c.candidateId, resume || null);
          }
        }
        return r;
      },
      parseJd: (jdRaw, jobId, jobTitle, recruiterId) => services.jd.parse(jdRaw, { jobId, jobTitle, recruiterId }),
      getMatches: () => store.readAll('matches.jsonl'),
      getCandidates: () => store.readAll('candidates.jsonl'),
      getJobs: () => store.readAll('jobs.jsonl'),
      // BOSS 打招呼
      greetJob: (jobId) => {
        const job = store.readAll('jobs.jsonl').find((j) => j.jobId === jobId) ?? null;
        return domain.sendGreeting(jobId, job?.recruiterId || 'A1', job?.jobTitle || jobId);
      },
      greetCandidate: (candidateId) => domain.greetCandidate(candidateId, 'A1'),
      // 索要简历 / 索要电话 / 跟进（受护栏节流 + 触达契约入库）
      touchCandidate: (candidateId, { action = 'request_resume', recruiterId = 'A1' } = {}) => domain.touch(candidateId, recruiterId, action),
      replyCandidate: (candidateId, { content = '', stopFlag = false, recruiterId = 'A1' } = {}) => domain.reply(candidateId, recruiterId, { content, stopFlag }),
      // 触达记录与护栏状态
      engagements: {
        list: (limit) => domain.listEngagements(limit),
        byCandidate: (candidateId) => services.engagement.byCandidate(candidateId),
      },
      guardrail: {
        stats: () => services.guardrail.stats(),
        check: ({ recruiterId = 'A1', action = 'greet' } = {}) => services.guardrail.check({ recruiterId, action }),
      },
      // B-1 话术库：三档（初次/二次激活/三次及以上），多版本保存/切换/换回常用语
      messagelib: {
        list: () => services.messagelib.list(),
        active: (tier) => services.messagelib.activeFor(tier),
        render: (tier, jobTitle, round) => services.messagelib.render(tier, jobTitle, round),
        create: (p) => services.messagelib.create(p),
        activate: (templateId) => services.messagelib.activate(templateId),
        setToPreset: (tier) => services.messagelib.setToPreset(tier),
      },
      // B-2 自动打招呼：匹配达标 → 用当前生效「初次」话术发送（受护栏）
      autoGreet: (opts) => domain.autoGreetQualified(opts),
      // B-3 跟进重发 / 标记沉睡（供网关/前端/引擎调用）
      sendFollowUp: (candidateId, recruiterId, round) => domain.sendFollowUp(candidateId, recruiterId ?? 'A1', round),
      markSleeping: (candidateId) => domain.markSleeping(candidateId),
      // M3 里程碑：人工唤醒沉睡候选人（沉睡标记保留、可唤醒、不删除）
      wakeCandidate: (candidateId) => domain.wakeCandidate(candidateId),
      // B-3 智能跟进引擎：双轨按 1天→≥5周频→满月沉睡 流转
      followup: {
        sweep: (opts) => followup.sweep(opts),
        status: () => followup.status(),
        plan: (candidateId) => followup.planOf(candidateId),
        start: (minutes) => followup.start(minutes),
        dispose: () => followup.dispose(),
      },
      // B-4 触达审计：统一拉取（含操作人/时点/对象/轮次/话术版本/结果）
      auditTrail: (n) => deps.audit.tail(n ?? 50),
      // F-1 候选人发送简历 → 自动同意收取（成功触发解析；异常转人工；审计+护栏）
      resumeInbound: (candidateId, opts) => domain.receiveResumeInbound(candidateId, opts ?? {}),
      retryManualResume: (candidateId, opts) => domain.retryManualResume(candidateId, opts ?? {}),
      manualPending: () => domain.listManualPending(),
      // F-2 缺联系方式自动交换（话术附我方联系方式）；HR 联系方式配置
      exchangeContact: (candidateId, recruiterId) => domain.requestExchangeContact(candidateId, recruiterId),
      hrContact: { get: () => services.messagelib.getHrContact(), set: (v) => services.messagelib.setHrContact(v) },
      // F-3 打招呼批次（GreetCampaign 契约：职位顺序/指定职位 + 各职位额度）
      campaign: {
        list: () => greetcampaign.list(),
        get: (id) => greetcampaign.get(id),
        create: (p) => greetcampaign.create(p ?? {}),
        run: (id) => greetcampaign.run(id),
        control: (id, action) => greetcampaign.control(id, action),
      },
      // F-4 批次结束提醒 + 数据复盘（口径 PRD 3.2，来源 Engagement 与状态记录）
      notifications: {
        list: (limit) => notify.list(limit),
        unread: () => notify.unread(),
        markRead: (id) => notify.markRead(id ?? 'all'),
      },
      metrics: (campaignId) => greetcampaign.metrics(campaignId ?? null),
      // F-5 推荐牛人列表寻访（扩展 B-2；与搜索结果去重）
      recommend: (jobId, opts) => domain.recommendSourcing(jobId, opts ?? {}),
      // M1 里程碑：自动寻访打招呼（推荐牛人 + 搜索两路合一；供调度/网关/前端触发）
      autoSourceAndGreet: (jobId, opts) => domain.autoSourceAndGreet(jobId, opts ?? {}),
      // M2 里程碑：自动收简历（批量入站主链路：一律自动同意 → 解析入库 → 缺电话交换；逐条隔离不拖垮整轮）
      autoReceiveResumes: (jobId, opts) => domain.autoReceiveResumes(jobId, opts ?? {}),
      // M1–M3 完整流水线：一次执行串起「寻访打招呼 → 自动收简历 → 智能跟进」（供调度/网关/一次性触发）
      runAutoPipeline: (jobId, opts) => domain.runAutoPipeline(jobId, opts ?? {}),
      // M4 里程碑：AI 基座改造（接入公司 AI Coding 中转平台：baseURL+Key 两点轻量接入 + /models 自动拉取 + 模型选择）
      ai: {
        status: () => aiBase.status(),
        listModels: () => aiBase.listModels(),
        configure: (cfg, actorId) => aiBase.save(cfg, actorId),
      },
      // 匹配规则（JD 解析 + AI 匹配）：硬性门槛 / 权重 / 打招呼阈值；管理员读写
      rules: {
        get: () => rules.get(),
        status: () => rules.status(),
        save: (over, actorId) => rules.save(over, actorId ?? 'A1'),
      },
      // C4 · 轨道二总体能力分 + 人工复核池
      overall: {
        score: (candidateId) => overallScoreFor(candidateId),
      },
      review: {
        pool: () => reviewPoolRows(),
        decide: (candidateId, decision, recruiterId) => reviewDecide(candidateId, decision, recruiterId),
      },
      // M6 · Python 前置 AI 匹配（在线简历→差距分析打分，高分才打招呼）
      preMatch: async (jobId, resumeText) => {
        const job = store.readAll('jobs.jsonl').find((j) => j.jobId === jobId);
        if (!job) return { ok: false, error: '未找到岗位' };
        if (!String(resumeText ?? '').trim()) return { ok: false, error: '缺少在线简历文本' };
        const jobParsed = {
          hard_skills: job.hardSkills ?? job.parsedKeywords ?? [],
          soft_skills: job.softSkills ?? [],
          core_duties: [],
          keywords: job.parsedKeywords ?? job.hardSkills ?? [],
        };
        let resumeParsed;
        try { resumeParsed = await services.parser.parseRaw(resumeText); }
        catch { return { ok: false, error: '简历解析失败' }; }
        return await services.matcher.preScore({ jobParsed, resumeParsed });
      },
      // 岗位状态管理：关闭 / 重新开放 / 删除（删除时连同定时任务一并清理）
      setJobStatus: (jobId, status) => {
        const jobs = store.readAll('jobs.jsonl');
        const j = jobs.find((x) => x.jobId === jobId);
        if (!j) return { ok: false, error: '未找到岗位' };
        j.status = status;
        store.writeAll('jobs.jsonl', jobs);
        return { ok: true, job: j };
      },
      deleteJob: (jobId) => {
        const jobs = store.readAll('jobs.jsonl');
        const next = jobs.filter((x) => x.jobId !== jobId);
        if (jobs.length === next.length) return { ok: false, error: '未找到岗位' };
        store.writeAll('jobs.jsonl', next);
        const { removed } = scheduler.removeByJob(jobId);
        return { ok: true, removedSchedules: removed };
      },
      // 新增能力
      searchCandidates,
      getResumeText,
      originalFile: { info: getOriginalInfo, download: downloadOriginal, upload: uploadOriginal },
      schedule: {
        list: () => scheduler.list(),
        create: (p) => scheduler.create(p),
        control: (scheduleId, action) => scheduler.control(scheduleId, action),
        start: () => scheduler.start(),
        dispose: () => scheduler.dispose(),
      },
    },
  };
  return { manifest, instance };
}