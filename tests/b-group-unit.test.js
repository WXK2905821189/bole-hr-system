// B 组单元测试：话术库分档/渲染与跟进引擎的双轨流转判定（不启 HTTP，纯逻辑）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageLibraryService } from '../modules/recruitment-sourcing/services/messagelib.js';
import { FollowUpEngine } from '../modules/recruitment-sourcing/services/followup.js';

const DAY = 86400000;

// 内存 store + 便捷 impl：setEngagements(cid, rows)
function mkStore() {
  const data = {};
  return {
    readAll(key) { return data[key] ?? []; },
    write(key, row) { (data[key] ??= []).push(row); },
    writeAll(key, rows) { data[key] = rows; },
    setEngagements(cid, rows) {
      data['engagements.jsonl'] = rows.map((r) => ({
        candidateId: cid,
        action: r.action,
        timestamps: r.timestamps ?? { sent: new Date(r.sent).toISOString() },
        meta: { createdAt: new Date(r.created ?? r.sent ?? Date.now()).toISOString() },
      }));
    },
    setCandidates(cands) { data['candidates.jsonl'] = cands; },
  };
}
const mkValidate = () => ({ validate: () => ({ ok: true, errors: [] }) });
const mkAudit = () => ({ record: async () => ({}) });
const CAND = { candidateId: 'c1', name: '张三', jobId: 'job1', recruiterId: 'A1' };

function mkEngine() {
  const store = mkStore();
  store.setCandidates([CAND]);
  const engine = new FollowUpEngine({
    store, audit: mkAudit(),
    domain: { sendFollowUp: async () => ({ ok: true }), markSleeping: async () => { store.setCandidates([{ ...CAND, touchStatus: 'sleeping', sleeping: true }]); return { ok: true }; } },
    messagelib: {}, config: { engage: {} },
  });
  return { store, engine };
}

test('话术库：分档映射与占位符渲染正确', () => {
  const ml = new MessageLibraryService({ store: mkStore(), validate: mkValidate(), audit: mkAudit(), config: { engage: {} } });
  assert.equal(ml.tierForRound(1), 'first');
  assert.equal(ml.tierForRound(2), 'second');
  assert.equal(ml.tierForRound(3), 'third');
  assert.equal(ml.tierForRound(99), 'third');
  const rendered = ml.render('first', '后端工程师', 1);
  assert.ok(rendered.content.includes('后端工程师'));
  assert.ok(ml.byTier('first').some((t) => t.active), 'seed 后 first 档有生效版本');
});

test('话术库：自定义版本激活只影响本档，跨档生效独立', () => {
  const ml = new MessageLibraryService({ store: mkStore(), validate: mkValidate(), audit: mkAudit(), config: { engage: {} } });
  const c2 = ml.create({ tier: 'second', content: 'B档自定义', activate: true });
  assert.equal(ml.activeFor('second').templateId, c2.templateId);
  const c1b = ml.create({ tier: 'first', content: 'A档新版', activate: true });
  assert.equal(ml.activeFor('first').templateId, c1b.templateId);
  assert.equal(ml.activeFor('second').templateId, c2.templateId, '激活 first 不影响 second 档');
});

test('跟进引擎：未读轨隔1天发送 · 累计≥5次降周频 · 满月沉睡', () => {
  const { store, engine } = mkEngine();
  const now = Date.now();

  // 刚触达（未读）→ 等待
  store.setEngagements('c1', [{ action: 'greet', sent: now, created: now }]);
  let plan = engine.plan(CAND, now);
  assert.equal(plan.track, 'unread');
  assert.equal(plan.touchCount, 1);
  assert.equal(plan.action, 'wait');

  // 隔 1 天 → 发送
  store.setEngagements('c1', [{ action: 'greet', sent: now - 2 * DAY, created: now - 2 * DAY }]);
  plan = engine.plan(CAND, now);
  assert.equal(plan.mode, 'daily');
  assert.equal(plan.intervalDays, 1);
  assert.equal(plan.action, 'send');

  // 累计 5 次 → 周频；周频间隔未到 7 天则等待
  const five = [];
  for (let i = 0; i < 5; i++) five.push({ action: 'follow_up', sent: now - (i + 1) * 3 * DAY, created: now - (i + 1) * 3 * DAY });
  store.setEngagements('c1', five);
  plan = engine.plan(CAND, now);
  assert.equal(plan.touchCount, 5);
  assert.equal(plan.mode, 'weekly');
  assert.equal(plan.intervalDays, 7);
  assert.equal(plan.action, 'wait', '周频未到 7 天');

  // 已读轨（有回复）
  store.setEngagements('c1', [...five, { action: 'reply', timestamps: { read: new Date(now).toISOString() }, created: now }]);
  plan = engine.plan(CAND, now);
  assert.equal(plan.track, 'read');

  // 满 1 月（自首次触达起）→ 沉睡
  store.setEngagements('c1', [{ action: 'greet', sent: now - 32 * DAY, created: now - 32 * DAY }]);
  plan = engine.plan(CAND, now);
  assert.equal(plan.status, 'sleeping');
  assert.equal(plan.action, 'sleep');
});