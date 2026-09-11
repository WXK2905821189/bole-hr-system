// CDP 登录闭环测试：加载页面 → 确认登录页优先 → 填写并提交登录 → 验证进入总览且可点击模块。
import { spawn } from 'node:child_process';

const CHROME = 'C:\\Users\\王小棵\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const TARGET = process.env.APP_URL || 'http://127.0.0.1:4700';
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.env.TEMP + '\\cdp_login_test', 'about:blank',
  ], { stdio: 'ignore' });

  let targets = [];
  for (let i = 0; i < 30; i++) { await sleep(300); try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break; } catch {} }
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
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };

  const errors = [];
  ws.addEventListener('message', (ev) => {
    try { const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') errors.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      if (m.method === 'Runtime.consoleAPICalled' && ['error'].includes(m.params.type)) errors.push('CONSOLE ERR: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    } catch {}
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: TARGET });
  await sleep(1500);
  // 清空本地登录态并重载，模拟“从未登录过”打开网页
  await evalJs(`try{localStorage.removeItem('hr_token');}catch(e){} true`);
  await send('Page.reload');
  await sleep(1200);

  // 轮询等待 boot() 完成（最长 12s），避免与首屏加载竞态
  let loginOpen = false;
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    loginOpen = await evalJs(`(()=>{const el=document.getElementById('loginOverlay');return !!el && el.classList.contains('open');})()`);
    if (loginOpen) break;
  }
  console.log('1) 打开页面 → 登录遮罩已弹出？', loginOpen);
  if (!loginOpen) {
    const probe = await evalJs(`(()=>{
      const ov=document.getElementById('loginOverlay');
      const vis=[...document.querySelectorAll('.view')].filter(v=>getComputedStyle(v).display!=='none').map(v=>v.id);
      const footA=document.getElementById('footAva')?.textContent;
      let token=''; try{token=localStorage.getItem('hr_token')||'(null)';}catch(e){token='err';}
      return {
        ovClass: ov?.className||'NO-EL',
        token,
        footName: document.getElementById('footName')?.textContent||'none',
        footAva: footA,
        health: document.getElementById('healthTxt')?.textContent||'none',
        visibleViews: vis,
        bodyClass: document.body.className
      };
    })()`);
    console.log('   页面探针 =', JSON.stringify(probe, null, 2));
    console.log('--- 网页 JS 异常 ---');
    if (errors.length) errors.slice(0, 20).forEach((e) => console.log(e)); else console.log('（无 JS 异常）');
    cleanup();
    return;
  }

  // 提交登录表单（wang / boss123）
  const submitRes = await evalJs(`(async()=>{
    document.getElementById('loginUser').value='wang';
    document.getElementById('loginPass').value='boss123';
    document.getElementById('loginForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
    await new Promise(r=>setTimeout(r,1500));
    return {
      overlayOpen: document.getElementById('loginOverlay').classList.contains('open'),
      footName: document.getElementById('footName').textContent,
      err: document.getElementById('loginErr')?.textContent||''
    };
  })()`);
  console.log('2) 提交登录后 →', JSON.stringify(submitRes));

  const stateProbe = await evalJs(`(async()=>{
    async function clickNav(href){
      const a=document.querySelector('aside a[href="'+href+'"]'); if(!a) return 'no-link';
      a.click(); await new Promise(r=>setTimeout(r,400)); return document.querySelector('.view[style*="display"]:not([style*="none"]), .view'); 
    }
    // 找出当前可见视图
    let visible='';
    document.querySelectorAll('.view').forEach(v=>{ if(getComputedStyle(v).display!=='none') visible=v.id; });
    return { visible, recruiter:(typeof state!=='undefined'?state.recruiter:'--') };
  })()`);
  console.log('3) 登录后视图 =', JSON.stringify(stateProbe));

  // 尝试点击一个侧边栏模块，确认可跳转
  const navRes = await evalJs(`(async()=>{
    const a = document.querySelector('.navitem[data-view="candidates"]');
    if(!a) return '未找到候选人模块链接';
    a.click(); await new Promise(r=>setTimeout(r,500));
    let active='none';
    document.querySelectorAll('.view').forEach(v=>{ if(v.classList.contains('active')) active=v.id; });
    return { clicked: a.textContent.trim().replace(/\\d+$/,'').trim(), activeView: active };
  })()`);
  console.log('4) 点击“候选人库”模块 →', JSON.stringify(navRes));

  console.log('--- 网页 JS 异常 ---');
  if (errors.length) errors.slice(0, 20).forEach((e) => console.log(e)); else console.log('（无 JS 异常）');

  await send('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  ws.close();
  chrome.kill();
  function cleanup() { try { ws.close(); } catch {} chrome.kill(); }
}
main().catch((e) => { console.error('测试失败:', e.message); process.exit(1); });