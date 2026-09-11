// B 组 · 对话/触达模块：B-1 话术库、B-2 自动打招呼、B-3 智能跟进、B-4 触达审计
// 端到端：真实网关 + 事件链（sourcing/candidates → 解析 → 匹配 → match.score → 自动打招呼 → 跟进引擎）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../framework/server.js';

const DAY = 86400000;

let app, base, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hr-test-b-'));
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
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const get = (path) => fetch(base + path).then((r) => r.json());

// 测试工具：回溯候选人触达时间戳（sent）/ 全量时间戳（sent+createdAt）、补种触达记录
// store 与网关共享同一磁盘文件，直接改写即为服务端所见。
function backdateSent(cid, msAgo) {
  const t = new Date(Date.now() - msAgo).toISOString();
  app.store.writeAll('engagements.jsonl', app.store.readAll('engagements.jsonl').map((e) =>
    (e.candidateId === cid ? { ...e, timestamps: { ...(e.timestamps ?? {}), sent: t } } : e)));
}
function backdateAll(cid, msAgo) {
  const t = new Date(Date.now() - msAgo).toISOString();
  app.store.writeAll('engagements.jsonl', app.store.readAll('engagements.jsonl').map((e) =>
    (e.candidateId === cid ? { ...e, meta: { ...(e.meta ?? {}), createdAt: t }, timestamps: { ...(e.timestamps ?? {}), sent: t } } : e)));
}
function seedTouch(cid, msAgo, n = 1) {
  const cand = app.store.readAll('candidates.jsonl').find((c) => c.candidateId === cid);
  const list = app.store.readAll('engagements.jsonl');
  for (let i = 0; i < n; i++) {
    const t = new Date(Date.now() - msAgo - i * 60000).toISOString();
    list.push({
      engagementId: `eng_seed_${Date.now()}_${i}`,
      candidateId: cid, jobId: cand?.jobId ?? '', recruiterId: 'A1', action: 'follow_up',
      touchCount: 0, readStatus: 'unread', messageVersion: 'seed', frequencyMode: 'balanced',
      timestamps: { sent: t }, meta: { createdAt: t, updatedAt: t },
    });
  }
  app.store.writeAll('engagements.jsonl', list);
}

test('B 组·触达：话术库 / 自动打招呼 / 智能跟进 / 触达审计', { timeout: 90000 }, async () => {
  // ================= B-1 打招呼话术库（三档 + F-2 交换档 · 多版本 · 常用语/自定义切换） =================
  const lib0 = (await get('/api/messagelib')).templates;
  assert.equal(lib0.length, 4, '预置三档常用语 + F-2 交换联系方式档');
  const activeTier = {};
  for (const t of lib0) { activeTier[t.tier] = t.templateId; assert.equal(t.source, 'preset'); assert.equal(t.active, true); }
  assert.ok(['first', 'second', 'third', 'exchange'].every((tier) => activeTier[tier]), '四档齐备');

  // 新建「初次」自定义版本并激活 → 生效版本切换为自定义
  const customFirst = await (await post('/api/messagelib', { tier: 'first', source: 'custom', content: '初次自定义@[岗位]，您好！', activate: true })).json();
  assert.ok((await post('/api/messagelib', { tier: 'first', content: '' })).status === 400, '空话术被契约/业务拒绝');
  const libAfterCustom = (await get('/api/messagelib')).templates.filter((t) => t.tier === 'first');
  assert.ok(libAfterCustom.some((t) => t.templateId === customFirst.templateId && t.active));
  assert.ok(!libAfterCustom.some((t) => t.templateId === activeTier.first && t.active));

  // 换回常用语 → preset 重新生效
  const presetBack = await (await post('/api/messagelib/preset', { tier: 'first' })).json();
  assert.equal(presetBack.source, 'preset');
  assert.equal((await get('/api/messagelib')).templates.find((t) => t.tier === 'first' && t.active).source, 'preset');

  // ================= 准备岗位 + 注入候选人（触发事件链 + B-2 自动打招呼） =================
  const jr = await post('/api/jobs', { jobId: 'job_b_01', jdRaw: '招聘 前端工程师：熟练 JavaScript、TypeScript、React、Node.js，负责核心业务前端开发。', jobTitle: '前端工程师' });
  assert.equal(jr.status, 201);

  const inject = await post('/api/sourcing/candidates', {
    candidateId: 'cand_b1', source: 'boss', jobId: 'job_b_01', name: '自动候选人A', skills: ['JavaScript'],
    resume: { rawText: '张伟 13800138000 3年经验 熟悉 JavaScript、React、Node.js', format: 'text' },
    meta: { createdAt: new Date().toISOString(), masked: true },
  });
  assert.equal(inject.status, 201);

  // B-2：匹配达标 → 已自动发送初次打招呼（用当前生效「初次」话术），进入待跟进
  const cand = (await get('/candidates')).candidates.find((c) => c.candidateId === 'cand_b1');
  assert.ok(cand.greetedAt, '匹配达标即自动打招呼');
  assert.equal(cand.greeted, true);
  assert.equal(cand.touchStatus, 'engaging');

  const firstGreet = (await get('/api/engagements/candidates/cand_b1')).engagements[0];
  assert.equal(firstGreet.action, 'greet');
  assert.equal(firstGreet.messageVersion, activeTier.first, '话术版本 = 生效「初次」常用语');
  assert.match(firstGreet.content, /前端工程师/, '初次话术用岗位名填充占位符');

  // B-4 触达审计：打招呼含 操作人/时点/对象/轮次/话术版本/结果
  const greetingAudit = (await get('/api/audit?n=100')).audit.find((a) => a.action === 'sourcing.greet' && a.detail?.candidateId === 'cand_b1');
  assert.ok(greetingAudit, '打招呼有审计留痕');
  assert.equal(greetingAudit.actor, 'A1');
  assert.ok(greetingAudit.ts);
  assert.equal(greetingAudit.detail.jobId, 'job_b_01');
  assert.equal(greetingAudit.detail.round, 1);
  assert.equal(greetingAudit.detail.messageVersion, activeTier.first);
  assert.equal(greetingAudit.detail.result, 'ok');

  // ================= B-3 智能跟进：未读轨 · 隔1天重发 · 话术随轮次切换 =================
  const plan0 = (await get('/api/engage/followup/cand_b1')).plan;
  assert.equal(plan0.track, 'unread');
  assert.equal(plan0.touchCount, 1);
  assert.equal(plan0.mode, 'daily');
  assert.equal(plan0.intervalDays, 1);
  assert.equal(plan0.action, 'wait', '刚打招呼未到期，暂不跟进');

  // 建自定义「二次激活」话术并激活（验证跟进话术按轮次切换）
  const customSecond = await (await post('/api/messagelib', { tier: 'second', source: 'custom', content: '【二次激活】[岗位]，期待您的回复~', activate: true })).json();
  const customThird = await (await post('/api/messagelib', { tier: 'third', source: 'custom', content: '【三次激活】[岗位]，欢迎随时沟通。', activate: true })).json();

  // 未读隔 1 天即重发：把上次触达回溯到 2 天前 → sweep 到期重发（二次激活话术）
  backdateSent('cand_b1', 2 * DAY);
  const sweepl = await post('/api/engage/followup/sweep', {});
  assert.equal((await sweepl.json()).sent.length, 1, '到期跟进发送 1 条');
  const followup2 = (await get('/api/engagements/candidates/cand_b1')).engagements.at(-1);
  assert.equal(followup2.action, 'follow_up');
  assert.equal(followup2.messageVersion, customSecond.templateId, '第2轮用「二次激活」话术');
  assert.match(followup2.content, /二次激活/);
  const fuAudit = (await get('/api/audit?n=100')).audit.find((a) => a.action === 'sourcing.follow_up' && a.detail?.candidateId === 'cand_b1');
  assert.equal(fuAudit.detail.round, 2);
  assert.equal(fuAudit.detail.messageVersion, customSecond.templateId);

  // ================= B-3 累计 ≥5 次 → 降为周频；≥3 轮用「三次及以上」话术 =================
  const planAfter = (await get('/api/engage/followup/cand_b1')).plan;
  assert.equal(planAfter.touchCount, 2);
  seedTouch('cand_b1', 12 * DAY, 3);           // 补种 3 次历史跟进 → 触达次数达 5
  backdateSent('cand_b1', 8 * DAY);            // 上次触达回溯到 8 天前 → 超过周频间隔
  const planWeekly = (await get('/api/engage/followup/cand_b1')).plan;
  assert.equal(planWeekly.touchCount, 5);
  assert.equal(planWeekly.mode, 'weekly', '累计≥5次降为周频');
  assert.equal(planWeekly.intervalDays, 7);
  assert.equal(planWeekly.action, 'send');

  const sweepw = await post('/api/engage/followup/sweep', {});
  assert.equal((await sweepw.json()).sent.length, 1);
  const followupThird = (await get('/api/engagements/candidates/cand_b1')).engagements.at(-1);
  assert.equal(followupThird.action, 'follow_up');
  assert.equal(followupThird.messageVersion, customThird.templateId, '第6轮（≥3档）用「三次及以上」话术');
  assert.match(followupThird.content, /三次激活/);

  // ================= B-3 满 1 月仍未读 → 置沉睡，停止触达 =================
  backdateAll('cand_b1', 32 * DAY);            // 自首次触达起满 1 月
  const sleepSweep1 = await post('/api/engage/followup/sweep', {});
  const sleepBody1 = await sleepSweep1.json();
  assert.equal(sleepBody1.slept.length, 1, '满月置沉睡');
  assert.equal(sleepBody1.sent.length, 0);
  const craw = (await get('/candidates')).candidates.find((c) => c.candidateId === 'cand_b1');
  assert.equal(craw.touchStatus, 'sleeping');
  assert.equal(craw.sleeping, true);
  const sleepAudit = (await get('/api/audit?n=100')).audit.find((a) => a.action === 'engage.sleep' && a.detail?.candidateId === 'cand_b1');
  assert.ok(sleepAudit, '沉睡有审计留痕');

  const sleepSweep2 = await post('/api/engage/followup/sweep', {});
  const sleepBody2 = await sleepSweep2.json();
  assert.equal(sleepBody2.sent.length, 0);
  assert.equal(sleepBody2.slept.length, 0, '沉睡后不再触达');

  // B-3 状态实时可查：引擎快照含轮次/频次/状态
  const statuses = (await get('/api/engage/followup')).plans;
  const st = statuses.find((p) => p.candidateId === 'cand_b1');
  assert.equal(st.touchCount, 6);
  assert.equal(st.action, 'sleep');
  assert.equal(st.status, 'sleeping');
});