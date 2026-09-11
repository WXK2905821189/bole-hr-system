// F 组 · v3.0 细化需求：F-1 自动同意收取 / F-2 交换联系方式 / F-3 打招呼批次 / F-4 提醒+复盘 / F-5 推荐牛人寻访
// 端到端：真实网关 + 事件链（含 GreetCampaign 契约、护栏、审计、导出）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../framework/server.js';

let app, base, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hr-test-f-'));
  app = await createApplication({
    storeDir: dir,
    filesDir: dir,
    llm: {},
    engage: { autoGreetThreshold: 20 },
    safety: { interval_seconds: [0, 0], daily_cap: 100000, touch_daily_cap: 100000, session_cap: 100000, cooldown_minutes: 0 },
  });
  app.start(0);
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  app?.instance?.api?.schedule?.dispose();
  app?.instance?.api?.followup?.dispose();
  await new Promise((resolve) => app.server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const post = (path, body) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
});
const put = (path, body) => fetch(base + path, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
});
const get = (path) => fetch(base + path).then((r) => r.json());
const text = (path) => fetch(base + path).then((r) => r.text());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 注入候选人（触发 解析→匹配→match.score→达标自动打招呼 链路）
async function inject(candidateId, jobId, name, rawText, skills = []) {
  const r = await post('/api/sourcing/candidates', {
    candidateId, source: 'boss', jobId, name, skills,
    resume: { rawText, format: 'text' },
    meta: { createdAt: new Date().toISOString(), masked: true },
  });
  assert.equal(r.status, 201, `注入 ${candidateId} 应成功`);
  await sleep(150);
}

test('F 组·v3.0 细化需求：自动同意收取 / 交换联系方式 / 打招呼批次 / 提醒复盘 / 推荐寻访', { timeout: 120000 }, async () => {
  // ================= 准备两个岗位 =================
  const j1 = await post('/api/jobs', { jobId: 'job_f_01', jdRaw: '招聘 后端工程师：熟练 Python、Go、SQL，负责核心服务开发。', jobTitle: '后端工程师' });
  const j2 = await post('/api/jobs', { jobId: 'job_f_02', jdRaw: '招聘 测试工程师：熟悉 自动化测试、Python。', jobTitle: '测试工程师' });
  assert.equal(j1.status, 201); assert.equal(j2.status, 201);

  // ================= F-2 缺联系方式 → 自动交换（解析联动，附我方联系方式） =================
  await inject('cand_f_ex1', 'job_f_01', '交换候选人甲', '王芳 5年经验 擅长 Python、Go', ['Python', 'Go']);
  const exEngs = (await get('/api/engagements/candidates/cand_f_ex1')).engagements.filter((e) => e.action === 'exchange_contact');
  assert.equal(exEngs.length, 1, '缺联系方式解析后自动发送「交换联系方式」');
  const contact0 = (await get('/api/engage/contact')).contact;
  assert.ok(exEngs[0].content.includes(contact0), '交换话术附默认我方联系方式');
  assert.ok(exEngs[0].messageVersion, '交换话术记录话术版本');
  // 重复触发幂等：不再重复发送
  const again = await post('/api/engage/exchange-contact', { candidateId: 'cand_f_ex1' });
  assert.equal((await again.json()).already, true, '已发送过交换不再重复');

  // 修改我方联系方式 → 新候选人交换话术带新联系方式
  const newContact = 'HR小王 13911112222（BOSS 站内信）';
  assert.equal((await (await put('/api/engage/contact', { contact: newContact })).json()).contact, newContact);
  await inject('cand_f_ex2', 'job_f_01', '交换候选人乙', '赵敏 3年经验 擅长 SQL', ['SQL']);
  const ex2 = (await get('/api/engagements/candidates/cand_f_ex2')).engagements.find((e) => e.action === 'exchange_contact');
  assert.ok(ex2.content.includes(newContact), '更新后交换话术附新我方联系方式');

  // 回复带手机号 → 联系方式回写 Resolve + 审计
  const rep = await post('/api/candidates/cand_f_ex1/reply', { content: '您好，我的电话是 13712345678，随时联系', recruiterId: 'A1' });
  assert.equal(rep.status, 200);
  const repBody = await rep.json();
  assert.equal(repBody.contactResolved, true, '回复含电话触发联系方式回写');
  const resolved = (await get('/candidates')).candidates.find((c) => c.candidateId === 'cand_f_ex1');
  assert.equal(resolved.phone, '13712345678');
  assert.equal(resolved.contactResolved, true);
  const resolveAudit = (await get('/api/audit?n=300')).audit.find((a) => a.action === 'engage.contact.resolve' && a.detail?.candidateId === 'cand_f_ex1');
  assert.ok(resolveAudit, '联系方式回写有审计留痕');

  // ================= F-1 候选人发送简历 → 自动同意收取 =================
  // 准备一个未收取简历的候选人（低匹配不自动打招呼，不影响断言）
  await inject('cand_f_in1', 'job_f_01', '收取候选人甲', '钱七 2年经验 从事行政工作', []);
  // ① 模拟适配层异常 → 转人工待处理
  const fail = await (await post('/api/engage/resume-inbound', { candidateId: 'cand_f_in1', fail: true, rawText: '钱七 2年 简历正文' })).json();
  assert.equal(fail.ok, false);
  assert.equal(fail.manualPending, true, '异常转人工待处理');
  const pending = (await get('/api/engage/manual-pending')).candidates;
  assert.ok(pending.some((c) => c.candidateId === 'cand_f_in1'), '人工待处理清单可见');
  const failAudit = (await get('/api/audit?n=300')).audit.find((a) => a.action === 'sourcing.agree_resume.failed' && a.detail?.candidateId === 'cand_f_in1');
  assert.ok(failAudit, '收取失败有审计留痕');

  // ② 人工重试 → 自动点击同意成功 → 索取成功态 + 触发解析
  const retry = await (await post('/api/engage/manual-pending/cand_f_in1/retry', { rawText: '钱七 2年经验 擅长 Python、Go，电话 13611112233' })).json();
  assert.equal(retry.ok, true, '人工重试自动收取成功');
  assert.equal(retry.resumeReceived, true);
  assert.equal(retry.parsed, true, '收取成功触发解析（联 FR-3）');
  const received = (await get('/candidates')).candidates.find((c) => c.candidateId === 'cand_f_in1');
  assert.equal(received.status, 'resume_received', '进入索取成功态');
  assert.equal(received.manualPending, false, '转人工标记清除');
  const agreeEng = (await get('/api/engagements/candidates/cand_f_in1')).engagements.find((e) => e.action === 'agree_resume');
  assert.ok(agreeEng, '同意收取进入触达契约');
  const agreeAudit = (await get('/api/audit?n=300')).audit.find((a) => a.action === 'sourcing.agree_resume' && a.detail?.candidateId === 'cand_f_in1');
  assert.ok(agreeAudit, '同意收取动作写审计（轮次/时点/对象）');
  assert.ok(agreeAudit.detail.round >= 1);
  // 幂等：重复收取不再重复入库
  const again2 = await (await post('/api/engage/resume-inbound', { candidateId: 'cand_f_in1' })).json();
  assert.equal(again2.already, true, '重复收取幂等');

  // ================= F-3 打招呼批次（职位顺序 + 额度） =================
  // 准备未打招呼候选人：job_f_01 两名、job_f_02 一名。
  // 离线匹配启发式对任何简历都给基础分（35 ≥ 阈值20），注入即被自动打招呼；
  // 与 b-group 直改 store 同法，重置这三人打招呼标记，构造批次可打池。
  await inject('cand_f_c1', 'job_f_01', '批次候选人一', '孙一 1年经验 从事运营', []);
  await inject('cand_f_c2', 'job_f_01', '批次候选人二', '孙二 2年经验 从事运营', []);
  await inject('cand_f_c3', 'job_f_02', '批次候选人三', '孙三 1年经验 从事运营', []);
  const batchIds = ['cand_f_c1', 'cand_f_c2', 'cand_f_c3'];
  app.store.writeAll('candidates.jsonl', app.store.readAll('candidates.jsonl').map((c) =>
    (batchIds.includes(c.candidateId) ? { ...c, greeted: false, greetedAt: null, greetMessage: '' } : c)));

  const created = await (await post('/api/engage/campaigns', {
    mode: 'selected_jobs',
    jobs: [{ jobId: 'job_f_01', quota: 1 }, { jobId: 'job_f_02', quota: 0 }],
  })).json();
  assert.ok(created.campaignId, '批次创建成功');
  assert.equal(created.jobs.length, 2);
  assert.equal(created.jobs[0].quota, 1, '职位额度可自定义');
  // GreetCampaign 走 Schema 入库（greetcampaigns.jsonl 中存在且契约合法——写入即校验）
  const rawCampaigns = app.store.readAll('greetcampaigns.jsonl');
  assert.ok(rawCampaigns.some((c) => c.campaignId === created.campaignId), 'GreetCampaign 契约入库');

  const run = await (await post(`/api/engage/campaigns/${created.campaignId}/control`, { action: 'run' })).json();
  assert.equal(run.ok, true);
  assert.equal(run.finished, true, '批次运行至结束');
  const camp = (await get('/api/engage/campaigns')).campaigns.find((c) => c.campaignId === created.campaignId);
  assert.equal(camp.status, 'finished');
  const job1Entry = camp.jobs.find((j) => j.jobId === 'job_f_01');
  const job2Entry = camp.jobs.find((j) => j.jobId === 'job_f_02');
  assert.equal(job1Entry.greeted, 1, 'job_f_01 到配额 1 即切换');
  assert.equal(job1Entry.state, 'quota_reached', '到额状态');
  assert.equal(job2Entry.greeted, 1, 'job_f_02 遍历完全部可打候选人');
  assert.equal(job2Entry.state, 'exhausted', '遍历完状态');
  // 批次打招呼走护栏与审计
  const c1 = (await get('/candidates')).candidates.find((x) => x.candidateId === 'cand_f_c1');
  const c2 = (await get('/candidates')).candidates.find((x) => x.candidateId === 'cand_f_c2');
  const c3 = (await get('/candidates')).candidates.find((x) => x.candidateId === 'cand_f_c3');
  assert.notEqual(!!c1.greetedAt, !!c2.greetedAt, 'job_f_01 仅打配额内 1 人');
  assert.equal(c3.greetedAt != null, true, 'job_f_02 候选人被打招呼');
  const greetAuditC3 = (await get('/api/audit?n=500')).audit.find((a) => a.action === 'sourcing.greet' && a.detail?.candidateId === 'cand_f_c3');
  assert.ok(greetAuditC3, '批次打招呼写审计');

  // 暂停/恢复控制
  const created2 = await (await post('/api/engage/campaigns', { mode: 'all_jobs', recruiterId: 'A1' })).json();
  assert.equal(created2.mode, 'all_jobs');
  assert.ok(created2.jobs.length >= 2, '全部职位顺序模式覆盖所有 open 岗位');
  const pause = await (await post(`/api/engage/campaigns/${created2.campaignId}/control`, { action: 'pause' })).json();
  assert.equal(pause.ok, true);
  assert.equal(pause.campaign.status, 'paused');
  const runPaused = await (await post(`/api/engage/campaigns/${created2.campaignId}/control`, { action: 'run' })).json();
  assert.equal(runPaused.paused, true, '暂停中 run 不执行');
  const resume = await (await post(`/api/engage/campaigns/${created2.campaignId}/control`, { action: 'resume' })).json();
  assert.equal(resume.ok, true);
  // 既有调度不受影响：调度器与跟进引擎仍在运行
  assert.ok((await get('/api/engage/followup')).plans);

  // ================= F-4 批次结束提醒 + 数据复盘 =================
  const notes = await get('/api/engage/notifications');
  const finNote = notes.notifications.find((n) => n.type === 'campaign_finished' && n.data?.campaignId === created.campaignId);
  assert.ok(finNote, '批次结束触发提醒');
  assert.ok(notes.unread >= 1, '未读提醒计数');
  assert.match(finNote.body, /共打招呼/);

  // 复盘指标（口径 PRD 3.2：打招呼量/已读未读/回复比例/索要交换转化/沉睡数/话术采用）
  const metrics = await get(`/api/engage/metrics?campaignId=${created.campaignId}`);
  assert.ok(metrics.campaign, '复盘含批次进度');
  const m1 = metrics.perJob.find((x) => x.jobId === 'job_f_01');
  const m2 = metrics.perJob.find((x) => x.jobId === 'job_f_02');
  assert.ok(m1 && m2, '各职位指标分列');
  assert.ok(m1.greeted >= 1 && m2.greeted >= 1, '各职位打招呼量');
  assert.ok('readRate' in m1 && 'replyRate' in m1 && 'convertRate' in m1 && 'sleeping' in m1, '已读/回复/转化/沉睡口径');
  assert.ok(m1.templateUsage && Object.keys(m1.templateUsage).length >= 1, '话术采用统计');
  assert.ok(m1.read >= 1, '回复计入已读（cand_f_ex1 已回复）');
  assert.ok(m1.converted >= 1, '联系方式回写计入索要/交换转化');
  assert.ok(metrics.totals.greeted >= 3, '汇总打招呼量');

  // 导出（FR-8 审计留痕）
  const csv = await text(`/export/engage-metrics.csv?campaignId=${created.campaignId}`);
  assert.match(csv, /job_f_01/);
  assert.match(csv, /打招呼量/);
  const exportAudit = (await get('/api/audit?n=300')).audit.find((a) => a.action === 'export.metrics');
  assert.ok(exportAudit, '复盘导出有审计留痕');

  // 标记已读
  const markAll = await (await post('/api/engage/notifications/read', { id: 'all' })).json();
  assert.ok(markAll.ok);
  assert.equal((await get('/api/engage/notifications')).unread, 0);

  // ================= F-5 推荐牛人列表寻访（扩展 B-2 + 去重） =================
  const recList = [
    { name: '推荐牛人甲', years: 6, skills: ['Python', 'Go', 'SQL'], rawText: '推荐牛人甲 6年经验 擅长 Python、Go、SQL' },
    { name: '推荐牛人乙', years: 4, skills: ['Python'], rawText: '推荐牛人乙 4年经验 擅长 Python' },
  ];
  const rec1 = await (await post('/api/sourcing/recommend', { jobId: 'job_f_01', candidates: recList })).json();
  assert.equal(rec1.ok, true);
  assert.equal(rec1.fetched, 2);
  assert.equal(rec1.injected.length, 2, '推荐牛人命中后注入');
  await sleep(250);
  const recCands = (await get('/candidates')).candidates.filter((c) => rec1.injected.includes(c.candidateId));
  assert.equal(recCands.length, 2);
  assert.ok(recCands.every((c) => c.source === 'boss_recommend'), '来源标记 boss_recommend');
  assert.ok(recCands.every((c) => c.greetedAt), '推荐牛人进入打招呼流程（匹配达标自动打招呼）');

  // 去重：同列表再次寻访 → 全部去重、不重复耗额度
  const greetsBefore = (await get('/api/engagements')).engagements.filter((e) => e.action === 'greet').length;
  const rec2 = await (await post('/api/sourcing/recommend', { jobId: 'job_f_01', candidates: recList })).json();
  assert.equal(rec2.deduped, 2, '与既有候选人去重生效');
  assert.equal(rec2.injected.length, 0);
  const greetsAfter = (await get('/api/engagements')).engagements.filter((e) => e.action === 'greet').length;
  assert.equal(greetsAfter, greetsBefore, '去重后不重复耗打招呼额度');
  const recAudit = (await get('/api/audit?n=500')).audit.find((a) => a.action === 'sourcing.recommend');
  assert.ok(recAudit, '推荐寻访写审计');

  // 模拟推荐路径（无直供列表）
  const rec3 = await (await post('/api/sourcing/recommend', { jobId: 'job_f_02', count: 2 })).json();
  assert.equal(rec3.ok, true);
  assert.equal(rec3.fetched, 2, '模拟推荐牛人列表可寻访');
});
