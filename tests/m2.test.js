// M2 里程碑「自动收简历」端到端验证（PRD 3.3 / 6.3 / 6.4）：
// ① 一律自动同意、无遗漏：批量入站事件对每位候选人自动点「同意」收取（无人工确认门槛）
// ② 收取后状态可查、自动进入解析入库：标记 resume_received → 解析 → 缺电话自动交换联系方式 → 入库可检索
// ③ 失败自动隔离、不拖垮整轮：单条失败/异常仅转该人「需人工」，其余候选人正常处理
// ④ 重复入站幂等：已收则 already，不重复解析/耗动作
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../framework/server.js';

let app, base, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hr-test-m2-'));
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
const get = (path) => fetch(base + path).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('M2 里程碑·自动收简历：一律自动同意 → 解析入库 → 缺电话交换 → 失败隔离不拖垮整轮', { timeout: 120000 }, async () => {
  // ================= 准备岗位 + 注入候选（经 M1 寻访、处于 sourced 待索取） =================
  const job = await post('/api/jobs', { jobId: 'job_m2', jdRaw: '招聘 后端工程师：熟练 Python、Go、SQL，负责核心服务开发。', jobTitle: '后端工程师' });
  assert.equal(job.status, 201);

  const auto = await (await post('/api/sourcing/auto-source', {
    jobId: 'job_m2',
    candidates: {
      recommend: [
        { name: 'M2甲', years: 5, skills: ['Python', 'Go', 'SQL'], rawText: 'M2甲 5年经验 擅长 Python、Go、SQL' },   // 缺电话 → 应收+交换
        { name: 'M2乙', years: 4, skills: ['Python'], rawText: 'M2乙 4年经验 擅长 Python' },                       // 本轮收简历交付失败
        { name: 'M2丙', years: 3, skills: ['Python', 'Go'], rawText: 'M2丙 3年经验 擅长 Python、Go' },             // 应收（有电话）
      ],
      search: [],
    },
  })).json();
  assert.equal(auto.ok, true, 'M1 寻访注入候选成功');
  await sleep(300); // 事件链：注入→解析→匹配→自动打招呼落定

  const cidA = 'cand_rec_M2甲', cidB = 'cand_rec_M2乙', cidC = 'cand_rec_M2丙';
  const cands0 = (await get('/candidates')).candidates;
  assert.equal(cands0.filter((c) => [cidA, cidB, cidC].includes(c.candidateId) && c.status === 'sourced').length, 3, '三件候选处于待收取(sourced)');

  // ================= ①/②/③/④ 批量入站：自动同意 + 解析入库 + 缺电话交换 + 失败隔离 + 幂等 =================
  const inbounds = [
    { candidateId: cidA, rawText: 'M2甲，5年经验，擅长 Python、Go、SQL，上海交通大学计算机硕士，负责核心服务开发。', channel: 'boss_chat' },
    { candidateId: cidB, rawText: 'M2乙，4年经验，擅长 Python、SQL。', fail: true, channel: 'boss_chat' }, // 交付失败 → 隔离
    { candidateId: cidC, rawText: 'M2丙，3年经验，擅长 Python、Go，电话 13800000088。', channel: 'boss_chat' }, // 有电话 → 不交换
    { candidateId: 'cand_ghost', rawText: '不存在的候选人', channel: 'boss_chat' }, // 未注册 → notFound
    { candidateId: cidA, rawText: 'M2甲 重复投递', channel: 'boss_chat' }, // 已收 → 幂等
  ];
  const r = await (await post('/api/sourcing/auto-receive', { jobId: 'job_m2', inbounds })).json();
  assert.equal(r.ok, true, 'M2 批量自动收简历触发成功');
  assert.equal(r.received.includes(cidA), true, 'M2甲 自动同意收取成功');
  assert.equal(r.received.includes(cidC), true, 'M2丙 自动同意收取成功');
  assert.equal(r.received.length, 2, '本轮下层 2 件');
  assert.equal(r.manualPending.includes(cidB), true, 'M2乙 交付失败转需人工（隔离）');
  assert.equal(r.notFound.includes('cand_ghost'), true, '未注册候选人计入 notFound，不中断');
  assert.equal(r.idempotent.includes(cidA), true, 'M2甲 重复入站幂等（already）');
  assert.equal(r.blocked.length, 0, '护栏余量充足，无拦截');

  await sleep(400); // 事件链：解析→匹配→缺电话自动交换联系方式落定

  // ================= ② 收取后状态可查：resume_received + 渠道/时间；进入解析入库 =================
  const cands = (await get('/candidates')).candidates;
  const a = cands.find((c) => c.candidateId === cidA);
  const b = cands.find((c) => c.candidateId === cidB);
  const c = cands.find((c) => c.candidateId === cidC);
  assert.equal(a.status, 'resume_received', 'M2甲 收简历状态可查');
  assert.equal(a.resumeChannel, 'boss_chat', '收取渠道登记');
  assert.ok(a.resumeReceivedAt, '收取时间登记');
  assert.equal(c.status, 'resume_received', 'M2丙 收简历状态可查');

  // ③ 失败隔离：M2乙 仍 sourced + 转需人工，未拖垮同轮 M2甲/丙
  assert.equal(b.status, 'sourced', 'M2乙 未越权收取（保持待索取）');
  assert.equal(b.manualPending, true, 'M2乙 标记需人工');
  assert.ok(b.manualReason && b.manualReason.includes('失败'), 'M2乙 隔离原因留痕');
  const pending = (await get('/api/engage/manual-pending')).candidates;
  assert.ok(pending.some((p) => p.candidateId === cidB), 'M2乙 进入需人工待处理清单');

  // 自动进入解析入库：人才库检索（status≠sourced）可查到 M2甲/丙，且简历已结构化
  const talent = (await get('/api/candidates/search?jobId=job_m2')).candidates;
  const ta = talent.find((x) => x.candidateId === cidA);
  const tc = talent.find((x) => x.candidateId === cidC);
  assert.ok(ta && tc, 'M2甲/丙 自动解析入库、可检索');
  assert.ok((ta.skills ?? []).concat(ta.resumeParsed?.skills ?? []).some((s) => s.toLowerCase().includes('python')), 'M2甲 简历结构化技能入库');

  // ④ 幂等：M2甲 已收无重复解析（sourced 期解析 1 次 + 入站解析 1 次 = 2 次，重复入站不再加）
  const resumes = (await get('/resumes')).resumes.filter((x) => x.candidateId === cidA);
  assert.equal(resumes.length, 2, 'M2甲 解析恰 2 次（寻访1 + 入站1），重复入站幂等未再解析');

  // ② 缺电话自动交换联系方式（联 FR-3）+ 幂等：
// 三件候选在 M1 寻访期解析时均无电话 → 各发起 1 次交换（故三件均恰为 1）。
// 入站层再校验幂等与「带电话不重复」：
//   · M2甲 入站仍缺电话→重复触发交换→幂等，不新增（仍 1）
//   · M2丙 入站带电话→解析命中电话→不重复交换（仍 1，未变 2）
//   · M2乙 入站交付失败→未收取、未入站解析（仍为寻访期 1 次）
  const engagements = (await get('/api/engagements')).engagements;
  const exch = (id) => engagements.filter((e) => e.action === 'exchange_contact' && e.candidateId === id).length;
  assert.equal(exch(cidA), 1, 'M2甲 缺电话自动交换（重复触发幂等，不重复耗动作）');
  assert.equal(exch(cidC), 1, 'M2丙 入站带电话→解析命中电话，不重复交换');
  assert.equal(exch(cidB), 1, 'M2乙 未收取故不进入入站交换（仅存寻访期 1 次）');

  // 审计留痕
  const audit = (await get('/api/audit?n=400')).audit;
  assert.ok(audit.some((x) => x.action === 'sourcing.auto_receive' && x.detail?.jobId === 'job_m2'), 'M2 批量执行写审计');
  assert.ok(audit.some((x) => x.action === 'sourcing.agree_resume.ok' && x.detail?.candidateId === cidA), 'M2甲 同意收取写审计');
});