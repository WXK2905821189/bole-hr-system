// M1 里程碑「自动寻访打招呼」端到端验证：
// ① 定时调度（FR-2）驱动「推荐牛人 + 搜索」两路寻访，全程无人工介入
// ② 命中筛选（画像/JD/关键词，联 FR-5 匹配）→ 匹配达标自动打招呼（FR-6a）
// ③ 两路候选跨路去重，不重复耗打招呼额度
// ④ 全程走风控护栏（每日上限/间隔/冷却），动作留审计
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../framework/server.js';

let app, base, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hr-test-m1-'));
  app = await createApplication({
    storeDir: dir,
    filesDir: dir,
    llm: {},
    engage: { autoGreetThreshold: 20 },          // 离线匹配基础分 ≥20 即自动打招呼
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

test('M1 里程碑·自动寻访打招呼：调度驱动两路寻访 + 命中筛选 + 跨路去重 + 自动打招呼', { timeout: 120000 }, async () => {
  // ================= 准备岗位（含硬技能，供画像命中） =================
  const job = await post('/api/jobs', { jobId: 'job_m1', jdRaw: '招聘 后端工程师：熟练 Python、Go、SQL，负责核心服务开发。', jobTitle: '后端工程师' });
  assert.equal(job.status, 201);

  // ================= ① 定时调度（FR-2）驱动 M1 主链路 =================
  // enabled:true + 超大 interval（_arm 上限 6h）→ 测试内不会自动到点，仅由 runNow 显式驱动
  const schRes = await post('/api/sourcing/schedules', { jobId: 'job_m1', keyword: 'Python', intervalMinutes: 60000, enabled: true });
  assert.equal(schRes.status, 201, '创建定时任务成功');
  const sch = await schRes.json();

  // ================= ② 直供两路候选（推荐牛人 + 搜索）；含一件「两路重复」验证跨路去重 =================
  const recList = [
    { name: 'M1推荐甲', years: 6, skills: ['Python', 'Go', 'SQL'], phone: '13800000001', rawText: 'M1推荐甲 6年经验 擅长 Python、Go、SQL' },
    { name: 'M1推荐乙', years: 4, skills: ['Python'], phone: '13800000002', rawText: 'M1推荐乙 4年经验 擅长 Python' },
  ];
  const srhList = [
    // 与 recList 中「M1推荐甲」同名同电话 → 应被跨路去重
    { name: 'M1推荐甲', years: 6, skills: ['Python', 'Go', 'SQL'], phone: '13800000001', rawText: '搜索命中 M1推荐甲' },
    { name: 'M1搜索丙', years: 5, skills: ['Python', 'SQL'], phone: '13800000003', rawText: 'M1搜索丙 5年经验 擅长 Python、SQL' },
  ];
  const auto = await (await post('/api/sourcing/auto-source', { jobId: 'job_m1', candidates: { recommend: recList, search: srhList } })).json();
  assert.equal(auto.ok, true, 'auto-source 触发成功');
  assert.equal(auto.hit.recommend, 2, '推荐牛人两件均命中');
  assert.equal(auto.hit.search, 2, '搜索两件均命中');
  await sleep(400); // 等事件链：解析→匹配→自动打招呼

  // ================= ③ 两路注入 + 来源标记 + 自动打招呼（联 FR-5 匹配、FR-6a 打招呼） =================
  const cands = (await get('/candidates')).candidates.filter((c) => auto.candidateIds.includes(c.candidateId));
  assert.equal(cands.length, 3, '注入 3 位（推荐2 + 搜索1，重复的1位去重）');
  assert.equal(cands.filter((c) => c.source === 'boss_recommend').length, 2, '推荐牛人来源标记 boss_recommend');
  assert.equal(cands.filter((c) => c.source === 'boss').length, 1, '搜索结果来源标记 boss');
  // 匹配达标 → 自动打招呼（无需人工介入）
  assert.ok(cands.every((c) => c.greetedAt), '寻访送达即自动打招呼（全程无人工介入）');
  assert.ok(cands.every((c) => c.touchStatus === 'engaging' || c.touchStatus === 'replied'), '进入触达状态机');

  // 触达契约留痕
  const engagements = (await get('/api/engagements')).engagements;
  const greetIds = engagements.filter((e) => e.action === 'greet').map((e) => e.candidateId);
  assert.equal(greetIds.filter((id) => auto.candidateIds.includes(id)).length, 3, '每位寻访候选均产生 greet 触达');
  assert.ok(engagements.some((e) => e.action === 'exchange_contact'), '缺联系方式自动发起交换（FR-3 联动）');

  // 审计留痕（enabled:true 的调度创建即 _arm 触发一次，故 ≥2：手动调用 + 调度即时运行）
  const audit = (await get('/api/audit?n=300')).audit;
  assert.ok(audit.filter((a) => a.action === 'sourcing.auto_source').length >= 2, 'M1 执行写审计');
  assert.ok(audit.some((a) => a.action === 'sourcing.greet'), '自动打招呼写审计');

  // ================= ④验证「调度驱动」走 M1 主链路 =================
  // 定时任务创建即 _arm 触发一次（.runNow 受全局 min-gap 节流会推迟，故以该次驱动的产物/审计为准）
  const runNow = await post('/api/sourcing/schedules/control', { scheduleId: sch.scheduleId, action: 'runNow' });
  assert.equal(runNow.status, 200, '调度器 runNow 触发');
  const schedAudit = (await get('/api/audit?n=600')).audit;
  assert.ok(schedAudit.some((a) => a.action === 'schedule.tick' && a.detail?.jobId === 'job_m1'), '调度器 tick 驱动 job_m1');
  assert.ok(schedAudit.some((a) => a.action === 'sourcing.auto_source' && a.detail?.jobId === 'job_m1'), '调度的 M1 执行写审计');
  // 调度路注入的两路模拟候选：推荐牛人路 > 手动注入的 2 件、搜索路 > 手动注入的 1 件
  const allCands = (await get('/candidates')).candidates;
  assert.ok(allCands.filter((c) => c.source === 'boss_recommend' && c.jobId === 'job_m1').length > 2, '调度寻访注入推荐牛人路新候选');
  assert.ok(allCands.filter((c) => c.source === 'boss' && c.jobId === 'job_m1').length > 1, '调度寻访注入搜索路新候选');

  // ================= ⑤ 再次执行 → 跨路去重生效、不重复耗打招呼额度 =================
  const greetsBefore = (await get('/api/engagements')).engagements.filter((e) => e.action === 'greet').length;
  const auto2 = await (await post('/api/sourcing/auto-source', { jobId: 'job_m1', candidates: { recommend: recList, search: srhList } })).json();
  assert.equal(auto2.injected.length, 0, '两路候选全部去重（含跨路重复的1件+已有3件）');
  const greetsAfter = (await get('/api/engagements')).engagements.filter((e) => e.action === 'greet').length;
  assert.equal(greetsAfter, greetsBefore, '去重后不重复耗打招呼额度');

  // ================= 订阅：调度器仍完好（既有调度不受影响） =================
  assert.ok((await get('/api/engage/followup')).plans, '跟进引擎仍在运行');
});