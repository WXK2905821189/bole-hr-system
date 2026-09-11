#!/usr/bin/env python3
"""招聘提效模块 · 采集调度入口（Python）
用法：
  python run.py                                    # 按 config.json 任务清单调度
  python run.py --job job_01 --once --keyword 前端  # 仅跑一个岗位一轮
  python run.py --config config.example.json
环境：
  HR_GATEWAY_URL  候选投递的框架网关地址(默认回帖 config.gateway_url)
  HR_MODE         simulator|boss（可选，覆盖 config.mode）
说明：
  采集到的每个候选经 POST {gateway_url}/api/sourcing/candidates 交付 Node 侧，
  由框架事件总线触发「解析→匹配→入库→前端展示」。
"""
import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from adapter import SourcingAdapter  # noqa: E402


def load_config(path):
    p = Path(path) if path else HERE / "config.json"
    if not p.exists():
        p = HERE / "config.example.json"
    if not p.exists():
        raise SystemExit("缺少 config.json / config.example.json")
    return json.loads(p.read_text(encoding="utf-8"))


def deliver(candidate, gateway_url):
    """把单个候选 POST 到框架网关，返回是否已入库。"""
    import urllib.request

    req = urllib.request.Request(
        gateway_url.rstrip("/") + "/api/sourcing/candidates",
        data=json.dumps(candidate).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.status in (200, 201)


def run(config, job_id=None, keyword=None, once=False, verbose=False):
    mode = os.environ.get("HR_MODE") or config.get("mode", "simulator")
    config["mode"] = mode
    if mode == "boss":
        print(f"[adapter] 模式 boss（真实账号采集，严格节流）", flush=True)
    else:
        print(f"[adapter] 模式 simulator（离线脱敏模拟，供全链路联调）", flush=True)

    adapter = SourcingAdapter(config)
    gateway_url = os.environ.get("HR_GATEWAY_URL") or config.get("gateway_url", "http://127.0.0.1:4700")
    jobs = [j for j in config.get("jobs", []) if (not job_id) or j.get("job_id") == job_id]
    if job_id and not jobs:  # Node 侧新建的岗位不在配置文件 → 作为临时岗位按传入关键词采集
        jobs = [{"job_id": job_id, "keyword": keyword or job_id}]

    produced = delivered = 0
    for job in jobs:
        kw = keyword or job.get("keyword", "")
        print(f"[job ] {job.get('job_id')} 关键词: {kw}", flush=True)
        try:
            candidates = adapter.produce_candidates(job["job_id"], kw)
        except RuntimeError as e:
            print(f"[stop] {e}", flush=True)
            break
        for cand in candidates:
            produced += 1
            try:
                if deliver(cand, gateway_url):
                    delivered += 1
                    if verbose:
                        print(f"  [+] {cand['candidateId']} 技能={','.join(cand.get('skills', []))}", flush=True)
            except Exception as e:
                print(f"  [!] 投递失败 {cand['candidateId']}: {e}", flush=True)
        if once:
            break
        if adapter.safety.should_stop():
            print("[stop] 已达节流边界(冷却/上限/熔断)，提前收工", flush=True)
            break

    print(f"[done] 产出 {produced} 位候选，成功投递 {delivered} 位", flush=True)
    print(f"[safe] {json.dumps(adapter.safety.stats, ensure_ascii=False)}", flush=True)
    return 0 if delivered or produced == 0 else 1


def main():
    ap = argparse.ArgumentParser(description="招聘提效 · 采集调度")
    ap.add_argument("--config", help="配置文件路径")
    ap.add_argument("--job", help="仅处理指定 job_id")
    ap.add_argument("--keyword", help="覆盖关键词")
    ap.add_argument("--once", action="store_true", help="每个岗位只产出一轮候选")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    cfg = load_config(args.config)
    raise SystemExit(run(cfg, args.job, args.keyword, args.once, args.verbose))


if __name__ == "__main__":
    main()