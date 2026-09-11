## 数据模型 · 招聘提效模块
> 依据：`mock.js`（契约 §6 机械提取，中立 schema，不绑定任何数据库技术）
> 用途：BaaS 建表 / SQL migration / ORM 实体均可据此映射。

### 关系总览
```
jobs ──< cycles（按岗位的采集轮次）
jobs ──< candidates（candidate.jobId 归属岗位，单表冗余 jobId 以简化查询）
candidates ──1:1→ resumes（解析结果）
candidates ──1:1→ matches（匹配分，可空）
audit（独立审计流水）
accounts（账号接入与护栏）
```

### 实体与字段

#### jobs 岗位
| 字段 | 类型 | 必填 | 说明 | 示例 |
|---|---|---|---|---|
| id | int | ✓ | 主键，自增 | 1 |
| jobId | string | ✓ | 业务岗位标识（唯一索引） | frontend_01 |
| title | string | ✓ | 岗位名称 | 前端工程师 |
| status | enum[active,idle] | ✓ | 采集中 / 待命 | active |
| round | int | ✓ | 已执行轮次 | 128 |
| todayQuota | int | ✓ | 今日已收简历数 | 46 |
| keywords | string[] | ✓ | JD 自动解析关键词 | [Vue3, TypeScript] |
| lastRun | string | ✓ | 上次运行 | 17:00 · 今天 |

#### candidates 候选人
| 字段 | 类型 | 必填 | 说明 | 示例 |
|---|---|---|---|---|
| id | string | ✓ | 候选人全局唯一（PFX_cand_+序号） | cand_09271 |
| jobId | string | ✓ | 归属岗位 | frontend_01 |
| name | string | ✓ | 姓名 | 陈亦凡 |
| source | string | ✓ | 来源平台 | BOSS |
| workYears | int | ✓ | 工作年限 | 5 |
| skills | string[] | ✓ | 技能标签 | [Vue3, TypeScript] |
| salary | string | ✓ | 期望薪资区间 | 28–35k |
| status | enum[matched,parsed,pending,failed] | ✓ | 状态 | matched |

#### resumes 解析结果（1:1 附属于候选人）
| 字段 | 类型 | 必填 | 说明 | 示例 |
|---|---|---|---|---|
| candidateId | string | ✓ | FK → candidates.id | cand_09271 |
| school | string | ✓ | 学历学校 | 武汉大学 |
| degree | string | ✓ | 学历层次 | 本科 |
| company | string | 有 | 当前/最近公司 | 某云计算 |
| role | string | 有 | 最近职位 | 高级前端 |
| tenure | string | 有 | 在职时段 | 2021–今 |
| phone | string | ✓ | 脱敏存储 | 138****7210 |
| email | string | ✓ | 脱敏存储 | chen**@outlook.com |
| confidence | float(0–1) | ✓ | 解析置信度 | 0.94 |

#### matches 匹配分（候选人不一定都有）
| 字段 | 类型 | 必填 | 说明 | 示例 |
|---|---|---|---|---|
| candidateId | string | ✓ | FK → candidates.id | cand_09271 |
| score | int(0–100) | ✓ | 匹配分 | 82 |
| evidence | string | 有 | 匹配依据摘要 | Vue3·Node·微前端 |

#### cycles 采集轮次
| 字段 | 类型 | 必填 | 说明 | 示例 |
|---|---|---|---|---|
| id | int | ✓ | 主键 | 128 |
| jobId | string | ✓ | 岗位 | frontend_01 |
| at | string | ✓ | 运行时间 | 今天 09:00 |
| status | enum[success,fail] | ✓ | 结果 | success |

#### audit 审计流水
| 字段 | 类型 | 必填 | 说明 | 示例 |
|---|---|---|---|---|
| id | string | ✓ | 业务 id | a2001 |
| action | string | ✓ | 动作描述 | 导出候选人清单 |
| target | string | ✓ | 目标 | export_candidates_0909.csv |
| actor | string | ✓ | 操作人/审批 | 赵经理·批准 |
| ts | string | ✓ | 时间 | 09:32 |
| type | enum[collect,access,export] | ✓ | 分类 | export |

#### accounts 账号接入
| 字段 | 类型 | 必填 | 说明 | 示例 |
|---|---|---|---|---|
| id | string | ✓ | 账号标识 | A1 |
| name | string | ✓ | 账号名 | BOSS 主账号 |
| status | enum[active,cooling] | ✓ | 状态 | active |
| used | int | ✓ | 已用量 | 46 |
| limit | int | ✓ | 每日上限 | 200 |
| note | string | 有 | 备注 | 会话隔离 |

### 安全规则（不可由前端绕过）
- 电话/邮箱等 `phone`/`email` 字段：**默认脱敏存储**，仅授权会话可调用 `/api/detail/decrypt` 单次解密并留痕。
- 所有采集/访问/导出动作写入 `audit`，导出需审批（`POST /api/export/candidates` 返回待审批状态）。
- 数据留存：原始简历 90 天自动脱敏归档、删除留审计。