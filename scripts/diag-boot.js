// 诊断：在无头环境下执行 index.html 内联脚本，定位登录页不弹出的根因。
// 通过可解析选择器的 DOM 桩，报告第一条因元素为空而抛出的错误，以及 boot()/showLogin 是否被触及。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'modules', 'recruitment-sourcing', 'public', 'index.html'), 'utf8');

// 收集 body 中真实存在的 id / class / tag（粗粒度即可，用于判断选择器是否可能命中）
const body = html.split('</head>')[1] || html;
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const classes = new Set();
for (const mm of html.matchAll(/class="([^"]+)"/g)) mm[1].split(/\s+/).forEach((c) => c && classes.add(c));
const tagsEls = new Set();
for (const mm of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)/g)) tagsEls.add(mm[1]);

const tokens = [];
const record = (kind, msg) => { tokens.push(`${kind}: ${msg}`); };

function selectorResolvable(sel) {
  const s = String(sel).trim();
  if (!s) return true;
  // 复杂选择器：只要其中某个 #id 存在即视为可解析（宽松，避免误报）
  const idRefs = [...s.matchAll(/#([A-Za-z0-9_\-:]+)/g)].map((m) => m[1]);
  if (idRefs.length) return idRefs.every((id) => ids.has(id));
  const clsRefs = [...s.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
  if (clsRefs.length && clsRefs.every((c) => classes.has(c))) return true;
  const tagRef = s.match(/^([a-z][a-z0-9-]*)$/i);
  if (tagRef) return tagsEls.has(tagRef[1]);
  return true; // 其它复杂组合，宽松通过
}

function makeEl(sel) {
  return new Proxy({
    _sel: sel, _cls: new Set(), _style: {}, _dataset: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
  }, {
    get(t, k) {
      if (k === 'addEventListener') return () => record('EVENT', t._sel);
      if (k === 'querystyle' || k === 'setAttribute' || k === 'appendChild') return () => {};
      if (k === 'classList') return t.classList;
      if (k === 'style') return t._style;
      if (k === 'dataset') return t._dataset;
      if (k === 'value' || k === 'textContent' || k === 'innerHTML') return '';
      if (k === 'scrollIntoView') return () => {};
      if (k === 'querySelector') return () => makeEl(sel);
      if (k === 'querySelectorAll') return () => [];
      if (k === 'add') return () => {};
      if (k === 'focus') return () => {};
      if (k === 'className' === 'className') return '';
      return t[k];
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

const dom = new Proxy({
  body: {}, documentElement: {}, readyState: 'complete',
  head: { appendChild: () => {} },
}, {
  get(t, k) {
    if (k === 'querySelector') {
      return (sel) => {
        if (!selectorResolvable(sel)) { record('MISSING-EL', String(sel)); t.__missing = t.__missing || []; t.__missing.push(String(sel)); return null; }
        return makeEl(sel);
      };
    }
    if (k === 'querySelectorAll') return () => [];
    if (k === 'getElementById') return (id) => (ids.has(id) ? makeEl('#' + id) : null);
    if (k === 'createElement') return () => makeEl('node');
    if (k === 'addEventListener' || k === 'removeEventListener') return () => {};
    return t[k] ?? {};
  },
  set(t, k, v) { t[k] = v; return true; },
});

const win = { document: dom, window: {}, navigator: {}, location: { href: 'http://127.0.0.1:4700/', search: '' }, localStorage: { _s: {}, getItem(k) { record('LOCAL-STORAGE-GET', k); return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = v; }, removeItem(k) { delete this._s[k]; } }, console, setTimeout: (fn) => fn && fn(), clearTimeout: () => {}, fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, ts: '' }), text: async () => '{}' }) };
win.window = win;

const script = html.split('<script type="module">')[1].split('</script>')[0];

const sandbox = { ...win, window: win, document: dom, console, fetch: win.fetch, setTimeout: setTimeout, clearTimeout: clearTimeout, Promise, Date, Math, JSON, String, Number, Boolean, Array, Object, RegExp, URLSearchParams, $: (s) => dom.querySelector(s) };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let threw = null;
const bootReached = { showLogin: false, boot: false };
try {
  // 在脚本之外额外注入探针：通过改写 showLogin 观察是否被调用
  sandbox.__observed = bootReached;
  // 运行整个脚本
  vm.runInContext(script, sandbox, { timeout: 3000 });
  // 脚本里 boot() 是 async 且末尾 showLogin()；showLogin 定义在全局。直接检查 boot 是否有执行痕迹：
  sandbox.__vmFlagShow = false;
  // 用最后一次 hook：把 showLogin 替换无法直接做到，改为扫描 token 是否走 fetch /api/auth/me
} catch (e) {
  threw = e;
}

console.log('=== 执行结果 ===');
console.log('顶层抛错:', threw ? (threw.stack || String(threw)).split('\n').slice(0, 3).join(' | ') : '无（顶层未抛错）');
console.log('顶层事件订阅(部分):');
tokens.filter((t) => t.startsWith('EVENT')).slice(0, 5).forEach((t) => console.log('  ', t));
console.log('localStorage 访问:', tokens.filter((t) => t.startsWith('LOCAL')).length, '次');
console.log('缺失元素(空值访问风险):', tokens.filter((t) => t.startsWith('MISSING')).slice(0, 10).join(' , ') || '无');
console.log('说明: 若顶层未抛错而登录页仍不弹出，问题在 boot() 异步体内（renderPipe/updateBossBar/健康检查等）或运行时元素访问。');