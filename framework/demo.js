// 框架演示：注册模块 → 事件流转 → 契约校验 → 审计 → 网关
// 运行：node framework/demo.js
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventBus } from './core/bus.js';
import { ModuleRegistry } from './core/registry.js';
import { Lifecycle } from './core/lifecycle.js';
import { Gateway } from './core/gateway.js';
import { cfg } from './core/config.js';
import { Audit } from './audit/audit.js';
import { ContractValidator } from './schema/validate.js';
import { Store } from '../infra/store/store.js';
import { loadModule, manifest } from '../modules/recruitment-sourcing/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// LLM 可经由环境变量指向本地 Ollama/Qwen（OpenAI 兼容）：
//   HR_LLM_BASE=http://127.0.0.1:11434/v1 HR_LLM_MODEL=qwen2.5 node framework/demo.js
// 未配置时使用离线启发式解析/匹配（框架仍可跑通）。
const config = cfg({
  storeDir: join(__dirname, '../infra/store'),
  llm: {
    baseURL: process.env.HR_LLM_BASE,
    apiKey: process.env.HR_LLM_KEY,
    model: process.env.HR_LLM_MODEL,
  },
});

const bus = new EventBus();
const registry = new ModuleRegistry();
const audit = new Audit(config.storeDir);
const validate = new ContractValidator();
const store = new Store(config.storeDir);
const gateway = new Gateway({ registry, audit });

// 1) 注册并挂起模块
const { instance } = await loadModule({ bus, validate, audit, store, config, manifest });
registry.register({ ...manifest, instance });
await new Lifecycle(registry, bus).start(manifest.id);
console.log('[框架] 已注册模块：', registry.list());

// 2) API 服务暴露到统一网关
gateway.route('GET', /^\/health$/, (_req, res) => json(res, 200, { ok: true }));
gateway.route('GET', /^\/modules$/, (_req, res) => json(res, 200, { modules: registry.list() }));
gateway.route('GET', /^\/matches$/, (_req, res) => json(res, 200, { matches: store.readAll('matches.jsonl') }));
gateway.route('GET', /^\/jobs$/, (_req, res) => json(res, 200, { jobs: store.readAll('jobs.jsonl') }));
gateway.route('GET', /^\/audit$/, (_req, res) => json(res, 200, { audit: audit.tail(10) }));

// 3) 触发一次「JD解析→要简历→解析→匹配」事件链（模拟 HR 触发）
const jdRaw = '招聘 前端工程师：熟练 JavaScript/TypeScript、React、Node.js，负责核心业务前端开发，具备跨部门协作能力。';
const { candidate, job } = await instance.api.runSourcingCycle('job_01', jdRaw, '前端工程师');
console.log('\n[事件流转] job.parsed -> candidate.sourced -> resume.parsed -> match.computed 完成');
console.log('  岗位JD关键词:', (job.parsedKeywords ?? []).join(','));
console.log('  候选人      :', candidate.candidateId, '@', candidate.source);
console.log('  匹配分      :', store.readAll('matches.jsonl').at(-1)?.matchScore, '(离线启发式/LLM)');

// 4) 演示统一网关（含审计）
const server = gateway.listen(0);
const port = server.address().port;
for (const path of ['/modules', '/matches', '/jobs', '/audit']) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.json();
  console.log(`[网关] GET ${path} ->`, res.status, path === '/modules' ? `模块数=${body.modules.length}` : Object.keys(body));
}
server.close();

console.log('\n[审计] 最近留痕：');
for (const l of audit.tail(4)) console.log('  -', l.action, '|', l.ts);

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}