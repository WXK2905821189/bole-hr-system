// 简历文件 → 纯文本（迁移自 InterviewPrep/chatflow/resume-parser.js 的文本抽取逻辑）
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

// node:child_process 异步导入，避免顶层依赖在未使用 pdftotext 时加载
async function exec(cmd) {
  const { execSync } = await import('node:child_process');
  return execSync(cmd, { timeout: 15000, encoding: 'utf-8' });
}

export async function extractText(filePath, fileName = '') {
  const ext = extname(fileName).toLowerCase();
  let text = '';
  let sourceType = 'unknown';
  let warning = '';

  if (ext === '.txt' || ext === '.md') {
    text = readUtf8(filePath);
    sourceType = 'txt';
  } else if (ext === '.pdf') {
    const buf = readFileSync(filePath);
    text = await tryPdftotext(filePath);
    if (text.trim()) {
      sourceType = 'pdf';
    } else {
      const builtin = extractPdfText(buf);
      if (builtin.trim()) {
        text = builtin;
        sourceType = 'fallback';
        warning = 'pdftotext 不可用或输出为空，已用内置解析提取文本层';
      } else {
        text = readableFromBinary(buf);
        sourceType = 'fallback';
        warning = '无法正常解析，已提取部分可识别文本';
      }
    }
  } else {
    text = readUtf8(filePath);
  }

  const clean = cleanText(text);
  if (!clean || clean.length < 10) throw new Error('简历解析后无文本内容（可能为加密/纯图片扫描件）');
  return { text: clean, sourceType, warning };
}

async function tryPdftotext(filePath) {
  try { return await exec('pdftotext -layout "' + filePath + '" -'); } catch { return ''; }
}

// 内置 PDF 文本层提取（零依赖）。适用于内容流未压缩的 PDF；压缩流须依赖 pdftotext。
export function extractPdfText(buf) {
  const src = buf.toString('latin1'); // PDF 内容流按字节处理
  const parts = [];
  // 扫描文本字符串操作数：(literal) 或 <hex>，紧跟 Tj / "'" / TJ
  const re = /(?:\(((?:\\.|[^\\()])*)\)|\<([0-9A-Fa-f\s]+)\>)\s*(?:Tj|TJ|'|")/g;
  let m;
  while ((m = re.exec(src))) parts.push(m[1] != null ? unescapeLit(m[1]) : unescapeHex(m[2]));
  return cleanText(parts.join('\n'));
}

function unescapeLit(s) {
  return s
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\n/g, ' ').replace(/\\r/g, ' ').replace(/\\t/g, ' ')
    .replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}
function unescapeHex(s) {
  const h = s.replace(/\s+/g, '');
  const bytes = [];
  for (let i = 0; i + 1 < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
  return Buffer.from(bytes).toString('latin1');
}

function readUtf8(p) {
  try { return readFileSync(p, 'utf-8'); } catch { return ''; }
}
function cleanText(raw) {
  return String(raw ?? '')
    .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\t/g, ' ')
    .replace(/ {3,}/g, '  ').replace(/\n{4,}/g, '\n\n\n').trim();
}
function readableFromBinary(buf) {
  const s = buf.toString('utf-8').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  return s.length > buf.length * 0.3 ? cleanText(s) : '';
}