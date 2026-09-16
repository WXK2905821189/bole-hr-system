// C4 · 评分规则 + 总体能力分 + 人工复核池（v1.2 新增）
// 覆盖：① 规则读写（GET/PUT /api/sourcing/rules，含 overall 段）② 总体能力分 /overall/:id
// ③ 复核池入选判定 ④ 复核动作 + 审计留痕 ⑤ 非管理员写规则被拒
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../framework/server.js';
import { loginAdmin } from './_helpers.js';

let app, base, dir;

const CAND_ID = 'cand_c4_001';
// 高能力（维度足、年限长、自驱信号多）但岗位匹配低（45）的候选人
const RESUME_PARSED = {
  education: { degree: '本科', school: '示例大学' },
  skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'Vue', 'WebGL', 'Git'],
  projects: [
    { name: '在线三维编辑器', role: '核心开发', detail: '主导 WebGL 渲染引擎与性能优化，实现 PBR 材质与实时光照，支撑十万级三角面片流畅渲染。' },
    { name: '组件库与工程化平台', role: '负责人', detail: '搭建前端组件库及 CI/CD 工程化体系，覆盖 20+ 业务方，将构建耗时降低 60%。' },
  ],
  experiences: [
    { company: '示例科技', role: '资深前端工程师', years: 4 },
    { company: '示例网络', role: '前端工程师', years: 2 },
  ],
  workExperienceYears: 6,
};
const RESUME_RAW = '开源项目维护者、GitHub 主页、获内推获奖与专利，公众号与技术博客持续输出。';

const login = async (username, password) => (await fetch(base + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
})).json();

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hr-test-c4-'));
  app = await createApplication({ storeDir: dir, filesDir: dir, llm: {}, auth: {}, engage: {}, safety: {} });
  app.start(0);
  base = `http://127.0.0.1:${app.server.address().port}`;
  // 注入候选人 + 简历 + 低匹配分（status 需非 'sourced'，即已收简历）
  app.instance.services.store.write('candidates.jsonl', {
    candidateId: CAND_ID, jobId: 'job_c4', source: 'boss_recommend', name: '能力型候选人',
    status: 'parsed', touchStatus: 'pending', meta: { createdAt: new Date().toISOString() },
  });
  app.instance.services.store.write('resumes.jsonl', {
    candidateId: CAND_ID, jobId: 'job_c4', rawText: RESUME_RAW, parsed: RESUME_PARSED,
    parsedAt: new Date().toISOString(),
  });
  app.instance.services.store.write('matches.jsonl', { matchId: `m_${CAND_ID}`, candidateId: CAND_ID, jobId: 'job_c4', matchScore: 45, meta: { matchedAt: new Date().toISOString() } });
});

after(async () => {
  app?.instance?.api?.schedule?.dispose();
  app?.instance?.api?.followup?.dispose();
  await new Promise((r) => app.server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const rulesGet = (token) => fetch(base + '/api/sourcing/rules', { headers: { 'x-auth': token || '' } });
const rulesPut = (token, body) => fetch(base + '/api/sourcing/rules', {
  method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-auth': token || '' }, body: JSON.stringify(body ?? {}),
});

test('C4 规则读取：登录返回 ok + 含 match/overall 两轨道', async () => {
  const { token } = await loginAdmin(base);
  assert.ok(token, 'admin 可登录');
  const r = await rulesGet(token);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.ok(body.rules.match && body.rules.match.weights, '含 match 轨道权重');
  assert.ok(body.rules.overall && body.rules.overall.weights, '含 overall 轨道与权重');
  assert.equal(body.rules.overall.enabled, false, '人工复核默认关闭');
  assert.equal(body.rules.overall.reviewThreshold, 70);
});

test('C4 规则写入：未登录被拒 401', async () => {
  assert.equal((await rulesPut('', { overall: { enabled: true } })).status, 401);
});

test('C4 规则写入：admin 保存即时生效并留审计', async () => {
  const { token } = await loginAdmin(base);
  const r = await rulesPut(token, {
    overall: { enabled: true, reviewThreshold: 70 },
    filter: { maxAge: 40, minDegree: '本科', mustInclude: ['WebGL'] },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.rules.overall.enabled, true, '保存后开启复核');
  // 生效确认：重新读取仍为开
  const g = await (await rulesGet(token)).json();
  assert.equal(g.rules.overall.enabled, true);
  // 审计留痕
  const audit = await (await fetch(base + '/api/audit?n=200', { headers: { 'x-auth': token } })).json();
  const recs = (audit?.audit ?? []).filter((x) => x.action === 'sourcing.rules.configure');
  assert.ok(recs.length >= 1, '应存在规则配置审计记录');
});

test('C4 总体能力分：/overall/:id 返回 0-100 与五维明细', async () => {
  const { token } = await loginAdmin(base);
  const r = await fetch(base + `/api/sourcing/overall/${encodeURIComponent(CAND_ID)}`, { headers: { 'x-auth': token } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.ok(Number.isFinite(body.overallScore) && body.overallScore >= 0 && body.overallScore <= 100, `overallScore=${body.overallScore}`);
  assert.ok(body.overallScore >= 70, `高能力候选人总体分应>=70，实际 ${body.overallScore}`);
  const dims = Object.keys(body.dimensionScores || {});
  for (const d of ['project_depth', 'skill_breadth', 'exp_level', 'resume_quality', 'self_drive']) assert.ok(dims.includes(d), `含维度 ${d}`);
});

test('C4 复核池：能力强但匹配低 → 入选', async () => {
  const { token } = await loginAdmin(base);
  const body = await (await fetch(base + '/api/sourcing/review-pool', { headers: { 'x-auth': token } })).json();
  assert.equal(body.ok, true);
  assert.equal(body.enabled, true, '复核已开启');
  assert.equal(body.greetThreshold, 60);
  assert.ok(body.count >= 1, '应有复核候选人');
  const row = body.rows.find((x) => x.candidateId === CAND_ID);
  assert.ok(row, '注入的高能力候选人进入复核池');
  assert.equal(row.matchScore, 45, '匹配分低于打招呼阈值');
  assert.ok(row.overallScore >= 70, `总体能力分>=阈值，实际 ${row.overallScore}`);
  assert.ok(row.dimensionScores && Object.keys(row.dimensionScores).length >= 5, '含五维明细');
});

test('C4 复核动作：discard 落库 + 从池移除 + 审计', async () => {
  const { token } = await loginAdmin(base);
  const r = await fetch(base + `/api/sourcing/review/${encodeURIComponent(CAND_ID)}/decide`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth': token }, body: JSON.stringify({ decision: 'discard' }),
  });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.decision, 'discard');
  // 已处理，复核池中不再包含
  const pool = await (await fetch(base + '/api/sourcing/review-pool', { headers: { 'x-auth': token } })).json();
  assert.ok(!pool.rows.some((x) => x.candidateId === CAND_ID), '处理后移出复核池');
  const audit = await (await fetch(base + '/api/audit?n=200', { headers: { 'x-auth': token } })).json();
  assert.ok((audit?.audit ?? []).some((x) => x.action === 'sourcing.review.decide' && /discard/.test(JSON.stringify(x.detail || {}))), '复核动作留审计');
});

test('C4 复核阈值边界：复核关闭时池为空(独立候选验证)', async () => {
  // 用第二个候选验证同经验关闭复核 → enabled:false, rows 空
  const cid2 = 'cand_c4_off';
  app.instance.services.store.write('candidates.jsonl', {
    candidateId: cid2, jobId: 'job_c4', source: 'boss_recommend', name: '关闭复核时的候选',
    status: 'parsed', touchStatus: 'pending', meta: { createdAt: new Date().toISOString() },
  });
  app.instance.services.store.write('resumes.jsonl', { candidateId: cid2, jobId: 'job_c4', rawText: RESUME_RAW, parsed: RESUME_PARSED, parsedAt: new Date().toISOString() });
  app.instance.services.store.write('matches.jsonl', { matchId: `m_${cid2}`, candidateId: cid2, jobId: 'job_c4', matchScore: 45, meta: { matchedAt: new Date().toISOString() } });
  const { token } = await loginAdmin(base);
  // 关闭复核
  await rulesPut(token, { overall: { enabled: false } });
  const body = await (await fetch(base + '/api/sourcing/review-pool', { headers: { 'x-auth': token } })).json();
  assert.equal(body.enabled, false, '复核关闭');
  assert.equal(body.count, 0, '复核关闭时池为空');
  assert.equal(body.rows.length, 0);
});