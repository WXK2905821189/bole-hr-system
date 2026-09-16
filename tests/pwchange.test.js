// M5 · 首登强制改密 —— 默认账号/弱口令 boss123 须改密后解锁：未改密受限、改密后解除
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../framework/server.js';

const TOKEN = 'hr-secret-123';
const NEW_PW = 'Passw0rd123!';
const started = [];

function makeApp(baseName) {
  return mkdtempSync(join(tmpdir(), baseName));
}

async function spawnApp(dir) {
  const app = await createApplication({ storeDir: dir, filesDir: dir, llm: {}, auth: { token: TOKEN, actor: 'tester' } });
  app.start(0);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  started.push(app);
  return { app, base };
}

async function login(base, username, password) {
  return fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ username, password }),
  });
}

after(async () => {
  for (const app of started) {
    app.instance?.api?.schedule?.dispose?.();
    await new Promise((resolve) => app.server.close(resolve));
  }
  while (started.length) rmSync(started.pop()._dir, { recursive: true, force: true });
});

test('首登强制改密：默认 boss123 账号登录返回 mustChangePw=true，业务接口受限', async () => {
  const dir = makeApp('hr-test-pwchange-');
  const { app, base } = await spawnApp(dir);
  started[started.length - 1]._dir = dir;

  const r = await login(base, 'wang', 'boss123');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.mustChangePw, true);           // 登录响应标记首登改密
  assert.equal(body.user.mustChangePw, true);      // 用户信息同步暴露
  const token = body.token;

  // 未改密：用户会话被门禁拦截 → /api/users 返回 401
  const blocked = await fetch(base + '/api/users', {
    headers: { Authorization: `Bearer ${TOKEN}`, 'x-auth': token },
  });
  assert.equal(blocked.status, 401, '未改密的账号业务接口应被受限');

  // 未改密：/api/auth/me 放行，能识别身份（供前端重定向改密）
  const me = await fetch(base + '/api/auth/me', {
    headers: { Authorization: `Bearer ${TOKEN}`, 'x-auth': token },
  });
  assert.equal(me.status, 200);
  const meBody = await me.json();
  assert.equal(meBody.user.mustChangePw, true);

  // 改密成功 → 解除受限
  const chg = await fetch(base + '/api/users/A1/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'x-auth': token },
    body: JSON.stringify({ old: 'boss123', password: NEW_PW }),
  });
  assert.equal(chg.status, 200, (await chg.json()).error ?? '改密应成功');

  // 同一会话现在可访问业务接口，且 mustChangePw 已清除
  const afterBlocked = await fetch(base + '/api/users', {
    headers: { Authorization: `Bearer ${TOKEN}`, 'x-auth': token },
  });
  assert.equal(afterBlocked.status, 200);
  const meAfter = await (await fetch(base + '/api/auth/me', {
    headers: { Authorization: `Bearer ${TOKEN}`, 'x-auth': token },
  })).json();
  assert.equal(meAfter.user.mustChangePw, false);

  // 重登新口令不再要求改密
  const relogin = await login(base, 'wang', NEW_PW);
  assert.equal(relogin.status, 200);
  assert.equal((await relogin.json()).mustChangePw, false);
});

test('启动弱口令检查：既有 boss123（旧明文）账号被自动补标 mustChangePw，需改密解锁', async () => {
  const dir = makeApp('hr-test-pwweak-');
  // 预置一个使用 boss123 且未标记的用户（模拟历史部署，旧明文）
  writeFileSync(join(dir, 'users.jsonl'), JSON.stringify({ id: 'A1', username: 'wang', name: '王先生', password: 'boss123', role: 'admin', active: true }) + '\n', 'utf8');
  const { app, base } = await spawnApp(dir);
  started[started.length - 1]._dir = dir;

  const r = await login(base, 'wang', 'boss123');
  assert.equal(r.status, 200);
  const body = await r.json();
  // 启动扫描已把 boss123 账号补标 → 登录仍要求改密
  assert.equal(body.mustChangePw, true);
  const blocked = await fetch(base + '/api/users', {
    headers: { Authorization: `Bearer ${TOKEN}`, 'x-auth': body.token },
  });
  assert.equal(blocked.status, 401);
});