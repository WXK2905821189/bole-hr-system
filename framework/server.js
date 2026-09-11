// 应用入口：统一网关 + 静态前端 + 采集候选注入(供 Python 适配器推送) + CSV 导出
// 运行：node framework/server.js   （默认端口 4700）
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
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

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    store.write('users.jsonl', { id: 'A1', username: 'wang', name: '王先生', password: 'boss123', role: 'admin', active: true });
  }
  const findUser = (username) => store.readAll('users.jsonl').find((u) => u.username === username);
  const findSession = (token) => store.readAll('sessions.jsonl').find((s) => s.token === token);
  const userBySession = (req, url) => {
    const token = req.headers['x-auth'] ?? url?.searchParams?.get('token') ?? '';
    const s = findSession(String(token));
    return s && store.readAll('users.jsonl').find((u) => u.id === s.userId);
  };
  const publicUser = (u, withBoss = true) => {
    if (!u) return null;
    const boss = store.readAll('bossbindings.jsonl').find((b) => b.userId === u.id);
    const base = { id: u.id, username: u.username, name: u.name, role: u.role, active: u.active !== false };
    if (withBoss) base.boss = boss ? { account: boss.bossAccount, nick: boss.bossNick || '', masked: boss.bossToken ? maskToken(boss.bossToken) : null } : null;
    return base;
  };
  const maskToken = (t) => (t && t.length > 8 ? `${t.slice(0, 4)}****${t.slice(-4)}` : t);

  const { instance } = await loadModule({ bus, validate, audit, store, config: merged, manifest });
  registry.register({ ...manifest, instance });
  await new Lifecycle(registry, bus).start(manifest.id);
  instance.api.schedule.start(); // 恢复持久化的定时调度任务
  instance.api.followup.start(merged.engage?.followSweepMinutes ?? 1); // 恢复智能跟进扫描

  // ---------- 域查询（GET） ----------
  const list = (name) => (_req, res) => json(res, 200, { [name]: store.readAll(`${name}.jsonl`) });
  gateway.route('GET', /^\/health$/, (_req, res) => json(res, 200, { ok: true, ts: new Date().toISOString() }));

  // ---------- 用户系统（登录 / 会话 / 登出） ----------
  gateway.route('POST', /^\/api\/auth\/login$/, async (req, res) => {
    const b = await readBody(req);
    const u = findUser(String(b?.username ?? ''));
    if (!u || u.password !== String(b?.password ?? '')) return json(res, 401, { ok: false, error: '账号或密码错误' });
    if (u.active === false) return json(res, 403, { ok: false, error: '该账号已被停用，请联系管理员' });
    const token = randomBytes(16).toString('hex');
    store.write('sessions.jsonl', { token, userId: u.id, createdAt: new Date().toISOString() });
    await audit.record({ actor: u.id, action: 'auth.login', detail: { username: u.username } });
    json(res, 200, { ok: true, token, user: publicUser(u) });
  });
  gateway.route('POST', /^\/api\/auth\/register$/, async (req, res) => {
    const b = await readBody(req);
    const uname = String(b?.username ?? '').trim().toLowerCase();
    const name = String(b?.name ?? '').trim();
    if (!name || !uname || !b?.password) return json(res, 400, { ok: false, error: '姓名/用户名/密码必填' });
    if (String(b.password).length < 4) return json(res, 400, { ok: false, error: '密码至少 4 位' });
    if (!/^[a-zA-Z0-9_]{2,24}$/.test(uname)) return json(res, 400, { ok: false, error: '用户名需为 2-24 位字母/数字/下划线' });
    if (findUser(uname)) return json(res, 409, { ok: false, error: '该用户名已存在，请更换' });
    const id = `U${Date.now().toString(36).toUpperCase()}`;
    store.write('users.jsonl', { id, username: uname, name, password: String(b.password), role: 'recruiter', active: true });
    const token = randomBytes(16).toString('hex');
    store.write('sessions.jsonl', { token, userId: id, createdAt: new Date().toISOString() });
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
    const id = b?.id || `U${Date.now().toString(36).toUpperCase()}`;
    store.write('users.jsonl', { id, username: uname, name: String(b.name), password: String(b.password), role: b.role === 'admin' ? 'admin' : 'recruiter', active: true });
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
    if (target.id === me.id && b?.old && target.password !== String(b.old)) return json(res, 401, { ok: false, error: '原密码不正确' });
    if (!b?.password || String(b.password).length < 4) return json(res, 400, { ok: false, error: '新密码至少 4 位' });
    target.password = String(b.password);
    store.writeAll('users.jsonl', users);
    await audit.record({ actor: me.id, action: 'users.password', detail: { id: target.id } });
    json(res, 200, { ok: true });
  });
  // 停用 / 启用（管理员）
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
    await audit.record({ actor: me.id, action: 'users.active', detail: { id: target.id, active: target.active } });
    json(res, 200, { ok: true, active: target.active });
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
    binds.push({ userId: sess.userId, bossAccount: existing?.bossAccount ?? '', bossNick: existing?.bossNick ?? '', bossToken: sess.cookieString, bossScan: true, updatedAt: new Date().toISOString() });
    store.writeAll('bossbindings.jsonl', binds);
    await audit.record({ actor: sess.userId, action: 'boss.scan_capture', detail: { userId: sess.userId, cookies: sess.cookieCount } });
    rt.info('bossscan', `用户 ${sess.userId} 扫码登录成功，自动捕获 ${sess.cookieCount} 个 BOSS 会话 cookie`);
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

  gateway.route('GET', /^\/jobs$/, list('jobs'));
  gateway.route('GET', /^\/candidates$/, list('candidates'));
  gateway.route('GET', /^\/resumes$/, list('resumes'));
  gateway.route('GET', /^\/matches$/, list('matches'));
  gateway.route('GET', /^\/cycles$/, list('cycles'));
  gateway.route('GET', /^\/audit$/, (_req, res) => json(res, 200, { audit: audit.tail(50) }));
  gateway.route('GET', /^\/api\/audit$/, (_req, res, url) => json(res, 200, { audit: audit.tail(Number(url.searchParams.get('n') ?? 50)) }));

  // ---------- 系统运行日志（运维排查） ----------
  gateway.route('GET', /^\/api\/logs$/, (_req, res, url) => {
    const level = url.searchParams.get('level') || '';
    const rows = rt.list(Number(url.searchParams.get('n') ?? 300));
    json(res, 200, { logs: level ? rows.filter((l) => l.level === level) : rows });
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

  // 采集候选注入（Python 适配器真实推送入口）：校验契约 → 入库 → 发事件 → 触发解析/匹配
  gateway.route('POST', /^\/api\/sourcing\/candidates$/, async (req, res) => {
    const cand = await readBody(req);
    const check = validate.validate('candidate', cand);
    if (!check.ok) return json(res, 400, { error: `契约校验失败: ${check.errors.join('; ')}` });
    store.write('candidates.jsonl', cand);
    await audit.record({ actor: 'python-adapter', action: 'candidate.sourced', detail: { candidateId: cand.candidateId, jobId: cand.jobId } });
    await bus.emit('candidate.sourced', cand, { actor: 'python-adapter' });
    const match = store.readAll('matches.jsonl').filter((m) => m.candidateId === cand.candidateId).at(-1);
    json(res, 201, { candidateId: cand.candidateId, matchScore: match?.matchScore ?? null });
  });

  // 调用 Python 采集适配器（simulator 默认 / boss 需已配置账号会话），失败自动降级为 Node 冒烟
  gateway.route('POST', /^\/api\/sourcing\/collect$/, async (req, res) => {
    const b = await readBody(req);
    const jobId = b?.jobId ?? firstOpenJob(store)?.jobId;
    if (!jobId) return json(res, 400, { error: '无可用岗位，请先创建岗位(JOB + JD 文本)' });
    const job = store.readAll('jobs.jsonl').find((j) => j.jobId === jobId);
    const home = join(__dirname, '../modules/recruitment-sourcing/adapters/sourcing-py');
    const py = merged.python ?? process.env.HR_PYTHON ?? (existsSync(join(home, 'run.py')) ? 'python' : null);
    try {
      const { code, out } = await runPython(py, home, { jobId, keyword: b?.keyword }, merged.gatewayUrl ?? urlOf(req));
      if (code !== 0) throw new Error(out.slice(-600) || `python 退出码 ${code}`);
      rt.info('adapter', `BOSS 采集成功 jobId=${jobId}：${out.trim().split('\n').slice(-4).join(' | ')}`);
      json(res, 200, { ok: true, shield: 'python-adapter', summary: out.trim().split('\n').slice(-4).join(' | ') });
    } catch (err) {
      audit.record({ actor: 'web', action: 'sourcing.collect.fallback', detail: { jobId, reason: err.message } });
      rt.warn('adapter', `BOSS 采集失败，降级模拟：${err.message}`);
      const recruiterId = b?.recruiterId || req.headers['x-recruiter-id'] || job?.recruiterId || 'A1';
      const r = await instance.api.runSourcingCycle(jobId, job.jdRaw ?? b?.jdRaw ?? '招聘 前端工程师', b?.keyword ?? job.jobTitle, recruiterId);
      json(res, 200, { ok: true, shield: 'node-mock(降级)', note: `Python 调用失败已降级：${err.message}`, greeted: r.greeted, candidates: r.candidates?.length ?? 0, steps: r.steps });
    }
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
function runPython(py, home, args, gatewayUrl) {
  return new Promise((resolve) => {
    if (!py) return resolve({ code: -1, out: '未检测到 python' });
    const env = { ...process.env, HR_GATEWAY_URL: gatewayUrl || '' };
    const child = spawn(py, [join(home, 'run.py'), '--job', args.jobId, '--once', '-v', ...(args.keyword ? ['--keyword', args.keyword] : [])], { cwd: home, env });
    let out = ''; child.stdout.on('data', (d) => { out += d; process.stdout.write('[py>] ' + String(d)); });
    child.stderr.on('data', (d) => { out += d; process.stdout.write('[py!] ' + String(d)); });
    child.on('error', (e) => resolve({ code: -2, out: e.message }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

function urlOf(req) {
  const host = req.headers.host ?? '127.0.0.1:4700';
  return `http://${host}`;
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
}