// 测试辅助：自 Phase-1 #2「首登强制改密」起，默认弱口令账号（wang/boss123）登录后被受限门禁拦截。
// 需要访问管理接口的用例必须先解锁该账号。本辅助把「登录 + 若须改密则改为合规口令」封装为幂等操作：
// 优先用旧口令，失败则回退到上次改密后的口令，保证同文件多次调用不缺、不重。
import assert from 'node:assert/strict';

export const WANG_UNLOCK_PW = 'Passw0rd123!';

export async function loginAdmin(base) {
  for (const pw of ['boss123', WANG_UNLOCK_PW]) {
    const body = await (
      await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'wang', password: pw }),
      })
    ).json();
    if (body?.token) {
      if (body.mustChangePw) {
        const chg = await fetch(base + '/api/users/A1/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-auth': body.token },
          body: JSON.stringify({ old: pw, password: WANG_UNLOCK_PW }),
        });
        assert.equal(chg.status, 200, '默认管理员解锁改密应成功');
        const rel = await (
          await fetch(base + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'wang', password: WANG_UNLOCK_PW }),
          })
        ).json();
        assert.ok(rel.token, '改密后应能重新登录');
        return rel;
      }
      return body;
    }
  }
  return { ok: false, error: '未能登录并解锁默认管理员账号 wang' };
}