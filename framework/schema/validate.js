// 契约校验器：直接解析并执行 framework/schema/*.json（draft-2020-12 子集）
// 支持：required / type(含联合类型与 integer) / properties / items / enum / format(email,date-time) / minimum / maximum
// API：validate(type, data) -> {ok, errors}；assertValid(type, data) -> data 或抛错
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS = { candidate: 'candidate.schema.json', job: 'job.schema.json', resume: 'resume.schema.json', match: 'match.schema.json', engagement: 'engagement.schema.json', messagelib: 'messagelib.schema.json', 'greet-campaign': 'greet-campaign.schema.json' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 兼容带/不带时区与毫秒的 ISO-8601 日期时间（例：2026-09-09T17:00:55、...123Z、...+08:00）
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

export class ContractValidator {
  constructor() {
    this.schemas = {};
    for (const [name, file] of Object.entries(SCHEMAS)) {
      this.schemas[name] = JSON.parse(readFileSync(join(__dirname, file), 'utf8'));
    }
  }

  validate(type, data) {
    const schema = this.schemas[type];
    if (!schema) return { ok: false, errors: [`unknown contract type: ${type}`] };
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, errors: [`${type}: 期望对象，实际 ${this.#typeOf(data)}`] };
    }
    const errors = [];
    this.#validateNode(schema, data, '', errors);
    return { ok: errors.length === 0, errors };
  }

  assertValid(type, data) {
    const r = this.validate(type, data);
    if (!r.ok) throw new Error(`契约校验失败[${type}]: ${r.errors.join('; ')}`);
    return data;
  }

  #validateNode(schema, value, path, errors) {
    if (typeof schema !== 'object' || value === undefined) return;

    // ---- type（含 "integer" 与联合类型数组） ----
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const okType = types.some((t) => (t === 'integer' ? Number.isInteger(value) : t === this.#typeOf(value)));
      if (!okType) {
        errors.push(`${path || '(root)'}: 期望类型 ${types.join('/')}，实际 ${this.#typeOf(value)}`);
        return; // 类型不符即不再深入，避免级联噪声
      }
    }

    if (value === null) return;

    // ---- enum ----
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      errors.push(`${path || '(root)'}: 取值需为 ${schema.enum.join(' / ')}`);
    }

    // ---- format ----
    if (schema.format) {
      const s = String(value ?? '');
      if (schema.format === 'email' && !EMAIL_RE.test(s)) errors.push(`${path}: 非法 email 格式`);
      if (schema.format === 'date-time' && !DATETIME_RE.test(s)) errors.push(`${path}: 非法 date-time 格式`);
    }

    // ---- 数值边界 ----
    if (typeof value === 'number') {
      if (Number.isInteger(schema.minimum) && value < schema.minimum) errors.push(`${path}: 小于最小值 ${schema.minimum}`);
      if (Number.isInteger(schema.maximum) && value > schema.maximum) errors.push(`${path}: 大于最大值 ${schema.maximum}`);
    }

    // ---- 对象（required / properties） ----
    if (typeof value === 'object' && !Array.isArray(value)) {
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (value[key] === undefined || value[key] === null) errors.push(`${path || '(root)'}.${key}: 必填缺失`);
        }
      }
      if (schema.properties) {
        for (const [key, sub] of Object.entries(schema.properties)) {
          if (value[key] !== undefined) this.#validateNode(sub, value[key], path ? `${path}.${key}` : key, errors);
        }
      }
    }

    // ---- 数组（items） ----
    if (Array.isArray(value) && schema.items) {
      value.forEach((item, i) => this.#validateNode(schema.items, item, `${path || '(root)'}[${i}]`, errors));
    }
  }

  #typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v; // 'string' | 'number' | 'boolean' | 'object'
  }
}