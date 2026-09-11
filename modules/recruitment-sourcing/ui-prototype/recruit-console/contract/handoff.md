# 后端交接指南 · 招聘提效模块

> MVP 原型已冻结并经静态自审通过。本文档给出**架构中立**的接口契约与三条落地路径，供你按团队规模 / 时间 / 成本选择。本 skill 不实现后端，只交付契约与指引。

## 交接契约文件（`contract/` 目录）
| 文件 | 内容 | 消费方 |
|---|---|---|
| `design-contract.md` | 设计令牌 / 组件 / 外壳 / 页面清单 | 前端 + 设计实现 |
| `data-model.md` | 实体 / 字段 / 关系 / 安全规则（中立 schema） | 数据库 migration / ORM / BaaS 建表 |
| `openapi.yaml` | 每个 API 桩对应一个端点（method+path+请求/响应） | 代码生成 / 联调文档 |
| `endpoint-map.md` | 页面 → 桩函数 → 端点的映射表 | 后端团队排期、前端核对 |

## 关键原则：唯一接缝在 `api.js`
前端的状态 / 视图 / mock 层不动，接入真实后端只需**替换 `api.js` 桩函数内部实现**（每个桩已带 `// TODO: replace with fetch(...)` 与 method/path/shape 标注）。架构在你选定的后端技术栈中可插拔、不锁死。

## 三条落地路径（按速度 → 灵活性排序）

| 层级 | 适用 | 你要做的 | 前端改动 |
|---|---|---|---|
| **① BaaS 直连**（Supabase / Pocketbase / Firebase / Appwrite） | 验证期、小团队、想要真实数据 | 把 `data-model.md` 映射为 BaaS 表；逐个替换 `api.js` 桩体为 BaaS SDK 调用 | 仅 `api.js` 内部，签名不变 |
| **② 契约驱动脚手架**（自托管，架构仍开放 Node/Go/Python…） | 自建后端 | 把 `openapi.yaml` 喂给代码生成器：前端类型化 client、后端路由/DTO/校验(migration 依据数据模型) | 仅 `api.js` 内部，架构可换 |
| **③ 工程外包交接**（业务复杂 / 定制架构 / 外包开发） | 正式研发 | 基于本契约 + openapi + 数据模型产出完整开发文档（功能模块、接口契约、数据模型、页面到 API 映射）由团队独立实现 | 取决于团队实现 |

> 无论走哪条路径，**真实鉴权（JWT/Session/OAuth）、部署、环境变量、监控**都是后续工程工作——原型的"登录"只是前端 mock 校验。

## 落地前的代码级核对点（给后端）
1. `openapi.yaml` 的每个 operationId 与 `api.js` 桩函数同名（fetchOverview / createJob / runCollect / exportCandidates / decryptField…），替换即可无缝对接。
2. 安全规则不可由前端绕过：电话/邮箱默认脱敏，解密走 `/api/detail/decrypt` 且每次留痕；采集/访问/导出写 `audit`；`POST /api/export/candidates` 返回"待审批"。
3. 数据模型含 `jobs → candidates → resumes/matches` 关系与 `audit`/`cycles`/`accounts` 实体，作为 DB 设计基线。