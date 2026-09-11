// 扫码登录 BOSS：用可控的无头 Chromium 打开 BOSS 网页版登录页，
// 把二维码画面转发给前端 → 用户用手机 BOSS App 扫码 → 捕获登录后下发到 www.zhipin.com 的会话 cookie，
// 合并成 cookie 串写回 bossbindings，实现“扫码自动复用登录态”。
// 说明：BOSS 无开放登录 API，本模块复用其网页版扫码流程（属账号自动化）。
import { spawn } from 'node:child_process';

const DEFAULT_CHROME = 'C:\\Users\\王小棵\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const BOSS_LOGIN_URL = 'https://www.zhipin.com/web/user/?ka=header-login';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
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

export class BossScanManager {
  constructor(opts = {}) {
    this.chromePath = opts.chromePath || process.env.HR_BOSS_CHROME || DEFAULT_CHROME;
    this.sessions = new Map();
    this.onLogin = opts.onLogin || null; // async (session) => void，登录成功后回调持久化
    this._port = 9400;
  }

  start(userId, opts = {}) {
    this.stop(userId);
    const port = ++this._port;
    const url = opts.url || BOSS_LOGIN_URL;
    const chrome = spawn(this.chromePath, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--mute-audio',
      '--window-size=420,720', `--user-agent=${UA}`,
      `--remote-debugging-port=${port}`,
      '--user-data-dir=' + process.env.TEMP + `\\boss_scan_${userId}_${Date.now()}`,
      'about:blank',
    ], { stdio: 'ignore' });

    const s = {
      userId, chrome, port, url, status: 'opening', loggedIn: false, cookieCount: 0, cookieString: '',
      lastImg: '', lastErr: '', persisted: false, ws: null, send: null, startedAt: Date.now(),
    };
    s.bootstrap = this.#connect(s).then(() => this.#drive(s)).catch((e) => { s.status = 'error'; s.lastErr = String(e?.message ?? e); });
    this.sessions.set(String(userId), s);
    chrome.once('exit', () => { if (s.status !== 'closed') { s.status = 'closed'; s.loggedIn = false; } });
    return { ok: true, sessionId: String(userId), pid: chrome.pid };
  }

  async poll(sessionId) {
    const s = this.sessions.get(String(sessionId));
    if (!s) return { ok: false, error: '扫码会话不存在或已结束' };
    if (s.status === 'error') return { ok: false, error: s.lastErr || '扫码会话异常' };
    if (!s.send) await s.bootstrap.catch(() => {});
    if (!s.send) return { ok: false, error: '浏览器未就绪（缺少 Chromium？）' };
    if (s.status === 'opening') s.status = 'waiting';
    if (s.status !== 'logged_in') {
      try { s.lastImg = await this.#shot(s); } catch {}
      let cookies = [];
      try { cookies = await this.#cookies(s); } catch {}
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
    return {
      ok: true, status: s.status, loggedIn: s.loggedIn, cookieCount: s.cookieCount,
      img: s.lastImg, persisted: s.persisted, err: s.lastErr || '',
    };
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
    let targets = [];
    for (let i = 0; i < 50; i++) {
      await wait(300);
      try { targets = await (await fetch(`http://127.0.0.1:${s.port}/json`)).json(); if (targets.length) break; } catch {}
    }
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('未找到浏览器页面（CDP 连接失败）');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
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
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable');
  }

  async #drive(s) { if (s.send) await s.send('Page.navigate', { url: s.url }); }

  async #shot(s) { const r = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); return r?.result?.data || ''; }
  async #cookies(s) { const r = await s.send('Network.getAllCookies'); return r?.result?.cookies || []; }
}