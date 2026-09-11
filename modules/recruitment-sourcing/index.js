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
import { FileVault } from '../../infra/files/vault.js';
import { OriginalStore } from '../../infra/files/originals.js';
import { SourcingListeners } from './listeners/sourcingListeners.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const manifest = JSON.parse(readFileSync(join(__dirname, 'manifest.json'), 'utf8'));

// 组装模块实例：构造业务服务链（LLM → JD/解析/匹配）+ 事件分发供框架内核挂载
export async function loadModule(deps) {
  const llmConfig = deps.config?.llm ?? {};
  const llm = new LLMClient(llmConfig);
  // 简历原文加密（合规红线），filesDir 沿用框架配置
  const vault = new FileVault(deps.config?.filesDir ?? 'infra/files', deps.config?.vaultKey ?? process.env.HR_VAULT_KEY ?? null);
  const originals = new OriginalStore(deps.config?.filesDir ?? 'infra/files');
  const store = deps.store;
  const services = {
    jd: new JdService({ llm, validate: deps.validate, store }),
    parser: new ParserService({ llm, validate: deps.validate, store, bus: deps.bus, vault }),
    matcher: new MatcherService({ llm, validate: deps.validate, store }),
    engagement: new EngagementService({ store, validate: deps.validate, audit: deps.audit, config: deps.config }),
    guardrail: new GuardrailService({ store, audit: deps.audit, config: deps.config }),
    messagelib: new MessageLibraryService({ store, validate: deps.validate, audit: deps.audit, config: deps.config }),
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
    run: async (s) => {
      const job = store.readAll('jobs.jsonl').find((j) => j.jobId === s.jobId) ?? null;
      return domain.runSourcingCycle(s.jobId, job?.jdRaw ?? '', s.keyword || job?.jobTitle || s.jobId, job?.recruiterId || s.recruiterId || 'A1');
    },
  });

  // 人才库检索：按 岗位/关键词/技能/学历 过滤，返回候选 + 解析 + 匹配分
  function searchCandidates({ jobId = '', keyword = '', skill = '', education = '', limit = 50 } = {}) {
    const resumes = store.readAll('resumes.jsonl');
    const matches = store.readAll('matches.jsonl');
    let rows = store.readAll('candidates.jsonl').map((c) => {
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
    return { found: true, text: r.storageRef ? vault.get(r.storageRef) : r.rawText ?? null };
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
        create: (p) => services.messagelib.create(p),
        activate: (templateId) => services.messagelib.activate(templateId),
        setToPreset: (tier) => services.messagelib.setToPreset(tier),
      },
      // B-2 自动打招呼：匹配达标 → 用当前生效「初次」话术发送（受护栏）
      autoGreet: (opts) => domain.autoGreetQualified(opts),
      // B-3 跟进重发 / 标记沉睡（供网关/前端/引擎调用）
      sendFollowUp: (candidateId, recruiterId, round) => domain.sendFollowUp(candidateId, recruiterId ?? 'A1', round),
      markSleeping: (candidateId) => domain.markSleeping(candidateId),
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