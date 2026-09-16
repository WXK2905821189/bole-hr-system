// M1–M3 完整流水线端到端验证：一次执行串起「寻访打招呼 → 自动收简历 → 智能跟进」，全程受护栏、无需人工介入。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../framework/server.js';

let app, base, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hr-test-pipe-'));
  app = await createApplication({
    storeDir: dir,
    filesDir: dir,
    llm: {},
    engage: { autoGreetThreshold: 20, dailyFollowUpIntervalDays: 30, weeklyFollowUpIntervalDays: 30, sleepAfterDays: 90 },
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

test('M1–M3 完整流水线：一次调用串起寻访打招呼→自动收简历→智能跟进（含隔离与审计）', { timeout: 120000 }, async () => {
  await post('/api/jobs', { jobId: 'job_pipe', jdRaw: '招聘 后端工程师：熟练 Python、Go、SQL。', jobTitle: '后端工程师' });

  // ============ 一次流水线：M1 两路寻访注入+自动打招呼 → M2 入站收简历 → M3 跟进扫描 ============
  const core = 'cand_rec_流甲', fail = 'cand_rec_流乙', unk = 'cand_rec_流丙';
  const r = await (await post('/api/sourcing/run-pipeline', {
    jobId: 'job_pipe',
    candidates: {
      recommend: [
        { name: '流甲', years: 5, skills: ['Python', 'Go', 'SQL'], rawText: '流甲 5年经验 擅长 Python、Go、SQL' },
        { name: '流乙', years: 4, skills: ['Python'], rawText: '流乙 4年经验 擅长 Python' },
      ],
      search: [{ name: '流丙', years: 6, skills: ['Python', 'Go'], rawText: '流丙 6年经验 擅长 Python、Go，电话 13800000111' }],
    },
    inbounds: [
      { candidateId: core, rawText: '流甲，5年经验，擅长 Python、Go、SQL，硕士。', channel: 'boss_chat' },
      { candidateId: fail, rawText: '流乙，4年经验，擅长 Python。', fail: true, channel: 'boss_chat' },
      { candidateId: unk, rawText: '不存在的候选人', channel: 'boss_chat' },
      { candidateId: core, rawText: '流甲 重复投递', channel: 'boss_chat' },
    ],
  })).json();

  assert.equal(r.ok, true, '流水线执行成功');

  // ① M1 寻访打招呼：两路注入 3 件（推荐2 + 搜索1），送达即自动打招呼
  assert.equal(r.sourcing.ok, true, 'M1 段成功');
  assert.equal(r.sourcing.injected.length, 3, 'M1 注入 3 位（推荐2 + 搜索1）');

  // ② M2 自动收简历：一律自动同意（流甲、流丙）+ 失败隔离（流乙）+ 未注册 notFound + 重复幂等
  assert.equal(r.intake.ok, true, 'M2 段成功');
  assert.equal(r.intake.received.length, 2, 'M2 自动同意收取 2 位（流甲、流丙）');
  assert.equal(r.intake.received.includes(core) && r.intake.received.includes(unk), true, '应收两位均已收取');
  assert.equal(r.intake.manualPending.includes(fail), true, '交付失败隔离(流乙)，不拖垮整轮');
  assert.equal(r.intake.notFound.length, 0, '搜索路 流丙 已被 M1 注入，故不存在 notFound');
  assert.equal(r.intake.idempotent.includes(core), true, '重复入站幂等(流甲)');

  // ③ M3 跟进扫描：正常执行（不抛错），给出 sent/slept 汇总
  assert.ok('sent' in r.followup && 'slept' in r.followup, 'M3 段给出跟进扫描汇总');

  await sleep(350); // 事件链：解析→匹配→打招呼/交换落定

  // 结果可查：收取者进入人才库、状态正确；失败者隔离
  const cands = (await get('/candidates')).candidates;
  const cCore = cands.find((c) => c.candidateId === core);
  const cFail = cands.find((c) => c.candidateId === fail);
  const cUnk = cands.find((c) => c.candidateId === unk);
  assert.equal(cCore.status, 'resume_received', '流甲 自动收简历成功');
  assert.equal(cUnk.status, 'resume_received', '流丙 自动收简历成功（M1 先注入、M2 后收取）');
  assert.equal(cFail.status, 'sourced', '流乙 隔离未越权收取');
  assert.equal(cFail.manualPending, true, '流乙 标记需人工');

  // 触达留痕：打招呼 + 流水线审计 + 收简历审计
  const engs = (await get('/api/engagements')).engagements;
  assert.ok(engs.filter((e) => e.action === 'greet' && e.candidateId === core).length >= 1, 'M1 打招呼留痕');
  const audit = (await get('/api/audit?n=500')).audit;
  assert.ok(audit.some((a) => a.action === 'sourcing.pipeline.cycle' && a.detail?.jobId === 'job_pipe'), '流水线写审计');
  assert.ok(audit.some((a) => a.action === 'sourcing.auto_receive' && a.detail?.jobId === 'job_pipe'), '收简历段写审计');
});