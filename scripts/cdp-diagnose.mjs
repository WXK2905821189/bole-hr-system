// CDP 诊断：启动无头 Chrome，加载页面，收集真实控制台异常，检查登录遮罩状态。
// 使用 Node 22 全局 WebSocket（无需从 node:net 导入）。
import { spawn } from 'node:child_process';

const CHROME = 'C:\\Users\\王小棵\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const TARGET = process.env.APP_URL || 'http://127.0.0.1:4700';
const PORT = 9333;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.env.TEMP + '\\cdp_prof', 'about:blank',
  ], { stdio: 'ignore' });

  let targets = [];
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      if (targets.length) break;
    } catch {}
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) { console.log('未找到页面 target'); chrome.kill(); return; }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    const h = (ev) => { try { const m = JSON.parse(ev.data); if (m.id === mid) { ws.removeEventListener('message', h); res(m); } } catch {} };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  const errors = [];
  ws.addEventListener('message', (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') { errors.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); }
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) { errors.push('CONSOLE ' + m.params.type.toUpperCase() + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')); }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') { errors.push('LOG: ' + m.params.entry.text); }
    } catch {}
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: TARGET });
  await sleep(5000);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };

  const loginClass = await evalJs(`(()=>{const el=document.getElementById('loginOverlay');return el?el.className:'NO-EL';})()`);
  const bodyClass = await evalJs(`document.body.className`);
  const health = await evalJs(`document.getElementById('healthTxt')?.textContent||'none'`);
  const footName = await evalJs(`document.getElementById('footName')?.textContent||'none'`);
  const stateRecruiter = await evalJs(`(typeof state==='object'?('recruiter='+state.recruiter+' user='+(state.user?state.user.id:'none')):'state not global')`);
  const activeView = await evalJs(`(()=>{const v=document.querySelector('.view[style*="display"]');const a=[...document.querySelectorAll('.view')].find(x=>getComputedStyle(x).display!=='none');return a?a.id:'none-probe';})()`);

  console.log('=== 页面状态 ===');
  console.log('loginOverlay.className =', loginClass);
  console.log('body.className =', bodyClass);
  console.log('healthTxt =', health);
  console.log('footName =', footName);
  console.log('state =', stateRecruiter);
  console.log('activeView =', activeView);
  console.log('=== console/异常捕获 ===');
  if (errors.length) errors.slice(0, 40).forEach((e) => console.log(e));
  else console.log('（未捕获到 console 错误）');

  await send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  ws.close();
  chrome.kill();
}
main().catch((e) => { console.error('CDP诊断失败:', e.message); process.exit(1); });