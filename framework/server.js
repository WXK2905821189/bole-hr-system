// 应用入口：统一网关 + 静态前端 + 采集候选注入(供 Python 适配器推送) + CSV 导出
// 运行：node framework/server.js   （默认端口 4700）
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventBus } from './core/bus.js';
import { ModuleRegistry } from './core/registry.js';
import { Lifecycle } from './core/lifecycle.js';
import { Gateway } from './core/gateway.js';
import { cfg } from './core/config.js';
import { Audit } from './audit/audit.js';
import { ContractValidator } from './schema/validate.js';
import { initRuntimeLog, rt } from './core/runtimeLog.js';
import { Store } from '../infra/store/store.js';
import { buildXlsx } from '../infra/files/xlsx.js';
import { BossScanManager } from './core/bossScan.js';
import { loadModule, manifest } from '../modules/recruitment-sourcing/index.js';
import { hashPw, verifyPw, pwPolicyError } from '../infra/auth/password.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 一键停止所有采集：集中登记运行中的采集子进程与后台定时器，便于随时一键中断。
// 声明在模块作用域：createApplication 内部接口与文件底部直连运行块都要引用它。
const sourcingRuntime = { children: new Set(), timers: [], stoppedAt: null };
const killChildTree = (child) => {
  try {
    if (child && child.pid) {
      // Windows 需终止进程树：python 采集可能再拉起 playwright 浏览器/子进程，仅 kill 父进程会残留
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      try { child.kill('SIGKILL'); } catch (_) {}
    }
  } catch (_) {}
};
const stopAllSource = () => {
  let killed = 0;
  for (const c of sourcingRuntime.children) { killChildTree(c); killed++; }
  sourcingRuntime.children.clear();
  for (const t of sourcingRuntime.timers) { try { clearInterval(t); } catch (_) {} }
  sourcingRuntime.timers = [];
  sourcingRuntime.stoppedAt = new Date().toISOString();
  return killed;
};

export async function createApplication(config = {}) {
  const merged = cfg(config);
  const bus = new EventBus();
  const registry = new ModuleRegistry();
  const audit = new Audit(merged.storeDir);
  const validate = new ContractValidator();
  const store = new Store(merged.storeDir);
  initRuntimeLog(merged.storeDir);
  rt.info('server', '系统启动，加载招聘提效模块');
  const gateway = new Gateway({ registry, audit, auth: merged.auth });
  if (!merged.auth?.token) console.warn('[auth] 未配置 HR_AUTH_TOKEN，数据/导出等敏感接口保持开放；生产部署请设置令牌');

  // 用户系统：首次启动注入默认账号（登录决定所属招聘者账号，替代左下角切换器）
  if (!store.readAll('users.jsonl').length) {
    store.write('users.jsonl', { id: 'A1', username: 'wang', name: '王先生', password: hashPw('boss123'), role: 'admin', active: true });
  }
  const findUser = (username) => store.readAll('users.jsonl').find((u) => u.username === username);
  const findSession = (token) => store.readAll('sessions.jsonl').find((s) => s.token === token);
  // 会话是否可用：必须存在且未过期（M5：超时自动失效）。无 expiresAt 的历史残留视为已失效。
  const sessionAlive = (s) => !!s && !!s.expiresAt && new Date(s.expiresAt).getTime() > Date.now();
  const userBySession = (req, url) => {
    const token = req.headers['x-auth'] ?? url?.searchParams?.get('token') ?? '';
    const s = findSession(String(token));
    if (!s || !sessionAlive(s)) {
      if (s && !sessionAlive(s)) { // 过期会话：删除（惰性失效）
        store.writeAll('sessions.jsonl', store.readAll('sessions.jsonl').filter((x) => x.token !== s.token));
      }
      return undefined;
    }
    return store.readAll('users.jsonl').find((u) => u.id === s.userId && u.active !== false);
  };
  const sessionTtl = () => (Number(merged.auth?.sessionTtlMs) || 12 * 60 * 60 * 1000);
  const newSession = async (userId, username) => {
    const token = randomBytes(16).toString('hex');
    const now = Date.now();
    const expiresAt = new Date(now + sessionTtl()).toISOString();
    store.write('sessions.jsonl', { token, userId, createdAt: new Date(now).toISOString(), expiresAt });
    return token;
  };
  const invalidateUserSessions = (userId, reason) => {
    const before = store.readAll('sessions.jsonl').length;
    store.writeAll('sessions.jsonl', store.readAll('sessions.jsonl').filter((s) => s.userId !== userId));
    return before - store.readAll('sessions.jsonl').length;
  };
  // 启动时清理失效会话：无 expiresAt 的历史残留或已过期会话一律清除（避免误判为活跃、防登录态残留）
  (() => {
    const alive = store.readAll('sessions.jsonl').filter((s) => sessionAlive(s));
    if (alive.length !== store.readAll('sessions.jsonl').length) store.writeAll('sessions.jsonl', alive);
  })();
  const publicUser = (u, withBoss = true) => {
    if (!u) return null;
    const boss = store.readAll('bossbindings.jsonl').find((b) => b.userId === u.id);
    const base = { id: u.id, username: u.username, name: u.name, role: u.role, active: u.active !== false };
    if (withBoss) base.boss = boss ? { bossAccount: boss.bossAccount, bossNick: boss.bossNick || '', masked: boss.bossToken ? maskToken(boss.bossToken) : null } : null;
    return base;
  };
  const maskToken = (t) => (t && t.length > 8 ? `${t.slice(0, 4)}****${t.slice(-4)}` : t);
  // 当前用户的 BOSS 绑定（扫码登录抓取的会话 cookie）
  const bossBindingOf = (userId) => store.readAll('bossbindings.jsonl').find((b) => b.userId === userId) ?? null;

  // 自动任务门控：仅当存在活跃会话时才自动驱动 BOSS；登出后无会话则自动停止服务
  const activeSessionCount = () => store.readAll('sessions.jsonl').filter((s) => sessionAlive(s)).length;
  const autoStops = [];
  const registerAutoStop = (fn) => autoStops.push(fn);
  const stopAuto = () => { for (const fn of autoStops) { try { fn(); } catch { /* ignore */ } } };
  const stopWhenNoActiveSession = () => {
    if (activeSessionCount() > 0) return;
    rt.info('server', '已无活跃会话，自动停止后台任务与服务');
    audit?.record?.({ actor: 'system', action: 'server.autostop', detail: { reason: 'no_active_session' } });
    stopAuto();
    setTimeout(() => process.exit(0), 500).unref();
  };

  const { instance } = await loadModule({ bus, validate, audit, store, config: merged, manifest });
  registry.register({ ...manifest, instance });
  await new Lifecycle(registry, bus).start(manifest.id);
  instance.api.schedule.start(); // 恢复持久化的定时调度任务

  // ---------- 一键停止所有采集（声明见模块作用域：sourcingRuntime / killChildTree / stopAllSource） ----------

  // 智能跟进扫描：无活跃会话时跳过（不驱动 BOSS），登出后随服务一并停止
  const followSweepMs = Math.max(1, Number(merged.engage?.followSweepMinutes) || 1) * 60000;
  const followTimer = setInterval(() => {
    if (activeSessionCount() === 0) return;
    instance.api.followup.sweep({}).catch(() => {});
  }, followSweepMs);
  followTimer.unref?.();
  registerAutoStop(() => clearInterval(followTimer));
  sourcingRuntime.timers.push(followTimer);

  // ---------- 域查询（GET） ----------
  const list = (name) => (_req, res) => json(res, 200, { [name]: store.readAll(`${name}.jsonl`) });
  // 时间过滤辅助：按「本地日期 YYYY-MM-DD」筛选 `ts` 字段，支持 date(单日)/from/to(含边界)。
  function dStr(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function inDateRange(q, rec) {
    const ds = dStr(rec?.ts);
    if (ds == null) return false;
    const date = q.get('date'), from = q.get('from'), to = q.get('to');
    if ((date || from || to) && !(date || from || to).trim()) return true;
    if (date && ds !== date) return false;
    if (from && ds < from) return false;
    if (to && ds > to) return false;
    return true;
  }
  gateway.route('GET', /^\/health$/, (_req, res) => json(res, 200, { ok: true, ts: new Date().toISOString() }));

  // ---------- 用户系统（登录 / 会话 / 登出） ----------
  gateway.route('POST', /^\/api\/auth\/login$/, async (req, res) => {
    const b = await readBody(req);
    const u = findUser(String(b?.username ?? ''));
    const v = u ? verifyPw(String(b?.password ?? ''), u.password) : { ok: false };
    if (!u || !v.ok) return json(res, 401, { ok: false, error: '账号或密码错误' });
    if (u.active === false) return json(res, 403, { ok: false, error: '该账号已被停用，请联系管理员' });
    if (v.legacy === true) { // 旧版明文命中 → 升级为 scrypt 散列（一次性、静默）
      const users = store.readAll('users.jsonl');
      users.find((x) => x.id === u.id).password = hashPw(String(b.password));
      store.writeAll('users.jsonl', users);
    }
    const token = await newSession(u.id, u.username);
    await audit.record({ actor: u.id, action: 'auth.login', detail: { username: u.username } });
    json(res, 200, { ok: true, token, user: publicUser(u) });
  });
  gateway.route('POST', /^\/api\/auth\/register$/, async (req, res) => {
    const b = await readBody(req);
    const uname = String(b?.username ?? '').trim().toLowerCase();
    const name = String(b?.name ?? '').trim();
    if (!name || !uname || !b?.password) return json(res, 400, { ok: false, error: '姓名/用户名/密码必填' });
    if (!/^[a-zA-Z0-9_]{2,24}$/.test(uname)) return json(res, 400, { ok: false, error: '用户名需为 2-24 位字母/数字/下划线' });
    const policyErr = pwPolicyError(b.password, uname);
    if (policyErr) return json(res, 400, { ok: false, error: policyErr });
    if (findUser(uname)) return json(res, 409, { ok: false, error: '该用户名已存在，请更换' });
    const id = `U${Date.now().toString(36).toUpperCase()}`;
    store.write('users.jsonl', { id, username: uname, name, password: hashPw(String(b.password)), role: 'recruiter', active: true });
    const token = await newSession(id, uname);
    await audit.record({ actor: id, action: 'auth.register', detail: { username: uname } });
    json(res, 201, { ok: true, token, user: publicUser(store.readAll('users.jsonl').find((x) => x.id === id)) });
  });
  gateway.route('GET', /^\/api\/auth\/me$/, (req, res, url) => {
    const me = userBySession(req, url);
    if (!me) return json(res, 401, { ok: false, error: '未登录或会话已失效' });
    json(res, 200, { ok: true, user: publicUser(me) });
  });
  gateway.route('POST', /^\/api\/auth\/logout$/, async (req, res) => {
    const b = await readBody(req);
    const list = store.readAll('sessions.jsonl').filter((s) => s.token !== String(b?.token ?? ''));
    store.writeAll('sessions.jsonl', list);
    json(res, 200, { ok: true });
    // 登出后若已无活跃会话，自动停止后台自动任务并退出服务（不再自动采集/拉起 BOSS）
    setTimeout(stopWhenNoActiveSession, 300);
  });

  // ---------- 账号管理（需管理员会话令牌：Header x-auth） ----------
  gateway.route('GET', /^\/api\/users$/, (req, res, url) => {
    const me = userBySession(req, url);
    if (!me) return json(res, 401, { ok: false, error: '未登录或会话失效' });
    const users = store.readAll('users.jsonl').map((u) => publicUser(u, true));
    json(res, 200, { ok: true, users, self: publicUser(me, true) });
  });
  gateway.route('POST', /^\/api\/users$/, async (req, res, url) => {
    const me = userBySession(req, url);
    if (!me || me.role !== 'admin') return json(res, 403, { ok: false, error: '仅管理员可新增账号' });
    const b = await readBody(req);
    const uname = String(b?.username ?? '').trim();
    if (!b?.name || !uname || !b?.password) return json(res, 400, { ok: false, error: '用户名/姓名/密码必填' });
    if (findUser(uname)) return json(res, 409, { ok: false, error: '该用户名已存在' });
    const policyErr = pwPolicyError(b.password, uname);
    if (policyErr) return json(res, 400, { ok: false, error: policyErr });
    const id = b?.id || `U${Date.now().toString(36).toUpperCase()}`;
    store.write('users.jsonl', { id, username: uname, name: String(b.name), password: hashPw(String(b.password)), role: b.role === 'admin' ? 'admin' : 'recruiter', active: true });
    await audit.record({ actor: me.id, action: 'users.create', detail: { id, username: uname } });
    json(res, 201, { ok: true, user: publicUser(store.readAll('users.jsonl').find((u) => u.id === id), true) });
  });
  // 修改/重置密码：管理员重置任意；本人可用 old 改自己的
  gateway.route('POST', /^\/api\/users\/([^/]+)\/password$/, async (req, res, url) => {
    const m = url.pathname.match(/^\/api\/users\/([^/]+)\/password$/);
    const me = userBySession(req, url);
    if (!me) return json(res, 401, { ok: false, error: '未登录或会话失效' });
    const users = store.readAll('users.jsonl');
    const target = users.find((u) => u.id === decodeURIComponent(m[1]));
    if (!target) return json(res, 404, { ok: false, error: '账号不存在' });
    const b = await readBody(req);
    if (target.id !== me.id && me.role !== 'admin') return json(res, 403, { ok: false, error: '仅本人或管理员可修改密码' });
    if (target.id === me.id && b?.old && !verifyPw(String(b.old), target.password).ok) return json(res, 401, { ok: false, error: '原密码不正确' });
    const policyErr = pwPolicyError(b?.password, target.username);
    if (policyErr) return json(res, 400, { ok: false, error: policyErr });
    target.password = hashPw(String(b.password));
    store.writeAll('users.jsonl', users);
    await audit.record({ actor: me.id, action: 'users.password', detail: { id: target.id } });
    json(res, 200, { ok: true });
  });
  // 停用 / 启用（管理员；停用后该用户现存会话立即失效——认证与权限变更联动）
  gateway.route('POST', /^\/api\/users\/([^/]+)\/active$/, async (req, res, url) => {
    const m = url.pathname.match(/^\/api\/users\/([^/]+)\/active$/);
    const me = userBySession(req, url);
    if (!me) return json(res, 401, { ok: false, error: '未登录或会话失效' });
    if (me.role !== 'admin') return json(res, 403, { ok: false, error: '仅管理员可操作' });
    const users = store.readAll('users.jsonl');
    const target = users.find((u) => u.id === decodeURIComponent(m[1]));
    if (!target) return json(res, 404, { ok: false, error: '账号不存在' });
    const b = await readBody(req);
    if (target.id === me.id && b?.active === false) return json(res, 400, { ok: false, error: '不能停用自己' });
    target.active = b?.active === false ? false : true;
    store.writeAll('users.jsonl', users);
    const invalidated = target.active === false ? invalidateUserSessions(target.id, 'account_disabled') : 0;
    await audit.record({ actor: me.id, action: 'users.active', detail: { id: target.id, active: target.active, invalidatedSessions: invalidated } });
    json(res, 200, { ok: true, active: target.active, invalidatedSessions: invalidated });
  });
  // 角色变更（管理员；权限变更后该用户现存会话立即失效，需重新登录生效——认证与权限变更审计联动）
  gateway.route('POST', /^\/api\/users\/([^/]+)\/role$/, async (req, res, url) => {
    const m = url.pathname.match(/^\/api\/users\/([^/]+)\/role$/);
    const me = userBySession(req, url);
    if (!me) return json(res, 401, { ok: false, error: '未登录或会话失效' });
    if (me.role !== 'admin') return json(res, 403, { ok: false, error: '仅管理员可操作' });
    const users = store.readAll('users.jsonl');
    const target = users.find((u) => u.id === decodeURIComponent(m[1]));
    if (!target) return json(res, 404, { ok: false, error: '账号不存在' });
    const role = String((await readBody(req))?.role ?? '').trim();
    if (role !== 'admin' && role !== 'recruiter') return json(res, 400, { ok: false, error: '角色仅支持 admin / recruiter' });
    if (target.role === role) return json(res, 200, { ok: true, changed: false, role });
    const from = target.role;
    target.role = role;
    store.writeAll('users.jsonl', users);
    const invalidated = invalidateUserSessions(target.id, 'role_changed');
    await audit.record({ actor: me.id, action: 'users.role', detail: { id: target.id, username: target.username, from, to: role, invalidatedSessions: invalidated } });
    json(res, 200, { ok: true, changed: true, from, role, invalidatedSessions: invalidated });
  });

  // ---------- BOSS 账号绑定（登录后绑定真实 BOSS 直聘账号） ----------
  gateway.route('POST', /^\/api\/users\/([^/]+)\/boss$/, async (req, res, url) => {
    const m = url.pathname.match(/^\/api\/users\/([^/]+)\/boss$/);
    const me = userBySession(req, url);
    if (!me) return json(res, 401, { ok: false, error: '未登录或会话失效' });
    if (me.id !== decodeURIComponent(m[1])) return json(res, 403, { ok: false, error: '只能绑定自己的 BOSS 账号' });
    const b = await readBody(req);
    const acc = String(b?.bossAccount ?? '').trim();
    if (!acc) return json(res, 400, { ok: false, error: '请输入真实 BOSS 直聘账号（手机号/通行证）' });
    const binds = store.readAll('bossbindings.jsonl').filter((x) => x.userId !== me.id);
    binds.push({ userId: me.id, bossAccount: acc, bossNick: String(b?.bossNick ?? '').trim(), bossToken: b?.bossToken ? String(b.bossToken).trim() : '', updatedAt: new Date().toISOString() });
    store.writeAll('bossbindings.jsonl', binds);
    await audit.record({ actor: me.id, action: 'boss.bind', detail: { userId: me.id, bossAccount: acc } });
    json(res, 200, { ok: true, boss: publicUser(me, true).boss });
  });
  gateway.route('GET', /^\/modules$/, (_req, res) => json(res, 200, { modules: registry.list() }));

  // ---------- 扫码登录 BOSS：复用 BOSS 网页版扫码流程，自动捕获会话 cookie ----------
  const bossScan = new BossScanManager({ chromePath: process.env.HR_BOSS_CHROME });
  bossScan.onLogin = async (sess) => {
    const binds = store.readAll('bossbindings.jsonl').filter((x) => x.userId !== sess.userId);
    const existing = store.readAll('bossbindings.jsonl').find((x) => x.userId === sess.userId);
    // cdpPort：扫码浏览器的调试端口；窗口保持开启时，采集可直接 CDP 附着（登录态最新鲜）
    binds.push({ userId: sess.userId, bossAccount: existing?.bossAccount ?? '', bossNick: existing?.bossNick ?? '', bossToken: sess.cookieString, cdpPort: sess.port, bossScan: true, updatedAt: new Date().toISOString() });
    store.writeAll('bossbindings.jsonl', binds);
    await audit.record({ actor: sess.userId, action: 'boss.scan_capture', detail: { userId: sess.userId, cookies: sess.cookieCount } });
    rt.info('bossscan', `用户 ${sess.userId} 扫码登录成功，自动捕获 ${sess.cookieCount} 个 BOSS 会话 cookie（CDP 端口 ${sess.port}，窗口保持开启可供采集附着）`);
    return sess.cookieCount;
  };
  process.once('exit', () => bossScan.killAll());
  gateway.route('POST', /^\/api\/scan-boss\/start$/, async (req, res, url) => {
    const me = userBySession(req, url);
    if (!me) return json(res, 401, { ok: false, error: '未登录或会话失效' });
    try { json(res, 200, bossScan.start(me.id)); }
    catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
  });
  gateway.route('GET', /^\/api\/scan-boss\/poll$/, async (req, res, url) => {
    const me = userBySession(req, url);
    if (!me) return json(res, 401, { ok: false, error: '未登录或会话失效' });
    const sessionId = url.searchParams.get('sessionId') || String(me.id);
    if (sessionId !== String(me.id)) return json(res, 403, { ok: false, error: '无权访问该扫码会话' });
    try { json(res, 200, await bossScan.poll(sessionId)); }
    catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
  });
  gateway.route('POST', /^\/api\/scan-boss\/stop$/, async (req, res, url) => {
    const me = userBySession(req, url);
    if (!me) return json(res, 401, { ok: false, error: '未登录或会话失效' });
    const sessionId = url.searchParams.get('sessionId') || String(me.id);
    bossScan.stop(sessionId);
    json(res, 200, { ok: true });
  });
  // 拉起 BOSS 网页端：自动复用已保存的会话凭证，注入后打开招聘端页面（在线条件由系统代劳）
  gateway.route('POST', /^\/api\/boss-web\/launch$/, async (req, res, url) => {
    const me = userBySession(req, url);
    if (!me) return json(res, 401, { ok: false, error: '未登录或会话失效' });
    const bind = bossBindingOf(me.id);
    if (!bind?.bossToken) return json(res, 400, { ok: false, error: '尚未绑定 BOSS 会话：请先扫码登录绑定，再拉起网页端' });
    try {
      const r = bossScan.start(me.id, { url: 'https://www.zhipin.com/web/chat/index', cookies: bind.bossToken });
      const nCookies = String(bind.bossToken).split(';').filter((x) => x.trim().includes('=')).length;
      rt.info('bossweb', `用户 ${me.id} 拉起 BOSS 网页端（注入 ${nCookies} 项会话凭证，窗口保持开启可供采集附着）`);
      json(res, 200, r);
    } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
  });

  gateway.route('GET', /^\/jobs$/, list('jobs'));
  gateway.route('GET', /^\/candidates$/, list('candidates'));
  gateway.route('GET', /^\/resumes$/, list('resumes'));
  gateway.route('GET', /^\/matches$/, list('matches'));
  gateway.route('GET', /^\/cycles$/, list('cycles'));
  gateway.route('GET', /^\/audit$/, (_req, res) => json(res, 200, { audit: audit.tail(50) }));
  gateway.route('GET', /^\/api\/audit$/, (_req, res, url) => {
    const q = url.searchParams;
    const n = Number(q.get('n') ?? 50);
    const hasDate = q.has('date') || q.has('from') || q.has('to');
    let rows = audit.tail(hasDate ? 20000 : n);
    if (hasDate) rows = rows.filter((r) => inDateRange(q, r));
    json(res, 200, { audit: rows });
  });

  // ---------- 系统运行日志（运维排查） ----------
  gateway.route('GET', /^\/api\/logs$/, (_req, res, url) => {
    const q = url.searchParams;
    const level = q.get('level') || '';
    const hasDate = q.has('date') || q.has('from') || q.has('to');
    const n = Number(q.get('n') ?? 300);
    let rows = rt.list(hasDate ? 20000 : n);
    if (level) rows = rows.filter((l) => l.level === level);
    if (hasDate) rows = rows.filter((r) => inDateRange(q, r));
    json(res, 200, { logs: rows });
  });
  gateway.route('POST', /^\/api\/logs\/clear$/, (_req, res) => {
    const ok = rt.clear();
    json(res, ok ? 200 : 500, ok ? { ok: true } : { error: '清空运行日志失败' });
  });

  // ---------- 人才库检索（FR5）与调度查看 ----------
  gateway.route('GET', /^\/api\/candidates\/search$/, (_req, res, url) => {
    const q = Object.fromEntries(url.searchParams.entries());
    json(res, 200, { candidates: instance.api.searchCandidates(q) });
  });
  gateway.route('GET', /^\/api\/sourcing\/schedules$/, (_req, res) => json(res, 200, { schedules: instance.api.schedule.list() }));
  gateway.route('GET', /^\/api\/resumes\/([^/]+)\/text$/, async (req, res, url) => {
    const m = url.pathname.match(/^\/api\/resumes\/([^/]+)\/text$/);
    const text = await instance.api.getResumeText(decodeURIComponent(m[1]));
    json(res, 200, text);
  });

  // ---------- 原始简历文件（BOSS 索要简历 → docx/PDF） ----------
  gateway.route('GET', /^\/api\/candidates\/([^/]+)\/original\/info$/, async (req, res, url) => {
    const m = url.pathname.match(/^\/api\/candidates\/([^/]+)\/original\/info$/);
    const meta = instance.api.originalFile.info(decodeURIComponent(m[1]));
    json(res, 200, { found: !!meta, meta });
  });
  gateway.route('GET', /^\/api\/candidates\/([^/]+)\/original\/file$/, async (req, res, url) => {
    const m = url.pathname.match(/^\/api\/candidates\/([^/]+)\/original\/file$/);
    const cid = decodeURIComponent(m[1]);
    const { meta, buffer } = instance.api.originalFile.download(cid);
    if (!meta || !buffer || !buffer.length) return json(res, 404, { error: '未找到原始简历文件', candidateId: cid });
    const filename = encodeURIComponent(meta.filename || `${cid}.docx`);
    res.writeHead(200, {
      'Content-Type': meta.mime || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${filename}`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  });
  gateway.route('POST', /^\/api\/candidates\/([^/]+)\/original\/file$/, async (req, res, url) => {
    const m = url.pathname.match(/^\/api\/candidates\/([^/]+)\/original\/file$/);
    const b = await readBody(req);
    if (!b?.data) return json(res, 400, { error: '缺少文件内容(data, base64)' });
    const meta = instance.api.originalFile.upload(decodeURIComponent(m[1]), {
      filename: b.filename || 'resume.docx',
      mime: b.mime,
      data: Buffer.from(b.data, 'base64'),
    });
    await audit.record({ actor: 'web', action: 'candidate.original.upload', detail: { candidateId: m[1], filename: meta?.filename } });
    json(res, 201, meta ?? { error: '上传失败' });
  });

  // ---------- 业务动作（POST） ----------
  // 新增/解析岗位（岗位按招聘者账号归属）
  gateway.route('POST', /^\/api\/jobs$/, async (req, res) => {
    const b = await readBody(req);
    if (!b?.jobId || !b?.jdRaw) return json(res, 400, { error: 'jobId/jdRaw 必填' });
    const recruiterId = b.recruiterId || req.headers['x-recruiter-id'] || 'A1';
    const job = await instance.api.parseJd(b.jdRaw, b.jobId, b.jobTitle, recruiterId);
    await audit.record({ actor: req.headers['x-actor'] ?? 'web', action: 'job.create', detail: { jobId: job.jobId, recruiterId } });
    json(res, 201, { jobId: job.jobId, jobTitle: job.jobTitle, keywords: job.parsedKeywords, hardSkills: job.hardSkills, recruiterId });
  });

  // 岗位状态：关闭 / 重新开放（POST /api/jobs/:jobId/control {action})
  gateway.route('POST', /^\/api\/jobs\/([^/]+)\/control$/, async (req, res, url) => {
    const m = url.pathname.match(/^\/api\/jobs\/([^/]+)\/control$/);
    const b = await readBody(req);
    const action = b?.action;
    const statusMap = { close: 'closed', reopen: 'open' };
    if (!(action in statusMap)) return json(res, 400, { error: 'action 仅支持 close / reopen' });
    const r = instance.api.setJobStatus(decodeURIComponent(m[1]), statusMap[action]);
    if (!r.ok) return json(res, 404, { error: r.error });
    await audit.record({ actor: 'web', action: `job.${action}`, detail: { jobId: m[1] } });
    json(res, 200, { ok: true, jobId: m[1], status: r.job.status });
  });

  // 岗位删除（连同其定时任务）（DELETE /api/jobs/:jobId）
  gateway.route('DELETE', /^\/api\/jobs\/([^/]+)$/, async (req, res, url) => {
    const m = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    const r = instance.api.deleteJob(decodeURIComponent(m[1]));
    if (!r.ok) return json(res, 404, { error: r.error });
    await audit.record({ actor: 'web', action: 'job.delete', detail: { jobId: m[1], removedSchedules: r.removedSchedules } });
    json(res, 200, { ok: true, jobId: m[1], removedSchedules: r.removedSchedules });
  });

  // 运行一次完整链路（Node 侧冒烟候选，用于无 Python 环境下演示事件流转）
  gateway.route('POST', /^\/api\/sourcing\/run$/, async (req, res) => {
    const b = await readBody(req);
    const jd = pickJd(b?.jdRaw, b?.jobId, b?.keyword, store);
    const recruiterId = b?.recruiterId || req.headers['x-recruiter-id'] || 'A1';
    const r = await instance.api.runSourcingCycle(b?.jobId ?? `job_${Date.now()}`, jd.raw, jd.keyword, recruiterId);
    rt.info('sourcing', `发起采集链路 jobId=${b?.jobId ?? '(新岗位)'} 打招呼 ${r.greeted} 位，候选 ${r.candidates?.length} 位`);
    json(res, 200, { ok: true, note: '已触发 BOSS 采集链路（Node 冒烟）', jobId: b?.jobId ?? null, recruiterId, greeted: r.greeted, candidates: r.candidates?.length ?? 0, steps: r.steps });
  });

  // 对岗位已有候选人批量发送打招呼（BOSS 会话行为）
  gateway.route('POST', /^\/api\/sourcing\/greet$/, async (req, res) => {
    const b = await readBody(req);
    const jobId = b?.jobId ?? firstOpenJob(store)?.jobId;
    if (!jobId) return json(res, 400, { error: '缺少 jobId' });
    const r = await instance.api.greetJob(jobId);
    rt.info('greet', `批量打招呼 jobId=${jobId} 成功 ${r.count} 位${r.blocked?.length ? `，拦截 ${r.blocked.length} 位` : ''}`);
    await audit.record({ actor: 'web', action: 'sourcing.greet', detail: { jobId, count: r.count } });
    json(res, 200, { ok: true, jobId, count: r.count });
  });
  // 对单个候选人发送打招呼
  gateway.route('POST', /^\/api\/candidates\/([^/]+)\/greet$/, async (req, res, url) => {
    const m = url.pathname.match(/^\/api\/candidates\/([^/]+)\/greet$/);
    const r = await instance.api.greetCandidate(decodeURIComponent(m[1]));
    if (!r.ok) return json(res, 404, { error: r.error });
    json(res, 200, { ok: true, candidateId: m[1], already: r.already, blocked: r.blocked ?? false, reason: r.reason ?? null });
  });

  // 索要简历/电话/跟进（受护栏节流 + 触达契约入库）
  gateway.route('POST', /^\/api\/candidates\/([^/]+)\/touch$/, async (req, res, url) => {
    const m = url.pathname.match(/^\/api\/candidates\/([^/]+)\/touch$/);
    const b = await readBody(req);
    const r = await instance.api.touchCandidate(decodeURIComponent(m[1]), b);
    if (!r.ok) return json(res, r.error === '未找到候选人' ? 404 : 400, { error: r.error, reason: r.reason ?? null });
    json(res, 200, { ok: true, candidateId: m[1], blocked: r.blocked ?? false, reason: r.reason ?? null, touchStatus: r.candidate?.touchStatus ?? null });
  });

  // 登记简历已收到（Moka 流转：简历经企业邮箱进 Moka，本系统不存简历文件，仅登记状态使候选人进入两库）
  gateway.route('POST', /^\/api\/candidates\/([^/]+)\/resume-received$/, async (req, res, url) => {
    const m = url.pathname.match(/^\/api\/candidates\/([^/]+)\/resume-received$/);
    const cid = decodeURIComponent(m[1]);
    const me = userBySession(req, new URL(req.url, 'http://x'));
    const cands = store.readAll('candidates.jsonl');
    const c = cands.find((x) => x.candidateId === cid);
    if (!c) return json(res, 404, { error: '未找到候选人' });
    if (c.status && c.status !== 'sourced') return json(res, 200, { ok: true, already: true, status: c.status });
    c.status = 'resume_received';
    c.resumeReceivedAt = new Date().toISOString();
    c.resumeChannel = 'moka';
    store.writeAll('candidates.jsonl', cands);
    await audit.record({ actor: me?.username ?? 'web', action: 'candidate.resume_received', detail: { candidateId: cid, jobId: c.jobId, channel: 'moka' } });
    rt.info('resume', `登记简历已收到（Moka）: ${c.name ?? cid}`);
    json(res, 200, { ok: true, candidate: c });
  });

  // 候选人回复 / 标记沉睡
  gateway.route('POST', /^\/api\/candidates\/([^/]+)\/reply$/, async (req, res, url) => {
    const m = url.pathname.match(/^\/api\/candidates\/([^/]+)\/reply$/);
    const b = await readBody(req);
    const r = await instance.api.replyCandidate(decodeURIComponent(m[1]), b);
    if (!r.ok) return json(res, 404, { error: r.error });
    json(res, 200, { ok: true, candidateId: m[1], touchStatus: r.candidate?.touchStatus ?? null, contactResolved: r.contactResolved ?? false });
  });

  // 触达记录
  gateway.route('GET', /^\/api\/engagements$/, (_req, res) => json(res, 200, { engagements: instance.api.engagements.list(200) }));
  gateway.route('GET', /^\/api\/engagements\/candidates\/([^/]+)$/, (_req, res, url) => {
    const m = url.pathname.match(/^\/api\/engagements\/candidates\/([^/]+)$/);
    json(res, 200, { engagements: instance.api.engagements.byCandidate(decodeURIComponent(m[1])) });
  });

  // 护栏状态
  gateway.route('GET', /^\/api\/guardrail$/, (_req, res) => json(res, 200, { stats: instance.api.guardrail.stats() }));

  // ---------- B-1 话术库（打招呼话术配置） ----------
  gateway.route('GET', /^\/api\/messagelib$/, (_req, res) => json(res, 200, { templates: instance.api.messagelib.list() }));
  gateway.route('POST', /^\/api\/messagelib$/, async (req, res) => {
    const b = await readBody(req);
    try { const r = instance.api.messagelib.create(b); json(res, 201, r); }
    catch (e) { json(res, 400, { ok: false, error: String(e?.message ?? e) }); }
  });
  gateway.route('POST', /^\/api\/messagelib\/([^\/]+)\/activate$/, async (req, res, url) => {
    const m = url.pathname.match(/^\/api\/messagelib\/([^\/]+)\/activate$/);
    const r = instance.api.messagelib.activate(decodeURIComponent(m[1]));
    json(res, 200, r);
  });
  gateway.route('POST', /^\/api\/messagelib\/preset$/, async (req, res) => {
    const b = await readBody(req);
    if (!['first', 'second', 'third', 'exchange'].includes(b.tier)) return json(res, 400, { ok: false, error: 'tier 必须是 first/second/third/exchange' });
    const r = instance.api.messagelib.setToPreset(b.tier);
    json(res, 200, r);
  });

  // ---------- B-2/B-3 自动打招呼 / 智能跟进 ----------
  gateway.route('POST', /^\/api\/engage\/auto-greet$/, async (req, res) => {
    const b = await readBody(req);
    if (!b.candidateId) return json(res, 400, { ok: false, error: 'candidateId 必填' });
    const r = await instance.api.autoGreet(b);
    json(res, 200, r);
  });
  gateway.route('GET', /^\/api\/engage\/followup$/, (_req, res) => json(res, 200, { plans: instance.api.followup.status() }));
  gateway.route('POST', /^\/api\/engage\/followup\/sweep$/, async (req, res) => {
    const r = await instance.api.followup.sweep({});
    json(res, 200, r);
  });
  gateway.route('GET', /^\/api\/engage\/followup\/([^\/]+)$/, (_req, res, url) => {
    const m = url.pathname.match(/^\/api\/engage\/followup\/([^\/]+)$/);
    json(res, 200, { plan: instance.api.followup.plan(decodeURIComponent(m[1])) });
  });
  gateway.route('POST', /^\/api\/engage\/mark-sleep$/, async (req, res) => {
    const b = await readBody(req);
    if (!b.candidateId) return json(res, 400, { ok: false, error: 'candidateId 必填' });
    const r = await instance.api.markSleeping(b.candidateId);
    if (!r.ok) return json(res, 404, { ok: false, error: r.error });
    json(res, 200, r);
  });
  // M3 里程碑：人工唤醒沉睡候选人（标记保留、可唤醒、不删除）
  gateway.route('POST', /^\/api\/engage\/wake$/, async (req, res) => {
    const b = await readBody(req);
    if (!b.candidateId) return json(res, 400, { ok: false, error: 'candidateId 必填' });
    const r = await instance.api.wakeCandidate(b.candidateId);
    if (!r.ok) return json(res, 404, { ok: false, error: r.error });
    json(res, 200, r);
  });

  // ---------- F-1 候选人发送简历 → 自动同意收取 ----------
  gateway.route('POST', /^\/api\/engage\/resume-inbound$/, async (req, res) => {
    const b = await readBody(req);
    if (!b.candidateId) return json(res, 400, { ok: false, error: 'candidateId 必填' });
    const r = await instance.api.resumeInbound(b.candidateId, { rawText: b.rawText, fail: !!b.fail, recruiterId: b.recruiterId });
    if (!r.ok && r.error) return json(res, 404, r);
    json(res, 200, r);
  });
  gateway.route('GET', /^\/api\/engage\/manual-pending$/, (_req, res) => json(res, 200, { candidates: instance.api.manualPending() }));
  gateway.route('POST', /^\/api\/engage\/manual-pending\/([^/]+)\/retry$/, async (req, res, url) => {
    const m = url.pathname.match(/^\/api\/engage\/manual-pending\/([^/]+)\/retry$/);
    const b = await readBody(req);
    const r = await instance.api.retryManualResume(decodeURIComponent(m[1]), { rawText: b?.rawText, recruiterId: b?.recruiterId });
    if (!r.ok && r.error) return json(res, 404, r);
    json(res, 200, r);
  });

  // ---------- F-2 缺联系方式自动交换 + 我方联系方式配置 ----------
  gateway.route('GET', /^\/api\/engage\/contact$/, (_req, res) => json(res, 200, { contact: instance.api.hrContact.get() }));
  gateway.route('PUT', /^\/api\/engage\/contact$/, async (req, res) => {
    const b = await readBody(req);
    try { json(res, 200, { ok: true, contact: instance.api.hrContact.set(b?.contact ?? '') }); }
    catch (e) { json(res, 400, { ok: false, error: String(e?.message ?? e) }); }
  });
  gateway.route('POST', /^\/api\/engage\/exchange-contact$/, async (req, res) => {
    const b = await readBody(req);
    if (!b.candidateId) return json(res, 400, { ok: false, error: 'candidateId 必填' });
    const r = await instance.api.exchangeContact(b.candidateId, b.recruiterId);
    if (!r.ok && r.error) return json(res, 404, r);
    json(res, 200, r);
  });

  // ---------- F-3 打招呼批次（GreetCampaign：职位顺序/指定职位 + 额度） ----------
  gateway.route('GET', /^\/api\/engage\/campaigns$/, (_req, res) => json(res, 200, { campaigns: instance.api.campaign.list() }));
  gateway.route('POST', /^\/api\/engage\/campaigns$/, async (req, res) => {
    const b = await readBody(req);
    try {
      const c = instance.api.campaign.create(b);
      await audit.record({ actor: req.headers['x-actor'] ?? 'web', action: 'campaign.create', detail: { campaignId: c.campaignId, mode: c.mode } });
      json(res, 201, c);
    } catch (e) { json(res, 400, { ok: false, error: String(e?.message ?? e) }); }
  });
  gateway.route('POST', /^\/api\/engage\/campaigns\/([^/]+)\/control$/, async (req, res, url) => {
    const m = url.pathname.match(/^\/api\/engage\/campaigns\/([^/]+)\/control$/);
    const b = await readBody(req);
    const id = decodeURIComponent(m[1]);
    if (b?.action === 'run') {
      const r = await instance.api.campaign.run(id);
      await audit.record({ actor: req.headers['x-actor'] ?? 'web', action: 'campaign.run', detail: { campaignId: id, finished: r.finished, paused: r.paused } });
      return json(res, 200, r);
    }
    const r = instance.api.campaign.control(id, b?.action);
    if (!r.ok) return json(res, 400, r);
    await audit.record({ actor: req.headers['x-actor'] ?? 'web', action: `campaign.${b.action}`, detail: { campaignId: id } });
    json(res, 200, r);
  });

  // ---------- F-4 批次结束提醒 + 数据复盘 ----------
  gateway.route('GET', /^\/api\/engage\/notifications$/, (_req, res, url) => {
    const n = Number(url.searchParams.get('n') ?? 50);
    json(res, 200, { notifications: instance.api.notifications.list(n), unread: instance.api.notifications.unread().length });
  });
  gateway.route('POST', /^\/api\/engage\/notifications\/read$/, async (req, res) => {
    const b = await readBody(req);
    json(res, 200, instance.api.notifications.markRead(b?.id));
  });
  gateway.route('GET', /^\/api\/engage\/metrics$/, (_req, res, url) => {
    const campaignId = url.searchParams.get('campaignId');
    json(res, 200, instance.api.metrics(campaignId));
  });
  // 复盘导出（FR-8：导出审计留痕）
  gateway.route('GET', /^\/export\/engage-metrics\.csv$/, async (_req, res, url) => {
    const campaignId = url.searchParams.get('campaignId');
    const r = instance.api.metrics(campaignId);
    const HEAD = ['jobId', '职位', '打招呼量', '已读', '未读', '已读比例', '回复数', '回复比例', '索要/交换次数', '转化数', '转化率', '沉睡数', '候选人数'];
    const rows = r.perJob.map((x) => [x.jobId, x.jobTitle, x.greeted, x.read, x.unread, x.readRate, x.replied, x.replyRate, x.requested, x.converted, x.convertRate, x.sleeping, x.candidates]);
    const csv = [HEAD.join(','), ...rows.map((row) => row.map((v) => `"${String(v ?? '')}"`).join(','))].join('\r\n');
    await audit.record({ actor: 'web', action: 'export.metrics', detail: { campaignId: campaignId ?? null, rows: rows.length } });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="engage-metrics.csv"' });
    res.end('\uFEFF' + csv);
  });

  // ---------- F-5 推荐牛人列表寻访（扩展 B-2，与搜索结果去重） ----------
  gateway.route('POST', /^\/api\/sourcing\/recommend$/, async (req, res) => {
    const b = await readBody(req);
    const jobId = b?.jobId ?? firstOpenJob(store)?.jobId;
    if (!jobId) return json(res, 400, { error: '缺少 jobId' });
    const r = await instance.api.recommend(jobId, { count: b?.count, keyword: b?.keyword, recruiterId: b?.recruiterId, candidates: b?.candidates });
    if (!r.ok) return json(res, 404, r);
    json(res, 200, r);
  });

  // ---------- M4 里程碑·AI 基座改造（baseURL+Key 轻量接入 + /models 自动拉取 + 模型选择；仅管理员可改配置，联 M5） ----------
  const adminMe = (req, url, res) => {
    const me = userBySession(req, url);
    if (!me) { json(res, 401, { ok: false, error: '未登录或会话已失效' }); return null; }
    if (me.role !== 'admin') { json(res, 403, { ok: false, error: '仅管理员可操作' }); return null; }
    return me;
  };
  // 状态与模型列表可读（登录即可），配置的写入(configure)仅管理员。
  gateway.route('GET', /^\/api\/llm\/status$/, (req, res, url) => {
    const me = userBySession(req, url);
    if (!me) return json(res, 401, { ok: false, error: '未登录或会话已失效' });
    json(res, 200, { ok: true, ...instance.api.ai.status() });
  });
  gateway.route('GET', /^\/api\/llm\/models$/, async (req, res, url) => {
    const me = userBySession(req, url);
    if (!me) return json(res, 401, { ok: false, error: '未登录或会话已失效' });
    json(res, 200, { ok: true, ...(await instance.api.ai.listModels()) });
  });
  gateway.route('PUT', /^\/api\/llm\/config$/, async (req, res, url) => {
    const me = adminMe(req, url, res);
    if (!me) return;
    const b = await readBody(req);
    if (!b?.baseURL) return json(res, 400, { ok: false, error: 'baseURL 必填' });
    const r = await instance.api.ai.configure({ baseURL: b.baseURL, apiKey: b.apiKey, model: b.model }, me.id);
    if (!r.ok) return json(res, 400, r);
    json(res, 200, r);
  });
  // M6 · Python 前置 AI 匹配（在线简历差距分析打分门禁；登录即可调用，Python 采集端据此决定是否打招呼）
  gateway.route('POST', /^\/api\/ai\/pre-match$/, async (req, res, url) => {
    const me = userBySession(req, url);
    if (!me) return json(res, 401, { ok: false, error: '未登录或会话已失效' });
    const b = await readBody(req);
    if (!b?.jobId || !String(b.resumeText ?? '').trim()) return json(res, 400, { ok: false, error: 'jobId 与 resumeText 必填' });
    const r = await instance.api.preMatch(b.jobId, b.resumeText);
    if (!r.ok) return json(res, 404, r);
    json(res, 200, r);
  });

  // ---------- 匹配规则（JD 解析 + AI 匹配）：硬性门槛/权重/打招呼阈值；读取需登录，保存仅管理员（联 M5） ----------
  gateway.route('GET', /^\/api\/sourcing\/rules$/, (req, res, url) => {
    const me = userBySession(req, url);
    if (!me) return json(res, 401, { ok: false, error: '未登录或会话已失效' });
    json(res, 200, { ok: true, ...instance.api.rules.status() });
  });
  gateway.route('PUT', /^\/api\/sourcing\/rules$/, async (req, res, url) => {
    const me = adminMe(req, url, res);
    if (!me) return;
    const b = await readBody(req);
    if (!b) return json(res, 400, { ok: false, error: '请求体不能为空' });
    const r = await instance.api.rules.save(b, me.id);
    json(res, 200, r);
  });

// ---------- M1 里程碑·自动寻访打招呼（推荐牛人 + 搜索两路合一；支持手动触发与即时调度） ----------
  gateway.route('POST', /^\/api\/sourcing\/auto-source$/, async (req, res) => {
    const b = await readBody(req);
    const jobId = b?.jobId ?? firstOpenJob(store)?.jobId;
    if (!jobId) return json(res, 400, { error: '缺少 jobId' });
    const r = await instance.api.autoSourceAndGreet(jobId, { count: b?.count, keyword: b?.keyword, recruiterId: b?.recruiterId, candidates: b?.candidates });
    if (!r.ok) return json(res, 404, r);
    json(res, 200, r);
  });

  // ---------- M2 里程碑·自动收简历（批量入站主链路：一律自动同意→解析入库→缺电话交换；逐条隔离不拖垮整轮） ----------
  gateway.route('POST', /^\/api\/sourcing\/auto-receive$/, async (req, res) => {
    const b = await readBody(req);
    const jobId = b?.jobId ?? firstOpenJob(store)?.jobId;
    if (!jobId) return json(res, 400, { error: '缺少 jobId' });
    const inbounds = Array.isArray(b?.inbounds) ? b.inbounds : (b?.candidateId ? [{ candidateId: b.candidateId, rawText: b?.rawText, fail: !!b?.fail, channel: b?.channel }] : []);
    if (!inbounds.length) return json(res, 400, { error: '缺少 inbounds（候选人发简历入站事件）' });
    const r = await instance.api.autoReceiveResumes(jobId, { inbounds, recruiterId: b?.recruiterId });
    if (!r.ok && r.error) return json(res, 404, r);
    json(res, 200, r);
  });

  // ---------- M1–M3 完整流水线·一次执行串起「寻访打招呼→自动收简历→智能跟进」 ----------
  gateway.route('POST', /^\/api\/sourcing\/run-pipeline$/, async (req, res) => {
    const b = await readBody(req);
    const jobId = b?.jobId ?? firstOpenJob(store)?.jobId;
    if (!jobId) return json(res, 400, { error: '缺少 jobId' });
    const r = await instance.api.runAutoPipeline(jobId, {
      count: b?.count, candidates: b?.candidates,
      inbounds: Array.isArray(b?.inbounds) ? b.inbounds : [], recruiterId: b?.recruiterId,
    });
    if (!r.ok && r.error) return json(res, 404, r);
    json(res, 200, r);
  });

  // 采集候选注入（Python 适配器真实推送入口）：校验契约 → 入库（按 candidateId 幂等 upsert）→ 发事件 → 触发解析/匹配
  gateway.route('POST', /^\/api\/sourcing\/candidates$/, async (req, res) => {
    const cand = await readBody(req);
    const check = validate.validate('candidate', cand);
    if (!check.ok) return json(res, 400, { error: `契约校验失败: ${check.errors.join('; ')}` });
    const all = store.readAll('candidates.jsonl');
    const existing = all.find((c) => c.candidateId === cand.candidateId);
    if (existing) {
      // 同一牛人（expectId 主键）重复投递：仅更新数据，不重复触发解析/匹配/打招呼计数
      store.writeAll('candidates.jsonl', all.map((c) => (c.candidateId === cand.candidateId
        ? { ...c, ...cand, meta: { ...c.meta, ...cand.meta, updatedAt: new Date().toISOString() } }
        : c)));
      return json(res, 200, { candidateId: cand.candidateId, deduped: true });
    }
    // BOSS 端已打招呼的候选人（meta.greeted）：回填打招呼状态与触达记录，
    // 使跟进引擎与岗位跟进视图正确显示「跟进中 · 第 1 轮」而非「未触达」
    if (cand.meta?.greeted) {
      const now = new Date().toISOString();
      cand.greeted = true;
      cand.greetedAt = cand.meta.createdAt ?? now;
      if (!cand.touchStatus) cand.touchStatus = 'engaging';
      store.write('engagements.jsonl', {
        engagementId: `eng_${cand.candidateId}_greet`,
        candidateId: cand.candidateId,
        jobId: cand.jobId,
        recruiterId: cand.recruiterId ?? 'A1',
        action: 'greet',
        touchCount: 1,
        readStatus: 'unread',
        content: cand.meta.greetMessage ?? '',
        stopFlag: false,
        meta: { createdAt: now },
      });
    }
    store.write('candidates.jsonl', cand);
    await audit.record({ actor: 'python-adapter', action: 'candidate.sourced', detail: { candidateId: cand.candidateId, jobId: cand.jobId } });
    const emitResults = await bus.emit('candidate.sourced', cand, { actor: 'python-adapter' });
    for (const r of emitResults) if (r?.error) rt.warn('bus', `candidate.sourced 处理失败 ${cand.candidateId}: ${r.error}`);
    const match = store.readAll('matches.jsonl').filter((m) => m.candidateId === cand.candidateId).at(-1);
    json(res, 201, { candidateId: cand.candidateId, matchScore: match?.matchScore ?? null });
  });

  // 调用 Python 采集适配器（simulator 默认 / boss 复用当前用户扫码登录的会话），失败自动降级为 Node 冒烟
  // 采集设置：单次打招呼人数上限 maxGreet（供「运行采集」与前端设置页持久化）
  const sourcingDefault = { maxGreet: Number(merged.sourcing?.perJobTarget ?? 5) };
  gateway.route('GET', /^\/api\/sourcing\/settings$/, (_req, res) => {
    json(res, 200, { ...sourcingDefault, ...(store.readAll('sourcing_settings.jsonl').at(-1) ?? {}) });
  });
  gateway.route('PUT', /^\/api\/sourcing\/settings$/, async (req, res) => {
    const me = userBySession(req, new URL(req.url, 'http://x'));
    if (!me) return json(res, 401, { error: '请先登录' });
    if (me.role !== 'admin') return json(res, 403, { error: '仅管理员可修改采集设置' });
    const b = await readBody(req);
    const cur = store.readAll('sourcing_settings.jsonl').at(-1) ?? { ...sourcingDefault };
    const next = { ...cur, maxGreet: Math.max(1, Math.min(100, Number(b?.maxGreet) || sourcingDefault.maxGreet)), updatedBy: me.username, updatedAt: new Date().toISOString() };
    store.write('sourcing_settings.jsonl', next);
    await audit.record({ actor: me.username, action: 'sourcing.settings.update', detail: { maxGreet: next.maxGreet } });
    rt.info('settings', `采集设置更新：单次打招呼上限 ${next.maxGreet}（by ${me.username}）`);
    json(res, 200, next);
  });
  gateway.route('POST', /^\/api\/sourcing\/collect$/, async (req, res) => {
    const b = await readBody(req);
    const jobId = b?.jobId ?? firstOpenJob(store)?.jobId;
    if (!jobId) return json(res, 400, { error: '无可用岗位，请先创建岗位(JOB + JD 文本)' });
    const job = store.readAll('jobs.jsonl').find((j) => j.jobId === jobId);
    const home = join(__dirname, '../modules/recruitment-sourcing/adapters/sourcing-py');
    const py = merged.python ?? (existsSync(join(home, 'run.py')) ? resolvePython() : null);
    const me = userBySession(req, new URL(req.url, 'http://x'));
    const bind = me ? bossBindingOf(me.id) : null;
    const cdpUrl = await liveCdpUrl(bind);
    const greet = instance.api.messagelib.render('first', job?.jobTitle ?? b?.keyword ?? '', 1);
    const curSetting = store.readAll('sourcing_settings.jsonl').at(-1) ?? {};
    const extraEnv = {
      // 已绑定 BOSS 会话（扫码/粘贴）→ boss 真实采集；未绑定 → simulator 全链路演示
      ...(bind?.bossToken ? { HR_MODE: 'boss' } : {}),
      ...(cdpUrl ? { HR_BOSS_CDP: cdpUrl } : {}),
      ...(bind?.bossToken ? { HR_BOSS_COOKIES: bind.bossToken } : {}),
      ...(greet?.content ? { HR_BOSS_GREET_MSG: greet.content } : {}),
      // M6 · 前置 AI 匹配：把本会话令牌交给 Python，供其回调 /api/ai/pre-match 做「读JD·在线简历→差距分析」
      HR_AUTH_TOKEN: String(req.headers['x-auth'] || me?.token || ''),
      // BOSS 端职位 ID（encryptJobId）：按职位推荐候选 + 打招呼接口必填；未同步过 BOSS 岗位时由 Python 侧按标题自动匹配
      ...(job?.meta?.bossJobId ? { HR_BOSS_JOB_ID: job.meta.bossJobId } : {}),
      // 用户可设置的「单次采集打招呼人数」上限（设置页持久化；未设时用 config.per_job_target 默认 5）
      HR_BOSS_MAX_GREET: String(curSetting.maxGreet ?? merged.sourcing?.perJobTarget ?? 5),
    };
    try {
      const { code, out } = await runPython(py, home, { jobId, keyword: b?.keyword ?? job?.jobTitle, city: job?.location ?? b?.city ?? '' }, merged.gatewayUrl ?? urlOf(req), extraEnv);
      if (code !== 0) throw new Error(out.slice(-600) || `python 退出码 ${code}`);
      // 解析运行总结（打招呼人数 + 各候选人得分/是否过线），缺失时回退末 4 行
      const sm = out.match(/###RUN_SUMMARY###\s*([\s\S]*?)\s*###RUN_SUMMARY_END###/);
      let summaryLines, greetedCount = null, candsSummary = [];
      if (sm) {
        try {
          const parsed = JSON.parse(sm[1]);
          const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
          greetedCount = jobs.reduce((n, j) => n + (j.greeted || 0), 0);
          for (const j of jobs) {
            const line = j.details?.length
              ? `岗位《${j.jobTitle ?? j.keyword ?? j.job}》打招呼 ${j.greeted} 位（上限 ${j.maxGreet}，阈值 ${j.threshold}）：` +
                j.details.map((d) => `${d.name || ''} ${d.score ?? '-'} 分${d.passed ? '·过线' : '·未过线'}${d.greeted ? '·已打招呼' : ''}(${d.via === 'online' ? '在线简历' : '无简历放行'})`).join('；')
              : `岗位《${j.jobTitle ?? j.keyword ?? j.job}》本轮无候选评估`;
            candsSummary.push(line);
          }
        } catch { /* 总结解析失败则回退默认 */ }
      }
      if (!sm || !candsSummary.length) summaryLines = out.trim().split('\n').slice(-4).join(' | ');
      else summaryLines = candsSummary.join('\n');
      const deliveredCount = (() => { const m = out.match(/成功投递 (\d+)/); return m ? Number(m[1]) : undefined; })();
      rt.info('adapter', `BOSS 采集成功 jobId=${jobId}${cdpUrl ? '（CDP 附着）' : ''}：${summaryLines.split('\n').filter(Boolean).join(' | ')}`);
      json(res, 200, { ok: true, shield: 'python-adapter', via: bind?.bossToken ? (cdpUrl ? 'cdp' : 'cookies') : 'simulator', greeted: greetedCount, candidates: candsSummary.length ? undefined : deliveredCount, summary: summaryLines });
    } catch (err) {
      audit.record({ actor: 'web', action: 'sourcing.collect.error', detail: { jobId, reason: err.message } });
      // 出错即出错，绝不降级 mock 伪造打招呼/候选；如实返回错误供排查
      rt.warn('adapter', `BOSS 采集失败：${err.message}`);
      const via = bind?.bossToken ? (cdpUrl ? 'cdp' : 'cookies') : 'simulator';
      return json(res, 502, { ok: false, shield: 'python-adapter', error: `BOSS 采集失败：${err.message}`, via });
    }
  });

  // ---------- 一键停止所有采集：终止运行中的 Python 采集/同步/沟通扫描子进程，并停用后台定时扫描 ----------
  gateway.route('POST', /^\/api\/sourcing\/stop-all$/, async (req, res) => {
    const me = userBySession(req, new URL(req.url, 'http://x'));
    if (!me) return json(res, 401, { error: '请先登录' });
    const killed = stopAllSource();
    await audit.record({ actor: me.username, action: 'sourcing.stop-all', detail: { killedProcesses: killed } });
    rt.info('adapter', `一键停止所有采集：终止 ${killed} 个采集进程，并停用后台定时扫描任务`);
    json(res, 200, { ok: true, killed });
  });

  // ---------- BOSS 沟通状态扫描（识别「已发简历 / 已同意发简历」→ 自动更新候选人简历状态） ----------
  // 手动按钮（简历收取页「同步 BOSS 沟通状态」）与 30 分钟定时共用；
  // 关注名单 = 已打招呼且尚未收简历的候选人（geekId + 脱敏名，供 Python 侧会话匹配）。
  async function runBossChatScan(me, bind, baseUrl, { auto = false } = {}) {
    const home = join(__dirname, '../modules/recruitment-sourcing/adapters/sourcing-py');
    const py = merged.python ?? (existsSync(join(home, 'run.py')) ? resolvePython() : null);
    const cdpUrl = await liveCdpUrl(bind);
    // 护栏：后台自动扫描绝不自行拉起 BOSS 窗口（那正是导致「自动弹出 BOSS 直聘页面」与触发风控的源头）。
    // 仅当已有在线 BOSS 扫码/网页窗口（CDP 端口存活）时才附着扫描；否则静默跳过，等待用户手动拉起后再扫。
    if (auto && !cdpUrl) {
      rt.info('chat-scan', '无在线 BOSS 窗口（CDP 未存活），本轮自动扫描跳过（不自动拉起窗口）');
      return { ok: true, scanned: 0, received: 0, agreed: 0, unmatched: 0, skipped: 'no_live_window' };
    }
    const watchFull = store.readAll('candidates.jsonl')
      .filter((c) => c.status === 'sourced' && (c.meta?.geekId || c.name))
      .slice(-200);
    const watch = watchFull.map((c) => ({
      geekId: String(c.meta?.geekId ?? ''),
      name: String(c.name ?? ''),
      candidateId: c.candidateId,
    }));
    const { code, out } = await runPython(py, home, { chatScan: true }, baseUrl, {
      ...(cdpUrl ? { HR_BOSS_CDP: cdpUrl } : {}),
      HR_BOSS_COOKIES: bind.bossToken,
      HR_CHAT_WATCH: JSON.stringify(watch),
    });
    const m = out.match(/###CHAT_BEGIN###\s*([\s\S]*?)\s*###CHAT_END###/);
    if (code !== 0 || !m) {
      const why = (out.split('\n').filter((l) => l.includes('[error]') || l.includes('Error')).join(' ').slice(0, 300)) || out.slice(-300);
      throw new Error(why || '适配器无输出');
    }
    let friends = [];
    try { friends = JSON.parse(m[1]); } catch { throw new Error('适配器输出无法解析'); }
    // 会话 → 候选人匹配：geekId 精确 > 姓氏唯一（同姓多人不自动登记，宁漏勿误）
    const cands = store.readAll('candidates.jsonl');
    let received = 0, agreed = 0, unmatched = 0;
    for (const f of friends) {
      const ids = [f.friendId, f.geekId].filter(Boolean).map(String);
      let hit = watchFull.find((c) => c.meta?.geekId && ids.includes(String(c.meta.geekId)));
      if (!hit) {
        const first = String(f.name ?? '')[0];
        if (first) {
          const same = watchFull.filter((c) => String(c.name ?? '')[0] === first);
          if (same.length === 1) hit = same[0];
        }
      }
      if (!hit) { unmatched++; continue; }
      const c = cands.find((x) => x.candidateId === hit.candidateId);
      if (!c) { unmatched++; continue; }
      if (f.resumeSent && c.status === 'sourced') {
        c.status = 'resume_received';
        c.resumeReceivedAt = f.resumeSentAt || new Date().toISOString();
        c.resumeChannel = 'boss_chat_scan';
        received++;
      } else if (f.resumeAgreed && c.status === 'sourced' && !c.resumeAgreedAt) {
        c.resumeAgreedAt = f.resumeAgreedAt || new Date().toISOString();
        agreed++;
      }
    }
    if (received || agreed) {
      store.writeAll('candidates.jsonl', cands);
      await audit.record({ actor: me?.username ?? 'web', action: 'candidate.chat_scan', detail: { scanned: friends.length, received, agreed } });
      rt.info('chat-scan', `BOSS 沟通扫描：${friends.length} 个会话，自动收简历 ${received} 人，标记同意发简历 ${agreed} 人`);
    }
    return { ok: true, scanned: friends.length, received, agreed, unmatched };
  }

  gateway.route('POST', /^\/api\/sourcing\/chat-scan$/, async (req, res) => {
    const me = userBySession(req, new URL(req.url, 'http://x'));
    if (!me) return json(res, 401, { error: '请先登录' });
    const bind = bossBindingOf(me.id);
    if (!bind?.bossToken) return json(res, 400, { error: '尚未绑定 BOSS 会话：请先到「我的账号与 BOSS 绑定」扫码登录，再同步沟通状态' });
    try {
      json(res, 200, await runBossChatScan(me, bind, urlOf(req)));
    } catch (err) {
      rt.warn('chat-scan', `BOSS 沟通状态扫描失败：${err.message}`);
      json(res, 502, { error: `扫描失败：${err.message}` });
    }
  });

  // 从 BOSS 同步在招岗位：复用当前用户扫码登录的会话，拉取账号下职位管理页的在招职位并入岗位库
  gateway.route('POST', /^\/api\/jobs\/sync-boss$/, async (req, res) => {
    const me = userBySession(req, new URL(req.url, 'http://x'));
    if (!me) return json(res, 401, { error: '请先登录' });
    const bind = bossBindingOf(me.id);
    if (!bind?.bossToken) return json(res, 400, { error: '尚未绑定 BOSS 会话：请先到「我的账号与 BOSS 绑定」扫码登录，再同步岗位' });
    const home = join(__dirname, '../modules/recruitment-sourcing/adapters/sourcing-py');
    const py = merged.python ?? (existsSync(join(home, 'run.py')) ? resolvePython() : null);
    const cdpUrl = await liveCdpUrl(bind);
    const { code, out } = await runPython(py, home, { syncJobs: true }, urlOf(req), {
      ...(cdpUrl ? { HR_BOSS_CDP: cdpUrl } : {}),
      HR_BOSS_COOKIES: bind.bossToken,
    });
    const m = out.match(/###JOBS_BEGIN###\s*([\s\S]*?)\s*###JOBS_END###/);
    if (code !== 0 || !m) {
      const why = (out.split('\n').filter((l) => l.includes('[error]') || l.includes('Error')).join(' ').slice(0, 300)) || out.slice(-300);
      rt.warn('jobs-sync', `BOSS 岗位同步失败：${why}`);
      return json(res, 502, { error: `岗位同步失败：${why || '适配器无输出'}` });
    }
    let jobs = [];
    try { jobs = JSON.parse(m[1]); } catch { return json(res, 502, { error: '岗位同步失败：适配器输出无法解析' }); }
    const existing = store.readAll('jobs.jsonl');
    let added = 0, updated = 0;
    for (const j of jobs) {
      const check = validate.validate('job', j);
      if (!check.ok) { rt.warn('jobs-sync', `岗位契约校验跳过 ${j.jobId}：${check.errors.join('; ')}`); continue; }
      const old = existing.find((x) => x.jobId === j.jobId);
      if (old) {
        store.writeAll('jobs.jsonl', existing.map((x) => (x.jobId === j.jobId ? { ...x, ...j, recruiterId: x.recruiterId, meta: { ...x.meta, ...j.meta, syncedAt: new Date().toISOString() } } : x)));
        updated++;
      } else {
        store.write('jobs.jsonl', { ...j, recruiterId: me.id });
        existing.push({ ...j, recruiterId: me.id });
        added++;
      }
    }
    // 清退：本账号此前从 BOSS 同步、但已不在当前在招集合中的岗位（在 BOSS 侧已关闭/暂停/删除）
    const keep = new Set(jobs.map((j) => j.jobId));
    const stale = existing.filter((x) => x.recruiterId === me.id && x.meta?.syncedFrom === 'boss' && !keep.has(x.jobId));
    if (stale.length) {
      const gone = new Set(stale.map((x) => x.jobId));
      store.writeAll('jobs.jsonl', existing.filter((x) => !gone.has(x.jobId)));
      rt.info('jobs-sync', `清退已下线岗位 ${stale.length} 个：${stale.map((x) => x.jobTitle).slice(0, 5).join('、')}${stale.length > 5 ? ' 等' : ''}`);
    }
    rt.info('jobs-sync', `BOSS 岗位同步完成：新增 ${added}、更新 ${updated}${stale.length ? `、清退 ${stale.length}` : ''}`);
    await audit.record({ actor: me.username, action: 'jobs.sync-boss', detail: { added, updated, pruned: stale.length } });
    json(res, 200, { ok: true, added, updated, pruned: stale.length, total: jobs.length, jobs });
  });

  // ---------- 定时调度（FR2） ----------
  gateway.route('POST', /^\/api\/sourcing\/schedules$/, async (req, res) => {
    const b = await readBody(req);
    try {
      const s = instance.api.schedule.create(b);
      rt.info('schedule', `新增定时任务 scheduleId=${s.scheduleId} jobId=${s.jobId} 每 ${s.intervalMinutes} 分钟`);
      await audit.record({ actor: req.headers['x-actor'] ?? 'web', action: 'schedule.create', detail: { scheduleId: s.scheduleId, jobId: s.jobId, intervalMinutes: s.intervalMinutes } });
      json(res, 201, s);
    } catch (e) {
      json(res, 400, { error: e.message });
    }
  });
  gateway.route('POST', /^\/api\/sourcing\/schedules\/control$/, async (req, res) => {
    const b = await readBody(req);
    if (!b?.scheduleId || !b?.action) return json(res, 400, { error: 'scheduleId/action 必填' });
    const r = instance.api.schedule.control(b.scheduleId, b.action);
    if (r.ok) {
      rt.info('schedule', `定时任务 ${r.action} scheduleId=${b.scheduleId}`);
      await audit.record({ actor: 'web', action: `schedule.${r.action}`, detail: { scheduleId: b.scheduleId } });
      json(res, 200, r);
    } else {
      json(res, 400, r);
    }
  });

  // ---------- 导出 ----------
  gateway.route('GET', /^\/export\/candidates\.csv$/, (_req, res) => exportCandidates(res, 'csv', store, instance));
  gateway.route('GET', /^\/export\/candidates\.xlsx$/, (_req, res) => exportCandidates(res, 'xlsx', store, instance));

  // ---------- 静态前端 ----------
  const staticRoutes = [/^\/$/, /^\/index\.html$/, /^\/modules\/recruitment-sourcing\/public\/index\.html$/];
  gateway.route('GET', /^\/modules\/recruitment-sourcing\/public\/index\.html$/, (_req, res) => sendIndex(res));
  gateway.route('GET', /^\/$/, (_req, res) => sendIndex(res));
  gateway.route('GET', /^\/index\.html$/, (_req, res) => sendIndex(res));
  gateway.route('GET', /modules/, (_req, res) => { void staticRoutes; json(res, 404, { error: 'module asset not found' }); });

  return {
    registry, bus, gateway, audit, store, instance, config: merged,
    chatScan: runBossChatScan,
    activeSessionCount,
    registerAutoStop,
    start(port = 0) { this.server = gateway.listen(port); return this.server; },
  };
}

function sendIndex(res) {
  const p = join(__dirname, '../modules/recruitment-sourcing/public/index.html');
  if (!existsSync(p)) return json(res, 404, { error: 'index.html not found' });
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(readFileSync(p, 'utf8'));
}

// 候选人导出：csv 或 xlsx（复用同一份行列数据）
function exportCandidates(res, fmt, store, instance) {
  const rows = buildExportRows(store, instance);
  if (fmt === 'xlsx') {
    const buf = buildXlsx('Candidates', EXPORT_HEAD, rows);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="candidates.xlsx"',
      'Content-Length': buf.length,
    });
    res.end(buf);
    return;
  }
  const csv = [EXPORT_HEAD.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\r\n');
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="candidates.csv"' });
  res.end('\uFEFF' + csv);
}

const EXPORT_HEAD = ['candidateId', '姓名', '来源', '状态', '技能', '工作年限', '期望薪资', '院校', '学历', '匹配分'];

function buildExportRows(store, instance) {
  const cands = instance.api.getCandidates();
  const matches = store.readAll('matches.jsonl');
  const resumes = store.readAll('resumes.jsonl');
  return cands.map((c) => {
    const m = matches.filter((x) => x.candidateId === c.candidateId).at(-1);
    const r = resumes.filter((x) => x.candidateId === c.candidateId).at(-1);
    const edu = r?.parsed?.education ?? c.education ?? {};
    return [
      c.candidateId,
      c.name ?? '',
      c.source,
      c.status,
      (r?.parsed?.skills ?? c.skills ?? []).join('|'),
      c.workExperienceYears ?? '',
      c.salaryExpected ?? '',
      edu.school ?? '',
      edu.degree ?? '',
      m?.matchScore ?? '',
    ];
  });
}

// 复用 Python 采集适配器：以环境/参数传入岗位，读 gateways.jsonl 或 stdout 汇总
// extraEnv 注入 BOSS 会话凭证（CDP 地址 / cookie）与打招呼话术（boss 模式真实采集时由调用方提供）
function runPython(py, home, args, gatewayUrl, extraEnv = {}) {
  return new Promise((resolve) => {
    if (!py) return resolve({ code: -1, out: '未检测到 python' });
    const env = { ...process.env, HR_GATEWAY_URL: gatewayUrl || '', ...extraEnv };
    const flags = args.syncJobs
      ? ['--sync-jobs', '--json']
      : args.chatScan
        ? ['--chat-scan', '--json']
        : ['--job', args.jobId, '--once', '-v',
          ...(args.keyword ? ['--keyword', args.keyword] : []),
          ...(args.city ? ['--city', args.city] : [])];
    const child = spawn(py, [join(home, 'run.py'), ...flags], { cwd: home, env });
    sourcingRuntime.children.add(child); // 登记运行中的采集/扫描子进程，供「一键停止所有采集」终止
    let out = ''; child.stdout.on('data', (d) => { out += d; process.stdout.write('[py>] ' + String(d)); });
    child.stderr.on('data', (d) => { out += d; process.stdout.write('[py!] ' + String(d)); });
    child.on('error', (e) => { sourcingRuntime.children.delete(child); resolve({ code: -2, out: e.message }); });
    child.on('close', (code) => { sourcingRuntime.children.delete(child); resolve({ code, out }); });
  });
}

function urlOf(req) {
  const host = req.headers.host ?? '127.0.0.1:4700';
  return `http://${host}`;
}

// Python 解释器解析（缓存）：优先 HR_PYTHON，否则探测 PATH 中能 import playwright+httpx 的解释器，
// 再回退已知自带依赖的候选。避免落到缺 playwright/httpx 的系统 Python（如 C:\Python314）导致适配器崩溃。
const PY_GOOD_ORDER = [
  process.env.HR_PYTHON,
  'python',
  'C:\\Users\\王小棵\\AppData\\Roaming\\TRAE SOLO CN\\ModularData\\ai-agent\\vm\\tools\\python\\python.exe',
  'C:\\Users\\王小棵\\AppData\\Roaming\\TRAE SOLO CN\\ModularData\\ai-agent\\vm\\tools\\bin\\python.exe',
];
let _pyResolved = null;
function resolvePython() {
  if (_pyResolved) return _pyResolved;
  const probe = 'import playwright, httpx';
  for (const cand of PY_GOOD_ORDER) {
    if (!cand) continue;
    try {
      execFileSync(cand, ['-c', probe], { stdio: 'ignore', timeout: 15000 });
      _pyResolved = cand;
      return cand;
    } catch { /* 该解释器缺依赖，尝试下一个 */ }
  }
  _pyResolved = 'python'; // 全部失败则回退 PATH，让 run.py 给出明确报错
  return _pyResolved;
}

// 扫码浏览器是否仍存活（CDP 附着的前提）：探测调试端口 /json/version
async function liveCdpUrl(bind) {
  if (!bind?.cdpPort) return '';
  try {
    const r = await fetch(`http://127.0.0.1:${bind.cdpPort}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? `http://127.0.0.1:${bind.cdpPort}` : '';
  } catch {
    return '';
  }
}

function pickJd(jdRaw, jobId, keyword, store) {
  if (jdRaw) return { raw: jdRaw, keyword: keyword ?? '前端工程师' };
  const job = store.readAll('jobs.jsonl').find((j) => j.jobId === jobId);
  if (job) return { raw: job.jdRaw ?? '', keyword: keyword ?? job.jobTitle };
  return { raw: '招聘 前端工程师：熟练 JavaScript/TypeScript、React、Node.js，负责核心业务前端开发，具备跨部门协作能力。', keyword: keyword ?? '前端工程师' };
}

function firstOpenJob(store) {
  return store.readAll('jobs.jsonl').find((j) => j.status === 'open') ?? store.readAll('jobs.jsonl').at(-1) ?? null;
}

function csvCell(v) {
  const s = String(v ?? '').replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 直接运行入口
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = await createApplication({
    storeDir: join(__dirname, '../infra/store'),
    llm: {
      baseURL: process.env.HR_LLM_BASE,
      apiKey: process.env.HR_LLM_KEY,
      model: process.env.HR_LLM_MODEL,
    },
    auth: { token: process.env.HR_AUTH_TOKEN || undefined, actor: process.env.HR_AUTH_ACTOR || undefined },
  });
  const port = Number(process.env.HR_PORT) || 4700;
  app.start(port);
  console.log(`[server] 招聘提效模块运行中 → http://127.0.0.1:${port}`);
  console.log('[server] LLM    :', app.config.llm?.baseURL ? '已配置(' + app.config.llm.model + ')' : '未配置(离线启发式)');
  // 每 30 分钟自动扫描已绑定 BOSS 账号的沟通状态：识别简历事件并自动更新候选人状态（无需人工点按钮）
  // 仅当存在活跃登录会话时执行；登出后无会话则跳过并随服务停止
  let chatScanBusy = false;
  const chatScanTimer = setInterval(() => {
    if (chatScanBusy) return;
    if (app.activeSessionCount() === 0) return;
    chatScanBusy = true;
    (async () => {
      for (const bind of app.store.readAll('bossbindings.jsonl').filter((b) => b.bossToken)) {
        try {
          const r = await app.chatScan({ id: bind.userId, username: bind.bossAccount || bind.userId }, bind, `http://127.0.0.1:${port}`, { auto: true });
          /* auto=true → runBossChatScan 内：无在线 BOSS 窗口（CDP 未存活）时跳过，绝不自行拉起浏览器窗口 */
          if (r.received || r.agreed) rt.info('chat-scan', `定时扫描（${bind.bossAccount || bind.userId}）：自动收简历 ${r.received} 人，标记同意发简历 ${r.agreed} 人`);
        } catch (e) {
          rt.warn('chat-scan', `定时扫描失败（下轮 30 分钟后自动重试）：${e.message}`);
        }
      }
    })().finally(() => { chatScanBusy = false; });
  }, 30 * 60 * 1000);
  chatScanTimer.unref?.();
  app.registerAutoStop(() => clearInterval(chatScanTimer));
  sourcingRuntime.timers.push(chatScanTimer);
}