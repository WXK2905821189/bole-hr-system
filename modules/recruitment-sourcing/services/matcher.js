// 招聘服务：简历↔JD 匹配打分（复用 GAP_ANALYSIS_SYSTEM 的加权口径，含离线启发式）
import { GAP_ANALYSIS_SYSTEM } from './prompts.js';
import { extractJson } from './llm.js';

const WEIGHTS = { hard_skills: 30, soft_skills: 20, core_duties: 20, industry_experience: 15, education: 15 };

export class MatcherService {
  constructor({ llm, validate, store }) {
    this.llm = llm;
    this.validate = validate;
    this.store = store;
  }

  async match({ candidateId, jobId, jobParsed, resumeParsed, engine = 'llm' }) {
    const gap = await this.#byLlm(jobParsed, resumeParsed);
    const out = {
      matchId: `match_${candidateId}_${jobId}`,
      candidateId,
      jobId,
      matchScore: clampInt(gap.match_score),
      dimensionScores: {
        hardSkills: dim(gap, 'hard_skills'),
        softSkills: dim(gap, 'soft_skills'),
        coreDuties: dim(gap, 'core_duties'),
        industry: dim(gap, 'industry_experience'),
        education: dim(gap, 'education'),
      },
      evidence: gap.match_points?.join('；') ?? '',
      meta: { matchedAt: new Date().toISOString(), engine },
    };
    this.validate.assertValid('match', out);
    await this.store.write('matches.jsonl', out);
    return out;
  }

  async #byLlm(job, resume) {
    const user = `JD解析结果：${JSON.stringify(job, null, 2)}\n\n简历解析结果：${JSON.stringify(resume, null, 2)}`;
    if (this.llm.ready) {
      const out = extractJson(await this.llm.complete(GAP_ANALYSIS_SYSTEM, user));
      if (typeof out.match_score === 'number') return out;
    }
    return heuristic(job, resume);
  }
}

function dim(gap, key) {
  const s = gap.dimension_scores?.[key]?.score;
  return Number.isFinite(s) ? Math.round(s) : 0;
}
function clampInt(n) {
  const v = Number.isFinite(n) ? Math.round(n) : 0;
  return Math.max(0, Math.min(100, v));
}

// 离线启发式：按权重计算五个维度得分
export function heuristic(job, resume) {
  const dims = {
    hard_skills: jdRatio(job, 'hard_skills') * 30,
    soft_skills: jdRatio(job, 'soft_skills') * 20,
    core_duties: jdRatio(job, 'core_duties') * 20,
    industry_experience: jdRatio(job, 'keywords') > 0.5 ? 8 : 0,
    education: 8,
  };
  const total = clampInt(Object.values(dims).reduce((a, b) => a + b, 0));
  return {
    match_score: total,
    match_points: [],
    weak_points: [],
    dimension_scores: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, { score: Math.round(v), max: WEIGHTS[k], detail: '' }])),
  };
}
function jdRatio(job, key) {
  const list = job[key] ?? job.mapDims?.[key] ?? [];
  return Array.isArray(list) && list.length ? 0.5 : 0.3;
}