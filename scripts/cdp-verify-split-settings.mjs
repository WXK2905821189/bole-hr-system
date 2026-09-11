// CDP 验证：候选人库/人才库拆分 + 「我的账号与 BOSS 绑定」界面美化
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:\\Users\\王小棵\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const TARGET = process.env.APP_URL || 'http://127.0.0.1:4700';
const PORT = 9335;
const SHOT_DIR = process.env.TEMP + '\\hrmod_shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.env.TEMP + '\\cdp_verify_split', 'about:blank',
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
  const shot = async (name) => {
    try {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      if (r.result?.data) { writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(r.result.data, 'base64')); return `${SHOT_DIR}\\${name}.png`; }
    } catch {}
    return '截图失败';
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
  await evalJs(`try{localStorage.removeItem('hr_token');}catch(e){} true`);
  await send('Page.reload');
  await sleep(1200);

  // 等登录遮罩
  let loginOpen = false;
  for (let i = 0; i < 24; i++) { await sleep(500); loginOpen = await evalJs(`(()=>{const el=document.getElementById('loginOverlay');return !!el && el.classList.contains('open');})()`); if (loginOpen) break; }
  console.log('1) 打开页面 → 登录遮罩弹出 =', loginOpen);
  await evalJs(`document.getElementById('loginUser').value='wang'; document.getElementById('loginPass').value='boss123'; document.getElementById('loginForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})); true;`);
  await sleep(1600);

  // 2) 侧边栏菜单
  const nav = await evalJs(`(()=>{
    const items=[...document.querySelectorAll('.navitem')].map(b=>({view:b.dataset.view,txt:b.textContent.trim().replace(/[0-9]+$/,'').trim()}));
    return { items: items.filter(x=>['overview','jobs','schedule','candidates','talent','engage','settings'].includes(x.view)),
      hasCand: !!document.querySelector('.navitem[data-view="candidates"]'),
      hasTalent: !!document.querySelector('.navitem[data-view="talent"]'),
      hasSettings: !!document.querySelector('.navitem[data-view="settings"]') };
  })()`);
  console.log('2) 侧边栏 =', JSON.stringify(nav));

  // 3) 人才库
  await evalJs(`(()=>{const b=document.querySelector('.navitem[data-view="talent"]'); if(b)b.click(); return true;})()`); await sleep(600);
  const talent = await evalJs(`(()=>{
    const v=document.getElementById('v-talent');
    const selects=[...v.querySelectorAll('select')].map(s=>s.id||s.name);
    const jobLike=selects.filter(x=>/job/i.test(x));
    return { title: v.querySelector('h2')?.textContent||'',
      hint: v.querySelector('.hint')?.textContent||'',
      selectIds: selects,
      hasJobFilter: jobLike.length>0,
      rows: v.querySelectorAll('#talentTbody tr').length,
      empty: !!(v.querySelector('#talentTbody .empty')) };
  })()`);
  console.log('3) 人才库 =', JSON.stringify(talent));
  await shot('talent_view');

  // 4) 候选人库
  await evalJs(`(()=>{const b=document.querySelector('.navitem[data-view="candidates"]'); if(b)b.click(); return true;})()`); await sleep(600);
  const cand = await evalJs(`(()=>{
    const v=document.querySelector('.view.active');
    const jobSelects=[...v.querySelectorAll('select')].map(s=>s.id).filter(x=>/job/i.test(x));
    return { activeView: v?.id||'', jobSelects };
  })()`);
  console.log('4) 候选人库 job 筛选 =', JSON.stringify(cand));

  // 5) 设置页（准入与护栏）
  await evalJs(`(()=>{const b=document.querySelector('.navitem[data-view="settings"]'); if(b)b.click(); return true;})()`); await sleep(700);
  const settings = await evalJs(`(()=>{
    const root=document.querySelector('.view.active')||document.querySelector('.view');
    const g=(id)=>{const el=document.getElementById(id); return el?el.textContent.trim():null;};
    return {
      activeView: root?.id||'',
      avatar: g('profileAvatar'), name: g('profileName'), uid: g('accUsername'), accId: g('accId'),
      boundTag: g('boundTag'), bossAcc: !!document.getElementById('bossAcc'),
      bossNick: !!document.getElementById('bossNick'), bossTok: !!document.getElementById('bossTok'),
      bossNote: document.querySelector('.bossnote .bn-txt')?.textContent||'',
      pwdOld: !!document.getElementById('pwdOld'), pwdNew: !!document.getElementById('pwdNew'),
      saveBtn: document.getElementById('btnSaveBoss')?.textContent||'',
      gridClass: document.getElementById('settingsGrid')?.className||''
    };
  })()`);
  console.log('5) 设置-BOSS绑定 =', JSON.stringify(settings));
  await shot('settings_view');

  console.log('--- 网页 JS 异常 ---');
  if (errors.length) errors.slice(0, 15).forEach((e) => console.log(e)); else console.log('（无 JS 异常）');
  console.log('截图目录 =', SHOT_DIR);

  await send('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  ws.close(); chrome.kill();
}
main().catch((e) => { console.error('测试失败:', e.message); process.exit(1); });
