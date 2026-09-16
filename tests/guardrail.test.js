// 触达服务与护栏单元测试（原 framework/schema/validate.test.mjs 的 A-1 落盘段 + A-2 护栏段迁移而来）
// 覆盖：① EngagementService.touch 落盘 + touchStatus 流转 + 变异校验拒绝并留痕
//      ② GuardrailService 触达共用上限耗尽拦截、非触达动作放行、连续失败熔断冷却
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractValidator } from '../framework/schema/validate.js';
import { Store } from '../infra/store/store.js';
import { EngagementService } from '../modules/recruitment-sourcing/services/engagement.js';
import { GuardrailService } from '../modules/recruitment-sourcing/services/guardrail.js';

const audit = { record: async () => {} };
let dir, store, validate;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hr-tst-guard-'));
  store = new Store(dir);
  validate = new ContractValidator();
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('eng.service：greet 触达落盘并推进 touchStatus，回复后 -> replied', () => {
  const eng = new EngagementService({ store, validate, audit, config: {} });
  store.write('candidates.jsonl', { candidateId: 'cand_1', jobId: 'job_1', source: 'boss', name: '测试', meta: { createdAt: new Date().toISOString(), masked: true } });

  const rec = eng.touch({ candidateId: 'cand_1', recruiterId: 'A1', action: 'greet' });
  assert.equal(store.readAll('engagements.jsonl').length, 1, 'greet 触达已写入');
  assert.equal(rec.touchCount, 1);
  assert.equal(rec.frequencyMode, 'balanced');
  assert.ok(rec.engagementId, '含完整字段');
  assert.equal(store.readAll('candidates.jsonl')[0].touchStatus, 'engaging', '候选人 touchStatus 推进为 engaging');

  eng.touch({ candidateId: 'cand_1', recruiterId: 'A1', action: 'reply', replyContent: '方便，谢谢' });
  assert.equal(store.readAll('candidates.jsonl')[0].touchStatus, 'replied', '回复后 touchStatus 推进为 replied');
});

test('eng.service：变异 action 被校验拒绝、不入库且护栏留痕', () => {
  const eng = new EngagementService({ store, validate, audit, config: {} });
  store.write('candidates.jsonl', { candidateId: 'cand_1', jobId: 'job_1', source: 'boss', name: '测试', meta: { createdAt: new Date().toISOString(), masked: true } });
  eng.touch({ candidateId: 'cand_1', recruiterId: 'A1', action: 'greet' });

  let rejected = false;
  try { eng.touch({ candidateId: 'cand_1', recruiterId: 'A1', action: 'surprise_call' }); } catch { rejected = true; }
  const guardRows = store.readAll('guardrail.jsonl').filter((g) => g.kind === 'engagement.validate.reject');
  assert.equal(rejected, true, '变异 action 被拒绝');
  assert.equal(guardRows.length, 1, '拒绝留痕');
  assert.equal(store.readAll('engagements.jsonl').length, 1, '非法数据不入库');
});

// ---------- A-2：触达护栏（打招呼/索取共用上限 + 冷却熔断） ----------
test('guardrail：打招呼/索取共用上限耗尽后拦截，非触达动作放行', () => {
  const guard = new GuardrailService({ store, audit, config: { safety: { touch_daily_cap: 3, daily_cap: 100, cooldown_minutes: 30, session_cap: 1000, circuit_breaker: 3, interval_seconds: [0, 0] } } });
  for (let i = 0; i < 3; i++) guard.record({ recruiterId: 'A1', action: 'request_resume', ok: true }); // 消耗共档配额
  const ck = guard.check({ recruiterId: 'A1', action: 'greet' });
  assert.equal(ck.ok, false, '打招呼在共用上限耗尽后被拦截');
  assert.ok(/打招呼\/索取/.test(ck.reason));

  const before = store.readAll('guardrail.jsonl').length;
  guard.logBlock({ recruiterId: 'A1', action: 'greet', reason: ck.reason });
  assert.equal(store.readAll('guardrail.jsonl').length, before + 1, '超频拦截留痕');

  assert.equal(guard.check({ recruiterId: 'A1', action: 'follow_up' }).ok, true, '非共档动作不被触达上限拦截');
});

test('guardrail：连续失败达阈值触发熔断冷却', () => {
  const guard = new GuardrailService({ store, audit, config: { safety: { touch_daily_cap: 100, daily_cap: 100, cooldown_minutes: 30, session_cap: 1000, circuit_breaker: 2, interval_seconds: [0, 0] } } });
  guard.record({ recruiterId: 'B1', action: 'greet', ok: false });
  guard.record({ recruiterId: 'B1', action: 'greet', ok: false });
  const ck = guard.check({ recruiterId: 'B1', action: 'greet' });
  assert.equal(ck.ok, false, '连续失败达阈值触发冷却');
  assert.ok(/冷却/.test(ck.reason));
});