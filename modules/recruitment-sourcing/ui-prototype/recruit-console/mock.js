/* mock.js — 单一数据源：所有视图读取此数据，跨页保持一致 */
export const DB = {
  jobs: [
    { id: 1, jobId: "frontend_01", title: "前端工程师", status: "active", round: 128, todayQuota: 46,
      keywords: ["Vue3", "TypeScript", "Node.js", "性能优化", "微前端"], lastRun: "17:00 · 今天" },
    { id: 2, jobId: "backend_01", title: "后端工程师", status: "active", round: 96, todayQuota: 32,
      keywords: ["Java", "Go", "MySQL", "Redis", "微服务"], lastRun: "14:00 · 今天" },
    { id: 3, jobId: "data_01", title: "数据分析师", status: "idle", round: 41, todayQuota: 12,
      keywords: ["Python", "SQL", "Tableau", "AB测试"], lastRun: "昨天" },
  ],
  candidates: [
    { id: "cand_09271", name: "陈亦凡", source: "BOSS", workYears: 5, skills: ["Vue3", "TypeScript", "Node.js"], salary: "28–35k", status: "matched", matchScore: 82 },
    { id: "cand_09270", name: "刘思远", source: "BOSS", workYears: 3, skills: ["React", "Next.js"], salary: "20–26k", status: "parsed", matchScore: 68 },
    { id: "cand_09268", name: "赵子昂", source: "BOSS", workYears: 6, skills: ["Java", "Spring", "MySQL"], salary: "35–45k", status: "matched", matchScore: 91 },
    { id: "cand_09266", name: "孙晓彤", source: "BOSS", workYears: 2, skills: ["Go", "K8s"], salary: "18–24k", status: "pending", matchScore: 52 },
    { id: "cand_09264", name: "周明轩", source: "BOSS", workYears: 4, skills: ["Python", "RAG", "AI"], salary: "30–38k", status: "matched", matchScore: 88 },
    { id: "cand_09260", name: "吴曼青", source: "BOSS", workYears: 1, skills: ["HTML", "CSS"], salary: "12–16k", status: "failed", matchScore: null },
    { id: "cand_09258", name: "郑宇", source: "BOSS", workYears: 7, skills: ["架构", "分布式"], salary: "40–55k", status: "matched", matchScore: 76 },
    { id: "cand_09250", name: "冯嘉怡", source: "BOSS", workYears: 3, skills: ["Vue2", "Element", "ECharts"], salary: "20–26k", status: "parsed", matchScore: 71 },
    { id: "cand_09247", name: "何立伟", source: "BOSS", workYears: 5, skills: ["Node", "Koa", "Mongo"], salary: "26–34k", status: "pending", matchScore: 64 },
    { id: "cand_09245", name: "许文静", source: "BOSS", workYears: 4, skills: ["React", "D3", "数据可视化"], salary: "28–36k", status: "matched", matchScore: 85 },
    { id: "cand_09242", name: "林一诺", source: "BOSS", workYears: 3, skills: ["Java", "SpringBoot", "MQ"], salary: "22–28k", status: "parsed", matchScore: 74 },
    { id: "cand_09238", name: "沈慕晴", source: "BOSS", workYears: 8, skills: ["前端架构", "工程化"], salary: "45–60k", status: "matched", matchScore: 79 },
  ],
  matches: {
    cand_09271: { score: 82, evidence: "Vue3·Node·微前端，与 JD 高度吻合" },
    cand_09268: { score: 91, evidence: "Java·Spring·MySQL 全栈匹配" },
    cand_09264: { score: 88, evidence: "AI/Python 经验匹配数据岗" },
    cand_09245: { score: 85, evidence: "React·可视化，强相关" },
    cand_09258: { score: 76, evidence: "分布式架构背景，年限充裕" },
    cand_09242: { score: 74, evidence: "Java 栈基础扎实" },
    cand_09250: { score: 71, evidence: "Vue2→Vue3 可迁移" },
    cand_09270: { score: 68, evidence: "React 栈，前端转岗可能" },
    cand_09247: { score: 64, evidence: "Node 后端经验，部分相关" },
    cand_09266: { score: 52, evidence: "Go/K8s 与 JD 部分重叠" },
  },
  resumes: {
    cand_09271: { school: "武汉大学", degree: "本科", company: "某云计算", role: "高级前端", tenure: "2021–今", phone: "138****7210", email: "chen**@outlook.com", confidence: 0.94 },
    cand_09268: { school: "华中科技大学", degree: "硕士", company: "某金融科技", role: "技术专家", tenure: "2018–今", phone: "139****1502", email: "zhao**@163.com", confidence: 0.96 },
    cand_09264: { school: "浙大", degree: "硕士", company: "某 AI 公司", role: "算法工程师", tenure: "2020–今", phone: "186****8841", email: "zhou**@gmail.com", confidence: 0.91 },
  },
  cycles: [
    { id: 128, jobId: "frontend_01", at: "今天 09:00", status: "success" },
    { id: 127, jobId: "frontend_01", at: "今天 09:00", status: "success" },
    { id: 126, jobId: "backend_01", at: "昨天 14:00", status: "success" },
  ],
  audit: [
    { id: "a2001", action: "导出候选人清单", target: "export_candidates_0909.csv", actor: "赵经理·批准", ts: "09:32", type: "export" },
    { id: "a2000", action: "采集运行", target: "round #128 · frontend_01", actor: "系统调度", ts: "09:00", type: "collect" },
    { id: "a1999", action: "访问简历详情 · 脱敏字段解密", target: "cand_09271", actor: "王女士", ts: "08:47", type: "access" },
    { id: "a1998", action: "账号状态变更 → 冷却", target: "账号 B2", actor: "系统触发", ts: "08:31", type: "access" },
    { id: "a1997", action: "关键词人工微调", target: "frontend_01 · +vue3", actor: "王女士", ts: "08:20", type: "collect" },
    { id: "a1996", action: "上传岗位 JD", target: "data_01 · 数据分析师", actor: "王女士", ts: "前一天", type: "collect" },
  ],
  accounts: [
    { id: "A1", name: "BOSS 主账号", status: "active", used: 46, limit: 200, note: "会话隔离" },
    { id: "B2", name: "BOSS 备用账号", status: "cooling", used: 80, limit: 200, note: "冷却中 · 10:05 恢复" },
  ],
  /* 触达状态中枢：st=待跟 pending / 跟进中 engaging / 已回复 replied / 沉睡 sleeping；round=已触轮次；read=最近已读；ver=当前话术版本 */
  touchMeta: {
    cand_09271: { st: "replied", round: 2, read: true, ver: "岗位邀约 · v3" },
    cand_09270: { st: "engaging", round: 1, read: true, ver: "初筛 · v2" },
    cand_09268: { st: "replied", round: 3, read: true, ver: "深度跟进 · v4" },
    cand_09266: { st: "pending", round: 0, read: false, ver: "—" },
    cand_09264: { st: "replied", round: 2, read: true, ver: "岗位邀约 · v3" },
    cand_09260: { st: "sleeping", round: 2, read: false, ver: "唤醒 · v5" },
    cand_09258: { st: "engaging", round: 1, read: true, ver: "初筛 · v2" },
    cand_09250: { st: "pending", round: 0, read: false, ver: "—" },
    cand_09247: { st: "engaging", round: 1, read: true, ver: "话题延伸 · v1" },
    cand_09245: { st: "replied", round: 2, read: true, ver: "岗位邀约 · v3" },
    cand_09242: { st: "pending", round: 0, read: false, ver: "—" },
    cand_09238: { st: "sleeping", round: 4, read: false, ver: "保活 · v6" },
  },
  /* 沟通时间线：dir = out 已发出 / in 收到；read = 对方是否已读；ver = 使用话术版本 */
  timelines: {
    cand_09271: [
      { ts: "今天 10:12", ch: "打招呼", dir: "out", read: true, ver: "岗位邀约 · v3", body: "您好，您在 Vue3 / Node 方面的经验与我们前端岗高度匹配，方便交换一份简历推进后续吗？" },
      { ts: "今天 09:41", ch: "打招呼", dir: "out", read: true, ver: "初筛 · v2", body: "您好，刚看到您的技术背景非常认可，想了解您近期有无换工作的意向～" },
      { ts: "昨天 16:20", ch: "收消息", dir: "in", read: true, ver: "—", body: "您好，收到，方便的话可以发我详细 JD 看看。" },
      { ts: "昨天 15:58", ch: "打招呼", dir: "out", read: true, ver: "初筛 · v2", body: "您好，我们在招聘前端工程师，看您的项目经验很契合，有意向聊聊吗？" },
    ],
    cand_09268: [
      { ts: "今天 09:12", ch: "打招呼", dir: "out", read: true, ver: "深度跟进 · v4", body: "您好，上次沟通后我们内部确认了技术栈，您之前的 Java / 分布式背景完全匹配，想看下简历。" },
      { ts: "昨天 11:30", ch: "收消息", dir: "in", read: true, ver: "—", body: "可以呀，回头方便加个微信直接聊。" },
      { ts: "昨天 11:02", ch: "打招呼", dir: "out", read: true, ver: "岗位邀约 · v3", body: "向您详细介绍一下岗位职责与团队情况，方便判断下匹配度？" },
    ],
    cand_09260: [
      { ts: "前天 09:30", ch: "打招呼", dir: "out", read: false, ver: "唤醒 · v5", body: "您好，看到您有前端基础，近期是否考虑新的机会？" },
      { ts: "4天前 14:10", ch: "打招呼", dir: "out", read: true, ver: "初筛 · v2", body: "您好，不知您对初级前端岗是否感兴趣？" },
    ],
    cand_09245: [
      { ts: "今天 08:50", ch: "收消息", dir: "in", read: true, ver: "—", body: "好的，我把简历更新一下发您。" },
      { ts: "今天 08:31", ch: "打招呼", dir: "out", read: true, ver: "岗位邀约 · v3", body: "您的数据可视化经验很亮眼，想邀请您进入岗位池，方便发份最新简历吗？" },
    ],
  },
  /* 触达沟通工作台（对齐实际系统 engage 视图） */
  engage: {
    threshold: 60,
    msgTiers: [
      { label: "初次打招呼", ver: "初筛 · v2", desc: "匹配达标即发送当前生效「初次」话术", text: "您好，看到您在 Vue3 / Node 方面的经验与我们前端岗高度匹配，方便交换一份简历推进后续吗？", used: 68 },
      { label: "二次激活", ver: "激活 · v3", desc: "未读 ≥1 天 · 隔天二次提醒", text: "再次打扰啦~ 昨天给您发过一条消息，如果近期在考虑新机会，欢迎回复我～", used: 31 },
      { label: "三次及以上", ver: "保活 · v4", desc: "已读未回复 · 降周频保活", text: "您好，还想跟您同步下我们团队的近况，方便的话随时聊～", used: 9 },
    ],
    egAuto: [
      { name: "陈亦凡", score: 82, job: "前端工程师", st: "done" },
      { name: "赵子昂", score: 91, job: "后端工程师", st: "done" },
      { name: "周明轩", score: 88, job: "数据分析师", st: "todo" },
      { name: "郑宇", score: 76, job: "后端工程师", st: "todo" },
    ],
    fups: [
      { name: "刘思远", track: "未读", round: 2, mode: "3–8s 间隔", next: "今天 15:00", st: "engaging" },
      { name: "郑宇", track: "已读", round: 1, mode: "降频保活", next: "明天 09:30", st: "engaging" },
      { name: "何立伟", track: "未读", round: 1, mode: "二次激活", next: "今天 17:00", st: "engaging" },
      { name: "沈慕晴", track: "已读", round: 4, mode: "降周频", next: "—", st: "sleeping" },
    ],
    pendingRes: [
      { name: "孙晓彤", job: "数据分析师", reason: "附件格式无法解析", action: "人工处理" },
      { name: "吴曼青", job: "前端工程师", reason: "疑似重复简历", action: "人工核对" },
    ],
    hrContact: "HR 小王 139-0000-1111（BOSS 站内信）",
    campaigns: [
      { id: "CG-1031", mode: "全部职位 · 顺序", jobs: "前端 ↣ 后端 ↣ 数据", quota: "各 20", status: "run", progress: 62, at: "09:30" },
      { id: "CG-1030", mode: "指定职位 · 自定义额度", jobs: "前端工程师", quota: "15", status: "ok", progress: 100, at: "昨天 14:00" },
    ],
    notify: [
      { ts: "09:12", text: "批次 CG-1031 ·「后端工程师」已到额 20 → 自动切换「数据分析师」" },
      { ts: "昨天 18:40", text: "批次 CG-1030 已遍历完成 · 共打招呼 15 人 · 待你复核复盘" },
    ],
    metrics: {
      rows: [
        { job: "前端工程师", greet: 68, read: 47, respRate: 54, convRate: 12, sleep: 3 },
        { job: "后端工程师", greet: 54, read: 41, respRate: 46, convRate: 9, sleep: 2 },
        { job: "数据分析师", greet: 31, read: 20, respRate: 39, convRate: 7, sleep: 1 },
      ],
      totals: { greet: 153, read: 108, resp: "48%", conv: "9%", sleep: 6 },
    },
    engageAudit: [
      { act: "自动打招呼", target: "陈亦凡 · 前端工程师", who: "系统", ts: "09:18", ver: "初筛 · v2", res: "已发送" },
      { act: "二次激活", target: "刘思远 · 前端工程师", who: "系统", ts: "08:56", ver: "激活 · v3", res: "已发送" },
      { act: "同意收取简历", target: "孙晓彤 · 数据分析师", who: "系统", ts: "08:41", ver: "—", res: "已解析" },
      { act: "交换联系方式", target: "吴曼青 · 前端工程师", who: "王女士", ts: "昨天 16:20", ver: "交换 · v1", res: "已发送" },
    ],
  },
};