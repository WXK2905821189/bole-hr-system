// M6 · 前置 AI 匹配门禁（Python 侧调用网关端匹配打分）端到端验证
// 覆盖：① /api/ai/pre-match 路由 ✅ ② 认证门禁（未登录 401）✅ ③ JD×简历差距分析打分 ✅
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../framework/server.js';
import { loginAdmin } from './_helpers.js';

let app, base, dir;

const JOB_ID = 'job_m6_prematch';
const JD = '招聘 前端工程师：熟练 JavaScript/TypeScript、React、Vue，负责核心业务前端开发与组件库建设，具备跨部门协作能力，本科及以上。';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hr-test-m6-'));
  app = await createApplication({ storeDir: dir, filesDir: dir, llm: {}, auth: {}, engage: {}, safety: {} });
  app.start(0);
  base = `http://127.0.0.1:${app.server.address().port}`;
  // 建一个测试岗位（供差距分析加载 JD）
  await app.instance.api.parseJd(JD, JOB_ID, '前端工程师', 'A1');
});

after(async () => {
  app?.instance?.api?.schedule?.dispose();
  app?.instance?.api?.followup?.dispose();
  await new Promise((r) => app.server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const login = async (username, password) => (await fetch(base + '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
})).json();

const postPreMatch = async (token, jobId, resumeText) => fetch(base + '/api/ai/pre-match', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { 'x-auth': token } : {}) },
  body: JSON.stringify({ jobId, resumeText }),
});

test('M6 前置匹配：未登录返回 401', async () => {
  const r = await postPreMatch(null, JOB_ID, '张三');
  assert.equal(r.status, 401, '未登录应返回 401');
});

test('M6 前置匹配：登录后调用返回门禁所需分数结构', async () => {
  const { token } = await loginAdmin(base);
  assert.ok(token, 'admin 可登录');

  const r = await postPreMatch(token, JOB_ID, '张三，3年前端开发经验，精通 JavaScript、TypeScript、React，熟悉 Vue 与工程化，做过组件库建设，本科。');
  assert.equal(r.status, 200, '登录调用返回 200');
  const body = await r.json();
  assert.equal(body.ok, true, 'ok 为 true');
  assert.equal('score' in body, true, '含 score');
  assert.ok(typeof body.score === 'number' && body.score >= 0 && body.score <= 100, `score 0-100，实际 ${body.score}`);
  assert.equal('dimensionScores' in body, true, '含 dimensionScores');
  assert.equal('evidence' in body, true, '含 evidence');
  console.log('[m6.test] 前端简历匹配分:', body.score);
});

test('M6 前置匹配：匹配分对技术栈不同有明显区分', async () => {
  const { token } = await loginAdmin(base);
  // 技术栈完全不符的简历 → 主分维度应明显低于强匹配简历
  const low = await (await postPreMatch(token, JOB_ID, '王五，10年会计经验，精通Excel、财务报表与税务申报，有CPA证书。')).json();
  const high = await (await postPreMatch(token, JOB_ID, '李四，4年前端，精通JavaScript、TypeScript、React、Vue，负责核心业务前端，本科。')).json();
  console.log('[m6.test] 弱匹配分:', low.score, '强匹配分:', high.score);
  assert.ok(low.score < high.score, `弱匹配(${low.score}) < 强匹配(${high.score})`);
  assert.ok(high.score >= 40, '强匹配分应较高（>=40）');
});

test('M6 前置匹配：必填字段校验', async () => {
  const { token } = await loginAdmin(base);
  assert.equal((await postPreMatch(token, '', '')).status, 400, '双空返回 400');
  assert.equal((await postPreMatch(token, JOB_ID, '')).status, 400, '缺简历返回 400');
  assert.equal((await postPreMatch(token, 'no_such', '张三')).status, 404, '不存在岗位返回 404');
});