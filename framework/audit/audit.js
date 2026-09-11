// 操作审计：统一追加到单文件 audit/audit.jsonl，tail() 从磁盘重读 —— 重启不丢留痕。
// 兼容旧版「每事件一个独立文件」格式：首次构造时自动迁移（一次性、幂等、不删除旧文件）。
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'audit.jsonl';

export class Audit {
  constructor(storeDir) {
    this.dir = join(storeDir, 'audit');
    mkdirSync(this.dir, { recursive: true });
    this.file = join(this.dir, FILE);
    this.#migrateLegacy();
  }

  async record(entry) {
    const line = { ts: new Date().toISOString(), actor: entry.actor ?? 'system', action: entry.action, detail: entry.detail ?? {} };
    appendFileSync(this.file, JSON.stringify(line) + '\n');
    return line;
  }

  /** 返回最近 n 条留痕（磁盘为准）。 */
  tail(n = 20) {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  // 一次性迁移旧版多文件格式；audit.jsonl 已存在则跳过（幂等）。
  #migrateLegacy() {
    if (existsSync(this.file)) return;
    const legacy = readdirSync(this.dir).filter((f) => f.endsWith('.jsonl') && f !== FILE).sort();
    if (!legacy.length) return;
    const lines = [];
    for (const f of legacy) {
      const raw = readFileSync(join(this.dir, f), 'utf8').trim();
      if (raw) lines.push(...raw.split('\n').filter(Boolean));
    }
    if (lines.length) writeFileSync(this.file, lines.join('\n') + '\n');
  }
}