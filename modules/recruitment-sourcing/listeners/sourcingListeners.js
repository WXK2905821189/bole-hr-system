// 事件订阅：候选人 sourced → 解析简历 → 加载 JD → 匹配打分
function buildFallbackText(c) {
  return `候选人简历：姓名 ${c.name ?? '候选人'}，来源 ${c.source}，工作年限 ${c.workExperienceYears ?? '待定'}，
技能：${(c.skills ?? []).join('、') || '未标注'}。期望薪资 ${c.salaryExpected ?? '面议'}。`;
}

export class SourcingListeners {
  constructor({ services, domain, bus }) {
    this.services = services;
    this.domain = domain ?? null;
    this.bus = bus ?? null;
  }

  async onCandidateSourced(_evt, { payload }) {
    // 优先使用真实简历文本（Python 采集适配器经 storageRef/rawText 提供）；
    // 无则用候选基础字段兜底生成文本，保证链路不断。
    const rawText =
      payload.rawText ||
      payload.resume?.rawText ||
      buildFallbackText(payload);
    return await this.services.parser.parse({
      resumeId: `res_${payload.candidateId}`,
      candidateId: payload.candidateId,
      jobId: payload.jobId,
      rawText,
      format: payload.resume?.format ?? 'text',
    });
  }

  async onResumeParsed(_evt, { payload }) {
    const job = (this.services.store.readAll('jobs.jsonl') ?? []).find((j) => j.jobId === payload.jobId) ?? null;
    const recruiterId = job?.recruiterId || 'A1';

    // F-2（PRD FR-3 联动②升级）：简历已解析但缺联系方式 → 自动发送「交换联系方式」话术（附我方联系方式，受护栏节流）
    if (this.domain && !payload.parsed?.contact?.phone) {
      await this.domain.requestExchangeContact(payload.candidateId, recruiterId);
    }

    const match = await this.services.matcher.match({
      candidateId: payload.candidateId,
      jobId: payload.jobId,
      jobParsed: {
        hard_skills: job?.hardSkills ?? [],
        soft_skills: job?.softSkills ?? [],
        core_duties: [],
        keywords: job?.parsedKeywords ?? [],
      },
      resumeParsed: payload.parsed,
    });

    // B-2 自动打招呼：匹配打分完成即广播 match.score，达标候选由领域自动发送初次打招呼
    await this.bus?.emit('match.score', { candidateId: payload.candidateId, jobId: payload.jobId, matchScore: match.matchScore, recruiterId }, { actor: 'system' });
    return match;
  }

  // B-2：匹配达标 → 自动打招呼（取当前生效「初次」话术，进入待跟进；已打/沉睡跳过）
  async onMatchScore(_evt, { payload }) {
    if (!this.domain) return { skipped: 'no_domain' };
    return await this.domain.autoGreetQualified(payload);
  }

  // F-4：打招呼批次结束 → 提醒 HR（应用内通知 + 审计留痕）
  async onCampaignFinished(_evt, { payload }) {
    const notify = this.services.notify;
    if (!notify) return { skipped: 'no_notify' };
    const c = payload?.campaign;
    const totalGreeted = (c?.jobs ?? []).reduce((n, j) => n + (j.greeted ?? 0), 0);
    notify.push({
      type: 'campaign_finished',
      title: `打招呼批次已结束：${c?.campaignId ?? ''}`,
      body: `模式 ${c?.mode ?? ''} · 覆盖 ${(c?.jobs ?? []).length} 个职位 · 共打招呼 ${totalGreeted} 人。批次已${payload?.reason === 'paused' ? '暂停（护栏拦截）' : '完成'}，可前往「触达沟通 → 数据复盘」查看明细。`,
      data: { campaignId: c?.campaignId, totalGreeted },
    });
    return { notified: true, campaignId: c?.campaignId };
  }
}