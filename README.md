# HR 自研系统 · 框架骨架（v0.1）

> 面向未来 AI HR 系统的**可插拔模块化框架**。招聘提效是第一个业务模块。
> 本骨架目标是验证「可读、可插拔、数据统一流转」，含**框架内核 + 统一数据契约 + 一位模块 + 演示脚本**，可在 Node 环境直接运行（无构建、原生 ESM）。

## 一、目录规范（可读性）

```
hr-system/
├── framework/              # 框架内核（不绑定业务）
│   ├── core/               #   内核引擎
│   │   ├── registry.js     #     模块注册表
│   │   ├── lifecycle.js    #     模块生命周期（start/stop）
│   │   ├── bus.js          #     事件/消息总线
│   │   ├── gateway.js      #     统一网关（HTTP 路由 + 审计）
│   │   └── config.js       #     配置读取
│   ├── schema/             #   统一数据契约（JSON Schema）
│   │   ├── candidate.schema.json
│   │   ├── job.schema.json
│   │   ├── resume.schema.json
│   │   ├── match.schema.json
│   │   └── validate.js     #     契约校验器
│   ├── audit/              #   操作审计
│   ├── demo.js             #   演示：注册→事件→校验→审计（离线冒烟）
│   └── server.js           #   应用入口：统一网关 + 静态前端 + 采集注入 + CSV 导出
├── modules/                # 业务模块（可插拔，互不直接调用）
│   └── recruitment-sourcing/   # 模块1：招聘提效 ◆本期◆
│       ├── manifest.json       #   模块声明
│       ├── domain/             #   模块领域逻辑
│       ├── services/           #   解析/匹配服务（Node，复用 InterviewPrep）
│       ├── adapters/           #   采集适配器（Python）
│       │   └── sourcing-py/
│       │       ├── run.py          #   调度 CLI（simulator/boss）
│       │       ├── adapter.py      #   SourcingAdapter 门面
│       │       ├── safety.py       #   账号风控护栏（频率/上限/冷却/熔断）
│       │       ├── simulator.py    #   离线脱敏模拟器
│       │       ├── boss_driver.py  #   真实 BOSS 驱动（强门控，需 T1 校准）
│       │       └── config.example.json
│       ├── listeners/          #   事件订阅
│       └── public/             #   模块业务控制台前端（index.html，自包含）
└── infra/
    ├── store/              # 领域数据存储（jsonl；含 audit/ 操作审计，单文件沉淀）
    └── files/              # 简历原文（AES-256-GCM 加密；vault.key 不入库）
```

## 二、模块接入范式（可插拔）

1. 新模块在 `modules/<name>/manifest.json` 声明 `id / version / requires / services / listens / provides`。
2. 模块**只依赖**框架内核接口（`registry/bus/schema/audit`），**不直接 import 其他模块内部**。
3. 模块产出数据必须通过 `framework/schema` 校验后写入领域库 —— 这就是「数据统一流转」的保障。

## 三、运行演示

```bash
# 前置：Node ≥ 18
# 离线模式（未配置 LLM 时，用启发式解析/匹配，全链路仍可跑通）：
node framework/demo.js

# 接入本地 LLM（OpenAI 兼容协议，如 Ollama/Qwen/DeepSeek）：
$env:HR_LLM_BASE="http://127.0.0.1:11434/v1"; $env:HR_LLM_MODEL="qwen2.5"; node framework/demo.js
```

演示将：注册招聘提效模块 → 解析 JD（复用 JD_PARSE_SYSTEM）→ 模拟「要简历 → 简历解析（RESUME_PARSE_SYSTEM）→ JD 匹配打分（GAP_ANALYSIS_SYSTEM）」事件流转 → 每条数据过统一 Schema 校验 → 写审计留痕 → 经统一网关（`/modules` `/jobs` `/matches` `/audit`）访问。

## 四、运行真实业务（Web 控制台 + Python 采集）

**1) 启动服务端（网关 + 业务控制台）**

```bash
node framework/server.js          # 默认端口 4700；改端口：$env:HR_PORT="4730"
# 敏感接口鉴权（可选但建议）：设置共享令牌后，数据/导出接口需带 Authorization: Bearer <token> 访问
$env:HR_AUTH_TOKEN="你的令牌"       # 未设置则数据接口保持开放并启动时给出告警；认证身份可用 $env:HR_AUTH_ACTOR 指定
```

打开 `http://127.0.0.1:4700` 进入招聘提效业务控制台，可：
- 新建岗位（粘贴 JD 自动解析关键词）；
- 触发 **Python 采集**（优先 `simulator` 离线脱敏 / 可切 `boss` 真实账号）或 **离线冒烟**；
- 查看候选人 & 匹配分（按分排序）、点行看简历解析详情；
- 导出 `candidates.csv`（含匹配分，批量导出走审批留痕）；
- 查看审计留痕与最近调度周期。

**2) Python 采集调度器（可选，更接近生产）**

```bash
cd modules/recruitment-sourcing/adapters/sourcing-py
python run.py                        # 按 config.example.json 任务清单调度
python run.py --job job_01 --once -v # 仅跑一个岗位一轮，投递到网关
```

- 默认 `simulator`（仅标准库，无需依赖即可全链路联调）；所有采集动作受 `safety.py` 护栏：随机间隔 3~8s、每账号日上限 200、会话上限 80、冷却 30min、连续失败熔断 3 次。
- `boss` 真实模式需公司自有账号持久会话（`account.profile_dir`）并先做 **T1(POC)** 用真实 DOM 校准 `boss_driver.py` 选择器；不轮换代理、不做 WebDriver 规避。

**3) 采集链路数据流**

`Python 采集候选 → POST /api/sourcing/candidates → 事件总线 candidate.sourced → 简历解析 → resume.parsed → JD 匹配打分 → 领域库 → 前端展示/导出`。

## 五、与方案文档关系

- 架构细节见《AI HR 系统·整体框架方案》
- 首位模块见《招聘提效模块 MVP 方案》
- 本骨架为上述两份方案的**可运行落地基**。