// 单元校验：A-1(Engagement 契约/touchStatus) 与 A-2(触达护栏超频拦截)
// 运行：node framework/schema/validate.test.mjs  （或 node 指向本文件）
import { ContractValidator } from './validate.js';
import { Store } from '../../infra/store/store.js';
import { EngagementService } from '../../modules/recruitment-sourcing/services/engagement.js';
import { GuardrailService } from '../../modules/recruitment-sourcing/services/guardrail.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name}`)); };
const _audit = { record: async () => {} };

// ---------- A-1: 契约校验 ----------
console.log('\n[A-1] Engagement 契约 & touchStatus');
const validate = new ContractValidator();

// 合法触达记录
const validEng = {
  engagementId: 'eng_t1', candidateId: 'cand_1', jobId: 'job_1', recruiterId: 'A1',
  action: 'greet', touchCount: 1, readStatus: 'unread', messageVersion: 'v1',
  frequencyMode: 'balanced', stopFlag: false,
  timestamps: { sent: new Date().toISOString() }, meta: { createdAt: new Date().toISOString() },
};
const v1 = validate.validate('engagement', validEng);
ok('合法 engagement 通过', v1.ok);

// 缺必填字段（无 engagementId）=> 拒绝
const badEng = { candidateId: 'cand_1', jobId: 'job_1', action: 'greet' };
const v2 = validate.validate('engagement', badEng);
ok('缺必填字段被拒绝', !v2.ok && v2.errors.some((e) => e.includes('engagementId')));

// 枚举值变异 => 拒绝
const badAction = { ...validEng, action: 'SPAM' };
ok('非法 action 枚举被拒绝', !validate.validate('engagement', badAction).ok);
const badFreq = { ...validEng, frequencyMode: 'extreme' };
ok('非法 frequencyMode 被拒绝', !validate.validate('engagement', badFreq).ok);
const badTimes = { ...validEng, timestamps: { sent: '2026/09/10' } };
ok('非法 date-time 被拒绝', !validate.validate('engagement', badTimes).ok);

// touchCount 边界
const badCount = { ...validEng, touchCount: 0 };
ok('touchCount=0(小于min) 被拒绝', !validate.validate('engagement', badCount).ok);

// candidate 带 touchStatus 合法 + 枚举正确
const candOk = { candidateId: 'cand_1', source: 'boss', jobId: 'job_1', meta: { createdAt: new Date().toISOString(), masked: true }, touchStatus: 'engaging' };
ok('candidate 带 touchStatus 通过', validate.validate('candidate', candOk).ok);
const candBad = { ...candOk, touchStatus: 'spamming' };
ok('candidate touchStatus 非法枚举被拒绝', !validate.validate('candidate', candBad).ok);

// ---------- A-1: 落盘与变异不入库 ----------
console.log('\n[A-1] 落盘 engagements.jsonl & 变异数据拒绝');
const dir = mkdtempSync(join(tmpdir(), 'hr-tst-'));
const store = new Store(dir);
const engService = new EngagementService({ store, validate, audit: _audit, config: {} });
store.write('candidates.jsonl', { candidateId: 'cand_1', jobId: 'job_1', source: 'boss', name: '测试', meta: { createdAt: new Date().toISOString(), masked: true } });

const rec = engService.touch({ candidateId: 'cand_1', recruiterId: 'A1', action: 'greet' });
ok('greet 触达已写入', store.readAll('engagements.jsonl').length === 1);
ok('touchCount=1 且含完整字段', rec.touchCount === 1 && rec.frequencyMode === 'balanced' && !!rec.engagementId);
const cand = store.readAll('candidates.jsonl')[0];
ok('候选人 touchStatus -> engaging', cand.touchStatus === 'engaging');

const rec2 = (() => { try { engService.touch({ candidateId: 'cand_1', recruiterId: 'A1', action: 'surprise_call' }); return null; } catch { return 'REJECTED'; } })();
const guardRows = store.readAll('guardrail.jsonl').filter((g) => g.kind === 'engagement.validate.reject');
ok('变异 action 被拒绝且留痕(不入库)', rec2 === 'REJECTED' && guardRows.length === 1 && store.readAll('engagements.jsonl').length === 1);

// 回复联动
engService.touch({ candidateId: 'cand_1', recruiterId: 'A1', action: 'reply', replyContent: '方便，谢谢' });
const cand2 = store.readAll('candidates.jsonl')[0];
ok('回复后 touchStatus -> replied', cand2.touchStatus === 'replied');

// ---------- A-2: 触达护栏（打招呼/索取共用上限，超频拦截留痕） ----------
console.log('\n[A-2] 触达护栏超频拦截');
const guard = new GuardrailService({ store, audit: _audit, config: { safety: { touch_daily_cap: 3, daily_cap: 100, cooldown_minutes: 30, session_cap: 1000, circuit_breaker: 3, interval_seconds: [0,0] } } });
// 先用 request_resume 消耗共档配额
for (let i = 0; i < 3; i++) guard.record({ recruiterId: 'A1', action: 'request_resume', ok: true });
const ck = guard.check({ recruiterId: 'A1', action: 'greet' });
ok('打招呼在共用上限耗尽后被拦截', !ck.ok && /打招呼\/索取/.test(ck.reason));
const blockBefore = store.readAll('guardrail.jsonl').length;
guard.logBlock({ recruiterId: 'A1', action: 'greet', reason: ck.reason });
ok('超频拦截已留痕(guardrail.jsonl)', store.readAll('guardrail.jsonl').length === blockBefore + 1);

// 非触达类动作不受该铡额限制（仍未到 dailyCap）
const ck2 = guard.check({ recruiterId: 'A1', action: 'follow_up' });
ok('非共档动作不被触达上限拦截', ck2.ok);

// 触发冷却：连续失败熔断
const guard2 = new GuardrailService({ store, audit: _audit, config: { safety: { touch_daily_cap: 100, daily_cap: 100, cooldown_minutes: 30, session_cap: 1000, circuit_breaker: 2, interval_seconds: [0,0] } } });
guard2.record({ recruiterId: 'B1', action: 'greet', ok: false });
guard2.record({ recruiterId: 'B1', action: 'greet', ok: false });
const ck3 = guard2.check({ recruiterId: 'B1', action: 'greet' });
ok('连续失败达阈值触发冷却', !ck3.ok && /冷却/.test(ck3.reason));

rmSync(dir, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);