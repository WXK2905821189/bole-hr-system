// xlsx / zip —— 自研 OOXML 最小合法性校验（魔数、结构、XML 转义）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx, zip, xml } from '../infra/files/xlsx.js';
import { buildDocx } from '../infra/files/ooxml.js';

test('xlsx：产物是合法 ZIP（PK 魔数）且含 workbook.xml', () => {
  const buf = buildXlsx('Candidates', ['candidateId', '姓名', '匹配分'], [['cand_1', '张三', 82]]);
  // ZIP 本地文件头魔数 PK\x03\x04
  assert.equal(buf[0], 0x50);
  assert.equal(buf[1], 0x4b);
  assert.equal(buf[2], 0x03);
  assert.equal(buf[3], 0x04);
  const s = buf.toString('utf8');
  assert.ok(s.includes('[Content_Types].xml'));
  assert.ok(s.includes('xl/workbook.xml'));
});

test('xlsx：中文表名与中文单元格可写入（此前曾因中文文件名/表名崩溃）', () => {
  const buf = buildXlsx('候选人', ['姓名'], [['张三'], ['李四']]);
  assert.ok(buf[0] === 0x50 && buf[1] === 0x4b);
});

test('xml：转义 & < > "', () => {
  assert.equal(xml('a&b'), 'a&amp;b');
  assert.equal(xml('<a>'), '&lt;a&gt;');
  assert.equal(xml('say "hi"'), 'say &quot;hi&quot;');
});

test('docx：产物是合法 ZIP', () => {
  const buf = buildDocx([{ text: '个人简历', bold: true }, '', '候选内容']);
  assert.equal(buf[0], 0x50);
  assert.equal(buf[1], 0x4b);
  assert.equal(buf[2], 0x03);
  assert.equal(buf[3], 0x04);
});