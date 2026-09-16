// 招聘服务：简历↔JD 匹配打分（复用 GAP_ANALYSIS_SYSTEM 的加权口径，含离线启发式）
import { GAP_ANALYSIS_SYSTEM } from './prompts.js';
import { extractJson } from './llm.js';

const WEIGHTS = { hard_skills: 30, soft_skills: 20, core_duties: 20, industry_experience: 15, education: 15 };

export class MatcherService {
  constructor({ llm, validate, store, rules }) {
    this.llm = llm;
    this.validate = validate;
    this.store = store;
    this.rules = rules;
  }

  weights() {
    // 可配置权重（默认 30/20/20/15/15，与改造前等价）
    const w = this.rules?.get()?.match?.weights ?? WEIGHTS;
    return { ...WEIGHTS, ...w };
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

  // M6 · 前置匹配打分：不落盘（供 Python 在线简历差距分析门禁，高分才打招呼）
  async preScore({ jobParsed, resumeParsed, engine = 'llm' }) {
    const gap = await this.#byLlm(jobParsed, resumeParsed);
    return {
      ok: true,
      score: clampInt(gap.match_score),
      dimensionScores: {
        hardSkills: dim(gap, 'hard_skills'),
        softSkills: dim(gap, 'soft_skills'),
        coreDuties: dim(gap, 'core_duties'),
        industry: dim(gap, 'industry_experience'),
        education: dim(gap, 'education'),
      },
      evidence: gap.match_points?.join('；') ?? '',
      weakPoints: gap.weak_points ?? [],
      matchedAt: new Date().toISOString(),
    };
  }

  async #byLlm(job, resume) {
    const weights = this.weights();
    const wl = Object.entries(weights).map(([k, v]) => `${k}:${v}`).join(' ');
    const user = `权重(各维度满分)：${wl}\n\nJD解析结果：${JSON.stringify(job, null, 2)}\n\n简历解析结果：${JSON.stringify(resume, null, 2)}`;
    if (this.llm.ready) {
      try {
        const out = extractJson(await this.llm.complete(GAP_ANALYSIS_SYSTEM, user));
        if (typeof out.match_score === 'number') return out;
      } catch { /* 网关不可用时回退启发式 */ }
    }
    return heuristic(job, resume, weights);
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

// 离线启发式：按权重计算五个维度得分。技术栈维度以「岗位硬技能覆盖率」计分，
// 使弱技术栈简历明显低于强技术栈简历，支撑前置匹配门禁的区分度。
// weights 可配置（默认 30/20/20/15/15），NULL/未传走默认。
export function heuristic(job, resume, weights = WEIGHTS) {
  const w = { ...WEIGHTS, ...weights };
  const coverage = skillCoverage(jobSkills(job), resumeSkills(resume));
  const dims = {
    hard_skills: Math.round(w.hard_skills * coverage),
    soft_skills: Math.round(w.soft_skills * jdRatio(job, 'soft_skills')),
    core_duties: Math.round(w.core_duties * jdRatio(job, 'core_duties')),
    industry_experience: jdRatio(job, 'keywords') > 0.5 ? Math.round(w.industry_experience * 0.53) : 0,
    education: Math.round(w.education * 0.53),
  };
  const total = clampInt(Object.values(dims).reduce((a, b) => a + b, 0));
  return {
    match_score: total,
    match_points: coverage > 0.5 ? ['技术栈覆盖岗位硬技能'] : [],
    weak_points: coverage < 0.3 ? ['技术栈与岗位硬技能匹配度低'] : [],
    dimension_scores: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, { score: Math.round(v), max: w[k], detail: '' }])),
  };
}
function jdRatio(job, key) {
  const list = job[key] ?? job.mapDims?.[key] ?? [];
  return Array.isArray(list) && list.length ? 0.5 : 0.3;
}
// 提取岗位硬技能（兼容 hard_skills / hardSkills / mapDims）
function jobSkills(job) {
  return norm(job?.hard_skills ?? job?.hardSkills ?? job?.mapDims?.hard_skills ?? job?.mapDims?.hardSkills ?? []);
}
// 提取简历技能（兼容 skills / hard_skills / hardSkills / keywords）
function resumeSkills(resume) {
  return norm(resume?.skills ?? resume?.hardSkills ?? resume?.hard_skills ?? resume?.keywords ?? []);
}
function coverRatio(a, b) {
  const bl = b.map((s) => s.toLowerCase());
  const hit = a.filter((s) => bl.some((jv) => jv.includes(s.toLowerCase()) || s.toLowerCase().includes(jv))).length;
  return Math.min(1, hit / Math.max(1, a.length));
}
function skillCoverage(jobs, res) {
  if (!jobs.length) return 0.5;
  if (!res.length) return 0.05;
  return Math.max(coverRatio(jobs, res), coverRatio(res, jobs));
}
function norm(list) {
  return list.map((s) => String(s ?? '').trim()).filter(Boolean);
}