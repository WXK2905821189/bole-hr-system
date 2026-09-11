// C-1 联动验证脚本（独立临时 store/files，不污染真实数据）
// 验证：① 回复→自动索要简历/电话  ② 解析后缺电话→自动索要电话  ③ 契约含 contact
import { EventBus } from './framework/core/bus.js';
import { ModuleRegistry } from './framework/core/registry.js';
import { Lifecycle } from './framework/core/lifecycle.js';
import { Audit } from './framework/audit/audit.js';
import { ContractValidator } from './framework/schema/validate.js';
import { Store } from './infra/store/store.js';
import { cfg } from './framework/core/config.js';
import { loadModule, manifest } from './modules/recruitment-sourcing/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'bole-c1-'));
const config = cfg({ storeDir: tmp, filesDir: tmp });
const bus = new EventBus();
const registry = new ModuleRegistry();
const audit = new Audit(tmp);
const validate = new ContractValidator();
const store = new Store(tmp);
const { instance } = await loadModule({ bus, validate, audit, store, config });

// 事件装配：与 server.js 一致，使 candidate.sourced / resume.parsed 触达模块联动
registry.register({ ...manifest, instance });
await new Lifecycle(registry, bus).start(manifest.id);

const show = (label, r) => {
  const a = r.autoRequested;
  if (!a) return console.log(`[${label}] 无自动索取（stopFlag 或已终止）`);
  if (a.already) return console.log(`[${label}] 已具备，无自动索取 → already=true`);
  if (a.blocked) return console.log(`[${label}] 被护栏拦截 → blocked`, a.reason);
  console.log(`[${label}] 自动索取已发送 → ok=true, round=${a.round}, touchStatus=${a.candidate?.touchStatus}`);
};

// 场景A：无简历，候选人回复 → 应自动 request_resume
store.write('candidates.jsonl', { candidateId: 'cand_A', source: 'boss', jobId: 'job_e2e', name: '测试A', status: 'sourced',
  education: { school: 'X大学', degree: '本科', major: '计算机' }, skills: ['JS'], meta: { createdAt: new Date().toISOString(), masked: true } });
const ra = await instance.api.replyCandidate('cand_A', { content: '好的，想了解' });
show('A 无简历回复', ra);
const aEng = store.readAll('engagements.jsonl').filter((e) => e.candidateId === 'cand_A').map((e) => e.action);
console.log('   [A] 动作序列:', aEng.join(' -> '), '（应含 reply + request_resume）');
console.log('   [A] 触达状态:', ra.candidate?.touchStatus, '（应为 replied→engaging 最终值）');

// 场景B：有简历且缺电话，回复 → 应自动 request_phone
store.write('candidates.jsonl', { candidateId: 'cand_B', source: 'boss', jobId: 'job_e2e', name: '测试B', status: 'parsed',
  meta: { createdAt: new Date().toISOString(), masked: true } });
store.write('resumes.jsonl', { resumeId: 'res_B', candidateId: 'cand_B', jobId: 'job_e2e', status: 'parsed',
  rawText: '测试B', parsed: { education: {}, contact: { phone: null, email: null }, skills: [] }, meta: { createdAt: new Date().toISOString(), parsedAt: new Date().toISOString() } });
const rb = await instance.api.replyCandidate('cand_B', { content: '可以' });
show('B 有简历缺电话回复', rb);
const bEng = store.readAll('engagements.jsonl').filter((e) => e.candidateId === 'cand_B').map((e) => e.action);
console.log('   [B] 动作序列:', bEng.join(' -> '), '（应含 reply + request_phone）');

// 场景C：有简历且有电话，回复 → 不应再要电话（already:true）
store.write('candidates.jsonl', { ...{ candidateId: 'cand_C', source: 'boss', jobId: 'job_e2e', name: '测试C', status: 'parsed',
  meta: { createdAt: new Date().toISOString(), masked: true } } });
store.write('resumes.jsonl', { resumeId: 'res_C', candidateId: 'cand_C', jobId: 'job_e2e', status: 'parsed',
  rawText: '测试C 13800138000', parsed: { education: {}, contact: { phone: '13800138000', email: 'a@b.com' }, skills: [] }, meta: { createdAt: new Date().toISOString(), parsedAt: new Date().toISOString() } });
const rc = await instance.api.replyCandidate('cand_C', { content: '好' });
show('C 有电话回复', rc);
console.log('   [C] 回显 autoRequested:', JSON.stringify(rc.autoRequested));

// 场景D：无电话原文经解析（onResumeParsed）→ 联动 request_phone（emit 已 await，含节流耗时）
store.write('candidates.jsonl', { candidateId: 'cand_D', source: 'boss', jobId: 'job_e2e', name: '测试D', status: 'sourced',
  meta: { createdAt: new Date().toISOString(), masked: true } });
await bus.emit('candidate.sourced', { candidateId: 'cand_D', jobId: 'job_e2e', rawText: '测试D，无电话号码，只有邮箱 a@b.com' }, { actor: 'system' });
const dEng = store.readAll('engagements.jsonl').filter((e) => e.candidateId === 'cand_D').map((e) => e.action);
console.log('[D] 无电话候选人触达序列:', dEng.join(' -> '), '（解析后应含 request_phone）');

// 契约校验：resume 需含 contact 且通过 resume schema
console.log('\n=== 契约校验（resume 需含 contact）===');
for (const r of store.readAll('resumes.jsonl')) {
  const chk = validate.validate('resume', r);
  console.log(`[契约] ${r.candidateId} contact.phone=${r.parsed?.contact?.phone ?? 'null'} email=${r.parsed?.contact?.email ?? 'null'} | ${chk.ok ? 'OK' : 'FAIL:' + chk.errors.join(';')}`);
}

console.log('\n=== 审计抽查（触达动作留痕）===');
const auditRows = audit.tail(200).filter((x) => String(x.action).startsWith('sourcing.'));
for (const a of auditRows.slice(-6)) console.log(`   [审计] ${a.action} → ${JSON.stringify(a.detail)}`);

rmSync(tmp, { recursive: true, force: true });
console.log('\n=== C-1 联动验证完成（临时库已清理）===');