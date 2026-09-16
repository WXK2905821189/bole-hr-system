// 路由注册（拆分自原 framework/server.js 的内联路由块）。
// 本次拆分纯粹是结构性重组：handler 代码原样迁入，仅将其所依赖的闭包/工具经 ctx 注入；
// 除下述两处外不对任何行为做改动——① Python 适配器目录 home 由 ctx 提供（规避 __dirname 深一层后路径漂移）；
// ② adminMe 提到本文件顶部（原内联定义）。拆分后不影响任何路由语义。
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function registerRoutes(gateway, ctx) {
  const {
    instance, store, audit, bus, rt, merged, validate,
    json, readBody, userBySession, pickJd, firstOpenJob,
    bossBindingOf, stopAllSource, runPython, resolvePython, liveCdpUrl, urlOf,
    sendIndex, exportCandidates, home, runBossChatScan, bossScan,
    registry, findUser, hashPw, verifyPw, pwPolicyError, publicUser,
    newSession, invalidateUserSessions, stopWhenNoActiveSession,
  } = ctx;

  // 管理员门禁（原内联于 M4 段；提到顶部复用给 rules / llm.config 等）
  const adminMe = (req, url, res) => {
    const me = userBySession(req, url);
    if (!me) { json(res, 401, { ok: false, error: '未登录或会话已失效' }); return null; }
    if (me.role !== 'admin') { json(res, 403, { ok: false, error: '仅管理员可操作' }); return null; }
    return me;
  };

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
    // mustChangePw=true：首登未改密，前端应强制跳转改密（业务接口已被门禁拦截）
    json(res, 200, { ok: true, token, user: publicUser(u), mustChangePw: u.mustChangePw === true });
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
    // allowPending：首登未改密的账号仍需能查询自身身份（前端据此弹出/重定向改密）
    const me = userBySession(req, url, { allowPending: true });
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
    // allowPending：首登未改密的账号必须能通过本接口完成强制改密（其余业务接口已被门禁拦截）
    const me = userBySession(req, url, { allowPending: true });
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
    if (target.mustChangePw === true) target.mustChangePw = false; // 首登强制改密完成 → 解除受限
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

  // ---------- C4 · 轨道二总体能力分（单候选预览/复核用） ----------
  gateway.route('GET', /^\/api\/sourcing\/overall\/([^/]+)$/, async (req, res, url) => {
    const me = userBySession(req, url);
    if (!me) return json(res, 401, { ok: false, error: '未登录或会话已失效' });
    const m = url.pathname.match(/^\/api\/sourcing\/overall\/([^/]+)$/);
    const ov = await instance.api.overall.score(decodeURIComponent(m[1]));
    if (!ov) return json(res, 404, { ok: false, error: '未找到候选人简历' });
    json(res, 200, { ok: true, ...ov });
  });

  // ---------- C4 · 人工复核池 ----------
  gateway.route('GET', /^\/api\/sourcing\/review-pool$/, async (req, res, url) => {
    const me = userBySession(req, url);
    if (!me) return json(res, 401, { ok: false, error: '未登录或会话已失效' });
    const pool = await instance.api.review.pool();
    await audit.record({ actor: me.username, action: 'sourcing.review.pool', detail: { enabled: pool.enabled, count: pool.count } });
    json(res, 200, { ok: true, ...pool });
  });
  gateway.route('POST', /^\/api\/sourcing\/review\/([^/]+)\/decide$/, async (req, res, url) => {
    const me = userBySession(req, url);
    if (!me) return json(res, 401, { ok: false, error: '未登录或会话已失效' });
    const m = url.pathname.match(/^\/api\/sourcing\/review\/([^/]+)\/decide$/);
    const b = await readBody(req);
    const r = await instance.api.review.decide(decodeURIComponent(m[1]), b?.decision, me.id);
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
  // 手动按钮（简历收取页「同步 BOSS 沟通状态」）与 30 分钟定时共用
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
}