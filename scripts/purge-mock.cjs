const fs = require('fs');
const path = require('path');
const store = path.join(__dirname, '../infra/store');
const mockIds = new Set(['cand_1789372605306_0', 'cand_1789372605307_1', 'cand_1789372605307_2']);
let purged = {};
for (const f of ['candidates.jsonl', 'matches.jsonl', 'engagements.jsonl', 'resumes.jsonl']) {
  const p = path.join(store, f);
  if (!fs.existsSync(p)) continue;
  const kept = [];
  let removed = 0;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let cid = null;
    try { cid = JSON.parse(line).candidateId; } catch { cid = null; }
    if (cid && mockIds.has(cid)) { removed++; continue; }
    kept.push(line);
  }
  fs.writeFileSync(p, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
  purged[f] = removed;
}
console.log('PURGED', JSON.stringify(purged));