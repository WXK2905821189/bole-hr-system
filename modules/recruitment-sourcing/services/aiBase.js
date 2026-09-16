// M4 · AI 基座：持久化 baseURL + Key + model，优先级 = 设置页(持久化) > 环境变量 > 启动配置
// 设置页仅管理员可改（联 M5）；写入即应用到共享 LLM 实例（jd/parser/matcher 同步经新基座），无需重启。
// 模型列表由 OpenAI 兼容 GET {baseURL}/models 自动拉取，供前端下拉选择。
const FILE = 'llmconfig.jsonl';

export class AiBaseService {
  constructor({ store, audit, llm, configLlm }) {
    this.store = store;
    this.audit = audit;
    this.llm = llm;
    this.configLlm = configLlm ?? {};
  }

  read() { return this.store.readAll(FILE)[0] ?? null; }
  write(cfg) { this.store.writeAll(FILE, [cfg]); return cfg; }

  // 解析最终生效配置（勿回传明文 Key）
  resolve() {
    const p = this.read();
    const env = process.env;
    return {
      baseURL: p?.baseURL || env.LLM_BASE_URL || this.configLlm?.baseURL || '',
      apiKey: p?.apiKey || env.LLM_API_KEY || this.configLlm?.apiKey || '',
      model: p?.model || env.LLM_MODEL || this.configLlm?.model || '',
    };
  }

  // 将最终配置应用到共享 LLM 实例（构造时与每次保存时调用）
  sync() {
    const c = this.resolve();
    this.llm.apply(c);
    return c;
  }

  status() {
    const c = this.sync();
    const persisted = this.read();
    return {
      ready: this.llm.ready,
      baseURL: c.baseURL,
      apiKeyMasked: c.apiKey ? this.llm.maskKey() : '',
      model: c.model,
      source: persisted ? 'settings' : (c.baseURL ? 'env/config' : 'none'),
      hasKey: !!c.apiKey,
    };
  }

  // 保存设置（仅授权管理员调用）。先校验可达性（拉一次模型），成功后持久化并即时应用。
  async save({ baseURL, apiKey, model }, actorId) {
    const u = String(baseURL ?? '').trim().replace(/\/+$/, '');
    if (!u) return { ok: false, error: 'baseURL 必填' };
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'baseURL 需 http(s) 开头' };
    const prev = this.read() ?? {};
    // 未传新 Key 则沿用旧 Key（编辑时不清空密钥）
    const key = apiKey != null && String(apiKey).trim() !== '' ? String(apiKey).trim() : prev.apiKey;
    const resolvedModel = model ? String(model).trim() : prev.model;
    // 探活：用新 baseURL+Key 拉取模型列表，验证可达且拿到模型
    const probe = await this.llm.listModels({ baseURL: u, apiKey: key });
    if (!probe.ok) return { ok: false, error: `无法连接 AI 平台：${probe.error}` };
    if (!resolvedModel && probe.models.length === 1) { /* 单模型自动选定 */ }
    this.write({ baseURL: u, apiKey: key, model: resolvedModel, updatedAt: new Date().toISOString() });
    this.sync();
    await this.audit.record({ actor: actorId, action: 'ai.base.configure', detail: { baseURL: u, model: resolvedModel ?? '', modelCount: probe.count } });
    return { ok: true, status: this.status(), models: probe.models };
  }

  async listModels() {
    const c = this.resolve();
    return this.llm.listModels({ baseURL: c.baseURL, apiKey: c.apiKey });
  }
}