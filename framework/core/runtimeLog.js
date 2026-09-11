// 系统运行日志：滚动落盘 infra/store/logs.jsonl，并接管 console 输出与进程异常，便于运维排查。
// 用法：initRuntimeLog(storeDir) 初始化并接管 console；rt.log/rt.info/rt.warn/rt.error 显式记录；rt.list(n) 读最近日志。
import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'logs.jsonl';
let _dir = process.cwd();
let _installed = false;

function fmt(x) {
  if (typeof x === 'string') return x;
  if (x instanceof Error) return x.stack || x.message;
  try { return JSON.stringify(x); } catch { return String(x); }
}
function append(level, scope, msg) {
  try { appendFileSync(join(_dir, FILE), JSON.stringify({ ts: new Date().toISOString(), level, scope, message: fmt(msg) }) + '\n'); } catch {}
}
function line2obj(l) { try { return JSON.parse(l); } catch { return { ts: '', level: 'error', scope: 'parse', message: l }; } }

export function initRuntimeLog(storeDir) {
  _dir = storeDir;
  mkdirSync(_dir, { recursive: true });
  if (_installed) return rt;
  _installed = true;
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = (...a) => { const s = a.map(fmt).join(' '); orig.log(...a); append('info', 'console', s); };
  console.info = (...a) => { const s = a.map(fmt).join(' '); orig.info(...a); append('info', 'console', s); };
  console.warn = (...a) => { const s = a.map(fmt).join(' '); orig.warn(...a); append('warn', 'console', s); };
  console.error = (...a) => { const s = a.map(fmt).join(' '); orig.error(...a); append('error', 'console', s); };
  process.on('uncaughtException', (e) => { append('error', 'process', (e && e.stack) || String(e)); orig.error('uncaughtException:', e); });
  process.on('unhandledRejection', (r) => { append('error', 'process', fmt(r)); orig.error('unhandledRejection:', r); });
  append('info', 'system', '运行日志已启动');
  return rt;
}

export const rt = {
  log: (scope, msg) => append('info', scope, msg),
  info: (scope, msg) => append('info', scope, msg),
  warn: (scope, msg) => append('warn', scope, msg),
  error: (scope, msg) => append('error', scope, msg),
  list(n = 200) {
    const p = join(_dir, FILE);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).slice(-Math.max(1, Number(n) || 200)).map(line2obj);
  },
  clear() {
    try { writeFileSync(join(_dir, FILE), '', 'utf8'); append('info', 'system', '运行日志已清空'); return true; } catch { return false; }
  },
};