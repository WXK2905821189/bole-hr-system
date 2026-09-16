/* app.js — 状态 + 视图渲染 + 交互接线
   视图内容全部注入 .view 容器；API 一律经 api.js 桩层，不直接碰 mock */
import * as api from './api.js';
import { DB } from './mock.js';

const $ = (s) => document.querySelector(s);
const state = {
  page: 'dashboard',
  candidates: { status: 'all', tch: 'all', q: '', page: 1, pageSize: 8, total: 0 },
  talent: { q: '', page: 1, pageSize: 8 },
};
const TITLES = {
  dashboard: ['运营总览', '信号看板 · 采集流水线 · 触达脉搏'],
  jobs: ['招聘岗位', 'JD → 关键词 → 定时关键词轮询'],
  schedule: ['采集调度', '定时批量 · 频率受控 · 失败熔断'],
  candidates: ['候选人库', '按登录账号隔离 · 触达状态 · 匹配分排序 · 脱敏导出'],
  talent: ['人才库', '共享人才池 · 账号无关 · 伯乐指数'],
  engage: ['触达沟通', '话术库 · 自动打招呼 · 智能跟进 · 批次 · 复盘'],
  engageaudit: ['触达审计', '打招呼 / 收取 / 交换 · 不可篡改'],
  audit: ['审计留痕', '采集 / 访问 / 导出 · 不可篡改'],
  settings: ['准入与护栏', '账号接入 · 最小权限 · 数据留存'],
  logs: ['运行日志', '系统流水 · 采集 / 触达 / 风控 / 访问 · 分级'],
};

/* ---------- 导航 ---------- */
function initNav() {
  document.querySelectorAll('.navitem').forEach((btn) =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.navitem').forEach((b) => b.classList.toggle('active', b === btn));
      show(btn.dataset.nav);
    }));
}
function show(page) {
  state.page = page;
  document.body.dataset.page = page;
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $('#view-' + page).classList.add('active');
  [$('#pageTitle').textContent, $('#pageSub').textContent] = TITLES[page];
  load(page);
}

/* ---------- 通用小件 ---------- */
function badge(c) {
  const m = { matched: ['b-ok', '已匹配'], parsed: ['b-info', '已入库'], pending: ['b-warn', '待核对'], failed: ['b-err', '解析失败'] };
  const [cls, txt] = m[c.status] || m.parsed;
  return `<span class="badge ${cls}">${txt}</span>`;
}
function score(c) {
  if (c.matchScore == null) return `<span class="scorewrap s-none"><span class="scorebar"><i></i></span><span class="scorenum">—</span></span>`;
  const g = c.matchScore >= 70 ? 'high' : c.matchScore >= 50 ? 'mid' : 'low';
  return `<span class="scorewrap s-${g}"><span class="scorebar"><i style="width:${c.matchScore}%"></i></span><span class="scorenum">${c.matchScore}</span></span>`;
}
function skills(arr) { return arr.map((s) => `<span class="skill">${s}</span>`).join(''); }
function toast(msg) {
  const t = $('#toast'); t.innerHTML = `<span class="ic">✓</span>${msg}`; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}
function skeleton(n) { return Array.from({ length: n }, () => '<div class="skel row"></div>').join(''); }
let selCand = null;

/* ================================================================
   VIEW 1 · 运营总览
   ================================================================ */
const TM = { pending: ['t-pending', '待跟'], engaging: ['t-engaging', '跟进中'], replied: ['t-replied', '已回复'], sleeping: ['t-sleeping', '沉睡'] };
function tmeta(c) { return DB.touchMeta[c.id] || { st: 'pending', round: 0, read: false, ver: '—' }; }
function tbadge(st) { const [cls, txt] = TM[st] || TM.pending; return `<span class="tbadge ${cls}"><i></i>${txt}</span>`; }
function touchCounts() {
  const out = { pending: 0, engaging: 0, replied: 0, sleeping: 0 };
  Object.values(DB.touchMeta || {}).forEach((t) => { if (out[t.st] != null) out[t.st]++; });
  const total = out.pending + out.engaging + out.replied + out.sleeping;
  return Object.assign(out, { total });
}
/* 运营总览右栏「触达信号」单行 */
function sigRow(lab, cls, v, total) {
  const pct = total ? Math.round(v / total * 100) : 0;
  return `<div class="sigrow"><span class="tch ${cls}"><i></i>${lab}</span><b>${v}</b><span class="pct">${pct}%</span></div>
    <div class="sig-bar"><i class="${cls}" style="width:${pct}%"></i></div>`;
}

/* ================================================================
   VIEW 1 · 运营总览（信号看板 + 采集流水线 + 触达信号右栏）
   ================================================================ */
async function loadDashboard() {
  $('#view-dashboard').innerHTML = '<div class="kpis">' + skeleton(4).replace(/row/g, 'row') + '</div>';
  const ov = await api.fetchOverview();
  const tc = touchCounts();
  $('#view-dashboard').innerHTML = `
    <div class="msbar">
      <div class="ms-head"><b>里程碑主线</b><span>寻访 → 触达 → 收取 → 跟进 · 自动化闭环</span></div>
      <div class="ms-track">
        <div class="ms m1 done"><span class="ms-no">M1</span><b>自动寻访打招呼</b><em>推荐牛人 + 搜索 · 匹配即打招呼</em></div>
        <div class="ms-arrow">→</div>
        <div class="ms m2 running"><span class="ms-no">M2</span><b>自动收简历</b><em>发简历事件自动同意 · 解析入库</em></div>
        <div class="ms-arrow">→</div>
        <div class="ms m3 todo"><span class="ms-no">M3</span><b>智能跟进</b><em>已读/未读状态机 · 自动求简历</em></div>
      </div>
    </div>
    <div class="dash-layout">
      <div class="dash-main">
        <div class="kpis">
          <div class="kpi"><div class="lab">今日索取简历 · <b style="color:#a16b12">伯乐指数</b></div><div class="val">${ov.kpis.today}<small>份</small></div><div class="delta">昨日同期 <b>+12%</b> · 日上限 200</div><div class="mbar"><i style="width:${Math.round(ov.kpis.today / 200 * 100)}%"></i></div></div>
          <div class="kpi g"><div class="lab">入库成功率</div><div class="val">${ov.kpis.successRate}<small>%</small></div><div class="delta"><b>达标</b> · 阈值 ≥90%</div><div class="mbar"><i style="width:${ov.kpis.successRate}%"></i></div></div>
          <div class="kpi i"><div class="lab">解析核心字段准确率</div><div class="val">${ov.kpis.accuracy}<small>%</small></div><div class="delta"><b>↑ 1.2pp</b> · 近7天</div><div class="mbar"><i style="width:${ov.kpis.accuracy}%"></i></div></div>
          <div class="kpi w"><div class="lab">活跃候选人 / 待处理</div><div class="val">${ov.kpis.active}<small>人</small></div><div class="delta">待人工核对 <b class="w">12</b> · 沉睡中 <b class="w">${tc.sleeping}</b></div><div class="mbar"><i style="width:72%"></i></div></div>
        </div>
        <div class="split2">
          <div class="card">
            <div class="card-hd"><h2>采集流水线</h2><span class="hint">按当前配置预期</span><span class="t-right"><span class="badge b-ok">运行中</span></span></div>
            <div class="card-bd">
              <div class="pipe">${ov.pipeline.map((p) => `<div class="step ${p.state}"><div class="bar"></div><span class="n">${p.name}</span><div>${p.pass}</div></div>`).join('')}</div>
              <p class="textfield" style="margin:16px 0 0;color:var(--muted);font-size:12.5px;line-height:1.7">下一周期：<b style="color:var(--ink)">「前端工程师」</b> 今日 17:00 · 间隔护栏 3–8s 随机化 · 目标 4 账号轮询。</p>
            </div>
          </div>
          <div class="card">
            <div class="card-hd"><h2>入库质量</h2><span class="hint">近7天解析样本</span></div>
            <div class="card-bd" style="display:flex;gap:18px;align-items:center">
              <div class="donut"><div class="mid">73%</div></div>
              <div class="legend">
                <div class="row"><span class="sw" style="background:var(--ok)"></span>解析达标<b>${ov.quality.ok}</b></div>
                <div class="row"><span class="sw" style="background:var(--gold)"></span>需人工复核<b>${ov.quality.review}</b></div>
                <div class="row"><span class="sw" style="background:var(--err)"></span>解析失败<b>${ov.quality.fail}</b></div>
              </div>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-hd"><h2>触达看板</h2><span class="hint">候选人触达状态分布 · 快捷入口</span>
            <span class="t-right"><button class="btn ghost sm" data-goto="engage" type="button">进入触达沟通 →</button></span></div>
          <div class="card-bd">
            <div class="touchband">${([['pending', '待跟', tc.pending], ['engaging', '跟进中', tc.engaging], ['replied', '已回复', tc.replied], ['sleeping', '沉睡', tc.sleeping]]
              .map(([k, lab, v]) => `<div class="ts" data-goto="candidates" data-f="tch=${k}">
                <span class="tb ${TM[k][0]}"><i></i>${lab}</span><b>${v}</b><span class="tpct">${tc.total ? Math.round(v / tc.total * 100) : 0}%</span></div>`).join(''))}
            </div>
            <p class="textfield" style="margin:14px 0 0;color:var(--muted);font-size:12px;line-height:1.7">点击状态卡片可在候选人库按对应触达状态筛选；指标口径与明细见「触达沟通 · 数据复盘」。</p>
          </div>
        </div>
        <div class="card">
          <div class="card-hd"><h2>今日候选高峰（按伯乐指数）</h2><span class="hint">Top 6 · 点击行查看详情</span></div>
          <div class="card-bd flat">
            <div class="table-wrap"><table><thead><tr><th>候选人</th><th>年限</th><th>核心技能</th><th>状态</th><th>伯乐指数</th></tr></thead>
            <tbody id="dashTable">${ov.top.map(dashRow).join('') || '<tr><td colspan="5" class="empty">暂无数据</td></tr>'}
            </tbody></table></div>
          </div>
        </div>
      </div>
      <aside class="signal">
        <div class="sig-hd"><span class="stitle">触达信号 · 今日</span><span class="badge b-gold">伯乐</span></div>
        <div class="sig-body">
          ${sigRow('已回复', 't-replied', tc.replied, tc.total)}
          ${sigRow('跟进中', 't-engaging', tc.engaging, tc.total)}
          ${sigRow('沉睡', 't-sleeping', tc.sleeping, tc.total)}
          ${sigRow('待跟', 't-pending', tc.pending, tc.total)}
          <div class="sig-sep"></div>
          <div style="font-size:11px;color:var(--faint);line-height:1.7">「触达信号」常驻运营总览右栏，实时反映候选人响应脉搏；点击可在候选人库左栏按状态筛看。</div>
        </div>
      </aside>
    </div>`;
  bindTableClicks('#dashTable');
  $('#view-dashboard').querySelectorAll('[data-goto]').forEach((el) =>
    el.addEventListener('click', () => {
      const page = el.dataset.goto;
      if (page === 'engage') {
        document.querySelectorAll('.navitem').forEach((b) => b.classList.toggle('active', b.dataset.nav === 'engage'));
        show('engage');
      } else if (page === 'candidates') {
        const m = (el.dataset.f || '').match(/tch=(\w+)/);
        if (m) { state.candidates.tch = m[1]; state.candidates.page = 1; }
        show('candidates');
        if (m) $('#touchSeg')?.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tc === m[1]));
      }
    }));
}

/* ================================================================
   VIEW 2 · 岗位 / JD
   ================================================================ */
async function loadJobs() {
  const { jobs } = await api.fetchJobs();
  $('#view-jobs').innerHTML = `
    <div class="card">
      <div class="card-hd"><h2>岗位 / JD 关键词</h2><span class="hint">粘贴 JD 自动解析，可人工微调</span>
        <div class="t-right"><button class="btn sm" id="btnNewJob" type="button">+ 新增岗位</button></div></div>
      <div class="card-bd"><div class="jobgrid" id="jobGrid">${jobs.map(jobCard).join('')}</div></div>
    </div>`;
  $('#btnNewJob').addEventListener('click', () => $('#jobModal').classList.add('open'));
  $('#jobGrid').querySelectorAll('.jobcard').forEach((el) =>
    el.addEventListener('click', () => show('candidates')));
}

function jobCard(j) {
  const act = j.status === 'active' ? 'b-ok' : 'b-gray';
  const txt = j.status === 'active' ? '采集中' : '待命';
  return `<div class="jobcard">
    <div class="jt">${j.title}<span class="jid">${j.jobId}</span><span class="badge stat ${act}">${txt}</span></div>
    <div class="kw">${j.keywords.map((k) => `<span class="tag">${k}</span>`).join('')}</div>
    <div class="ftr">本周第 <b style="color:var(--text)">${j.round}</b> 轮 · 今日已收 ${j.todayQuota} 份 · 上次 ${j.lastRun}</div>
  </div>`;
}

/* ================================================================
   VIEW 3 · 采集调度
   ================================================================ */
async function loadSchedule() {
  const { jobs } = await api.fetchJobs();
  const s = await api.fetchScheduleHealth();
  const healthRows = s.health.map((h) => `
    <div class="hcheck ${h.ok ? 'ok' : 'no'}">
      <span class="hc-ic">${h.ok ? '✓' : '!'}</span>
      <div style="flex:1;min-width:0"><b>${h.label}</b><div class="hc-note">${h.note}</div></div>
      <span class="badge ${h.ok ? 'b-ok' : 'b-warn'}">${h.ok ? '就绪' : '需处理'}</span>
    </div>`).join('');
  const quotaRows = s.sourceQuota.map((q) => {
    const pct = Math.round(q.used / q.quota * 100);
    return `
    <div class="qrow">
      <span class="q-ic">${q.icon}</span>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px"><b>${q.channel}</b><span class="chip">命中 ${q.hit} 人</span></div>
        <div class="qbar"><i style="width:${pct}%" class="${pct >= 80 ? 'hot' : ''}"></i></div>
        <div style="color:var(--text-faint);font-size:11.5px;margin-top:3px">${q.note}</div>
      </div>
      <div class="quota"><b>${q.used}</b><small>/${q.quota}</small><em>${pct}%</em></div>
    </div>`;
  }).join('');
  const guardChips = s.guards.map((g) => `<span class="chip ${g.on ? '' : 'off'}">${g.label} ${g.val}</span>`).join('');

  $('#view-schedule').innerHTML = `
    <div class="card">
      <div class="card-hd"><h2>BOSS 账号体检 · 一句话看是否可自动打招呼</h2><span class="hint">四项前置实时勾选 · 全部就绪方可自动触达</span>
        <span class="t-right"><button class="btn ghost sm" id="btnHealthRecheck" type="button">↻ 体检</button></span></div>
      <div class="card-bd"><div class="hchecks">${healthRows}</div>
        <p class="textfield" style="margin:12px 0 0;color:var(--muted);font-size:12px;line-height:1.7">
          <b style="color:var(--ink)">仅绑定 BOSS 账号不足以为自动打招呼</b> —— 需保持 BOSS 网页端登录<b>会话在线</b>，采集调度才会以该账号执行搜索与打招呼；且只对合规筛选通过的候选人发送，全程受风控护栏控制。</p></div>
    </div>
    <div class="split2">
      <div class="card">
        <div class="card-hd"><h2>寻访配额 · 两路</h2><span class="hint">推荐牛人 + 搜索 · 命中一致自动去重</span>
          <span class="t-right"><span class="badge b-info">今日寻访 21 / 35</span></span></div>
        <div class="card-bd">${quotaRows}</div>
      </div>
      <div class="card">
        <div class="card-hd"><h2>风控护栏明细</h2><span class="hint">超频/冷却/熔断 · 拦截留痕</span>
          <span class="t-right"><span class="badge b-gold">护栏启护</span></span></div>
        <div class="card-bd"><div class="guardwrap">${guardChips}</div>
          <p class="textfield" style="margin:14px 0 0;color:var(--faint);font-size:12px;line-height:1.7">任一护栏触顶即自动拦截并写审计，不轮换代理、不做 WebDriver 规避。</p></div>
      </div>
    </div>
    <div class="card">
      <div class="card-hd"><h2>采集调度任务</h2><span class="hint">定时批量 · 频率受控 · 熔断</span></div>
      <div class="card-bd">
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px">
          <div><label style="font-size:12px;color:var(--text-sub);font-weight:600">目标岗位</label><select id="schedJob">${jobs.map((j) => `<option value="${j.jobId}">${j.title} (${j.jobId})</option>`).join('')}</select></div>
          <div><label style="font-size:12px;color:var(--text-sub);font-weight:600">运行周期</label><select><option>工作日 09:00 / 14:00 / 17:00</option><option>每日 09:00</option><option>自定义 Cron</option></select></div>
          <div><label style="font-size:12px;color:var(--text-sub);font-weight:600">账号轮询</label><select><option>A1 主账号 · 4 账号轮询</option><option>A1 单账号</option></select></div>
          <div><label style="font-size:12px;color:var(--text-sub);font-weight:600">随机间隔</label><select><option>3 – 8 秒</option><option>5 – 12 秒</option><option>10 – 20 秒</option></select></div>
        </div>
      </div>
      <div class="card-bd" style="border-top:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
          <button class="btn sm" id="btnRunJob" type="button">▸ 立即运行</button>
          <span class="hint" style="color:var(--text-sub);font-size:12px">每次运行均写入审计留痕</span>
        </div>
        <div class="log" id="logBox">
<span class="t">[09:00:01]</span> 调度触发 <span class="dim">job=frontend_01 round=#128</span>
<span class="t">[09:00:02]</span> 检索「前端工程师」→命中 245 人 <span class="dim">(间隔等待 5.2s)</span>
<span class="t">[09:04:11]</span> 索取 46 份简历 <span class="ok">✓ 42 成功 · 3 重试 · 1 失败隔离</span>
<span class="t">[09:08:34]</span> 解析入库 42 份 <span class="ok">✓ 字段准确率 94%</span>
<span class="t">[09:12:40]</span> JD 匹配打分 <span class="ok">✓ 平均 71 分</span>
<span class="warn">⚠ 账号 B2 触发冷却 → 已自动切换 A1</span>
        </div>
      </div>
    </div>`;
  $('#btnRunJob').addEventListener('click', async () => {
    const jobId = $('#schedJob').value;
    const log = $('#logBox'); log.innerHTML += '\n<span class="dim">▷ 运行中 job=' + jobId + ' …</span>'; log.scrollTop = log.scrollHeight;
    const r = await api.runCollect(jobId);
    r.lines.forEach((l) => { log.innerHTML += '\n' + l; log.scrollTop = log.scrollHeight; });
    toast('采集任务运行完成');
  });
  $('#btnHealthRecheck').addEventListener('click', async () => { await api.fetchScheduleHealth(); toast('体检完成 · 四前置就绪 3 / 4 · 护栏余量待处理'); });
}

/* ================================================================
   VIEW 4 · 候选人库
   ================================================================ */
async function loadCandidates() {
  const host = $('#view-candidates');
  host.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div class="seg" id="statusSeg">
          <button data-st="all" class="active">全部</button><button data-st="matched">已匹配</button>
          <button data-st="pending">待核对</button><button data-st="parsed">已入库</button><button data-st="failed">失败</button>
        </div>
        <div class="seg" id="touchSeg">
          <button data-tc="all" class="active">所有触达</button><button data-tc="pending">待跟</button>
          <button data-tc="engaging">跟进中</button><button data-tc="replied">已回复</button><button data-tc="sleeping">沉睡</button>
        </div>
        <div class="search" style="margin-left:auto">
          <svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input id="candSearch" placeholder="搜索姓名 / 技能 / 岗位…" />
        </div>
        <button class="btn ghost sm" id="btnExport" type="button">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12M7 8l5 5 5-5M4 21h16"/></svg>导出 CSV</button>
      </div>
      <div class="card-bd flat">
        <div class="table-wrap"><table><thead><tr><th style="width:24px"><input type="checkbox"></th><th>候选人</th><th>核心技能</th><th>期望薪资</th><th>触达状态</th><th>轮次</th><th>话术版本</th><th>已读</th><th>解析状态</th><th>匹配分</th></tr></thead>
        <tbody id="candTable"><tr><td colspan="10">${skeleton(6)}</td></tr></tbody></table></div>
        <div class="pager"><span id="candCount">—</span><span style="margin-left:auto" id="candPager"></span></div>
      </div>
    </div>`;
  $('#statusSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $('#statusSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    state.candidates.status = b.dataset.st; state.candidates.page = 1; renderCandTable();
  });
  $('#touchSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $('#touchSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    state.candidates.tch = b.dataset.tc; state.candidates.page = 1; renderCandTable();
  });
  $('#candSearch').addEventListener('input', (e) => { state.candidates.q = e.target.value.trim(); state.candidates.page = 1; renderCandTable(); });
  $('#btnExport').addEventListener('click', async () => { const r = await api.exportCandidates(); toast(r.note); });
  await renderCandTable();
}

async function renderCandTable() {
  const { status, tch, q, page, pageSize } = state.candidates;
  const tbody = $('#candTable');
  tbody.innerHTML = '<tr><td colspan="10">' + skeleton(6) + '</td></tr>';
  const { list, total } = await api.fetchCandidates({ status, tch, q, page, pageSize });
  const count = $('#candCount');
  count.textContent = total ? `共 ${total} 条记录 · 脱敏展示` : '0 条记录';
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="10" class="empty">无匹配候选人</td></tr>'; $('#candPager').innerHTML = ''; return; }
  tbody.innerHTML = list.map(candRow).join('');
  const pages = Math.max(1, Math.ceil(total / pageSize));
  $('#candPager').innerHTML = `
    <button class="btn ghost sm" ${page <= 1 ? 'disabled' : ''} data-pg="${page - 1}">‹ 上一页</button>
    <span style="margin:0 8px;color:var(--text-sub)">${page} / ${pages}</span>
    <button class="btn ghost sm" ${page >= pages ? 'disabled' : ''} data-pg="${page + 1}">下一页 ›</button>`;
  $('#candPager').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => { state.candidates.page = Number(b.dataset.pg); renderCandTable(); }));
  bindTableClicks('#candTable');
}

function candRow(c) {
  const t = tmeta(c);
  return `<tr data-cid="${c.id}">
    <td><input type="checkbox" onclick="event.stopPropagation()"></td>
    <td><span class="cell-name">${c.name}<small>${c.id} · ${c.source} · ${c.workYears}年</small></span></td>
    <td>${skills(c.skills)}</td>
    <td>${c.salary}</td>
    <td>${tbadge(t.st)}</td>
    <td>${t.round > 0 ? `<span class="round">R${t.round}</span>` : '<span class="dim">—</span>'}</td>
    <td>${t.ver === '—' ? '<span class="dim">—</span>' : `<span class="tag">${t.ver}</span>`}</td>
    <td>${t.round > 0 ? (t.read ? '<span class="rd rd-read">已读</span>' : '<span class="rd rd-unread">未读</span>') : '<span class="dim">—</span>'}</td>
    <td>${badge(c)}</td>
    <td>${score(c)}</td>
  </tr>`;
}
function dashRow(c) {
  return `<tr data-cid="${c.id}">
    <td><span class="cell-name">${c.name}<small>${c.id} · ${c.source}</small></span></td>
    <td>${c.workYears} 年</td>
    <td>${skills(c.skills)}</td>
    <td>${badge(c)}</td>
    <td>${score(c)}</td>
  </tr>`;
}
function bindTableClicks(sel) {
  $(sel).querySelectorAll('tr[data-cid]').forEach((tr) =>
    tr.addEventListener('click', () => {
      document.querySelectorAll(sel + ' tr').forEach((t) => t.classList.remove('sel'));
      tr.classList.add('sel');
      openDrawer(tr.dataset.cid);
    }));
}

/* ---------- 抽屉：候选人详情 ---------- */
function openDrawer(cid) {
  const c = DB.candidates.find((x) => x.id === cid);
  const mt = DB.matches[cid]; const r = DB.resumes[cid];
  selCand = c;
  $('#dAva').textContent = c.name[0];
  $('#dName').textContent = c.name;
  $('#dMeta').textContent = `${c.id} · ${c.source} · ${c.workYears}年经验 · 期望 ${c.salary}`;
  $('#drawerBd').innerHTML = `
    <div class="dsec"><div class="dt">JD 匹配</div>
      <div style="display:flex;align-items:center;gap:14px;background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:13px">
        <div class="scorebar" style="flex:none;width:56px;height:10px"><i style="height:100%;width:${mt?.score || 0}%;background:${mt && mt.score >= 70 ? 'var(--ok)' : 'var(--warn)'}"></i></div>
        <div><b style="font-size:18px;color:${mt && mt.score >= 70 ? 'var(--ok)' : 'var(--warn)'}">${mt?.score ?? '—'}</b><span style="color:var(--text-sub);font-size:12px"> · ${scoreLabel(mt?.score)}</span></div>
        <div style="margin-left:auto;color:var(--text-sub);font-size:12px">${mt?.evidence ?? '暂无匹配依据'}</div>
      </div></div>
    <div class="dsec"><div class="dt">基本信息</div>
      <div class="kv">
        <div><div class="k">学历</div><div class="v">${r?.school ?? '—'} · ${r?.degree ?? ''}</div></div>
        <div><div class="k">解析置信度</div><div class="v">${r ? (r.confidence * 100).toFixed(0) + '%' : '—'}</div></div>
        <div><div class="k">电话</div><div class="v">${r?.phone ?? '—'}<span class="tag">脱敏</span></div></div>
        <div><div class="k">邮箱</div><div class="v">${r?.email ?? '—'}<span class="tag">脱敏</span></div></div>
      </div></div>
    <div class="dsec"><div class="dt">工作经历</div>
      ${r ? `<div class="pl"><li><span class="dur">${r.tenure}</span><div class="co">${r.company} · ${r.role}</div><div class="ro">与 JD 核心技能高度相关，可优先沟通。</div></li></div>` : '<p style="color:var(--text-faint);font-size:12.5px">暂无结构化经历</p>'}
    </div>
    <div class="dsec"><div class="dt">技能标签</div>${skills(c.skills)}</div>
    <div class="dsec"><div class="dt">触达进度</div>
      <div class="tpsum">
        ${tbadge((tmeta(c)).st)}
        <span>已触达 <b>${tmeta(c).round}</b> 轮</span>
        <span class="dot5 ${tmeta(c).read ? 'on' : ''}">${tmeta(c).round > 0 ? (tmeta(c).read ? '最近已读' : '最近未读') : '尚未触达'}</span>
        <button class="btn sm" id="dTouch" type="button" style="margin-left:auto">＋ 发送触达</button>
      </div></div>
    <div class="dsec"><div class="dt">触达时间线 · 沟通记录</div>
      <div class="tl" id="touchLine">${skeleton(3).replace(/row/g, 'tl-sk')}</div></div>
    <div class="dsec"><div class="dt">来源与风险</div><p style="color:var(--text-sub);font-size:12.5px;line-height:1.7;margin:0">来源：BOSS 自有账号 A1 · 简历原始文件已加密存储 · 解析置信度 ${r ? (r.confidence * 100).toFixed(0) + '%' : '—'}。</p></div>`;
  loadTouchLine(c.id);
  $('#dTouch')?.addEventListener('click', (e) => { e.stopPropagation(); api.fetchTouchTimeline(c.id).then(() => toast(`已向 ${c.name} 发起新一轮触达`)); });
  $('#drawer').classList.add('open'); $('#scrim').classList.add('open');
}
async function loadTouchLine(cid) {
  const box = $('#touchLine'); if (!box) return;
  const { timeline } = await api.fetchTouchTimeline(cid);
  box.innerHTML = timeline.map((ev) => `
    <div class="tli ${ev.dir === 'in' ? 'in' : 'out'}">
      <div class="tl-dot"></div>
      <div class="tl-card">
        <div class="tl-head"><b>${ev.ch}</b>
          <span class="tl-meta">${ev.dir === 'in' ? '收到' : '已发出'} · ${ev.ts}${ev.ver !== '—' ? ` · ${ev.ver}` : ''}${typeof ev.read === 'boolean' ? (ev.read ? ' · 已读' : ' · 未读') : ''}</span></div>
        <p>${ev.body}</p>
      </div>
    </div>`).join('');
}
function scoreLabel(s) { if (s == null) return '未评分'; return s >= 70 ? '高匹配' : s >= 50 ? '中匹配' : '低匹配'; }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#scrim').classList.remove('open'); }

/* ================================================================
   VIEW 5 · 审计留痕
   ================================================================ */
async function loadAudit() {
  const host = $('#view-audit');
  host.innerHTML = `<div class="card">
    <div class="card-hd"><h2>操作审计留痕</h2><span class="hint">采集 / 访问 / 导出 · 不可篡改</span>
      <div class="t-right"><select id="auditType"><option value="all">全部类型</option><option value="collect">采集</option><option value="access">访问</option><option value="export">导出</option></select></div></div>
    <div class="audit" id="auditList"></div></div>`;
  await renderAudit('all');
  $('#auditType').addEventListener('change', (e) => renderAudit(e.target.value));
}
async function renderAudit(type) {
  const { items } = await api.fetchAudit();
  const list = type === 'all' ? items : items.filter((a) => a.type === type);
  const IC = { collect: '⚙', access: '▣', export: '↓' };
  $('#auditList').innerHTML = list.length ? list.map((a) => `
    <div class="item"><div class="ic">${IC[a.type] || '·'}</div>
      <div class="act">${a.action}<small>${a.target}</small></div>
      <div class="who">${a.actor}</div><div class="ts">${a.ts}</div></div>`).join('') : '<div class="empty">该类型暂无记录</div>';
}

/* ================================================================
   VIEW 6 · 准入与护栏
   ================================================================ */
async function loadSettings() {
  const host = $('#view-settings');
  host.innerHTML = `
    <div class="card">
      <div class="card-hd"><h2>账号接入与权限</h2><span class="hint">最小权限 · 越权/导出需审批</span></div>
      <div class="card-bd">
        ${DB.accounts.map((a) => `
          <div class="srow">
            <b>${a.name}</b><span class="note">${a.note || (a.used + '/' + a.limit + '')}</span>
            <span class="t-right"><span class="badge ${a.status === 'active' ? 'b-ok' : 'b-warn'}">${a.status === 'active' ? '已接入' : '冷却中'}</span>
            <span class="mono" style="color:var(--text-sub);font-size:12px">${a.used} / ${a.limit}</span></span>
          </div>`).join('')}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:6px">
          <div><label style="font-size:12px;color:var(--text-sub);font-weight:600">敏感字段解密权限</label><p style="margin:6px 0 0;color:var(--text-sub);font-size:12.5px;line-height:1.7">仅授权 HR 登录后可查看，默认掩码，单次解密留痕。</p></div>
          <div><label style="font-size:12px;color:var(--text-sub);font-weight:600">数据留存策略</label><p style="margin:6px 0 0;color:var(--text-sub);font-size:12.5px;line-height:1.7">原始简历保留 90 天，逾期自动脱敏归档，删除留审计。</p></div>
        </div>
      </div>
      <div class="card-bd" style="border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px">
        <button class="btn ghost" id="btnReset" type="button">重置护栏</button>
        <button class="btn" id="btnSave" type="button">保存设置</button>
      </div>
    </div>`;
  $('#btnSave').addEventListener('click', async () => { await api.saveSettings(); toast('护栏配置已保存'); });
  $('#btnReset').addEventListener('click', () => toast('护栏已重置为系统默认'));
}

/* ================================================================
   VIEW 5 · 触达沟通（对齐实际系统 engage 工作台）
   ================================================================ */
async function loadEngage() {
  const host = $('#view-engage');
  host.innerHTML = '<div class="card"><div class="card-bd">' + skeleton(4).replace(/ /g, ' ') + '</div></div>';
  const eng = await api.fetchEngage();
  const m = await api.fetchTouchMetrics();

  /* 话术库：分级话术 */
  const tiers = eng.msgTiers.map((t) => `
    <div class="tier">
      <div class="tier-bar"></div>
      <div style="flex:1;min-width:0">
        <div class="tt">${t.label}<span class="tag">${t.ver}</span></div>
        <p class="txt">${t.text}</p>
        <div style="color:var(--text-faint);font-size:11.5px;margin-top:6px">${t.desc}</div>
      </div>
      <div class="tier-used">已用 <b>${t.used}</b> 次</div>
    </div>`).join('');

  /* 自动打招呼：本轮匹配达标 */
  const egRows = eng.egAuto.map((c) => `
    <div class="egrow">
      <span class="sc">${c.score}</span>
      <div style="flex:1;min-width:0"><b style="font-size:13px">${c.name}</b><span style="color:var(--text-sub);font-size:12px;margin-left:8px">${c.job}</span></div>
      <span class="badge ${c.st === 'done' ? 'b-ok' : 'b-warn'}">${c.st === 'done' ? '已打招呼' : '待打招呼'}</span>
    </div>`).join('');

  /* 智能跟进引擎（未读 / 已读双轨） */
  const fupRows = eng.followups.map((f) => `
    <tr><td><b>${f.name}</b><span class="dim" style="margin-left:6px">${f.track}</span></td>
      <td>${f.round > 0 ? `<span class="round">R${f.round}</span>` : '<span class="dim">—</span>'}</td>
      <td><span class="tag">${f.mode}</span></td>
      <td>${f.next}</td><td>${tbadge(f.st)}</td></tr>`).join('');

  /* 自动同意收取简历（M2）+ 人工待处理清单（重试） */
  const aa = eng.autoAccept;
  const pendRows = eng.pendingRes.length ? eng.pendingRes.map((p) => `
    <div class="egrow"><div style="flex:1;min-width:0">
        <b style="font-size:13px">${p.name}</b><span style="color:var(--text-sub);font-size:12px;margin-left:8px">${p.job}</span>
        <div style="color:var(--warn);font-size:12px;margin-top:3px">⚠ ${p.reason}</div></div>
      <span class="badge b-warn">${p.action}</span>
      <button class="btn ghost sm" data-retry="${p.id}" type="button">${p.action.includes('重试') ? '重试解析' : '核对确认'}</button></div>`).join('')
    : '<div class="empty">暂无待处理简历</div>';

  /* 打招呼批次（F-3 · 模式 / 额度 / 运行控制） */
  const campRows = eng.campaigns.map((cg) => `
    <div class="egrow" style="flex-direction:column;align-items:stretch;gap:8px">
      <div style="display:flex;align-items:center;gap:8px">
        <b class="mono" style="font-size:13px">${cg.id}</b><span class="tag">${cg.modeFull || cg.mode}</span>
        <span class="badge ${cg.status === 'run' ? 'b-ok' : 'b-gray'}">${cg.status === 'run' ? '运行中' : '已完成'}</span>
        <span style="margin-left:auto">
          <button class="btn ghost sm" data-ctl="${cg.id}" data-act="${cg.control}" type="button">${cg.control === 'stop' ? '暂停' : '恢复'}</button>
        </span>
      </div>
      <div style="color:var(--text-sub);font-size:12px">${cg.jobs} · 额度 ${cg.quota} · 开始 ${cg.at}</div>
      <div class="bprog"><i style="width:${cg.progress}%"></i></div>
    </div>`).join('');

  /* 批次结束提醒（F-4 前置） */
  const nList = eng.notify.length ? eng.notify.map((n) =>
      `<li><span class="ts">${n.ts}</span><span style="flex:1">${n.text}</span></li>`).join('')
    : '<li><span class="dim">暂无未读提醒</span></li>';

  /* 数据复盘（D-2 · 指标并入） */
  const tk = m.kpis;
  const tiles = [
    ['触达响应率', tk.responseRate.v, tk.responseRate.tip, 'b-brand'],
    ['简历索要成功率', tk.resumeAskRate.v, tk.resumeAskRate.tip, 'b-ok'],
    ['电话索要成功率', tk.phoneAskRate.v, tk.phoneAskRate.tip, 'b-info'],
    ['沉睡率', tk.sleepRate.v, tk.sleepRate.tip, 'b-warn'],
    ['转化率(邀约/应聘)', tk.conversion.v, tk.conversion.tip, 'b-brand'],
  ].map((x) => mkTile(x)).join('');
  const mRowHtml = eng.metrics.rows.map((r) => `
    <tr><td><b>${r.job}</b></td><td>${r.greet}</td><td>${r.read}</td>
      <td><span class="rt"><span class="rtb"><i style="width:${r.respRate}%"></i></span>${r.respRate}%</span></td>
      <td><span class="rt"><span class="rtb"><i style="width:${r.convRate}%"></i></span>${r.convRate}%</span></td>
      <td>${r.sleep}</td></tr>`).join('');
  const mt = eng.metrics.totals;

  host.innerHTML = `
    <div class="split2">
      <div class="card"><div class="card-hd"><h2>打招呼话术库</h2><span class="hint">分级话术 · 匹配达标自动触发</span>
        <span class="t-right"><span class="chip">阈值 ≥ ${eng.threshold} 分</span></span></div>
        <div class="card-bd">${tiers}</div></div>
      <div class="card"><div class="card-hd"><h2>自动打招呼</h2><span class="hint">匹配达标即发 · 走风控护栏</span>
        <span class="t-right"><span class="badge b-info">${eng.egAuto.filter((x) => x.st === 'todo').length} 人待打招呼</span></span></div>
        <div class="card-bd">${egRows}
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="btn sm" id="egGreet" type="button">发送打招呼</button>
            <button class="btn ghost sm" id="egSweep" type="button">扫描跟进引擎</button>
          </div></div></div>
    </div>
    <div class="card"><div class="card-hd"><h2>智能跟进引擎</h2><span class="hint">未读隔 1 天二次激活 · 已读降频保活 · 满 1 月沉睡</span></div>
      <div class="card-bd flat"><div class="table-wrap"><table><thead><tr><th>候选人</th><th>轮次</th><th>当前模式</th><th>下次计划</th><th>状态</th></tr></thead>
        <tbody>${fupRows || '<tr><td colspan="5" class="empty">暂无跟进任务</td></tr>'}</tbody></table></div></div></div>
    <div class="split2">
      <div class="card"><div class="card-hd"><h2>自动同意收取简历</h2><span class="hint">收到发简历事件自动同意 · 解析入库</span>
          <span class="t-right"><span class="badge ${aa.on ? 'b-ok' : 'b-gray'}">${aa.on ? aa.mode : '已停用'}</span></span></div>
        <div class="card-bd">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
            <span class="chip">已收 ${aa.count} 份</span><span class="chip">需重试 ${(aa.err || 0) + (aa.fail || 0)}</span>
            <span class="chip" style="margin-left:auto">原始文件不落盘 · 登记跟踪</span>
          </div>
          <p class="textfield" style="margin:0 0 10px;color:var(--muted);font-size:12px;line-height:1.7">${aa.note}</p>
          <h3 class="wb-sub">人工待处理清单</h3>
          ${pendRows}</div></div>
      <div class="card"><div class="card-hd"><h2>交换联系方式</h2><span class="hint">我方联系方式 · 统一回填话术</span></div>
        <div class="card-bd"><div class="contactbox">
            <div style="font-size:12px;color:var(--text-sub)">候选人同意后回发的交换话术中携带</div>
            <b style="font-size:14px;margin:8px 0;display:block">${eng.hrContact}</b>
            <button class="btn ghost sm" id="egContact" type="button">编辑联系方式</button></div></div></div>
    </div>
    <div class="split2">
      <div class="card"><div class="card-hd"><h2>打招呼批次</h2><span class="hint">职位顺序 · 额度管控 · 风控护栏</span>
          <span class="t-right">
            <select id="egCampMode" style="margin-right:6px">${eng.campaignModes.map((m) => `<option>${m.label}</option>`).join('')}</select>
            <button class="btn ghost sm" id="egCampaign" type="button">＋ 新建批次</button></span></div>
        <div class="card-bd">${campRows}</div></div>
      <div class="card"><div class="card-hd"><h2>批次结束提醒</h2><span class="hint">已到额 / 遍历完成通知</span>
          <span class="t-right"><button class="btn ghost sm" id="egNotifyRead" type="button">全部已读</button></span></div>
        <div class="card-bd"><ul class="nlist">${nList}</ul></div></div>
    </div>
    <div class="card"><div class="card-hd"><h2>数据复盘</h2><span class="hint">口径对齐 PRD 3.2 · 指标来自触达领域库</span>
          <span class="t-right"><button class="btn ghost sm" id="egExport" type="button">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12M7 8l5 5 5-5M4 21h16"/></svg>导出复盘</button></span></div>
      <div class="card-bd">
        <div class="mkpis">${tiles}</div>
        <h3 class="wb-sub">按岗位</h3>
        <div class="table-wrap"><table class="mtbl"><thead><tr><th>岗位</th><th>打招呼</th><th>已读</th><th>响应率</th><th>转化率</th><th>沉睡</th></tr></thead>
          <tbody>${mRowHtml}
            <tr class="sumrow"><td><b>合计</b></td><td>${mt.greet}</td><td>${mt.read}</td><td><b>${mt.resp}</b></td><td><b>${mt.conv}</b></td><td>${mt.sleep}</td></tr>
          </tbody></table></div>
      </div>
      <div class="card-bd" style="border-top:1px solid var(--border);display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div><h3 class="wb-sub">拨打漏斗</h3><div class="funnel">${funnelHtml(m)}</div></div>
        <div><h3 class="wb-sub">话术版本效果</h3><div class="table-wrap"><table class="mtbl"><thead><tr><th>话术</th><th>发出</th><th>已读</th><th>回复</th><th>回复率</th></tr></thead>
          <tbody>${scriptRows(m)}</tbody></table></div></div>
      </div>
      <div class="card-bd" style="border-top:1px solid var(--border);display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div><h3 class="wb-sub">触达状态分布</h3><div class="dist">${distHtml(m.distribution)}</div></div>
        <div style="position:relative"><h3 class="wb-sub">近7天 · 响应 vs 沉睡</h3><div class="twchart">${trendHtml(m.distribution)}
          <div class="tw-legend"><span><i class="resp"></i>响应率</span><span><i class="sleep"></i>沉睡率</span></div></div></div>
      </div>
    </div>
    <div class="card"><div class="card-hd"><h2>触达审计留痕</h2><span class="hint">打招呼 / 收取 / 交换 · 不可篡改</span></div>
      <div class="audit">${eng.engageAudit.map((a) => `
        <div class="item"><div class="ic">✉</div>
          <div class="act">${a.act}<small>${a.target}</small></div>
          <div class="who">${a.who}${a.ver !== '—' ? ` · ${a.ver}` : ''}</div>
          <div class="ts">${a.ts} · ${a.res}</div></div>`).join('')}</div></div>`;

  $('#egGreet').addEventListener('click', async () => { const r = await api.runAutoGreet(); toast(`${r.note}（共 ${r.n} 人）`); loadEngage(); });
  $('#egSweep').addEventListener('click', async () => { const r = await api.sweepFollowup(); toast(r.note); });
  $('#egContact').addEventListener('click', async () => { const r = await api.saveContact(); toast('联系方式已保存并回写交换话术'); });
  $('#egCampaign').addEventListener('click', async () => { const mode = $('#egCampMode').value; const r = await api.createCampaign(mode); toast(`${r.note}（${r.id}）`); });
  $('#egNotifyRead').addEventListener('click', async () => { const r = await api.markNotifyRead(); toast(r.note); });
  $('#egExport').addEventListener('click', async () => { const r = await api.exportEngageMetrics(); toast(r.note); });
  host.querySelectorAll('[data-retry]').forEach((b) =>
    b.addEventListener('click', async () => { const r = await api.retryResume(b.dataset.retry); toast(r.note); loadEngage(); }));
  host.querySelectorAll('[data-ctl]').forEach((b) =>
    b.addEventListener('click', async () => { const r = await api.controlCampaign(b.dataset.ctl, b.dataset.act); toast(r.note); }));
}

/* 数据复盘 · D-2 指标组件（复用） */
function mkTile([lab, v, tip, cls]) {
  return `<div class="mk ${cls}"><div class="mk-lab">${lab}</div><div class="mk-val">${v}<small>%</small></div>
      <div class="mk-bar"><i style="width:${Math.min(100, v)}%"></i></div><div class="mk-tip">${tip}</div></div>`;
}
function funnelHtml(m) {
  const maxF = Math.max(...m.funnel.map((f) => f.v));
  return m.funnel.map((f) => `<div class="frow"><span class="fl">${f.k}</span>
      <div class="fb"><i style="width:${Math.round((f.v / maxF) * 100)}%"></i></div><b>${f.v}</b></div>`).join('');
}
function scriptRows(m) {
  return m.byScript.map((s) => `<tr><td><span class="tag">${s.ver}</span></td><td>${s.sent}</td><td>${s.read}</td>
      <td>${s.replied}</td><td><span class="rt"><span class="rtb"><i style="width:${s.rate}%"></i></span>${s.rate}%</span></td></tr>`).join('');
}
function distHtml(D) {
  const segTotal = D.pending + D.engaging + D.replied + D.sleeping || 1;
  return [['待跟', D.pending, 'seg-pending'], ['跟进中', D.engaging, 'seg-engaging'],
    ['已回复', D.replied, 'seg-replied'], ['沉睡', D.sleeping, 'seg-sleeping']]
    .map(([lab, v, cls]) => `<div class="stcol"><span class="stbar ${cls}" style="height:${Math.round(v / segTotal * 100)}%"></span><b>${v}</b><em>${lab}</em></div>`).join('');
}
function trendHtml(D) {
  return D.trend.map((d) => `<div class="tcol"><div class="tw"><i class="tw-resp" style="height:${d.resp}%"></i><i class="tw-sleep" style="height:${d.sleep}%"></i></div>
      <em>${d.d}</em><div class="tl-vals"><span>${d.resp}%</span><span>${d.sleep}%</span></div></div>`).join('');
}

/* ================================================================
   VIEW 7 · 人才库（共享 · 账号无关 · 伯乐指数）
   ================================================================ */
async function loadTalent() {
  const host = $('#view-talent');
  host.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <span class="chip">共享人才池 · 账号无关</span><span class="chip">无岗位维度</span>
        <div class="search" style="margin-left:auto">
          <svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input id="tlSearch" placeholder="搜索姓名 / 技能…" />
        </div>
        <button class="btn ghost sm" id="btnTlExport" type="button">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12M7 8l5 5 5-5M4 21h16"/></svg>导出 CSV</button>
      </div>
      <div class="card-bd flat">
        <div class="table-wrap"><table><thead><tr><th>人才</th><th>核心技能</th><th>期望薪资</th><th>来源</th><th>是否已触达</th><th>伯乐指数</th></tr></thead>
        <tbody id="tlTable"></tbody></table></div>
        <div class="pager"><span id="tlCount">—</span><span style="margin-left:auto" id="tlPager"></span></div>
      </div>
    </div>`;
  $('#tlSearch').addEventListener('input', (e) => { state.talent.q = e.target.value.trim(); state.talent.page = 1; renderTalent(); });
  $('#btnTlExport').addEventListener('click', async () => { const r = await api.exportCandidates(); toast(r.note); });
  await renderTalent();
}
async function renderTalent() {
  const { q, page, pageSize } = state.talent;
  const tbody = $('#tlTable');
  const { list, total } = await api.fetchTalent({ q, page, pageSize });
  $('#tlCount').textContent = total ? `共 ${total} 位人才 · 共享池` : '0 位人才';
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">无匹配人才</td></tr>'; $('#tlPager').innerHTML = ''; return; }
  tbody.innerHTML = list.map((t) => `<tr data-tid="${t.id}">
    <td><span class="cell-name">${t.name}<small>${t.id} · ${t.workYears}年</small></span></td>
    <td>${skills(t.skills)}</td>
    <td>${t.salary}</td>
    <td><span class="tag gold">${t.source}</span></td>
    <td>${t.touched ? '<span class="rd rd-read">已触达</span>' : '<span class="rd rd-unread">未触达</span>'}</td>
    <td>${bluescore(t.bluescale)}</td>
  </tr>`).join('');
  const pages = Math.max(1, Math.ceil(total / pageSize));
  $('#tlPager').innerHTML = `
    <button class="btn ghost sm" ${page <= 1 ? 'disabled' : ''} data-pg="${page - 1}">‹ 上一页</button>
    <span style="margin:0 8px;color:var(--muted)">${page} / ${pages}</span>
    <button class="btn ghost sm" ${page >= pages ? 'disabled' : ''} data-pg="${page + 1}">下一页 ›</button>`;
  $('#tlPager').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { state.talent.page = Number(b.dataset.pg); renderTalent(); }));
  $('#tlTable').querySelectorAll('tr[data-tid]').forEach((tr) =>
    tr.addEventListener('click', () => toast(`已选中 ${tr.querySelector('.cell-name').childNodes[0].textContent}`)));
}
/* 伯乐指数（共享池）信号条 */
function bluescore(v) {
  const g = v >= 85 ? 'high' : v >= 75 ? 'mid' : 'low';
  return `<span class="scorewrap s-${g}"><span class="scorebar"><i style="width:${v}%"></i></span><span class="scorenum">${v}</span></span>`;
}

/* ================================================================
   VIEW 8 · 触达审计（打招呼 / 收取 / 交换 · 独立审计）
   ================================================================ */
async function loadEngageAudit() {
  const host = $('#view-engageaudit');
  host.innerHTML = '<div class="card"><div class="card-bd">' + skeleton(3).replace(/ /g, ' ') + '</div></div>';
  const eng = await api.fetchEngage();
  const a = eng.engageAudit;
  const types = { greet: a.filter((x) => x.ver && x.ver !== '—').length, collect: a.filter((x) => x.act.includes('收取')).length, swap: a.filter((x) => x.act.includes('交换')).length, manual: a.filter((x) => x.who !== '系统').length };
  host.innerHTML = `
    <div class="card">
      <div class="card-hd"><h2>触达审计留痕</h2><span class="hint">打招呼 / 收取 / 交换 · 不可篡改 · 话术版本可追溯</span>
        <span class="t-right"><button class="btn ghost sm" id="eAuditExport" type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12M7 8l5 5 5-5M4 21h16"/></svg>导出留痕</button></span></div>
      <div class="card-bd">
        <div class="statsum">
          <div class="stc" style="border-left-color:var(--brand)"><div class="sl">打招呼（系统+人工）</div><div class="sv">${types.greet}</div></div>
          <div class="stc" style="border-left-color:var(--ok)"><div class="sl">收取简历</div><div class="sv">${types.collect}</div></div>
          <div class="stc" style="border-left-color:var(--info)"><div class="sl">交换联系方式</div><div class="sv">${types.swap}</div></div>
          <div class="stc" style="border-left-color:var(--gold)"><div class="sl">人工介入</div><div class="sv">${types.manual}</div></div>
        </div>
        <div class="card-bd flat" style="padding:12px 0 0">
          <div class="audit">${a.map((x) => `<div class="item"><div class="ic">✉</div>
            <div class="act">${x.act}<small>${x.target}</small></div>
            <div class="who">${x.who}${x.ver !== '—' ? ` · ${x.ver}` : ''}</div>
            <div class="ts">${x.ts} · ${x.res}</div></div>`).join('')}</div>
        </div>
      </div>
    </div>`;
  $('#eAuditExport').addEventListener('click', async () => { const r = await api.exportEngageMetrics(); toast(r.note); });
}

/* ================================================================
   VIEW 9 · 运行日志（系统流水 · 分级筛选）
   ================================================================ */
async function loadLogs() {
  const host = $('#view-logs');
  host.innerHTML = `<div class="card">
    <div class="card-hd"><h2>系统运行日志</h2><span class="hint">采集 / 触达 / 风控 / 访问 · 只读</span>
      <span class="t-right"><span class="badge b-gold">伯乐时钟</span></span></div>
    <div class="logfilters">
      <span class="hint" style="color:var(--muted);font-size:12px;font-weight:600">级别</span>
      <div class="loglevels" id="lvSeg">
        <button data-lv="all" class="active">全部</button><button data-lv="info">信息</button>
        <button data-lv="ok">成功</button><button data-lv="warn">警告</button><button data-lv="err">错误</button><button data-lv="access">访问</button>
      </div>
      <span style="margin-left:auto;font-size:12px;color:var(--muted)" id="logCount">—</span>
      <button class="btn ghost sm" id="btnLogClear" type="button">清空</button>
      <button class="btn ghost sm" id="btnLogRefresh" type="button">刷新</button>
    </div>
    <div class="syslog" id="logList"></div></div>`;
  await renderLog('all');
  $('#lvSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $('#lvSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    renderLog(b.dataset.lv);
  });
  $('#btnLogRefresh').addEventListener('click', () => renderLog(currentLv));
  $('#btnLogClear').addEventListener('click', async () => { const r = await api.clearLogs(); toast(r.note); renderLog(currentLv); });
}
let currentLv = 'all';
async function renderLog(lv) {
  currentLv = lv; const host = $('#logList');
  const { items, total } = await api.fetchLogs(lv);
  $('#logCount').textContent = `共 ${total} 条`;
  const LV = { info: '信息', ok: '成功', warn: '警告', err: '错误', access: '访问' };
  host.innerHTML = items.length ? items.map((l) => `
    <div class="lg lv-${l.level}">
      <span class="ts">${l.ts}</span><span class="lvl">${LV[l.level] || l.level}</span>
      <span class="msg">[${l.tag}] ${l.msg}</span>
    </div>`).join('') : '<div class="empty">该级别暂无日志</div>';
}

/* ---------- Modal + Toast + 全局 ---------- */
function initModal() {
  $('#modalCancel')?.addEventListener('click', () => $('#jobModal').classList.remove('open'));
  $('#jobModal')?.querySelector('[data-close]')?.addEventListener('click', () => $('#jobModal').classList.remove('open'));
  $('#modalCreate')?.addEventListener('click', async () => {
    const body = { jobId: $('#mJobId').value.trim(), title: $('#mTitle').value.trim(), jdRaw: $('#mJd').value.trim() };
    if (!body.jobId) { toast('请填写岗位 ID'); return; }
    $('#modalCreate').disabled = true;
    const r = await api.createJob(body);
    $('#modalCreate').disabled = false;
    $('#jobModal').classList.remove('open');
    toast(`岗位 ${r.title} 已创建 · 关键词 ${r.keywords.length} 个`);
    show('jobs');
  });
}
function initGlobal() {
  $('#btnRefresh').addEventListener('click', () => load(state.page));
  $('#btnTopRun').addEventListener('click', async () => { const r = await api.runNow(); toast(r.note); });
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#dDecrypt').addEventListener('click', async () => { const r = await api.decryptField(); toast(r.phone); });
  $('#dMark').addEventListener('click', () => { toast(`已标记 ${selCand?.name || ''} 为已沟通`); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
}

/* 导航角标初始化 */
function initBadges() {
  const tc = touchCounts();
  const t = $('#navTalent'); if (t) t.textContent = DB.talent.length;
}

/* ---------- 路由与装载 ---------- */
async function load(page) {
  ({ dashboard: loadDashboard, jobs: loadJobs, schedule: loadSchedule, candidates: loadCandidates, talent: loadTalent, engage: loadEngage, engageaudit: loadEngageAudit, audit: loadAudit, settings: loadSettings, logs: loadLogs })[page]?.();
}
initNav(); initModal(); initGlobal(); initBadges(); load('dashboard');