// Gateway 鉴权 —— 配置令牌后：敏感接口需 Bearer，公开接口放行，audit.actor 取认证身份（防 x-actor 伪造）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../framework/server.js';

let app, base, dir, port;
const TOKEN = 'hr-secret-123';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hr-test-auth-'));
  app = await createApplication({ storeDir: dir, filesDir: dir, llm: {}, auth: { token: TOKEN, actor: 'alice' } });
  app.start(0);
  port = app.server.address().port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  app?.instance?.api?.schedule?.dispose();
  await new Promise((resolve) => app.server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

test('auth：公开路径无需令牌', async () => {
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/modules')).status, 200);
});

test('auth：敏感/数据接口无令牌返回 401', async () => {
  for (const p of ['/candidates', '/jobs', '/matches', '/export/candidates.csv']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 401, `${p} 应返回 401`);
    assert.ok(r.headers.get('www-authenticate')?.includes('Bearer'));
  }
});

test('auth：错误令牌返回 401', async () => {
  const r = await fetch(base + '/candidates', { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(r.status, 401);
});

test('auth：有效 Bearer 令牌可访问敏感接口', async () => {
  const r = await fetch(base + '/candidates', { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).candidates.length, 0);
});

test('auth：X-Auth-Token 头同样被接受', async () => {
  const r = await fetch(base + '/jobs', { headers: { 'X-Auth-Token': TOKEN } });
  assert.equal(r.status, 200);
});

test('auth：audit.actor 取认证身份，而非可伪造的 x-actor 头', async () => {
  // 带正确令牌 + 伪造 x-actor 头
  await fetch(base + '/candidates', { headers: { Authorization: `Bearer ${TOKEN}`, 'x-actor': 'hacker' } });
  const audit = (await (await fetch(base + '/audit', { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).audit;
  const entry = audit.filter((e) => e.action === 'GET /candidates').at(-1);
  assert.equal(entry.actor, 'alice');
  assert.notEqual(entry.actor, 'hacker');
});