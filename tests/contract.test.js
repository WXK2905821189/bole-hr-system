// 契约校验 —— 核心回归：schema 必须真正生效，且与各业务产物的真实形状一致
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractValidator } from '../framework/schema/validate.js';

const V = new ContractValidator();

// ---- 各业务产物的“真实合法样本”（若与 schema 漂移即红灯） ----
const validCandidate = {
  candidateId: 'cand_test_1',
  source: 'boss',
  jobId: 'job_01',
  name: '示例',
  status: 'sourced',
  workExperienceYears: 3,
  salaryExpected: '18-24K',
  skills: ['JavaScript', 'Node.js'],
  resume: null,
  meta: { createdAt: '2026-09-10T01:00:00Z', masked: true },
};

const validJob = {
  jobId: 'job_01',
  jobTitle: '前端工程师',
  recruiterId: 'A1',
  status: 'open',
  jdRaw: '招聘 前端工程师',
  parsedKeywords: ['JavaScript'],
  hardSkills: ['JavaScript', 'React'],
  softSkills: [],
  meta: { createdAt: '2026-09-10T01:00:00Z' },
};

const validResume = {
  resumeId: 'res_cand_1',
  candidateId: 'cand_1',
  jobId: 'job_01',
  status: 'parsed',
  format: 'text',
  storageRef: null,
  rawText: '预览...',
  parsed: { education: {}, experiences: [], projects: [], skills: ['Go'] },
  meta: { createdAt: '2026-09-10T01:00:00Z', parsedAt: '2026-09-10T01:01:00Z', engine: 'llm' },
};

const validMatch = {
  matchId: 'match_cand_1_job_01',
  candidateId: 'cand_1',
  jobId: 'job_01',
  matchScore: 82,
  dimensionScores: { hardSkills: 30, softSkills: 10, coreDuties: 15, industry: 8, education: 15 },
  evidence: '技能匹配高',
  meta: { matchedAt: '2026-09-10T01:02:00Z', engine: 'llm' },
};

test('契约：四类合法样本均通过', () => {
  assert.equal(V.validate('candidate', validCandidate).ok, true);
  assert.equal(V.validate('job', validJob).ok, true);
  assert.equal(V.validate('resume', validResume).ok, true);
  assert.equal(V.validate('match', validMatch).ok, true);
});

test('契约：必填生效 —— 缺失 meta 应失败（此前 REQUIRED 的手工表漏了 meta）', () => {
  const { ok, errors } = V.validate('candidate', { ...validCandidate, meta: undefined });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('meta')));
});

test('契约：必填生效 —— resume 缺失 meta 应失败', () => {
  const { ok } = V.validate('resume', { ...validResume, meta: undefined });
  assert.equal(ok, false);
});

test('契约：类型生效 —— skills 应为数组', () => {
  const { ok, errors } = V.validate('candidate', { ...validCandidate, skills: 'JavaScript' });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('类型')));
});

test('契约：枚举生效 —— source 只在白名单内', () => {
  assert.equal(V.validate('candidate', { ...validCandidate, source: 'linkedin' }).ok, false);
  assert.equal(V.validate('candidate', { ...validCandidate, source: 'manual' }).ok, true);
});

test('契约：format 生效 —— email / date-time', () => {
  assert.equal(V.validate('candidate', { ...validCandidate, email: 'not-an-email' }).ok, false);
  assert.equal(V.validate('candidate', { ...validCandidate, email: 'a@b.com' }).ok, true);
  // 兼容无时区/带毫秒的 date-time（simulator 的 now_iso 产出）
  assert.equal(V.validate('candidate', { ...validCandidate, meta: { createdAt: '2026-09-09T17:00:55', masked: true } }).ok, true);
});

test('契约：数值边界生效 —— matchScore 钳制在 0..100', () => {
  assert.equal(V.validate('match', { ...validMatch, matchScore: 120 }).ok, false);
  assert.equal(V.validate('match', { ...validMatch, matchScore: -1 }).ok, false);
  assert.equal(V.validate('match', { ...validMatch, matchScore: 0 }).ok, true);
});

test('契约：integer 类型能识别 JS 数字', () => {
  assert.equal(V.validate('candidate', { ...validCandidate, workExperienceYears: 3 }).ok, true);
  assert.equal(V.validate('candidate', { ...validCandidate, workExperienceYears: 3.5 }).ok, false);
});

test('契约：assertValid 对非法数据抛错', () => {
  assert.throws(() => V.assertValid('candidate', { candidateId: 'x', source: 'boss' }));
  assert.doesNotThrow(() => V.assertValid('candidate', validCandidate));
});

test('契约：未知类型名报错', () => {
  assert.equal(V.validate('nonexistent', {}).ok, false);
});