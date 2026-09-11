// F组实测验证脚本：对运行中的服务(4700)验证 F-1/F-3/F-4/F-5（含前置数据构造）
const base = process.env.BASE_URL || 'http://127.0.0.1:4700';
const post = async (p, b) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
  return { status: r.status, body: await r.json() };
};
const put = async (p, b) => {
  const r = await fetch(base + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
  return { status: r.status, body: await r.json() };
};
const get = async (p) => (await fetch(base + p)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function inject(candidateId, jobId, name, rawText, skills = []) {
  const r = await post('/api/sourcing/candidates', {
    candidateId, source: 'boss', jobId, name, skills,
    resume: { rawText, format: 'text' },
    meta: { createdAt: new Date().toISOString(), masked: true },
  });
  await sleep(150);
  return r;
}

(async () => {
  // 前置：专用职位
  await post('/api/jobs', { jobId: 'job_f_live', jdRaw: '招聘 后端工程师：熟练 Python、Go。', jobTitle: '后端工程师(Live验证)' });

  // ===== F-5 推荐牛人寻访（直供列表 + 去重） =====
  const recList = [
    { name: 'Live推荐甲', years: 6, skills: ['Python', 'Go'], rawText: 'Live推荐甲 6年经验 擅长 Python、Go' },
    { name: 'Live推荐乙', years: 4, skills: ['Python'], rawText: 'Live推荐乙 4年经验 擅长 Python' },
  ];
  const rec1 = await post('/api/sourcing/recommend', { jobId: 'job_f_live', candidates: recList });
  console.log('F-5 first: ok=', rec1.body.ok, 'fetched=', rec1.body.fetched, 'injected=', rec1.body.injected?.length);
  await sleep(300);
  const rec2 = await post('/api/sourcing/recommend', { jobId: 'job_f_live', candidates: recList });
  console.log('F-5 dedup: deduped=', rec2.body.deduped, 'injected=', rec2.body.injected?.length);

  // ===== F-1 自动同意收取：失败转人工 → 重试成功 =====
  await inject('cand_f_live1', 'job_f_live', 'Live收取甲', '李四 2年经验 从事行政工作', []);
  const fail = await post('/api/engage/resume-inbound', { candidateId: 'cand_f_live1', fail: true });
  console.log('F-1 fail: ok=', fail.body.ok, 'manualPending=', fail.body.manualPending);
  const pending = await get('/api/engage/manual-pending');
  console.log('F-1 pending list has candidate:', (pending.candidates || []).some((c) => c.candidateId === 'cand_f_live1'));
  const retry = await post('/api/engage/manual-pending/cand_f_live1/retry', { rawText: '李四 2年经验 擅长 Python，电话 13900001111' });
  console.log('F-1 retry: ok=', retry.body.ok, 'resumeReceived=', retry.body.resumeReceived, 'parsed=', retry.body.parsed);

  // ===== F-3 批次（指定职位 + 额度） =====
  const created = await post('/api/engage/campaigns', { mode: 'selected_jobs', jobs: [{ jobId: 'job_f_live', quota: 1 }] });
  console.log('F-3 created:', created.body.campaignId, 'quota=', created.body.jobs?.[0]?.quota);
  const run = await post('/api/engage/campaigns/' + created.body.campaignId + '/control', { action: 'run' });
  console.log('F-3 run: finished=', run.body.finished, 'states=', JSON.stringify((run.body.campaign?.jobs || []).map((j) => [j.jobId, j.greeted + '/' + j.quota, j.state])));

  // ===== F-4 通知 + 复盘 + 导出 =====
  const nt = await get('/api/engage/notifications');
  const finNote = (nt.notifications || []).find((n) => n.type === 'campaign_finished' && n.data?.campaignId === created.body.campaignId);
  console.log('F-4 notify: found=', !!finNote, 'title=', finNote?.title ?? null);
  const m = await get('/api/engage/metrics?campaignId=' + created.body.campaignId);
  const j1 = (m.perJob || []).find((j) => j.jobId === 'job_f_live');
  console.log('F-4 metrics job_f_live:', j1 ? JSON.stringify({ greeted: j1.greeted, read: j1.read, replied: j1.replied, requested: j1.requested, sleeping: j1.sleeping, candidates: j1.candidates }) : null);
  const csv = await fetch(base + '/export/engage-metrics.csv?campaignId=' + created.body.campaignId).then((r) => r.text());
  console.log('F-4 csv export rows:', csv.split('\r\n').length - 1, 'head:', csv.split('\r\n')[0]?.slice(0, 60));

  // ===== F-2 交换联系方式（我方联系方式配置） =====
  const contact = await get('/api/engage/contact');
  console.log('F-2 hrContact configured:', !!contact.contact);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
