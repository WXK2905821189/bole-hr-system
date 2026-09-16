// 扫码登录 BOSS：拉起一个可见的浏览器窗口（优先系统 Edge）直接打开 BOSS 网页登录页，
// 用户在窗口里扫码/输密码登录；后端仅通过浏览器级 CDP 通道读取 cookie，
// 合并成 cookie 串写回 bossbindings，实现“拉起 BOSS 界面自动复用登录态”。
// 白屏教训（2026-09-11）：曾用 about:blank 启动 + Runtime/Page/Network.enable + Page.navigate，
// BOSS 风控 JS 能探测到 CDP 域启用，页面加载后即被清空成白屏。
// 现改为：①命令行直接带登录页 URL 启动（零 CDP 导航）②不启用任何 CDP 域
// ③cookie 读取走浏览器级 Storage.getCookies（对页面完全无感知），失败才降级页面级。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// 优先使用系统 Edge（较新 Chromium 内核），可用环境变量 HR_BOSS_CHROME 强制指定其它浏览器。
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const FALLBACK_CHROME = 'C:\\Users\\王小棵\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
function resolveChrome() {
  if (process.env.HR_BOSS_CHROME) return process.env.HR_BOSS_CHROME;
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p;
  return FALLBACK_CHROME;
}
const BOSS_LOGIN_URL = 'https://www.zhipin.com/web/user/?ka=header-login';
// BOSS 常见会话 cookie；命中即视为已登录，降低依赖单站点 DOM 的脆弱性
const KNOWN_SESSION = ['zp_stoken', 'zp_boss_zp_stoken', 'wt2', 'LAST_LOGIN', 'zpd_uid', 'zploc', 'LGRID', 'teid'];
const COOKIE_CAP = 12; // 已登录态通常会在 zhipin 域名下写入大量 cookie 的兜底阈值

const isZhipin = (c) => /zhipin\.com/i.test(String(c?.domain ?? ''));

export function detectLoggedIn(cookies = []) {
  const z = cookies.filter(isZhipin);
  const keys = z.map((c) => c.name);
  const byKnown = keys.some((k) => KNOWN_SESSION.includes(k));
  const byCap = z.length >= COOKIE_CAP;
  return { loggedIn: byKnown || byCap, zCount: z.length, byKnown, byCap, keys };
}

export function buildCookieString(cookies = []) {
  return cookies.filter(isZhipin).map((c) => `${c.name}=${c.value}`).join('; ');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCookieString(str = '') {
  return String(str).split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    if (i <= 0) return null;
    return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: '.zhipin.com', path: '/' };
  }).filter(Boolean);
}

export class BossScanManager {
  constructor(opts = {}) {
    this.chromePath = opts.chromePath || resolveChrome();
    this.sessions = new Map();
    this.onLogin = opts.onLogin || null; // async (session) => void，登录成功后回调持久化
    this._port = 9400;
  }

  start(userId, opts = {}) {
    this.stop(userId);
    const port = ++this._port;
    const url = opts.url || BOSS_LOGIN_URL;
    const reuse = !!opts.cookies; // reuse 模式：拉起网页端并注入已保存的会话凭证
    // 直接带登录页 URL 启动可见窗口；参数保持最小且自然，不加任何自动化痕迹标记
    const chrome = spawn(this.chromePath, [
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-blink-features=AutomationControlled',
      `--window-size=1180,840`,
      `--remote-debugging-port=${port}`,
      '--user-data-dir=' + process.env.TEMP + `\\boss_scan_${userId}_${Date.now()}`,
      url,
    ], { stdio: 'ignore' });

    const s = {
      userId, chrome, port, url, status: 'opening', loggedIn: false, cookieCount: 0, cookieString: '',
      lastErr: '', persisted: false, ws: null, send: null, cookieFn: null, startedAt: Date.now(),
      reuse, injectCookies: parseCookieString(opts.cookies || ''),
    };
    s.bootstrap = this.#connect(s)
      .then(() => (reuse ? this.#reuseSession(s) : null))
      .catch((e) => { s.status = 'error'; s.lastErr = String(e?.message ?? e); });
    this.sessions.set(String(userId), s);
    chrome.once('exit', () => { if (s.status !== 'closed') { s.status = 'closed'; s.loggedIn = false; } });
    return { ok: true, sessionId: String(userId), pid: chrome.pid, reuse };
  }

  // 拉起网页端：注入已保存 cookie 后，用浏览器级 Target 域开新标签页加载招聘端
  // （不启用 Page/Runtime/Network 域，规避风控 JS 对 CDP 的探测）
  async #reuseSession(s) {
    if (!s.injectCookies.length) return;
    try { await s.send('Storage.setCookies', { cookies: s.injectCookies }); } catch {}
    const t = await s.send('Target.createTarget', { url: s.url });
    const newId = t?.result?.targetId;
    if (newId) {
      try {
        const list = await s.send('Target.getTargets');
        for (const ti of list?.result?.targetInfos || []) {
          if (ti.targetId !== newId && ti.type === 'page' && /zhipin\.com/.test(ti.url)) {
            await s.send('Target.closeTarget', { targetId: ti.targetId }).catch(() => {});
          }
        }
      } catch {}
    }
  }

  async poll(sessionId) {
    const s = this.sessions.get(String(sessionId));
    if (!s) return { ok: false, error: '扫码会话不存在或已结束' };
    if (s.status === 'closed') { // 用户已关闭浏览器窗口
      this.sessions.delete(String(sessionId));
      return { ok: true, status: 'closed', loggedIn: false, cookieCount: 0, persisted: false, err: '' };
    }
    if (s.status === 'error') return { ok: false, error: s.lastErr || '扫码会话异常' };
    if (!s.cookieFn) await s.bootstrap.catch(() => {});
    if (!s.cookieFn) return { ok: false, error: '浏览器连接建立中，请稍候再试' };
    if (s.status === 'opening') s.status = 'waiting';
    if (s.status !== 'logged_in') {
      let cookies = [];
      try { cookies = await s.cookieFn(); } catch { return { ok: false, error: '读取浏览器会话状态失败' }; }
      const d = detectLoggedIn(cookies);
      s.cookieCount = d.zCount;
      if (d.loggedIn && !s.loggedIn && !s.persisted) {
        s.loggedIn = true;
        s.cookieString = buildCookieString(cookies);
        try {
          if (this.onLogin) await this.onLogin(s);
          s.persisted = true; s.status = 'logged_in';
        } catch (e) {
          s.lastErr = String(e?.message ?? e); s.loggedIn = false; s.cookieString = '';
          return { ok: false, error: s.lastErr };
        }
      }
    }
    return { ok: true, status: s.status, loggedIn: s.loggedIn, cookieCount: s.cookieCount, persisted: s.persisted, reuse: !!s.reuse, err: s.lastErr || '' };
  }

  stop(sessionId) {
    const s = this.sessions.get(String(sessionId));
    if (!s) return;
    s.status = 'closed';
    try { s.ws?.close(); } catch {}
    try { s.chrome?.kill(); } catch {}
    this.sessions.delete(String(sessionId));
  }

  killAll() { [...this.sessions.keys()].forEach((id) => this.stop(id)); }

  async #connect(s) {
    // 优先连浏览器级端点（/json/version），对页面零干扰
    let ver = null;
    for (let i = 0; i < 50; i++) {
      await wait(300);
      try { ver = await (await fetch(`http://127.0.0.1:${s.port}/json/version`)).json(); if (ver?.webSocketDebuggerUrl) break; } catch {}
    }
    if (!ver?.webSocketDebuggerUrl) throw new Error('浏览器调试端口未就绪');
    await this.#attach(s, ver.webSocketDebuggerUrl);
    try { await this.#probe(s); return; } catch {}
    // 浏览器级取 cookie 不可用时，降级连页面级（仍不启用任何域）
    const targets = await (await fetch(`http://127.0.0.1:${s.port}/json`)).json();
    const page = targets.find((t) => t.type === 'page' && /zhipin\.com/.test(t.url))
      || targets.find((t) => t.type === 'page' && /^https?:/.test(t.url))
      || targets.find((t) => t.type === 'page');
    if (!page?.webSocketDebuggerUrl) throw new Error('未找到浏览器页面');
    await this.#attach(s, page.webSocketDebuggerUrl);
    await this.#probe(s);
  }

  async #attach(s, wsUrl) {
    try { s.ws?.close(); } catch {}
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const send = (method, params = {}) => new Promise((res) => {
      const mid = ++id;
      const h = (ev) => { try { const m = JSON.parse(ev.data); if (m.id === mid) { ws.removeEventListener('message', h); res(m); } } catch {} };
      ws.addEventListener('message', h);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    ws.addEventListener('close', () => { if (s.status !== 'closed' && s.status !== 'logged_in') s.status = 'error'; });
    s.ws = ws; s.send = send;
  }

  // 探测可用的 cookie 读取通道：Storage.getCookies 与 Network.getAllCookies 都无需启用对应域
  async #probe(s) {
    let r = await s.send('Storage.getCookies');
    if (r?.result?.cookies) { s.cookieFn = async () => (await s.send('Storage.getCookies'))?.result?.cookies || []; return; }
    r = await s.send('Network.getAllCookies');
    if (r?.result?.cookies) { s.cookieFn = async () => (await s.send('Network.getAllCookies'))?.result?.cookies || []; return; }
    throw new Error('无法读取浏览器 cookie');
  }
}
