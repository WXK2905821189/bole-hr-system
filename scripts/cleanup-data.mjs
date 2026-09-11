import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const storeDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'infra', 'store');

// 需清空的测试数据文件（保留文件本身，仅置空）
const CLEAR = [
  'sessions.jsonl', 'jobs.jsonl', 'candidates.jsonl', 'resumes.jsonl',
  'matches.jsonl', 'cycles.jsonl', 'engagements.jsonl', 'greetcampaigns.jsonl',
  'notifications.jsonl', 'guardrail.jsonl', 'schedules.jsonl', 'logs.jsonl',
];
// 需清除的绑定/会话等敏感占位
const CLEAR_SENSITIVE = ['bossbindings.jsonl'];
// 保留：users.jsonl(改为唯一种子)、messagelib.jsonl(系统默认话术)

// 读取剩余记录数，便于统计
let kept = [];
for (const f of CLEAR) {
  const p = join(storeDir, f);
  const n = readFileSync(p, 'utf8').split('\n').filter(Boolean).length;
  if (n) kept.push(`${f}:${n}`);
  writeFileSync(p, '');
}
for (const f of CLEAR_SENSITIVE) {
  const p = join(storeDir, f);
  const n = readFileSync(p, 'utf8').split('\n').filter(Boolean).length;
  if (n) kept.push(`${f}:${n}`);
  writeFileSync(p, '');
}

// 用户收敛为唯一：王先生（管理员）。前端依赖 role/active/username/name/id。
writeFileSync(join(storeDir, 'users.jsonl'), JSON.stringify({
  id: 'A1', username: 'wang', name: '王先生', password: 'boss123', role: 'admin', active: true,
}) + '\n');

console.log('cleared: ' + (kept.length ? kept.join(', ') : '无残留数据'));
console.log('users.jsonl -> 唯一账号 wang / 王先生 (admin)');