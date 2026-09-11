# 模拟采集适配器：离线生成符合统一契约的候选人，用于无 BOSS 账号时的全链路演示/联调。
# 候选全部为脱敏数据（name 打码、无真实联系方式），仅供自测流程，不对外。
import random
import re
from datetime import datetime

from safety import now_iso

_SAMPLE_NAMES = ["张*", "李*", "王*", "刘*", "陈*", "杨*", "赵*", "黄*", "周*", "吴*", "徐*", "孙*"]
_EDU = ["本科", "硕士", "大专", "本科", "硕士"]
_SCHOOLS = ["示例大学", "示例理工", "示例学院", "示例科技大学"]
_DICT = [("JavaScript", ["js", "javascript", "前端"]), ("TypeScript", ["ts", "typescript"]),
         ("React", ["react"]), ("Vue", ["vue"]), ("Node.js", ["node", "node.js"]),
         ("Python", ["python"]), ("Go", ["go"]), ("Java", ["java"]),
         ("SQL", ["sql", "mysql", "postgres"]), ("Docker", ["docker"]),
         ("Kubernetes", ["kube", "kubernetes"]), ("机器学习", ["机器学习", "ai", "算法"]),
         ("数据分析", ["数据分析", "分析"])]


class SimulatorAdapter:
    """按关键词合成候选人。produce_candidates 尊重 SafetyLimiter 节奏与上限。"""

    def __init__(self, config: dict):
        self.config = config
        self.target = int(config.get("per_job_target", 3))      # 每岗位若干人
        self.drift = float(config.get("skill_noise", 0.3))       # 技能覆盖噪声(0-1)

    def produce_candidates(self, job_id: str, keyword: str, limiter):
        keywords = self._tokens(keyword)
        out = []
        for i in range(self.target):
            if not limiter.allowed():
                break
            limiter.before_call()
            cand = self._candidate(job_id, keywords, i)
            limiter.record_call(ok=True)
            out.append(cand)
        return out

    def _tokens(self, keyword: str):
        low = keyword.lower()
        tokens = [k for k, aliases in _DICT if any(a in low for a in aliases)]
        # 任意英文/符号词也算关键词（便于匹配 JD 中的技术栈）
        tokens += [w for w in re.findall(r"[A-Za-z#+]{2,}", keyword)][:6]
        if not tokens:
            # 无技能字典命中时，直接取关键词切片作为技能词（避免出现"通用技能"这类无意义值）
            tokens = [t for t in re.split(r"[\s,，、/]", keyword) if t][:6] or [keyword]
        return sorted(set(tokens))[:8]

    def _candidate(self, job_id, keywords, idx):
        hit = random.sample(keywords, max(1, round(len(keywords) * (1 - self.drift)))
                            if len(keywords) > 1 else 1)
        missed = [k for k in keywords if k not in hit]
        years = random.choice([1, 2, 3, 3, 5, 5, 8])
        return {
            "candidateId": f"cand_sim_{idx}_{int(datetime.now().timestamp()*1000)}",
            "source": "boss",
            "jobId": job_id,
            "name": random.choice(_SAMPLE_NAMES) + f"{idx+1}号",
            "status": "sourced",
            "workExperienceYears": years,
            "salaryExpected": f"{years*2+6}-{years*2+12}K",
            "education": {"school": random.choice(_SCHOOLS), "degree": random.choice(_EDU),
                          "major": random.choice(["计算机", "软件工程", "自动化", "信息管理"])},
            "skills": hit,
            "resume": {"status": "pending", "format": "text",
                       "rawText": self._resume_text(hit, missed, years)},
            "meta": {"createdAt": now_iso(), "masked": True, "sourceLink": "demo:simulator"},
        }

    def _resume_text(self, hit, missed, years):
        lines = [f"候选人（脱敏）工作年限 {years} 年，学历：本科。"]
        lines.append("主要技能：" + "、".join(hit) + "。")
        lines.append("较薄弱：" + "、".join(missed) + "（经验较少）。")
        lines.append("曾在示例科技公司担任工程师，负责业务模块开发与维护，具备跨团队协作能力。")
        return "\n".join(lines)