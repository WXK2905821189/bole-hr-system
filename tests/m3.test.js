// M3 里程碑「打招呼后智能跟进」端到端验证（PRD 3.4 / 6.6A / 6.3）：
// 节奏与停止条件（未读隔1天→累计≥5次降周频→满1月沉睡）已由 b-group-unit.test 覆盖；
// 本测试聚焦 M3 验收的新能力：
// ② 沉睡 = 标记保留、人工可唤醒、不删除
// ③ 回复联动及时：沉睡者一旦回复 → 自动唤醒 + 即时跟进（缺电话自动交换）
// ④ 触达全程留痕可审计（engage.sleep / engage.wake）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../framework/server.js';

let app, base, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hr-test-m3-'));
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

test('M3 里程碑·智能跟进：沉睡标记保留可唤醒不删除 · 回复即醒并联动 · 全程审计', { timeout: 120000 }, async () => {
  // ============ 准备岗位 + 经 M1 寻访注入候选人（已完成打招呼、缺电话） ============
  await post('/api/jobs', { jobId: 'job_m3', jdRaw: '招聘 后端工程师：熟练 Python、Go、SQL。', jobTitle: '后端工程师' });
  const auto = await (await post('/api/sourcing/auto-source', {
    jobId: 'job_m3',
    candidates: { recommend: [{ name: 'M3甲', years: 5, skills: ['Python', 'Go', 'SQL'], rawText: 'M3甲 5年经验 擅长 Python、Go、SQL' }], search: [] },
  })).json();
  assert.equal(auto.ok, true, 'M1 寻访注入候选成功');
  await sleep(300);

  const cid = 'cand_rec_M3甲';
  const cand0 = (await get('/candidates')).candidates.find((c) => c.candidateId === cid);
  assert.equal(cand0.touchStatus, 'engaging', '注入后处于跟进中（已打招呼）');
  assert.equal(cand0.sleeping, undefined, '初始非沉睡');

  // ============ ② 标记沉睡：标记保留、数据不删除 ============
  const ms = await (await post('/api/engage/mark-sleep', { candidateId: cid })).json();
  assert.equal(ms.ok, true, '标记沉睡成功');
  let cand = (await get('/candidates')).candidates.find((c) => c.candidateId === cid);
  assert.ok(cand, '沉睡后候选人仍在库（不删除）');
  assert.equal(cand.sleeping, true, '沉睡标记保留');
  assert.equal(cand.touchStatus, 'sleeping', '触达状态置沉睡');
  assert.ok(cand.sleepingAt, '沉睡时间登记');

  // ④ 沉睡审计留痕
  let audit = (await get('/api/audit?n=300')).audit;
  assert.ok(audit.some((a) => a.action === 'engage.sleep' && a.detail?.candidateId === cid), '沉睡写审计');

  // ============ ② 人工唤醒：恢复跟进、标记清除、可再次查询 ============
  const wk = await (await post('/api/engage/wake', { candidateId: cid })).json();
  assert.equal(wk.ok, true, '人工唤醒成功');
  cand = (await get('/candidates')).candidates.find((c) => c.candidateId === cid);
  assert.equal(cand.sleeping, false, '唤醒后清除沉睡标记');
  assert.equal(cand.touchStatus, 'engaging', '唤醒后恢复跟进中');
  assert.equal(cand.sleepingAt, null, '沉睡时间清空');

  // 幂等：非沉睡候选人再次唤醒返回 already
  const wk2 = await (await post('/api/engage/wake', { candidateId: cid })).json();
  assert.equal(wk2.ok, true, '重复唤醒不报错');
  assert.equal(wk2.already, true, '非沉睡者唤醒幂等返回 already');

  audit = (await get('/api/audit?n=300')).audit;
  assert.ok(audit.some((a) => a.action === 'engage.wake' && a.detail?.candidateId === cid && a.detail?.manual === true), '人工唤醒写审计');

  // ============ ③ 沉睡者回复 → 自动唤醒 + 即时联动（缺电话自动交换联系方式） ============
  await post('/api/engage/mark-sleep', { candidateId: cid }); // 再次沉睡（标记保留）
  const reply = await (await post(`/api/candidates/${cid}/reply`, { content: '可以聊聊，薪资范围是？' })).json();
  assert.equal(reply.ok, true, '沉睡者回复处理成功');
  cand = (await get('/candidates')).candidates.find((c) => c.candidateId === cid);
  assert.equal(cand.touchStatus, 'replied', '回复联动：清醒状态置已回复（唤醒而非沉睡）');
  assert.equal(cand.sleeping, false, '沉睡者回复即自动唤醒（清理粘滞标记）');

  await sleep(300); // 联动触达落定
  const engs = (await get(`/api/engagements/candidates/${cid}`)).engagements;
  assert.ok(engs.some((e) => e.action === 'reply'), '回复触达已入库');
  assert.ok(engs.some((e) => e.action === 'exchange_contact'), '回复后缺电话自动发起交换联系方式（立即联动）');

  // ④ 唤醒/回复联动全程留痕
  audit = (await get('/api/audit?n=300')).audit;
  assert.ok(audit.filter((a) => a.action === 'engage.sleep' && a.detail?.candidateId === cid).length >= 2, '沉睡两次均留痕');
  assert.ok(audit.filter((a) => a.action === 'engage.wake' && a.detail?.candidateId === cid).length >= 1, '唤醒留痕');
  assert.ok(engs.filter((e) => e.action === 'reply').length >= 1, '回复留痕');
});