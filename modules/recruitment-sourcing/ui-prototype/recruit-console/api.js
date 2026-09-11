/* api.js — API 桩：签名即未来真实接口；只返回 mock，不连真实后端 */
import { DB } from './mock.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* GET /api/overview → {kpis, pipeline, quality}
   TODO: replace with fetch('/api/overview') */
export async function fetchOverview() {
  await delay(220);
  return {
    kpis: { today: 46, successRate: 91, accuracy: 94, active: 230 },
    pipeline: [
      { name: "检索", pass: 245, state: "run" },
      { name: "筛选", pass: 168, state: "ok" },
      { name: "索取", pass: 46, state: "run" },
      { name: "解析入库", pass: 42, state: "ok" },
      { name: "JD 匹配", pass: 40, state: "warn" },
    ],
    quality: { ok: 73, review: 18, fail: 9 },
    top: DB.candidates.filter((c) => c.matchScore != null).slice(0, 6),
  };
}

/* GET /api/jobs → {jobs} */
export async function fetchJobs() {
  await delay(160);
  return { jobs: DB.jobs };
}

/* POST /api/jobs → 创建岗位并返回解析关键词
   TODO: replace with fetch('/api/jobs', {method:'POST', body}) */
export async function createJob(payload) {
  await delay(500);
  const kw = analyzeKeywords(payload.jdRaw);
  return { ok: true, jobId: payload.jobId, title: payload.title, keywords: kw };
}
// JD → 关键词解析（前端演示；真实实现接解析服务）
function analyzeKeywords(jdRaw) {
  const pool = ["Java", "Go", "Python", "Vue3", "TypeScript", "SQL", "MySQL", "Redis", "微服务", "分布式"];
  return pool.filter((k) => jdRaw.includes(k)).slice(0, 6).concat(["人工微调"]);
}

/* GET /api/candidates → {list,total}  query:{status?,tch?,q?,page,pageSize}
   tch 为触达状态筛选：all/pending/engaging/replied/sleeping（与解析 status 独立） */
export async function fetchCandidates({ status = "all", tch = "all", q = "", page = 1, pageSize = 8 } = {}) {
  await delay(300);
  let list = DB.candidates;
  if (status !== "all") list = list.filter((c) => c.status === status);
  if (tch !== "all") list = list.filter((c) => (DB.touchMeta[c.id] || { st: "pending" }).st === tch);
  if (q) { const s = q.toLowerCase(); list = list.filter((c) => c.name.toLowerCase().includes(s) || c.skills.some((k) => k.toLowerCase().includes(s))); }
  const total = list.length;
  const paged = list.slice((page - 1) * pageSize, page * pageSize);
  return { list: paged, total };
}

/* GET /api/touch/metrics → 触达指标统计（口径与 PRD 3.2 一致：响应率=回复/打招呼，沉睡率=沉睡/已触达）
   TODO: replace with fetch('/api/touch/metrics') */
export async function fetchTouchMetrics() {
  await delay(360);
  return {
    kpis: {
      responseRate: { v: 41, tip: "回复数 / 已打招呼 · 目标 ≥50%" },
      resumeAskRate: { v: 86, tip: "索要简历成功数 / 发出数 · 目标 ≥80%" },
      phoneAskRate: { v: 62, tip: "索要电话成功数 / 发出数" },
      sleepRate: { v: 18, tip: "沉睡数 / 已触达数 · 应逐步下降" },
      conversion: { v: 9, tip: "进入邀约或应聘 / 已回复 · 目标 ≥8%" },
    },
    funnel: [
      { k: "已打招呼", v: 212 }, { k: "已读", v: 141 }, { k: "已回复", v: 87 },
      { k: "索要简历成功", v: 74 }, { k: "电话沟通", v: 46 }, { k: "进入邀约 / 应聘", v: 20 },
    ],
    byScript: [
      { ver: "初筛 · v2", sent: 68, read: 52, replied: 31, rate: 46 },
      { ver: "岗位邀约 · v3", sent: 54, read: 47, replied: 29, rate: 54 },
      { ver: "深度跟进 · v4", sent: 38, read: 34, replied: 22, rate: 58 },
      { ver: "唤醒 · v5", sent: 26, read: 14, replied: 5, rate: 19 },
    ],
    distribution: {
      total: 212, pending: 32, engaging: 24, replied: 39, sleeping: 5,
      trend: [
        { d: "周一", resp: 35, sleep: 20 }, { d: "周二", resp: 40, sleep: 19 },
        { d: "周三", resp: 44, sleep: 18 }, { d: "周四", resp: 46, sleep: 19 },
        { d: "周五", resp: 45, sleep: 17 }, { d: "周六", resp: 39, sleep: 18 },
        { d: "周日", resp: 41, sleep: 18 },
      ],
    },
  };
}

/* GET /api/candidates/:id/touch → 触达时间线（含各轮次话术 / 已读 / 沟通记录）
   TODO: replace with fetch('/api/candidates/' + id + '/touch') */
export async function fetchTouchTimeline(id) {
  await delay(220);
  const events = DB.timelines[id];
  if (events) return { id, timeline: events };
  const t = DB.touchMeta[id] || { st: "pending", round: 0, ver: "—" };
  const gen = [];
  for (let i = t.round; i >= 1; i--) {
    gen.push({ ts: `${i} 天前`, ch: "打招呼", dir: "out", read: i === 1 ? t.read : true, ver: i > 2 ? "保活 · v6" : "初筛 · v2", body: `第 ${i} 轮自动打招呼：候选状态 ${TOUCH_LABEL[t.st]}。` });
  }
  if (!gen.length) gen.push({ ts: "未触达", ch: "—", dir: "out", read: false, ver: "—", body: "尚未发起过打招呼，候选处于待跟状态。" });
  return { id, timeline: gen.reverse() };
}
const TOUCH_LABEL = { pending: "待跟", engaging: "跟进中", replied: "已回复", sleeping: "沉睡" };

/* GET /api/engage → 触达沟通工作台聚合（话术库/自动打招呼/跟进引擎/F-1~F-4/审计）
   TODO: replace with fetch('/api/engage') */
export async function fetchEngage() {
  await delay(300);
  const e = DB.engage;
  return {
    threshold: e.threshold,
    msgTiers: e.msgTiers,
    egAuto: e.egAuto,
    followups: e.fups,
    pendingRes: e.pendingRes,
    hrContact: e.hrContact,
    campaigns: e.campaigns,
    notify: e.notify,
    metrics: e.metrics,
    engageAudit: e.engageAudit,
  };
}
/* POST /api/engage/greet → 对全部匹配达标候选人打招呼 */
export async function runAutoGreet() {
  await delay(700);
  return { ok: true, n: 2, note: "已对匹配达标且待招呼的候选人发送打招呼并写入审计" };
}
/* POST /api/engage/sweep → 扫描跟进引擎（未读/已读双轨推进） */
export async function sweepFollowup() {
  await delay(650);
  return { ok: true, note: "跟进引擎已扫描 · 未读隔 1 天激活 · ≥5 次降周频 · 满 1 月沉睡" };
}
/* POST /api/engage/contact → 保存我方联系方式（回写交换话术） */
export async function saveContact(v) {
  await delay(350);
  return { ok: true, contact: v || "HR 小王 139-0000-1111（BOSS 站内信）" };
}
/* POST /api/engage/campaign → 创建打招呼批次（职位顺序 + 额度管控） */
export async function createCampaign(mode) {
  await delay(600);
  return { ok: true, id: "CG-" + Math.floor(1000 + Math.random() * 9000), mode, note: "批次已创建 · 按职位顺序逐个发送 · 走风控护栏" };
}
/* POST /api/engage/notify/read → 批次结束提醒全部已读 */
export async function markNotifyRead() {
  await delay(250);
  return { ok: true, note: "批次结束提醒已全部标记已读" };
}
/* POST /api/engage/metrics/export → 导出打招呼数据复盘（走审批留痕） */
export async function exportEngageMetrics() {
  await delay(600);
  return { ok: true, note: "打招呼数据复盘已加入导出队列 · 获批后生成 CSV 并留痕" };
}

/* POST /api/touch/export → 导出触达指标（走审批留痕） */
export async function exportTouch() {
  await delay(600);
  return { ok: true, note: "触达指标已加入导出队列 · 获批后生成 CSV 并留痕" };
}

/* POST /api/schedule/run → 立即运行采集（模拟日志追加）
   TODO: replace with fetch('/api/schedule/run', {method:'POST', body}) */
export async function runCollect(jobId) {
  await delay(900);
  const lines = [
    `[${now()}] 调度触发 job=${jobId}`,
    `[${now()}] 检索命中 245 人 · 间隔等待 5.2s`,
    `[${now()}] 索取 46 份简历 · ✓ 42 成功 · 3 重试 · 1 失败隔离`,
    `[${now()}] JD 匹配打分 ✓ 平均 71 分`,
    `[${now()}] 运行完成 · 计数已写入审计`,
  ];
  return { ok: true, lines };
}

/* POST /api/export/candidates → 导出（走审批留痕）
   TODO: replace with fetch('/api/export/candidates', {method:'POST'}) */
export async function exportCandidates() {
  await delay(700);
  return { ok: true, note: "已进入审批队列 · 获批后生成 CSV 并留痕" };
}

/* GET /api/audit → {items} */
export async function fetchAudit() {
  await delay(180);
  return { items: DB.audit };
}

/* POST /api/settings → 保存护栏配置 */
export async function saveSettings() {
  await delay(500);
  return { ok: true };
}

/* POST /api/detail/decrypt → 脱敏字段解密（演示） */
export async function decryptField() {
  await delay(400);
  return { ok: true, phone: "138****7210 → 138-0107-7210" };
}

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}