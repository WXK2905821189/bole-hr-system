// 应用入口（装配职责）：构建模块实例/审计/存储/网关，并把路由注册委托给 framework/routes/register.js。
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
import { registerRoutes } from './routes/register.js';

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

  // 用户系统：首次启动注入默认账号（登录决定所属招聘者账号，替代左下角切换器）。
  // 全新安装的默认账号标记 mustChangePw，首次登录须强制改密（收口 P0 弱口令）。
  if (!store.readAll('users.jsonl').length) {
    store.write('users.jsonl', { id: 'A1', username: 'wang', name: '王先生', password: hashPw('boss123'), role: 'admin', active: true, mustChangePw: true });
  }
  // 启动弱口令检查：历史部署可能已存在用 boss123 的账号（且未标记），统一补齐 mustChangePw 以便首登强改。
  // 这里用 verifyPw（兼容旧明文）而非比对散列原文，避免硬编码某个具体散列。
  (() => {
    const users = store.readAll('users.jsonl');
    let touched = false;
    for (const u of users) {
      if (u.mustChangePw) continue;
      if (verifyPw('boss123', u.password).ok) { u.mustChangePw = true; touched = true; }
    }
    if (touched) store.writeAll('users.jsonl', users);
  })();
  const findUser = (username) => store.readAll('users.jsonl').find((u) => u.username === username);
  const findSession = (token) => store.readAll('sessions.jsonl').find((s) => s.token === token);
  // 会话是否可用：必须存在且未过期（M5：超时自动失效）。无 expiresAt 的历史残留视为已失效。
  const sessionAlive = (s) => !!s && !!s.expiresAt && new Date(s.expiresAt).getTime() > Date.now();
  // 会话对应用户：可选 opts.allowPending 放行「首登未改密」账号（仅少数路径需放行）。
  // 默认下，mustChangePw 的账号被路由门禁拦截（返回 undefined → 业务/数据接口 401），强制先改密。
  const userBySession = (req, url, opts = {}) => {
    const token = req.headers['x-auth'] ?? url?.searchParams?.get('token') ?? '';
    const s = findSession(String(token));
    if (!s || !sessionAlive(s)) {
      if (s && !sessionAlive(s)) { // 过期会话：删除（惰性失效）
        store.writeAll('sessions.jsonl', store.readAll('sessions.jsonl').filter((x) => x.token !== s.token));
      }
      return undefined;
    }
    const u = store.readAll('users.jsonl').find((x) => x.id === s.userId && x.active !== false);
    if (u && u.mustChangePw === true && opts.allowPending !== true) return undefined;
    return u;
  };
  const sessionTtl = () => (Number(merged.auth?.sessionTtlMs) || 12 * 60 * 60 * 1000);
  const newSession = async (userId, username) => {
    const token = randomBytes(16).toString('hex');
    const now = Date.now();
    const expiresAt = new Date(now + sessionTtl()).toISOString();
    store.write('sessions.jsonl', { token, userId, createdAt: new Date(now).toISOString(), expiresAt });
    return token;
  };
  const invalidateUserSessions = (userId) => {
    const before = store.readAll('sessions.jsonl').length;
    store.writeAll('sessions.jsonl', store.readAll('sessions.jsonl').filter((s) => s.userId !== userId));
    return before - store.readAll('sessions.jsonl').length;
  };
  // 启动时清理失效会话：无 expiresAt 的历史残留或已过期会话一律清除（避免误判为活跃、防登录态残留）
  (() => {
    const alive = store.readAll('sessions.jsonl').filter((s) => sessionAlive(s));
    if (alive.length !== store.readAll('sessions.jsonl').length) store.writeAll('sessions.jsonl', alive);
  })();
  const maskToken = (t) => (t && t.length > 8 ? `${t.slice(0, 4)}****${t.slice(-4)}` : t);
  const publicUser = (u, withBoss = true) => {
    if (!u) return null;
    const boss = store.readAll('bossbindings.jsonl').find((b) => b.userId === u.id);
    const base = { id: u.id, username: u.username, name: u.name, role: u.role, active: u.active !== false, mustChangePw: u.mustChangePw === true };
    if (withBoss) base.boss = boss ? { bossAccount: boss.bossAccount, bossNick: boss.bossNick || '', masked: boss.bossToken ? maskToken(boss.bossToken) : null } : null;
    return base;
  };
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

  // 智能跟进扫描：无活跃会话时跳过（不驱动 BOSS），登出后随服务一并停止
  const followSweepMs = Math.max(1, Number(merged.engage?.followSweepMinutes) || 1) * 60000;
  const followTimer = setInterval(() => {
    if (activeSessionCount() === 0) return;
    instance.api.followup.sweep({}).catch(() => {});
  }, followSweepMs);
  followTimer.unref?.();
  registerAutoStop(() => clearInterval(followTimer));
  sourcingRuntime.timers.push(followTimer);

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

  // ---------- BOSS 沟通状态扫描（识别「已发简历 / 已同意发简历」→ 自动更新候选人简历状态） ----------
  // 手动按钮（简历收取页「同步 BOSS 沟通状态」）与 30 分钟定时共用；
  // 关注名单 = 已打招呼且尚未收简历的候选人（geekId + 脱敏名，供 Python 侧会话匹配）。
  async function runBossChatScan(me, bind, baseUrl, { auto = false } = {}) {
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

  const home = join(__dirname, '../modules/recruitment-sourcing/adapters/sourcing-py');

  // 路由注册（handler 见 framework/routes/register.js）：注入共享闭包与工具，保持行为与拆分前一致。
  await registerRoutes(gateway, {
    instance, store, audit, bus, rt, merged, validate,
    registry, findUser, hashPw, verifyPw, pwPolicyError, publicUser,
    newSession, invalidateUserSessions, stopWhenNoActiveSession,
    userBySession, bossBindingOf, bossScan, runBossChatScan, home,
    json, readBody, pickJd, firstOpenJob, urlOf,
    runPython, resolvePython, liveCdpUrl, stopAllSource, sendIndex, exportCandidates,
  });

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