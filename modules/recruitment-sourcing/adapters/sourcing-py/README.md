# 采集适配器（sourcing-py）

招聘提效模块的「采集与调度」端（Python）。负责按岗位关键词，在**公司自有授权账号**
前提下，**受控节流**地采集候选简历线索，并投递到框架网关，交由 Node 侧「解析→匹配→入库」。

## 两种模式

| 模式 | 作用 | 依赖 | 什么时候用 |
|---|---|---|---|
| `simulator`（默认） | 离线合成**脱敏**候选，链路可无账号跑通 | 标准库即可 | 全链路联调 / 无账号演示 |
| `boss` | 驱动 BOSS直聘网页端真实「索取简历」 | playwright | T1(POC) 用真实公司账号校准后 |

> boss 模式的**强门控前提（合规红线）**：必须提供公司自有账号的持久会话目录
> `account.profile_dir`；严格受 `safety` 节流；不做代理轮换、不做 WebDriver 规避；
> 不越权抓取、不导出售卖。未配置会话时安全抛错，不会静默抓取。

## 配置（config.example.json → 复制为 config.json）

```jsonc
{
  "mode": "simulator",               // simulator | boss
  "gateway_url": "http://127.0.0.1:4700",
  "safety": {                        // 账号风控护栏（三层上限 + 触达共档）
    "interval_seconds": [3, 8],      //   动作间随机间隔(秒)
    "daily_cap": 200,                //   每账号每日上限
    "touch_daily_cap": 60,           //   打招呼/索要简历/索要电话 共用每日上限
    "cooldown_minutes": 30,          //   命中风控后的冷却
    "session_cap": 80,               //   单会话上限 → 会话隔离
    "circuit_breaker": 3             //   连续失败熔断
  },
  "per_job_target": 3,               // simulator 每岗位产出人数
  "jobs": [ { "job_id": "job_01", "keyword": "前端工程师" } ]
}
```

## 运行

```bash
# 1) 先启动框架网关（Node 侧）
cd ../../../../..                  # hr-system/
node framework/server.js           # 监听 4700

# 2) 再启动采集调度（simulator 演示）
cd modules/recruitment-sourcing/adapters/sourcing-py
python run.py                       # 按 config.json 任务清单调度
python run.py --job job_01 --once -v   # 仅跑一个岗位一轮

# 启用真实 boss（需先校准选择器，见 boss_driver.py：DEFAULT_SELECTORS）
#   在 config.json 设 mode=boss，并填写 account.profile_dir 后运行
```

## 数据流

采集候选 → `POST {gateway_url}/api/sourcing/candidates` → 框架事件总线
→ `candidate.sourced`(解析) → `resume.parsed`(匹配) → 领域库 → 前端展示/导出。