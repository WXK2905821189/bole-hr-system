# 端点映射 · 页面 → 桩函数 → API 端点

> 目标：后端团队据此看清「哪个界面调用哪个接口」。每个桩函数与 openapi.yaml 中的 operationId 一一对应。

| 界面（app.js 视图） | 桩函数（api.js） | 端点 | 说明 |
|---|---|---|---|
| dashboard · 运营总览 | `fetchOverview` | `GET /api/overview` | KPI、流水线、入库质量、Top 匹配候选人 |
| jobs · 岗位/JD | `fetchJobs` | `GET /api/jobs` | 岗位列表渲染 |
| jobs · 新增岗位模态 | `createJob` | `POST /api/jobs` | 创建岗位并返回 JD 解析关键词 |
| schedule · 采集调度 | `runCollect` | `POST /api/schedule/run` | 「立即运行」→ 返回日志行追加到终端 |
| candidates · 候选人库 | `fetchCandidates` | `GET /api/candidates` | 状态筛选 + 搜索 + 分页 |
| candidates · 导出按钮 | `exportCandidates` | `POST /api/export/candidates` | 导出进审批队列（留痕） |
| candidates · 抽屉详情 | （直读 mock `DB.matches/resumes`） | `GET /api/candidates/{id}`+`GET /api/resumes/{candidateId}` | 详情所需数据（原型内联在 mock，真实后端建议单独资源） |
| candidates · 抽屉解密 | `decryptField` | `POST /api/detail/decrypt` | 脱敏字段单次解密（留痕） |
| audit · 审计留痕 | `fetchAudit` | `GET /api/audit` | 审计流水，前端做类型过滤 |
| settings · 准入与护栏 | `saveSettings` | `POST /api/settings` | 保存护栏/留存配置 |

> 注：候选抽屉中「标记已沟通」`dMark` 仅前端本地 toast，未映射后端端点；若需持久化状态，建议新增 `PATCH /api/candidates/{id}`（status 流转），本契约暂无对应桩，需落地时补充。