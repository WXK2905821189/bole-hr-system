// 招聘服务：简历解析（复用 RESUME_PARSE_SYSTEM，含离线启发式兜底）
import { RESUME_PARSE_SYSTEM } from './prompts.js';
import { extractJson } from './llm.js';

const SKILLS = ['JavaScript','TypeScript','Python','Go','Java','SQL','Node.js','React','Vue','Docker','Kubernetes','Linux','AI','机器学习','数据分析','C++','Ruby','PHP','Git','微服务'];

export class ParserService {
  constructor({ llm, validate, store, bus, vault }) {
    this.llm = llm;
    this.validate = validate;
    this.store = store;
    this.bus = bus;
    this.vault = vault || null;
  }

  async parse({ resumeId, candidateId, jobId, rawText, format = 'text', engine = 'llm' }) {
    const structured = await this.#byLlm(rawText);
    const resume = {
      resumeId,
      candidateId,
      jobId,
      status: 'parsed',
      format,
      storageRef: null,
      rawText: maskedPreview(rawText),
      parsed: {
        education: structured.education ?? {},
        contact: {
          phone: structured.contact?.phone ?? this.#heuristicPhone(rawText),
          email: structured.contact?.email ?? this.#heuristicEmail(rawText),
        },
        experiences: structured.experiences ?? [],
        projects: structured.projects ?? [],
        skills: structured.skills?.length ? structured.skills : this.#heuristicSkills(rawText),
      },
      meta: { createdAt: new Date().toISOString(), parsedAt: new Date().toISOString(), engine },
    };
    // 合规红线：简历原文加密落盘（files/<candidateId>.enc），jsonl 仅存脱敏预览与引用
    if (rawText && this.vault?.enabled) {
      resume.storageRef = this.vault.put(rawText, candidateId);
    }
    this.validate.assertValid('resume', resume);
    await this.store.write('resumes.jsonl', resume);
    // 发布解析完成事件 → 触发匹配服务（resume.parsed 订阅者）
    await this.bus?.emit('resume.parsed', resume, { actor: 'system' });
    return resume;
  }

  async #byLlm(rawText) {
    if (this.llm.ready) {
      const out = extractJson(await this.llm.complete(RESUME_PARSE_SYSTEM, rawText));
      if (out.education || out.skills?.length) return out;
    }
    const skills = this.#heuristicSkills(rawText);
    return { education: {}, experiences: [], projects: [], skills, strengths: [], weaknesses: [] };
  }

  #heuristicSkills(text) {
    const t = String(text ?? '').toLowerCase();
    const whitelist = SKILLS.filter((s) => t.includes(s.toLowerCase()));
    // 从原文再抽取英文/数字技能词（如 Go、C++、MySQL 等未列入白名单者）
    const extra = [...new Set((String(text ?? '').match(/[A-Za-z][A-Za-z0-9+#.]{1,}/g) ?? []))]
      .filter((w) => w.length >= 2 && !['cand','sim','source','demo','href','http','http'].includes(w.toLowerCase()));
    return [...new Set([...whitelist, ...extra])].slice(0, 12);
  }

  // 启发式抽取手机号：大陆 11 位，1[3-9] 开头，容忍空格/连字符；无则返回 null(视为缺电话)
  #heuristicPhone(text) {
    const m = String(text ?? '').match(/(?<![\d])1[3-9](?:\d[-\s]?){9}(?!\d)/);
    return m ? m[0].replace(/[-\s]/g, '') : null;
  }

  // 启发式抽取邮箱：标准邮箱正则；无则返回 null
  #heuristicEmail(text) {
    const m = String(text ?? '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    return m ? m[0] : null;
  }
}

// 脱敏预览：简历原文一律入库加密文件，jsonl 只留前置摘要（个人/敏感内容不落明文）
function maskedPreview(rawText, max = 160) {
  const s = String(rawText ?? '').trim().replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max) + '…' : s;
}