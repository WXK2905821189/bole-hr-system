// 匹配规则配置（JD 解析规则 + AI 匹配规则）：持久化到 matching_rules.jsonl
// - jd      : JD 解析产出的硬性条件是否自动作为寻访门槛 + 解析质量阈值
// - filter  : 硬性筛选规则（PRD FR-11，Pre-AI 门槛）。字段留空/0 表示不启用该条
// - match   : 匹配打分权重（五维求和默认 100）+ 打招呼阈值（达标才打招呼）
// 默认值与改造前行为完全等价，避免回归；管理员可在设置页调整，保存即生效。
const FILE = 'matching_rules.jsonl';

export const DEFAULT_RULES = {
  jd: {
    useParsedHardSkills: true, // JD 解析的硬技能自动作为寻访硬门槛（默认启用，等价原行为）
    minKeywords: 1,            // JD 解析关键词不足此阈值视为"JD 信息不足"
  },
  filter: {
    maxAge: 0,                 // 年龄上限（岁），0=不限。候选无年龄字段时不做年龄剔除
    minDegree: '',             // 学历下限，''=不限；取值如 专科/本科/硕士/博士
    minExperienceYears: 0,     // 经验年数下限，0=不限
    mustInclude: [],           // 必须含关键词（按技能/岗位匹配，任一命中即进入）
    mustExclude: [],           // 命中任一即剔除
    veto: [],                  // 一票否决关键词（命中任一直接跳过，不进入匹配）
  },
  match: {
    greetThreshold: null,      // 打招呼阈值，null=沿用改造前（配置/环境变量/默认 60）
    weights: { hard_skills: 30, soft_skills: 20, core_duties: 20, industry_experience: 15, education: 15 },
  },
};

// 深合并：以用户配置覆盖默认，缺失字段回退默认
function merge(over) {
  const base = structuredClone(DEFAULT_RULES);
  if (!over || typeof over !== 'object') return base;
  for (const sec of ['jd', 'filter', 'match']) {
    if (over[sec] && typeof over[sec] === 'object') {
      if (sec === 'match' && over[sec].weights && typeof over[sec].weights === 'object') {
        base.match.weights = { ...base.match.weights, ...over[sec].weights };
      }
      base[sec] = { ...base[sec], ...over[sec] };
    }
  }
  return base;
}

export class MatchingRulesService {
  constructor({ store, audit }) {
    this.store = store;
    this.audit = audit;
  }

  // 当前生效规则（默认 + 用户覆盖）
  get() { return merge(this.store.readAll(FILE)[0] ?? null); }

  // 原始持久化配置（供前端展示"已设置"状态）
  readPersisted() { return this.store.readAll(FILE)[0] ?? null; }

  jarSave(over, actorId) {
    const merged = merge(over ?? {});
    this.store.writeAll(FILE, [merged]);
    return { ok: true, rules: merged };
  }

  async save(over, actorId) {
    const merged = merge(over ?? {});
    this.store.writeAll(FILE, [merged]);
    await this.audit.record({ actor: actorId, action: 'sourcing.rules.configure', detail: { filter: merged.filter, greetThreshold: merged.match.greetThreshold, weights: merged.match.weights } });
    return { ok: true, rules: merged };
  }

  status() {
    return { persisted: !!this.readPersisted(), rules: this.get() };
  }

  // ============ 硬性筛选判定（FR-11，Pre-AI 门槛）：不满足 → { pass:false, reason } ============
  // cand: { name?, years?, education?: {degree,major}, skills?, rawText?, startYear? }
  evaluateHardFilter(cand) {
    const f = this.get().filter;
    const reasons = [];
    const hasSearchable = String(cand?.name ?? '') + ' ' + (cand?.skills ?? []).join(' ') + ' ' + String(cand?.rawText ?? '');
    const lower = hasSearchable.toLowerCase();
    const raw = Object.values(cand?.skills ?? []).concat([cand?.name, cand?.rawText]).filter(Boolean).join(' ').toLowerCase();

    // 一票否决（veto）
    if (Array.isArray(f.veto) && f.veto.length) {
      for (const v of f.veto) if (String(v).trim() && raw.includes(String(v).toLowerCase())) reasons.push(`命中一票否决关键词「${v}」`);
    }
    // 排除关键词
    if (Array.isArray(f.mustExclude) && f.mustExclude.length) {
      for (const w of f.mustExclude) if (String(w).trim() && lower.includes(String(w).toLowerCase())) reasons.push(`命中排除关键词「${w}」`);
    }
    // 经验年限下限
    if (Number(f.minExperienceYears) > 0 && (Number(cand?.years) || cand?.workExperienceYears || 0) < Number(f.minExperienceYears)) {
      reasons.push(`经验不足（要求 ≥${f.minExperienceYears} 年）`);
    }
    // 学历下限
    if (String(f.minDegree ?? '').trim()) {
      const deg = cand?.education?.degree ?? '';
      const rank = (d) => (d.includes('博士') ? 4 : d.includes('硕士') ? 3 : d.includes('本科') || d.includes('学士') ? 2 : d.includes('专科') || d.includes('大专') ? 1 : 0);
      if (rank(String(deg)) < rank(String(f.minDegree))) reasons.push(`学历不足（要求 ≥${f.minDegree}，当前 ${deg || '未标注'}）`);
    }

    // 硬性门槛未全过 → 直接跳过，不进入 AI 匹配、不打招呼（记录原因）
    if (reasons.length) return { pass: false, reason: reasons.join('；') };
    return { pass: true, reason: '' };
  }

  // 关键字进入门槛（mustInclude）：仅当配置非空时强制命中；空=不限制
  passesKeywordGate(cand) {
    const f = this.get().filter;
    if (!Array.isArray(f.mustInclude) || !f.mustInclude.length) return { pass: true };
    const hay = [cand?.name, ...(cand?.skills ?? []), cand?.rawText].filter(Boolean).join(' ').toLowerCase();
    const miss = f.mustInclude.filter((k) => String(k).trim() && !hay.includes(String(k).toLowerCase()));
    if (miss.length) return { pass: false, miss };
    return { pass: true };
  }
}