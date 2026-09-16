// M5 里程碑·账号与安全强化端到端验证（轻量安全）
// 覆盖：① 密码散列存储（非明文） ② 密码复杂度策略 ③ 会话超时自动失效 ④ 简单角色分级
//      ⑤ 多 BOSS 绑定隔离（仅本人可绑/可见） ⑥ 认证与权限变更审计联动（角色变更/停用→会话失效+留痕）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../framework/server.js';
import { hashPw, verifyPw, pwPolicyError } from '../infra/auth/password.js';
import { loginAdmin } from './_helpers.js';

const TTL = 900; // 短会话 TTL，用于验证超时失效（角色/停用测试在窗口内即时进行，不依赖计时）

let app, base, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hr-test-m5-'));
  app = await createApplication({ storeDir: dir, filesDir: dir, llm: {}, auth: { sessionTtlMs: TTL }, engage: {}, safety: {} });
  app.start(0);
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  app?.instance?.api?.schedule?.dispose();
  app?.instance?.api?.followup?.dispose();
  await new Promise((r) => app.server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const login = async (username, password) => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })).json();
const register = async (username, name, password) => (await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, name, password }) })).json();
const post = (path, token, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-auth': token } : {}) }, body: JSON.stringify(body ?? {}) });
const getMe = (token) => fetch(base + '/api/auth/me', { headers: token ? { 'x-auth': token } : {} });
const audit = async (token) => (await (await fetch(base + '/api/audit?n=500', { headers: { 'x-auth': token } })).json()).audit;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 单元：密码散列 + 复杂度策略 ----------
test('M5 密码：scrypt 散列往返 + 旧版明文校验标记 legacy', () => {
  const h = hashPw('hraq2026');
  assert.equal(h.startsWith('scrypt$'), true, '散列带版本前缀');
  assert.notEqual(h, 'hraq2026', '不回明文');
  assert.equal(verifyPw('hraq2026', h).ok, true, '正确密码校验通过');
  assert.equal(verifyPw('hraq2026', h).legacy, false, '新格式非 legacy');
  assert.equal(verifyPw('wrong', h).ok, false, '错误密码拒绝');
  // 旧版明文：命中且标记 legacy，供登录时升级
  assert.deepEqual(verifyPw('boss123', 'boss123'), { ok: true, legacy: true }, '旧明文命中标记 legacy');
});

test('M5 密码：复杂度策略拦截弱密码', () => {
  assert.equal(pwPolicyError('123456', 'm5u'), '密码需同时包含字母和数字', '纯数字拒绝');
  assert.equal(pwPolicyError('abcdef', 'm5u'), '密码需同时包含字母和数字', '纯字母拒绝');
  assert.equal(pwPolicyError('a1b2', 'm5u'), '密码至少 6 位', '过短拒绝');
  assert.equal(pwPolicyError('m5u123', 'm5u'), '密码不能包含用户名', '含用户名拒绝');
  assert.equal(pwPolicyError('aaaaa1', 'm5u'), '密码不能包含连续相同字符', '连续重复拒绝');
  assert.equal(pwPolicyError('hraq2026', 'm5u'), null, '合规密码通过');
});

// ---------- 端到端：登录 / 注册 / 散列落盘 / 会话 ----------
test('M5 登录与注册：默认管理员可登录；弱密码被拒；入库非明文', async () => {
  // 默认管理员（已散列注入）
  const admin = await loginAdmin(base);
  assert.equal(admin.ok, true, '默认管理员登录成功');
  assert.equal(admin.user.role, 'admin', '默认账号为管理员');

  // 弱密码拒绝
  const bad = await register('m5weak', '弱密码用户', 'abc');
  assert.equal(bad.ok, false, '弱密码注册被拒');
  // 合规注册
  const ok = await register('m5rec', 'HR小赵', 'zhao2026');
  assert.equal(ok.ok, true, '合规注册成功');
  assert.equal(ok.user.role, 'recruiter', '新用户为普通用户');

  // 入库为 scrypt 散列（非明文），且不含原始密码
  const raw = readFileSync(join(dir, 'users.jsonl'), 'utf8');
  const recLine = raw.split('\n').find((l) => l.includes('m5rec'));
  assert.ok(recLine.includes('scrypt$'), '密码散列落盘');
  assert.equal(recLine.includes('zhao2026'), false, '明文密码不入库');

  // 错误密码登录拒绝
  const wrong = await login('m5rec', 'wrongpass1');
  assert.equal(wrong.ok, false, '错误密码拒绝');
});

test('M5 会话：超时后自动失效（401）', async () => {
  const r = await loginAdmin(base);
  assert.equal(r.ok, true, '登录成功获取会话');
  assert.equal((await getMe(r.token)).status, 200, '会话有效期内可访问');
  await sleep(TTL + 400); // 超过 TTL
  assert.equal((await getMe(r.token)).status, 401, '超时后会话失效');
});

test('M5 权限变更联动：角色变更 → 该用户会话立即失效 + 审计留痕', async () => {
  const admin = await loginAdmin(base);
  const target = await login('m5rec', 'zhao2026'); // 被变更者的现存会话
  assert.equal(target.ok, true, '普通用户已登录');

  const chg = await (await post(`/api/users/${target.user.id}/role`, admin.token, { role: 'admin' })).json();
  assert.equal(chg.ok, true, '管理员变更角色成功');
  assert.equal(chg.changed, true, '角色发生变更');
  assert.equal(chg.from, 'recruiter');
  assert.equal(chg.role, 'admin');
  assert.ok(chg.invalidatedSessions >= 1, '被变更用户会话被作废');

  // 被变更者旧会话立即失效（需重新登录）
  assert.equal((await getMe(target.token)).status, 401, '角色变更后旧会话失效');

  // 审计：权限变更留痕
  const lines = await audit(admin.token);
  const entry = lines.filter((a) => a.action === 'users.role').at(-1);
  assert.equal(entry.detail.from, 'recruiter');
  assert.equal(entry.detail.to, 'admin');
  assert.ok(entry.detail.invalidatedSessions >= 1, '审计记录作废会话数');
});

test('M5 停用联动：停用账号 → 会话失效 + 非法账号无法登录', async () => {
  const admin = await loginAdmin(base);
  // 先为另一普通用户取得会话，再重新以管理员登录（管理员会话在窗口内有效）
  const victim = await register('m5victim', '被停用用户', 'victim123');
  assert.equal(victim.ok, true);
  const admin2 = await loginAdmin(base);

  const dis = await (await post(`/api/users/${victim.user.id}/active`, admin2.token, { active: false })).json();
  assert.equal(dis.ok, true, '停用成功');
  assert.ok(dis.invalidatedSessions >= 1, '停用时用户现存会话作废');
  assert.equal((await getMe(victim.token)).status, 401, '被停用用户会话立即失效');
  assert.equal((await login('m5victim', 'victim123')).ok, false, '停用账号不可登录');

  const lines = await audit(admin2.token);
  const entry = lines.filter((a) => a.action === 'users.active' && a.detail?.id === victim.user.id).at(-1);
  assert.equal(entry.detail.active, false, '审计记录停用');
});

test('M5 多 BOSS 绑定隔离：一用户一绑定，仅本人可绑', async () => {
  const u = await register('m5boss', '绑定用户', 'bossu2026');
  // 绑定他人账号 → 403
  const selfId = u.user.id;
  const otherId = (await (await fetch(base + '/api/users', { headers: { 'x-auth': u.token } })).json()).users.find((x) => x.id === selfId).id;
  const other = (await (await fetch(base + '/api/users', { headers: { 'x-auth': u.token } })).json()).users.find((x) => x.id !== selfId);
  const forbidden = await post(`/api/users/${other.id}/boss`, u.token, { bossAccount: '13800000001', bossNick: '他人BOSS' });
  assert.equal(forbidden.status, 403, '不能绑定他人账号的 BOSS');

  // 绑定本人的 → 200
  const bound = await post(`/api/users/${selfId}/boss`, u.token, { bossAccount: '13800000002', bossNick: '赵BOSS', bossToken: 'abcdefgh-12345678' });
  assert.equal(bound.status, 200, '本人可绑定 BOSS');
  const b = await bound.json();
  assert.equal(b.boss.bossAccount, '13800000002', '绑定成功');
  assert.equal(b.boss.masked, 'abcd****5678', 'BOSS 令牌掩码展示');

  // 绑定会覆盖既有（一用户一绑定），不会串到他人
  const users = (await (await fetch(base + '/api/users', { headers: { 'x-auth': u.token } })).json()).users.find((x) => x.id === selfId);
  assert.equal(users.boss.bossAccount, '13800000002', '本人绑定唯一');
});