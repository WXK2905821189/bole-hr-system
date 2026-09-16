#!/usr/bin/env python3
"""招聘提效模块 · 采集调度入口（Python）
用法：
  python run.py                                    # 按 config.json 任务清单调度
  python run.py --job job_01 --once --keyword 前端  # 仅跑一个岗位一轮
  python run.py --config config.example.json
  python run.py --sync-jobs --json                 # 同步 BOSS 账号在招岗位，输出 JSON
  python run.py --chat-scan --json                 # 扫描 BOSS 沟通会话识别简历事件，输出 JSON
环境：
  HR_GATEWAY_URL   候选投递的框架网关地址(默认回帖 config.gateway_url)
  HR_MODE          simulator|boss（可选，覆盖 config.mode）
  HR_BOSS_CDP      扫码窗口保活的 CDP 地址（Node 网关探活后注入，优先级最高）
  HR_BOSS_COOKIES  BOSS 会话 cookie 串（Node 网关注入：扫码登录抓取，优先于 profile_dir）
  HR_BOSS_GREET_MSG 打招呼话术（Node 网关注入：当前生效的「初次触达」话术）
  HR_BOSS_JOB_ID   BOSS 端职位 ID encryptJobId（Node 网关注入：推荐流搜索与打招呼必填）
  HR_BOSS_CITY     搜索城市（岗位所在地，用于城市编码过滤）
  HR_CHAT_WATCH    沟通扫描关注名单 JSON（Node 网关注入：[{geekId, name}]）
  HR_AUTH_TOKEN    框架会话令牌（Node 网关注入：供前置 AI 匹配 /api/ai/pre-match 鉴权）
  HR_PRE_MATCH     前置 AI 匹配开关 1/0（默认 1，高分才打招呼）
  HR_PRE_MATCH_THRESHOLD 前置匹配阈值（默认 60）
  HR_PRE_RESUME_URL 在线简历 URL 模板（可含 {lid} {expect}；留空则推荐页内联点击打开）
  HR_KEEP_BROWSER_OPEN   采集后保持扫码窗口在线 1/0（默认 1）
说明：
  采集到的每个候选经 POST {gateway_url}/api/sourcing/candidates 交付 Node 侧，
  由框架事件总线触发「解析→匹配→入库→前端展示」。
  boss 模式采集流程（采集调度）：解析JD → 推荐牛人页右上角岗位选择器选中目标岗位 →
  从上到下逐个打开在线简历(抽取文本+截图 resume_shots) → 差距分析打分配对(pre /api/ai/pre-match) →
  匹配分≥threshold(默认60) 才打招呼(addRelation，失败回退页面点击) → 产出候选；推荐页无候选则回退搜索三通道。
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


def sync_jobs(config, as_json=False):
    mode = os.environ.get("HR_MODE") or config.get("mode", "simulator")
    if mode != "boss":
        os.environ["HR_MODE"] = "boss"  # 岗位同步必然走真实账号
    adapter = SourcingAdapter({**config, "mode": "boss"})
    try:
        jobs = adapter.sync_jobs()
    except RuntimeError as e:
        print(f"[error] {e}", flush=True)
        return 2
    if as_json:
        print("###JOBS_BEGIN###")
        print(json.dumps(jobs, ensure_ascii=False))
        print("###JOBS_END###")
    else:
        for j in jobs:
            print(f"  [job] {j['jobId']} {j['jobTitle']}｜{j.get('location','')}｜{j.get('salary','')}", flush=True)
        print(f"[done] 同步到 {len(jobs)} 个在招岗位", flush=True)
    return 0


def chat_scan(config, as_json=False):
    """扫描 BOSS 沟通会话识别简历事件；关注名单由 HR_CHAT_WATCH 注入（JSON: [{geekId, name}]）。"""
    mode = os.environ.get("HR_MODE") or config.get("mode", "simulator")
    if mode != "boss":
        os.environ["HR_MODE"] = "boss"  # 沟通扫描必然走真实账号
    watch = []
    raw = (os.environ.get("HR_CHAT_WATCH") or "").strip()
    if raw:
        try:
            watch = json.loads(raw)
        except Exception as e:
            print(f"[error] HR_CHAT_WATCH 解析失败：{e}", flush=True)
            return 2
    adapter = SourcingAdapter({**config, "mode": "boss"})
    try:
        friends = adapter.scan_chat(watch)
    except RuntimeError as e:
        print(f"[error] {e}", flush=True)
        return 2
    if as_json:
        print("###CHAT_BEGIN###")
        print(json.dumps(friends, ensure_ascii=False))
        print("###CHAT_END###")
    else:
        for f in friends:
            mark = "已发简历" if f.get("resumeSent") else ("已同意发简历" if f.get("resumeAgreed") else "—")
            print(f"  [chat] {f.get('name', '')}（{(f.get('friendId') or '')[:10]}…）{mark}｜最新：{f.get('lastMsg', '')}", flush=True)
        print(f"[done] 扫描 {len(friends)} 个关注会话", flush=True)
    return 0


def run(config, job_id=None, keyword=None, once=False, verbose=False, city=None):
    mode = os.environ.get("HR_MODE") or config.get("mode", "simulator")
    config["mode"] = mode
    if city:
        os.environ["HR_BOSS_CITY"] = city
    if mode == "boss":
        acc = config.get("account") or {}
        via = ("CDP 附着（扫码窗口保活）" if os.environ.get("HR_BOSS_CDP")
               else "扫码/网关注入的会话 cookie" if os.environ.get("HR_BOSS_COOKIES")
               else "profile_dir 持久会话" if acc.get("profile_dir")
               else "未提供凭证（将提示先扫码登录）")
        print(f"[adapter] 模式 boss（真实账号采集，httpx 直调优先，严格节流，会话来源：{via}）", flush=True)
    else:
        print("[adapter] 模式 simulator（离线脱敏模拟，供全链路联调）", flush=True)

    try:
        adapter = SourcingAdapter(config)
    except RuntimeError as e:
        print(f"[error] {e}", flush=True)
        return 2
    gateway_url = os.environ.get("HR_GATEWAY_URL") or config.get("gateway_url", "http://127.0.0.1:4700")
    jobs = [j for j in config.get("jobs", []) if (not job_id) or j.get("job_id") == job_id]
    if job_id and not jobs:  # Node 侧新建的岗位不在配置文件 → 作为临时岗位按传入关键词采集
        jobs = [{"job_id": job_id, "keyword": keyword or job_id}]

    produced = delivered = 0
    job_summaries = []
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
        # boss 真实采集：收拢本岗位运行评估
        ls = getattr(adapter.backend, "last_summary", None) if mode == "boss" else None
        if ls:
            ls = {**ls, "job": job["job_id"], "keyword": kw}
            job_summaries.append(ls)
            print(_fmt_summary(ls), flush=True)
        if once:
            break
        if adapter.safety.should_stop():
            print("[stop] 已达节流边界(冷却/上限/熔断)，提前收工", flush=True)
            break

    # 收尾：结构化运行总结（供框架网关解析后写入运行日志），并附带可读文本
    if job_summaries:
        print("###RUN_SUMMARY###")
        print(json.dumps({"jobs": job_summaries}, ensure_ascii=False))
        print("###RUN_SUMMARY_END###")

    print(f"[done] 产出 {produced} 位候选，成功投递 {delivered} 位", flush=True)
    print(f"[safe] {json.dumps(adapter.safety.stats, ensure_ascii=False)}", flush=True)
    return 0 if delivered or produced == 0 else 1


def _fmt_summary(ls: dict) -> str:
    """把单个岗位的评估总结格式化成可读的一行（含各候选人得分/是否过线）。"""
    parts = ["候选打分(名 分数/过线/来源)："]
    for d in ls.get("details", []):
        via = "在线" if d.get("via") == "online" else "放行"
        score = d.get("score") if d.get("score") is not None else "-"
        mark = "✓打招呼" if d.get("greeted") else ("✗未过线" if not d.get("passed") else "✗失败")
        parts.append(f"{d.get('name')} {score}/{via}/{mark}")
    return (f"[summary] 岗位 {ls.get('job')} 关键词 {ls.get('keyword')}："
            f"本轮打招呼 {ls.get('greeted')} 位，在线打分 {ls.get('onlineScored')}、无简历放行 "
            f"{ls.get('noResumePassthrough')}、未过线 {ls.get('belowThreshold')}，上限 {ls.get('maxGreet')}，"
            f"阈值 {ls.get('threshold')}。{' | '.join(parts)}")


def main():
    ap = argparse.ArgumentParser(description="招聘提效 · 采集调度")
    ap.add_argument("--config", help="配置文件路径")
    ap.add_argument("--job", help="仅处理指定 job_id")
    ap.add_argument("--keyword", help="覆盖关键词")
    ap.add_argument("--city", help="搜索城市（如 北京），转为平台城市编码")
    ap.add_argument("--once", action="store_true", help="每个岗位只产出一轮候选")
    ap.add_argument("--sync-jobs", action="store_true", help="同步 BOSS 账号在招岗位（不走节流）")
    ap.add_argument("--json", action="store_true", help="配合 --sync-jobs / --chat-scan：以标记块输出 JSON")
    ap.add_argument("--chat-scan", action="store_true", help="扫描 BOSS 沟通会话，识别简历事件（不走节流）")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    cfg = load_config(args.config)
    if args.sync_jobs:
        raise SystemExit(sync_jobs(cfg, as_json=args.json))
    if args.chat_scan:
        raise SystemExit(chat_scan(cfg, as_json=args.json))
    raise SystemExit(run(cfg, args.job, args.keyword, args.once, args.verbose, args.city))


if __name__ == "__main__":
    main()