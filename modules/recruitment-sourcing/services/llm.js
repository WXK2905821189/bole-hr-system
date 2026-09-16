// 极简 LLM 客户端（OpenAI 兼容协议，含本地 Ollama / 输出/关闭云端）
// 支持配置：baseURL / apiKey / model / jsonSchema
// 注：fetch 为 Node≥18 全局 API
export class LLMClient {
  constructor(config = {}) {
    this.baseURL = config.baseURL ?? ''; // 未显式配置则视为未启用（走离线启发式）
    this.apiKey = config.apiKey ?? 'ollama';
    this.model = config.model ?? 'qwen2.5';
    this.timeoutMs = config.timeoutMs ?? 60000;
  }

  get ready() {
    return !!(this.baseURL && this.model);
  }

  // 运行时可重配（M4：管理员在设置页改 baseURL/Key/model 后即时生效，无需重启）
  apply({ baseURL, apiKey, model } = {}) {
    if (baseURL != null) this.baseURL = String(baseURL).replace(/\/+$/, '');
    if (apiKey != null) this.apiKey = String(apiKey);
    if (model) this.model = String(model);
    return this;
  }

  // 掩码输出 Key，供状态接口展示（不回传明文）
  maskKey() {
    if (!this.apiKey) return '';
    return this.apiKey.length > 8 ? `${this.apiKey.slice(0, 3)}****${this.apiKey.slice(-3)}` : '****';
  }

  // M4：自动拉取模型列表（OpenAI 兼容 GET {baseURL}/models）
  async listModels({ baseURL, apiKey } = {}) {
    const u = String(baseURL ?? this.baseURL ?? '').replace(/\/+$/, '');
    const k = String(apiKey ?? this.apiKey ?? '');
    if (!u) return { ok: false, error: 'baseURL 缺失，无法拉取模型', models: [] };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${u}/models`, {
        headers: k ? { Authorization: `Bearer ${k}` } : {},
        signal: ctrl.signal,
      });
      if (!res.ok) return { ok: false, error: `models HTTP ${res.status}`, models: [] };
      const data = await res.json();
      const models = (Array.isArray(data?.data) ? data.data : [])
        .map((m) => String(m?.id ?? '').trim()).filter(Boolean);
      return { ok: true, models, count: models.length };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e), models: [] };
    } finally {
      clearTimeout(timer);
    }
  }

  async complete(system, user, { jsonSchema = true } = {}) {
    if (!this.ready) throw new Error('LLM 未配置（baseURL/model 缺失）');
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    };
    if (jsonSchema) body.response_format = { type: 'json_object' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`LLM upstream ${res.status}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  }
}

// 从 LLM 输出中健壮地提取 JSON（剥离 markdown 代码块、截取首个 JSON 对象、防御空值）
export function extractJson(raw) {
  if (!raw) return {};
  let s = String(raw).trim();
  s = s.replace(/```(?:json)?/gi, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return {};
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return {};
  }
}