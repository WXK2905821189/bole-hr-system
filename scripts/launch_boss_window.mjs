// 一次性拉起脚本：复用系统保存的最新 BOSS 会话 cookie 打开 /web/chat/index 聊天窗口。
// 用于给聊天页选择器校准提供活的浏览器。等价于系统中「拉起 BOSS 网页端」的 reuse 模式。
import { BossScanManager } from '../framework/core/bossScan.js';
import { readFileSync } from 'node:fs';

const bindings = readFileSync('infra/store/bossbindings.jsonl', 'utf-8')
  .split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
const bind = bindings[bindings.length - 1] ?? bindings[0];
if (!bind?.bossToken) { console.log('无可用 BOSS cookie'); process.exit(1); }

const mgr = new BossScanManager();
const r = mgr.start(bind.userId, {
  url: 'https://www.zhipin.com/web/chat/index',
  cookies: bind.bossToken,
});
console.log('拉起:', JSON.stringify(r));
const port = mgr.sessions.get(String(bind.userId)).port;
console.log('PORT=' + port);
// 常驻：保持 manager 存活使 chrome 不被回收，直到收到终止信号
const term = () => { mgr.stop(String(bind.userId)); process.exit(0); };
process.on('SIGINT', term); process.on('SIGTERM', term);
// 轮询打印状态但不退出
const started = Date.now();
setInterval(async () => {
  try {
    const s = await mgr.poll(String(bind.userId));
    console.log('LOGINED=' + (s.loggedIn ? '1' : '0') + ' status=' + s.status + ' cookies=' + s.cookieCount);
  } catch (e) { console.log('ERR ' + String(e?.message ?? e)); }
  if (Date.now() - started > 60000) {
    const s = mgr.sessions.get(String(bind.userId));
    if (!s || !s.loggedIn) { try { mgr.stop(String(bind.userId)); } catch {} console.log('拉起超时'); process.exit(1); }
  }
}, 3000);