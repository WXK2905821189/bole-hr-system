// 清理 jobs.jsonl 中的错误字符测试数据（乱码 ???? 与大量重复的“未命名岗位”），仅保留干净的演示岗位 job_01/job_03。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const storeDir = join(__dirname, '..', 'infra', 'store');
const path = join(storeDir, 'jobs.jsonl');
if (!existsSync(path)) { console.log('未找到 jobs.jsonl'); process.exit(0); }

const KEEP = new Set(['job_01', 'job_03']); // 演示岗位，候选人池引用 job_01
const rows = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);

let removed = 0;
const kept = rows.filter((line) => {
  try {
    const o = JSON.parse(line);
    if (KEEP.has(o.jobId)) return true;
    removed++;
    return false;
  } catch { removed++; return false; }
});

if (removed === 0) { console.log('无需清理'); process.exit(0); }
writeFileSync(path, kept.join('\n') + '\n', 'utf8');
console.log(`已清理 ${removed} 条错误字符测试岗位数据，保留 ${kept.length} 条。`);