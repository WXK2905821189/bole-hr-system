const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const p = process.argv[2];
const html = fs.readFileSync(p, 'utf8');
const open = '<script type="module">';
const a = html.indexOf(open);
const b = html.indexOf('</script>', a);
if (a < 0 || b < 0) { console.error('script tags not found'); process.exit(2); }
const code = html.slice(a + open.length, b);
const tmp = path.join(os.tmpdir(), 'hrmod-' + Date.now() + '.mjs');
fs.writeFileSync(tmp, code);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  console.log('OK  module script syntax valid, ' + code.length + ' chars');
} catch (e) {
  console.error('SYNTAX ERROR:\n' + (e.stderr ? e.stderr.toString() : e.message));
  process.exit(1);
} finally {
  fs.unlinkSync(tmp);
}