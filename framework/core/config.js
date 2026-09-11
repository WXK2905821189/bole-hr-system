export function cfg(overrides = {}) {
  return {
    storeDir: overrides.storeDir ?? 'infra/store',
    filesDir: overrides.filesDir ?? 'infra/files',
    ports: { gateway: overrides.gatewayPort ?? 0 },
    llm: overrides.llm ?? {},
    auth: overrides.auth ?? {},
    safety: overrides.safety ?? {},
    engage: {
      autoGreetThreshold: overrides.engage?.autoGreetThreshold ?? 60, // 匹配分达标即自动打招呼
      dailyFollowUpIntervalDays: overrides.engage?.dailyFollowUpIntervalDays ?? 1, // 未读/已读未回复：隔 1 天重发
      weeklyFollowUpIntervalDays: overrides.engage?.weeklyFollowUpIntervalDays ?? 7, // 累计 >=5 次后降为周频
      weeklyAfterTouches: overrides.engage?.weeklyAfterTouches ?? 5, // 触发周频的触达次数阈值
      sleepAfterDays: overrides.engage?.sleepAfterDays ?? 30, // 满 1 月未读/未回复 → 置沉睡
      followSweepMinutes: overrides.engage?.followSweepMinutes ?? 1, // 跟进扫描周期(分钟)
      placeholder: overrides.engage?.placeholder ?? '[岗位]',
      hrContact: overrides.engage?.hrContact ?? '138-0000-0000（BOSS 站内信）', // F-2 交换话术附的我方联系方式
      defaultJobQuota: overrides.engage?.defaultJobQuota ?? 20, // F-3 批次各职位默认打招呼额度
    },
  };
}