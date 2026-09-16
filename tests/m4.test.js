// M4 里程碑·AI 基座改造端到端验证
// 用本地 mock OpenAI 兼容服务器模拟公司 AI Coding 中转平台，验证：
//   ① /models 自动拉取模型列表
//   ② 管理员门禁（非管理员配置 403；未登录 401）
//   ③ 配置持久化 + 探活 + 密钥掩码 + 即时生效（jd/parser/matcher 同步经新基座跑通）
//   ④ 配置变更写审计
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../framework/server.js';
import { loginAdmin } from './_helpers.js';

// ---------- mock OpenAI 兼容服务器（模拟公司 AI Coding 中转平台） ----------
const MODEL_LIST = ['m4-jd-parser', 'm4-resume-parser', 'm4-深匹配'];

// 依据 system 提示词分流返回对应 JSON（JD抽词 / 简历抽取 / 深度匹配）
function llmPayload(system, user) {
  if (system.includes('岗位JD')) {
    return { company: '示例科技有限公司', position: '后端工程师', hard_skills: ['Python', 'Go', 'SQL'], soft_skills: ['责任心', '沟通'], core_duties: ['接口开发', '数据库设计'], keywords: ['Python', 'Go', 'SQL', 'MySQL'], industry: '通用' };
  }
  if (system.includes('简历分析')) {
    return { education: { school: '某高校', major: '计算机科学', degree: '本科', year: '2020' }, experiences: [{ company: 'A公司', role: '后端工程师', duration: '3年', highlights: ['负责接口开发'] }], projects: [], skills: ['Python', 'Go', 'MySQL'], strengths: ['技术扎实'], weaknesses: ['团队管理'] };
  }
  if (system.includes('招聘筛选专家')) {
    return { match_score: 88, match_points: ['硬技能全覆盖Python/Go/SQL', '有3年后端经验'], weak_points: ['无微服务经验'], dimension_scores: { hard_skills: { score: 30, max: 30, detail: '全覆盖' }, soft_skills: { score: 16, max: 20, detail: '部分' }, core_duties: { score: 18, max: 20, detail: '类似经验' }, industry_experience: { score: 12, max: 15, detail: '相近' }, education: { score: 12, max: 15, detail: '基本满足' } } };
  }
  return { result: `len_user=${String(user).length}`, consumed: user };
}

function startMock() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const send = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && url.pathname === '/models') {
        send({ object: 'list', data: MODEL_LIST.map((id) => ({ id, object: 'model' })) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/chat/completions') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          let sys = '', usr = '';
          try { const j = JSON.parse(body); sys = j.messages?.[0]?.content ?? ''; usr = j.messages?.[1]?.content ?? ''; } catch { /* ignore */ }
          send({ id: 'mock-chat', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(llmPayload(sys, usr)) }, finish_reason: 'stop' }] });
        });
        return;
      }
      send({ error: 'mock 404' }, 404);
    });
    srv.listen(0, () => resolve(srv));
  });
}

let app, base, mock, mockBase, dir;

before(async () => {
  mock = await startMock();
  mockBase = `http://127.0.0.1:${mock.address().port}`;
  dir = mkdtempSync(join(tmpdir(), 'hr-test-m4-'));
  app = await createApplication({ storeDir: dir, filesDir: dir, llm: {}, engage: {}, safety: { interval_seconds: [0, 0], daily_cap: 100000, touch_daily_cap: 100000, session_cap: 100000, cooldown_minutes: 0 } });
  app.start(0);
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  app?.instance?.api?.schedule?.dispose();
  app?.instance?.api?.followup?.dispose();
  await new Promise((r) => app.server.close(r));
  await new Promise((r) => mock.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const login = async (username, password) => {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return r.json();
};
const put = (path, body, token) => fetch(base + path, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-auth': token } : {}) }, body: JSON.stringify(body ?? {}) });
const get = (path, token) => fetch(base + path, { ...(token ? { headers: { 'x-auth': token } } : {}) }).then((r) => r.json());
const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-auth': token } : {}) }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('M4 门禁：未登录 401，非管理员无法配置 AI 基座', async () => {
  // 未登录访问状态接口
  assert.equal((await fetch(base + '/api/llm/status')).status, 401, '未登录查询 AI 状态应 401');

  // 管理员登录
  const admin = await loginAdmin(base);
  assert.equal(admin.ok, true, '默认管理员登录成功');

  // 注册一名普通 HR（普通用户）
  const hr = await post('/api/auth/register', { username: 'm4hr', name: 'HR小李', password: 'hraq2026' });
  assert.equal(hr.ok, true, '普通用户注册成功');
  assert.equal(hr.user.role, 'recruiter', '新注册用户为普通用户');

  // 非管理员尝试配置 → 403
  const denied = await put('/api/llm/config', { baseURL: mockBase, model: 'm4-jd-parser' }, hr.token);
  assert.equal(denied.status, 403, '非管理员配置 AI 基座应 403');

  // 非管理员只读接口可访问（非 401/403；配置前无 baseURL → ok=false 属预期）
  const modelsRes = await fetch(base + '/api/llm/models', { headers: { 'x-auth': hr.token } });
  assert.equal(modelsRes.status, 200, '普通用户可只读访问模型列表接口（非 403）');
  const models = await modelsRes.json();
  assert.equal('ok' in models, true, '模型列表接口返回结构完整');
  assert.equal('models' in models, true, '含 models 字段');
});

test('M4 配置：管理员配置 → 探活自动列模型 → 持久化 + 密钥掩码 + 即时生效', async () => {
  const admin = await loginAdmin(base);

  // 配置前：未配置 → ready false / source none
  const before_ = await get('/api/llm/status', admin.token);
  assert.equal(before_.ok, true);
  assert.equal(before_.ready, false, '未配置模型前 ready=false');

  // 管理员用 mock 平台配置 baseURL + model（探活命中 /models）
  const r = await (await put('/api/llm/config', { baseURL: mockBase, apiKey: 'sk-mock-secret-abc123456', model: 'm4-jd-parser' }, admin.token)).json();
  assert.equal(r.ok, true, '管理员配置成功');
  assert.equal(r.models.length, 3, '自动拉取到 3 个模型');
  assert.deepEqual(r.models, MODEL_LIST, '模型列表与平台一致');

  // 状态：ready=true、来源=settings、Key 已掩码（不回传明文）
  const st = await get('/api/llm/status', admin.token);
  assert.equal(st.ready, true, '配置后 LLM ready');
  assert.equal(st.source, 'settings', '来源为设置页持久化');
  assert.equal(st.baseURL, mockBase);
  assert.equal(st.apiKeyMasked.includes('****'), true, 'Key 已掩码');
  assert.equal(st.apiKeyMasked.includes('sk-mock-secret-abc123456'), false, '不回传明文 Key');
  assert.equal(st.hasKey, true);
});

test('M4 三大 AI 功能经新基座跑通：JD 抽词 → 简历抽取 → 深度匹配', { timeout: 60000 }, async () => {
  const admin = await loginAdmin(base);
  const token = admin.token;

  // ① JD 抽词：解析结果与 mock 返回一致（证明走新基座而非离线启发式）
  const jobRes = await fetch(base + '/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth': token }, body: JSON.stringify({ jobId: 'job_m4', jdRaw: '招聘 后端工程师：熟练 Python、Go、SQL。', jobTitle: '后端工程师' }) });
  assert.equal(jobRes.status, 201, 'JD 解析成功');
  const job = await jobRes.json();
  assert.equal(job.keywords.join(','), 'Python,Go,SQL,MySQL', 'JD 抽词来自 mock（新基座返回值）');
  assert.deepEqual(job.hardSkills, ['Python', 'Go', 'SQL'], '硬技能取自 mock');

  // ② 简历抽取 + ③ 深度匹配：走完整流水线（M1 注入候选 → M2 收简历解析 → 事件链触发匹配）
  // 通过 recommend 直供带固定 candidateId 的候选人，供 inbound 引用（确保已注册）
  const r = await post('/api/sourcing/run-pipeline', {
    jobId: 'job_m4',
    candidates: { recommend: [{ candidateId: 'cand_m4', name: '张三', years: 3, skills: ['Python', 'Go', 'MySQL'], rawText: '张三，3年经验，擅长 Python、Go、MySQL。' }], search: [] },
    inbounds: [{ candidateId: 'cand_m4', rawText: '张三，3年经验，擅长 Python、Go、MySQL，本科。', channel: 'boss_chat' }],
  }, token);
  assert.equal(r.ok, true, '流水线执行成功');
  await sleep(400); // 事件链：解析 → 匹配落定

  // 候选人：状态已是已收简历
  const cands = (await get('/candidates', token)).candidates;
  const c = cands.find((x) => x.candidateId === 'cand_m4');
  assert.equal(c.status, 'resume_received', '候选人已收简历');

  // 简历抽取：解析技能来自 mock（new 基座）
  const resumes = (await get('/resumes', token)).resumes;
  const res = resumes.filter((x) => x.candidateId === 'cand_m4').at(-1);
  assert.deepEqual(res.parsed.skills, ['Python', 'Go', 'MySQL'], '简历技能抽取来自 mock');

  // 深度匹配：matchScore 来自 mock（88）
  const matches = (await get('/matches', token)).matches;
  const m = matches.filter((x) => x.candidateId === 'cand_m4').at(-1);
  assert.equal(m.matchScore, 88, '深度匹配得分来自 mock（新基座）');
  assert.equal(m.meta.engine, 'llm', '经 LLM 深度匹配');
});

test('M4 审计：配置变更写审计，actor 为管理员', async () => {
  const admin = await loginAdmin(base);
  const audit = (await get('/api/audit?n=500', admin.token)).audit;
  const entry = audit.filter((a) => a.action === 'ai.base.configure').at(-1);
  assert.ok(entry, '存在 AI 基座配置审计');
  assert.equal(entry.actor, admin.user.id, '审计 actor 为配置人');
  assert.equal(entry.detail?.baseURL, mockBase, '审计记录 baseURL（不含 Key）');
  assert.equal(entry.detail?.modelCount, 3, '审计记录模型数');
});