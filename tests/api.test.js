// API 集成层 —— 启动真实网关（隔离临时 store/files），跑一轮接口 + 导出 + 调度断言
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../framework/server.js';

let app, base, dir, jobId, port;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hr-test-api-'));
  app = await createApplication({ storeDir: dir, filesDir: dir, llm: {} });
  app.start(0);
  port = app.server.address().port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  app?.instance?.api?.schedule?.dispose();
  app?.instance?.api?.followup?.dispose();
  await new Promise((resolve) => app.server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const post = (path, body) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('API 集成：health 与模块发现', async () => {
  const h = await (await fetch(base + '/health')).json();
  assert.equal(h.ok, true);
  const mods = await (await fetch(base + '/modules')).json();
  assert.ok(mods.modules.some((m) => m.id === 'recruitment-sourcing'));
});

test('API 集成：创建岗位（JD 解析）并回读', async () => {
  const jd = '招聘 前端工程师：熟练 JavaScript、TypeScript、React、Node.js，负责核心业务前端开发。';
  const r = await post('/api/jobs', { jobId: 'job_it_01', jdRaw: jd, jobTitle: '前端工程师' });
  assert.equal(r.status, 201);
  const body = await r.json();
  jobId = body.jobId;
  assert.equal(body.jobId, 'job_it_01');
  assert.ok(Array.isArray(body.keywords) && body.keywords.includes('JavaScript'));
  const jobs = await (await fetch(base + '/jobs')).json();
  assert.ok(jobs.jobs.some((j) => j.jobId === 'job_it_01' && j.status === 'open'));
});

test('API 集成：缺 jobId/jdRaw 的建岗被 400', async () => {
  const r = await post('/api/jobs', { jobTitle: '只有标题' });
  assert.equal(r.status, 400);
});

test('API 集成：运行一轮采集链路（含契约入库）', async () => {
  const r = await post('/api/sourcing/run', { jobId, keyword: '前端工程师' });
  assert.equal(r.status, 200);
  // 候选、匹配、简历应已落库
  const cands = (await (await fetch(base + '/candidates')).json()).candidates;
  const matches = (await (await fetch(base + '/matches')).json()).matches;
  const resumes = (await (await fetch(base + '/resumes')).json()).resumes;
  assert.ok(cands.some((c) => c.jobId === jobId));
  assert.ok(matches.some((m) => m.jobId === jobId));
  assert.ok(resumes.some((m) => m.jobId === jobId));
  // 该候选简历文字可回读
  const c = cands.find((x) => x.jobId === jobId);
  const txt = await (await fetch(base + `/api/resumes/${encodeURIComponent(c.candidateId)}/text`)).json();
  assert.equal(txt.found, true);
  assert.equal(typeof txt.text, 'string');
});

test('API 集成：人才库检索按 jobId 过滤', async () => {
  const hit = await (await fetch(base + `/api/candidates/search?jobId=${jobId}`)).json();
  assert.ok(hit.candidates.every((c) => c.jobId === jobId));
  const miss = await (await fetch(base + '/api/candidates/search?jobId=not_exist')).json();
  assert.equal(miss.candidates.length, 0);
});

test('API 集成：契约护栏在网关入口生效', async () => {
  const valid = { candidateId: 'cand_it_ok', source: 'boss', jobId: 'job_it_x', name: 'T', meta: { createdAt: new Date().toISOString(), masked: true } };
  assert.equal((await post('/api/sourcing/candidates', valid)).status, 201);
  const noMeta = { candidateId: 'cand_it_bad', source: 'boss', jobId: 'job_it_x', name: 'T' };
  assert.equal((await post('/api/sourcing/candidates', noMeta)).status, 400);
  const badSrc = { candidateId: 'cand_it_bad2', source: 'linkedin', jobId: 'job_it_x', name: 'T', meta: { createdAt: new Date().toISOString(), masked: true } };
  assert.equal((await post('/api/sourcing/candidates', badSrc)).status, 400);
});

test('API 集成：导出 CSV（含 BOM 与表头）', async () => {
  const r = await fetch(base + '/export/candidates.csv');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  const buf = Buffer.from(await r.arrayBuffer());
  // UTF-8 BOM EF BB BF
  assert.deepEqual([buf[0], buf[1], buf[2]], [0xef, 0xbb, 0xbf]);
  assert.match(buf.toString('utf8'), /candidateId/);
  assert.match(buf.toString('utf8'), /匹配分/);
});

test('API 集成：导出 XLSX（合法 ZIP 魔数 + 中文表头）', async () => {
  const r = await fetch(base + '/export/candidates.xlsx');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /spreadsheetml.sheet/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([buf[0], buf[1], buf[2], buf[3]], [0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
  assert.ok(buf.toString('utf8').includes('[Content_Types].xml'));
});

test('API 集成：调度任务创建 / 列表 / 移除', async () => {
  const r = await post('/api/sourcing/schedules', { jobId, intervalMinutes: 60, enabled: false });
  assert.equal(r.status, 201);
  const { scheduleId } = await r.json();
  assert.ok(scheduleId.startsWith('sch_'));
  const list = await (await fetch(base + '/api/sourcing/schedules')).json();
  assert.ok(list.schedules.some((s) => s.scheduleId === scheduleId));
  const ctl = await post('/api/sourcing/schedules/control', { scheduleId, action: 'remove' });
  assert.equal(ctl.status, 200);
});

test('API 集成：审计留痕覆盖业务动作', async () => {
  const audit = (await (await fetch(base + '/audit')).json()).audit;
  assert.ok(audit.some((e) => e.action === 'job.create'));
  assert.ok(audit.some((e) => e.action === 'schedule.create'));
});