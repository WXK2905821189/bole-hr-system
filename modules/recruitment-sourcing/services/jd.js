// 招聘服务：JD 解析（复用 JD_PARSE_SYSTEM，含离线启发式兜底）
import { JD_PARSE_SYSTEM } from './prompts.js';
import { extractJson } from './llm.js';

const DIM = ['hard_skills', 'soft_skills', 'core_duties', 'keywords'];

export class JdService {
  constructor({ llm, validate, store }) {
    this.llm = llm;
    this.validate = validate;
    this.store = store;
  }

  async parse(jdRaw, { jobId, jobTitle, recruiterId, engine = 'llm' } = {}) {
    const structured = await this.#byLlm(jdRaw);
    const job = {
      jobId,
      jobTitle: structured.position || jobTitle || '未命名岗位',
      recruiterId: recruiterId || 'A1',
      status: 'open',
      jdRaw,
      parsedKeywords: structured.keywords ?? [],
      hardSkills: structured.hard_skills ?? [],
      softSkills: structured.soft_skills ?? [],
      meta: { createdAt: new Date().toISOString() },
    };
    this.validate.assertValid('job', job);
    await this.store.write('jobs.jsonl', job);
    return job;
  }

  async #byLlm(jdRaw) {
    if (this.llm.ready) {
      const raw = await this.llm.complete(JD_PARSE_SYSTEM, jdRaw);
      const r = extractJson(raw);
      if (r.position || r.hard_skills?.length) return r;
    }
    // 离线兜底：启发式提取
    const STOPWORDS = new Set(['招聘','熟练','负责','熟悉','拥有','具备','从事','相关','工作','能力','经验','要求','开发','工程师','以上','优先']);
    const kw = (text) => [...new Set((text.match(/[A-Za-z+#]+|\p{Script=Han}+(?=[，。、;；\s])/gu) ?? [])
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w)))];
    return {
      company: '',
      position: jdRaw.match(/(?:招聘|诚聘|急招)\s*([\u4e00-\u9fa5A-Za-z0-9+]+?)(?:：|:|，|。|$)/)?.[1] ?? '',
      hard_skills: kw(jdRaw).slice(0, 8),
      soft_skills: [],
      core_duties: [],
      keywords: kw(jdRaw).slice(0, 8),
      industry: '通用',
    };
  }
}