// Audit —— 磁盘为准：重启不丢留痕、单文件追加、旧格式迁移
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Audit } from '../framework/audit/audit.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'hr-test-audit-'));

test('audit：重启后 tail 从磁盘重读，不留痕丢失', async () => {
  const dir = tmp();
  try {
    const a1 = new Audit(dir);
    await a1.record({ action: 'job.create', actor: 'alice', detail: { jobId: 'j1' } });
    await a1.record({ action: 'candidate.sourced', actor: 'system' });
    // 全新实例模拟进程重启
    const a2 = new Audit(dir);
    const tail = a2.tail(10);
    assert.ok(tail.some((e) => e.action === 'job.create' && e.actor === 'alice'));
    assert.ok(tail.some((e) => e.action === 'candidate.sourced'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit：单文件追加（而非每事件一文件），目录只有一个 jsonl', async () => {
  const dir = tmp();
  try {
    const a = new Audit(dir);
    await a.record({ action: 'a', actor: 'x' });
    await a.record({ action: 'b', actor: 'x' });
    await a.record({ action: 'c', actor: 'x' });
    const files = readdirSync(join(dir, 'audit')).filter((f) => f.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    assert.equal(files[0], 'audit.jsonl');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit：tail 受 n 限制并取最近条目', async () => {
  const dir = tmp();
  try {
    const a = new Audit(dir);
    for (let i = 0; i < 5; i++) await a.record({ action: `evt_${i}`, actor: 'x' });
    const tail2 = a.tail(2);
    assert.equal(tail2.length, 2);
    assert.equal(tail2[0].action, 'evt_3');
    assert.equal(tail2[1].action, 'evt_4');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit：兼容迁移旧版多文件格式到 audit.jsonl，且幂等', async () => {
  const dir = tmp();
  try {
    const adir = join(dir, 'audit');
    mkdirSync(adir, { recursive: true });
    // 模拟旧格式：每事件一个独立文件
    writeFileSync(join(adir, '1789000000001.jsonl'), '{"ts":"2026-01-01T00:00:00.000Z","actor":"legacy","action":"old.a","detail":{}}\n');
    writeFileSync(join(adir, '1789000000002.jsonl'), '{"ts":"2026-01-01T00:00:01.000Z","actor":"legacy","action":"old.b","detail":{}}\n');
    const a = new Audit(dir); // 触发迁移
    const tail = a.tail(10);
    assert.ok(tail.some((e) => e.action === 'old.a'));
    assert.ok(tail.some((e) => e.action === 'old.b'));
    // 第二次构造不重复迁移
    const a2 = new Audit(dir);
    assert.equal(a2.tail(10).filter((e) => e.action === 'old.a').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});