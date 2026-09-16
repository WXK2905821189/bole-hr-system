// 轨道二·总体能力评分：独立于「岗位匹配分」的候选人本身能力评估
// 用于识别人岗匹配分不高、但自身能力强的候选人 → 进入「人工复核」池（review pool）。
// 打分沿用 heuristic + AI 双路径：默认走离线启发式（确定性、可测试）；AI 基座就绪时走 LLM 判定。
import { OVERALL_WEIGHTS } from './rules.js';
import { extractJson } from './llm.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const clampInt = (n) => Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));

export class OverallAbilityService {
  constructor({ llm, rules }) {
    this.llm = llm;
    this.rules = rules;
  }

  // 当前生效权重（默认 + 用户覆盖），缺失回退默认
  weights() {
    const w = this.rules?.get()?.overall?.weights;
    return { ...OVERALL_WEIGHTS, ...w };
  }

  // 计算总体能力分：resumeParsed 缺省时用 rawText 兜底启发抽取
  async score({ resumeParsed = null, resumeText = '', engine = 'llm' } = {}) {
    const weights = this.weights();
    if (this.llm?.ready && engine === 'llm') {
      try {
        const llm = await this.#byLlm(resumeParsed, resumeText, weights);
        if (llm && Number.isFinite(llm.overallScore)) return llm;
      } catch { /* AI 不可用回退启发式 */ }
    }
    return heuristicOverall(resumeParsed, resumeText, weights);
  }

  async #byLlm(resumeParsed, resumeText, weights) {
    if (!this.llm?.ready) return null;
    const wl = Object.entries(weights).map(([k, v]) => `${k}:${v}`).join(' ');
    const sys = '你是资深 HR。基于候选人的综合简历评估其「总体能力」（与具体岗位无关）。按给定维度各返回 0-{max} 的得分，输出 JSON：{"overallScore":0-100,"dimension_scores":{"<维度>":{"score":0-100,"detail":"理由"}},"points":["..."]}。';
    const user = `权重(各维度满分)：${wl}\n\n简历结构化：${JSON.stringify(resumeParsed ?? {})}\n\n简历原文：${String(resumeText ?? '').slice(0, 2000)}`;
    const out = extractJson(await this.llm.complete(sys, user));
    const MAX = 100;
    const dims = {};
    let total = 0;
    for (const [key, max] of Object.entries(weights)) {
      const s = out.dimension_scores?.[key]?.score;
      const v = Number.isFinite(s) ? clamp01(s / Math.max(1, max)) * max : max * 0.5;
      const sc = Math.round(Math.max(0, Math.min(max, v)));
      dims[key] = { score: sc, max, detail: out.dimension_scores?.[key]?.detail ?? '' };
      total += sc;
    }
    // 归一化到 0-100：以总权重为满分的百分比
    const weightSum = Object.values(weights).reduce((a, b) => a + (b || 0), 0) || 100;
    const overallScore = clampInt((total / weightSum) * 100);
    return { overallScore, dimensionScores: dims, evidence: (out.points ?? []).join('；'), meta: { engine: 'llm', scoredAt: new Date().toISOString() } };
  }
}

// 离线启发式（确定性）：从 项目深度/技能广度/经验层级/履历质量/自驱信号 五维子分（0-1）× 权重 加权，归一到 0-100
export function heuristicOverall(resumeParsed, resumeText, weights = OVERALL_WEIGHTS) {
  const ps = resumeParsed ?? {};
  const edu = ps.education ?? {};
  const skills = Array.isArray(ps.skills) ? ps.skills : [];
  const projects = Array.isArray(ps.projects) ? ps.projects.filter(nonEmpty) : [];
  const experiences = Array.isArray(ps.experiences) ? ps.experiences.filter(nonEmpty) : [];
  const raw = String(resumeText ?? '') + ' ' + (ps.rawText ?? '') + ' ' + projectsText(projects) + ' ' + experiencesText(experiences);

  const dims = {
    project_depth: clamp01(0.25 + 0.2 * Math.min(3, projects.length) + (hasLongContent(projects) ? 0.12 : 0)),
    skill_breadth: skillSub(skills, raw),
    exp_level: expSub(ps, experiences, raw),
    resume_quality: qualitySub(edu, experiences),
    self_drive: selfDriveSub(raw),
  };
  const w = { ...OVERALL_WEIGHTS, ...weights };
  const weightSum = Object.values(w).reduce((a, b) => a + (b || 0), 0) || 100;
  let total = 0;
  const dimensionScores = {};
  for (const [key, sub] of Object.entries(dims)) {
    const max = Math.max(0, Number(w[key]) || 0);
    const sc = Math.round(sub * max);
    dimensionScores[key] = { score: sc, max, detail: dimDetail(key, sub, { skills, projects, experiences, edu }) };
    total += sc;
  }
  const overallScore = clampInt((total / weightSum) * 100);
  const evidence = dimEvidence(dims, dimensionScores);
  return { overallScore, dimensionScores, evidence, meta: { engine: 'heuristic', scoredAt: new Date().toISOString() } };
}

function nonEmpty(o) { return o && JSON.stringify(o) !== '{}' && Object.keys(o).length > 0; }
function textLen(v) { const t = typeof v === 'string' ? v : (v && typeof v === 'object' ? findLongest(v) : String(v ?? '')); return (t || '').length; }
function findLongest(obj) { let s = 0; for (const k in obj) { if (obj[k] != null) s += String(obj[k]).length; } return s; }
function projectsText(p) { return p.map((x) => JSON.stringify(x)).join(' '); }
function experiencesText(e) { return e.map((x) => JSON.stringify(x)).join(' '); }
function hasLongContent(list) { return list.some((x) => textLen(x) >= 40); }

function skillSub(skills, raw) {
  if (skills.length >= 6) return 0.85;
  if (skills.length >= 3) return 0.6;
  if (skills.length >= 1) return 0.4;
  return /\b(技能|掌握|熟悉|精通)\b|:[,，]/.test(raw) ? 0.35 : 0.2;
}

function expSub(ps, experiences, raw) {
  const years = Number(ps.workExperienceYears ?? ps.experienceYears) || 0;
  let y = 0;
  if (years > 0) y = Math.min(0.9, 0.25 + 0.05 * Math.min(12, years));
  else y = Math.min(0.8, 0.15 + 0.1 * Math.min(5, experiences.length));
  // 带团队/带项目层级加成
  const leadRe = /负责人|主管|经理|总监|带头人|团队|lead|leader|director|manager|架构|核心成员|owner/i;
  if (leadRe.test(raw)) y = Math.min(0.98, y + 0.12);
  return y;
}

function qualitySub(edu, experiences) {
  const rank = (d) => (String(d).includes('博士') ? 4 : String(d).includes('硕士') ? 3 : String(d).includes('本科') || String(d).includes('学士') ? 2 : String(d).includes('专科') || String(d).includes('大专') ? 1 : 0);
  const deg = rank(edu.degree ?? '');
  const n = Math.min(3, experiences.length);
  // 履历覆盖度：学历/经历 双重信息提升
  const info = (deg > 0 ? 0.2 : 0.05) + (n > 0 ? 0.2 + 0.06 * n : 0.08);
  // 稳定性信号：经历较少但信息完整较好；同源加分收敛
  return clamp01(deg / 4 * 0.5 + Math.min(0.5, info));
}

function selfDriveSub(raw) {
  const signals = ['开源', 'open source', 'github', '博客', 'blog', '原创', '专利', '获奖', '竞赛', '晋升', '证书', '认证', '社区', '分享', '作品', '副业', '作品集', 'hall of fame', 'gitee', '公众号'];
  let hit = 0;
  for (const s of signals) if (raw.toLowerCase().includes(s.toLowerCase())) hit++;
  if (hit >= 3) return 0.9;
  if (hit === 2) return 0.7;
  if (hit === 1) return 0.5;
  return 0.2;
}

function dimDetail(key, sub, ctx) {
  switch (key) {
    case 'project_depth': return `主导/核心项目 ${ctx.projects.length} 个${ctx.projects.length ? '（`hasLongContent`:细节充分→更高）' : '，未含项目'} → ${Math.round(sub * 100)}%`;
    case 'skill_breadth': return `技能 ${ctx.skills.length} 项 → ${Math.round(sub * 100)}%`;
    case 'exp_level': return `经验年限/团队层级 → ${Math.round(sub * 100)}%`;
    case 'resume_quality': return `学历 ${ctx.edu.degree ?? '未标注'} / 经历 ${ctx.experiences.length} 段 → ${Math.round(sub * 100)}%`;
    case 'self_drive': return `自驱信号（开源/竞赛/晋升等）→ ${Math.round(sub * 100)}%`;
    default: return '';
  }
}
function dimEvidence(dims, dimensionScores) {
  const strong = Object.entries(dims).filter(([, s]) => s >= 0.6).map(([k]) => k);
  const weak = Object.entries(dims).filter(([, s]) => s < 0.35).map(([k]) => k);
  return [
    strong.length ? `突出：${strong.join('、')}` : '',
    weak.length ? `偏弱：${weak.join('、')}` : '',
    `加权总分 ${Object.values(dimensionScores).reduce((a, d) => a + d.score, 0)}`,
  ].filter(Boolean).join('；');
}