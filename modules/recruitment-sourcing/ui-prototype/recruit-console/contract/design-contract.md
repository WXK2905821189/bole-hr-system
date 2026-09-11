# Design Contract — 招聘提效模块「候选人寻源与控制台」

> 对应需求：招聘提效模块 MVP（AI HR 系统首个业务模块）
> 技术栈：**vanilla HTML/CSS/JS · pure-static**（离线可开、零 CDN、无构建链，匹配"内网私有/最小权限"）
> 交付形态：单入口 SPA（hash 路由切换视图），共享一个应用外壳与导航，杜绝导航漂移

## 1. Style Tier & Aesthetic Direction
- style: `business-international`（管理/数据密集型 SaaS 基调）
- aesthetic: **precision-operations**（精密运营台）——克制、高信息密度、间距有节奏；品牌蓝为主色、中性暖灰为辅、单一橙色用于风控告警
- tone keywords: 沉稳 / 克制 / 高信息密度 / 有序
- motion: 视图切入错峰 reveal（staggered）+ 行 hover 高亮 + 抽屉/表格抽屉过渡；全部 CSS-only，尊重 prefers-reduced-motion

## 2. Design Tokens
```
color.primary:      #2f54eb   primary-hover: #1f3bb0   primary-soft: #eef2ff
color.bg:           #eef1f6   canvas: #f7f9fc   surface: #ffffff
color.border:       #e6e9f0   border-strong: #d6dbe6
color.text:         #1b1f27   text-sub: #5b6b84   text-faint: #98a5bd
color.success: #16803c / bg #e6f6ec
color.warning: #b45309 / bg #fbf3e2
color.danger:  #c0392b / bg #fdecec
color.info:    #2563eb / bg #eef4ff
sidebar: bg linear-gradient(#101a33,#0c1226), text #c7d2ea, muted #7f8db5
font.display: "PingFang SC","Microsoft YaHei",system-ui (weight 600/700 作展示层级，无外部字体)
font.body:    "PingFang SC","Microsoft YaHei","Segoe UI",system-ui
font.mono:    ui-monospace,"SF Mono",Consolas,"Cascadia Code",Menlo,monospace
font.scale:   11 / 12 / 13 / 14 / 15 / 17 / 20 / 24 / 27 (px)
radius:       sm 6 / md 9 / lg 12 (px)
shadow:       sm 0 1px 2px rgba(16,24,40,.05) / md 0 6px 20px rgba(16,24,40,.09) / lg 0 12px 30px rgba(16,24,40,.14)
spacing.unit: 4px base (4/8/12/16/20/24/32/40)
layout:       内容区 max-width 1200px；sidebar 定宽 232px（固定定位，内容区 margin-left:232px）
icon.lib:     Lucide（内联 SVG，stroke 2，size 16/20/24，color currentColor）——离线必需，禁止 CDN
bg-texture:   内容画布轻微 top 线性渐变 + 卡片纯白；侧栏深色渐变；网格分隔线保持 1px
```

## 3. Component Spec
- **button**: primary(品牌蓝实底) / ghost(白底蓝字描边) / sm(紧凑)；hover 加深、active 微下沉、disabled 半透明+not-allowed
- **input/select/textarea**: 1px 边框，聚焦品牌蓝 ring(3px/12%)，圆角 8
- **card**: 白底 1px 边框，圆角 10，轻 sm 阴影；card-hd 含标题+右键区
- **table**: 表头 #f8fafc 小灰字、行 hover 浅蓝、行点击选中态 inset 3px 品牌蓝；td 垂直居中
- **seg(keyword chips)**: 浅蓝底 chips，可增删，add 虚线态
- **nav-sidebar**: 固定左侧、logo(聘)、navsec 分组、.active 品牌蓝底白字、风控护栏提示卡片、账号脚部
- **status badge**: 圆角胶囊，语义色底+深文，前置 5px 圆点
- **match score**: 条形进度+数字，>70 绿 /50-70 橙 /<50 红 /null 灰
- **drawer**: 右侧 460px 抽屉，遮罩淡入、内容卡片化；**modal**(新增岗位)居中
- **empty state / loading skeleton**: 均有实现分支

## 4. App Shell + Canonical Nav（固定，不得改）
- shell: `<body data-page="..."><aside class="app-nav">…固定导航…</aside><main class="app-content">…仅内容区变化…</main></body>`
- nav items（顺序固化）：运营总览 dashboard / 岗位与JD jobs / 采集调度 schedule / 候选人库 candidates(+badge 12) | 审计留痕 audit / 准入与护栏 settings
- positioning: `aside{position:fixed;inset:0 auto 0 0;width:232px} main{margin-left:232px}`
- active rule: `body[data-page=§]` 由 `nav-active.js` 映射，给对应 `<button data-nav>` 加 `.active`
- 导航注入采用内联 HTML（零 JS 依赖），只在 app.js 中设置 active 类

## 5. Page List（SPA 视图，同一外壳，仅内容槽变化）
| 视图 key | 责任 | 关键组件 | 导航 |
|---|---|---|---|
| dashboard | 运营总览 | KPI ×4、采集流水线、入库质量环形、Top候选人表 | 全站 |
| jobs | 岗位/JD 关键词 | 岗位卡片网格 + 新增岗位 modal(JD→关键词预览) | 依赖 candidates/schedule |
| schedule | 采集调度 | 配置表单 + 护栏 chips + 运行日志终端 + 立即运行 | 触发后去 candidates |
| candidates | 候选人库 | 筛选 seg + 搜索 + 分页表格 + 抽箱详情 | 抽屉 |
| audit | 审计留痕 | 类型筛选 + 条目流 | 静态 |
| settings | 准入与护栏 | 账号接入 + 权限/留存策略 | 保存→toast |

## 6. Mock Schema（mock.js 单一数据源）
```
jobs:      {id, jobId, title, status, round, todayQuota, keywords[], lastRun}
candidates:{id, name, source, workYears, skills[], salary, status, matchScore}
matches:   {candidateId, score, evidence}
resumes:   {candidateId, school, degree, company, role, tenure, phone(脱敏), email(脱敏), confidence}
cycles:    {id, jobId, at, status}
audit:     {id, action, target, actor, ts, type}
accounts:  {id, name, status, used, limit, note}
```

## 7. API 桩（api.js — 签名即未来真实接口）
```
// GET /api/overview   → {kpis, pipeline, quality}
// GET /api/jobs       → {jobs}
// POST /api/jobs      → job 创建（含关键词解析演示）
// GET /api/candidates → {list,total}  (query: status?, q?, page, pageSize)
// POST /api/schedule/run → {jobId}  立即运行（写入日志）
// GET /api/schedule/log → {lines}
// POST /api/export/candidates → {processed}  // 导出走审批留痕
// GET /api/audit      → {items}
// POST /api/settings  → {ok}
// POST /api/detail/decrypt → 脱敏字段解密演示（mock）
所有桩含 delay() 模拟延迟 + `// TODO: replace with fetch(...)` 集成点标注
```