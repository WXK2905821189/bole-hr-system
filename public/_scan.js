import fs from 'node:fs';
const f = process.argv[2];
let s = fs.readFileSync(f, 'utf8');
// strip <style>...</style>
s = s.replace(/<style>[\s\S]*?<\/style>/g, '');
// cut at first script tag
s = s.split('<script')[0];
// remove tags but keep text
const text = s.replace(/<[^>]+>/g, ' ');
// find runs of pure latin letters (len>=3) that are likely English words (surrounded by non-letters)
const words = {};
for (const m of text.matchAll(/\b([A-Za-z]{3,})\b/g)) {
  words[m[1]] = (words[m[1]] || 0) + 1;
}
const ignore = new Set(['BOSS','JD','AI','hr','CSS','PDF','JVM','HTML','React','Node','TypeScript','LLM','Ltd','OK','doc']);
const list = Object.entries(words).filter(([w]) => !ignore.has(w)).sort((a, b) => b[1] - a[1]);
console.log('visible English words (excluding brand/tech):');
for (const [w, c] of list) console.log('  ' + w + ' x' + c);