// SchedulingService —— 调度任务 CRUD / 持久化 / 暂停恢复 / 触发
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../infra/store/store.js';
import { SchedulingService } from '../modules/recruitment-sourcing/services/scheduler.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'hr-test-sched-'));
  const store = new Store(dir);
  const calls = [];
  const sched = new SchedulingService({
    store,
    audit: null,
    minGapMinutes: 60,
    run: async (s) => { calls.push(s.jobId); },
  });
  return { dir, store, sched, calls };
}
const closed = (s) => { s.dispose(); };

test('scheduler：缺 jobId 创建时应抛错', () => {
  const { dir, sched, calls } = setup();
  try {
    assert.throws(() => sched.create({ keyword: '前端' }));
  } finally {
    closed(sched); rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduler：创建后持久化到 store，可列出', () => {
  const { dir, store, sched } = setup();
  try {
    const s = sched.create({ jobId: 'job_01', intervalMinutes: 5, enabled: false });
    assert.ok(s.scheduleId.startsWith('sch_'));
    const persisted = store.readAll('schedules.jsonl');
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].lastStatus, 'pending');
  } finally {
    closed(sched); rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduler：pause / resume / remove 生命周期', () => {
  const { dir, sched, calls } = setup();
  try {
    const s = sched.create({ jobId: 'job_01', enabled: false });
    // pause 仅把 enabled 置 false，任务保留
    const p = sched.control(s.scheduleId, 'pause');
    assert.equal(p.action, 'pause');
    assert.equal(sched.list().find((x) => x.scheduleId === s.scheduleId).enabled, false);
    // 已知 action 之外的返回失败
    const bad = sched.control(s.scheduleId, 'explode');
    assert.equal(bad.ok, false);
    // remove 从持久层删除
    const r = sched.control(s.scheduleId, 'remove');
    assert.equal(r.ok, true);
    assert.equal(sched.list().length, 0);
  } finally {
    closed(sched); rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduler：resume 后于下一轮执行 run（注入的 runner 被调用）', async () => {
  const { dir, sched, calls } = setup();
  try {
    const s = sched.create({ jobId: 'job_01', enabled: false });
    const resume = sched.control(s.scheduleId, 'resume'); // 立即排程
    assert.equal(resume.ok, true);
    await new Promise((r) => setTimeout(r, 80)); // 等下一轮 tick
    assert.equal(calls.length >= 1, true);
    const persisted = sched.list().find((x) => x.scheduleId === s.scheduleId);
    assert.equal(persisted.lastStatus, 'ok');
  } finally {
    closed(sched); rmSync(dir, { recursive: true, force: true });
  }
});