// FileVault —— 简历加密存储回环（AES-256-GCM），隔离临时目录、显式注入密钥
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileVault } from '../infra/files/vault.js';

const KEY = 'a'.repeat(64); // 合法 64 位 hex

function tmp() {
  return mkdtempSync(join(tmpdir(), 'hr-test-vault-'));
}

test('vault：put/get 加解密回环一致', () => {
  const dir = tmp();
  try {
    const v = new FileVault(dir, KEY);
    const ref = v.put('机密简历：张三 138****', 'cand_1');
    assert.equal(ref, 'vault:cand_1');
    assert.equal(v.get(ref), '机密简历：张三 138****');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vault：空文本返回 null 不落盘', () => {
  const dir = tmp();
  try {
    const v = new FileVault(dir, KEY);
    assert.equal(v.put('', 'cand_empty'), null);
    assert.equal(v.put(null, 'cand_null'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vault：引用不存在/非法前缀返回 null', () => {
  const dir = tmp();
  try {
    const v = new FileVault(dir, KEY);
    assert.equal(v.get('vault:no-such-file'), null);
    assert.equal(v.get('plain-ref'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vault：密文是随机的，同一原文两次加密不同', () => {
  const dir = tmp();
  try {
    const v = new FileVault(dir, KEY);
    v.put('相同内容', 'a');
    v.put('相同内容', 'b');
    const encA = readFileSync(join(dir, 'a.enc'), 'utf8');
    const encB = readFileSync(join(dir, 'b.enc'), 'utf8');
    assert.notEqual(encA, encB);
    assert.equal(v.get('vault:a'), '相同内容');
    assert.equal(v.get('vault:b'), '相同内容');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vault：非法密钥抛错', () => {
  assert.throws(() => new FileVault(tmp(), 'not-a-valid-hex-key'));
});

test('vault：不注入密钥时 enabled 为 false（走自动生成熔断模式）', () => {
  const dir = tmp();
  try {
    const v = new FileVault(dir);
    // 自动生成了密钥文件
    assert.equal(existsSync(join(dir, 'vault.key')), true);
    assert.equal(v.enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});