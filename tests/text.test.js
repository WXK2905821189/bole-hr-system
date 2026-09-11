// 简历文本抽取 —— 零依赖内置 PDF 文本层提取 + extractText 端到端
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractText, extractPdfText } from '../modules/recruitment-sourcing/services/resumetext.js';

const MINIMAL_PDF = [
  '%PDF-1.4',
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
  '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
  '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj',
  '4 0 obj << /Length 100 >> stream',
  'BT /F1 12 Tf 72 720 Td (Hello Resume) Tj ET',
  'endstream endobj',
  'trailer << /Root 1 0 R >> %%EOF',
].join('\n');

test('extractPdfText：从未压缩内容流取出文本字符串', () => {
  assert.ok(extractPdfText(Buffer.from(MINIMAL_PDF)).includes('Hello Resume'));
});

test('extractPdfText：处理转义与十六进制字符串', () => {
  const escaped = Buffer.from(String.raw`BT (a\(b\)c) Tj ET`, 'latin1');
  assert.ok(extractPdfText(escaped).includes('a(b)c'), '应还原转义括号');
  const hex = Buffer.from(String.raw`BT (X) Tj <48656C6C6F> TJ ET`, 'latin1');
  assert.ok(extractPdfText(hex).includes('Hello'), '应从 hex 串解出文本');
});

test('extractPdfText：无文本层返回空', () => {
  assert.equal(extractPdfText(Buffer.from('BT /F1 12 Tf ET')) , '');
});

test('extractText：PDF 端到端提取（不依赖 pdftotext 是否安装）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-test-text-'));
  try {
    const f = join(dir, 'resume.pdf');
    writeFileSync(f, MINIMAL_PDF);
    const { text } = await extractText(f, 'resume.pdf');
    assert.ok(text.includes('Hello Resume'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractText：txt 走 UTF-8 读取', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-test-text-'));
  try {
    const f = join(dir, 'r.txt');
    writeFileSync(f, '这是一份中文简历，内容足够长以便通过长度校验。', 'utf-8');
    const { sourceType, text } = await extractText(f, 'r.txt');
    assert.equal(sourceType, 'txt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractText：纯二进制 PDF（无可读文本）抛错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-test-text-'));
  try {
    const f = join(dir, 'bin.pdf');
    writeFileSync(f, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(400)]));
    await assert.rejects(() => extractText(f, 'bin.pdf'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});