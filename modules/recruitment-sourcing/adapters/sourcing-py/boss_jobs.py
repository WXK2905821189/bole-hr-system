# BOSS 在招岗位同步：API 直调优先（zpjob/job/data/list，Auto-Recruiting 同源），
# 失败回退「职位管理」页 DOM 解析。返回统一岗位列表（与 jobs.jsonl 契约对齐）。
import hashlib
import json
import time
from pathlib import Path

import boss_api
from boss_api import ApiError, SecurityCheckError
from safety import now_iso

DEFAULT_JOB_SELECTORS = {
    # 职位管理页的职位条目列表
    "job_cards": '[class*="job-card"], [class*="job-item"], [class*="position-item"], [class*="job"] li',
    # 条目内：职位名 / 薪资 / 城市 / 在招状态
    "job_title": '[class*="job-name"], [class*="job-title"], [class*="title"]',
    "job_salary": '[class*="salary"], [class*="pay"]',
    "job_city": '[class*="city"], [class*="area"]',
    "job_status": '[class*="status"], [class*="tag"]',
}

# jobStatus 码 → 是否「开放中」（可被 config.json 的 job_status_open 覆盖）。
# 实测分布（2026-09，新账号 59 岗位）：按结构化信号严格分离三类——
#   0 = 开放中（12 个，paidJobEndDate/jobWebStatus 全部有值，真正在招）
#   1 = 待开放（45 个，全部无付费结束日/在线状态）
#   3 = 已关闭（2 个）
# 仅「开放中」采集；待开放、已关闭均排除。
OPEN_JOB_CODES = (0,)

# 岗位 JD 详情页 URL 模板（{bossJobId} 由 meta.bossJobId 占位；可用 config.pages.job_detail 覆盖）
DEFAULT_JOB_DETAIL_PAGE = "https://www.zhipin.com/job_detail/{bossJobId}.html"

# 职位详情页「职位描述」容器启发式列表（按序尝试；仍取不到则回退标题定位）
JD_TEXT_HEURISTICS = [
    ".job-sec-text",
    '[class*="job-desc"]',
    '[class*="job-sec"]',
    '[class*="job-description"]',
    '[class*="job-detail"] .text',
    ".text",
]


def _extract_jd_text(page) -> str:
    """从职位详情页抽取「职位描述」文本。

    优先级：常见描述容器 → 按「职位描述/岗位职责/任职要求」标题定位其后续文本 → 整页正文。
    """
    sels = "', '".join(JD_TEXT_HEURISTICS)
    js = """(sels)=> {
        const list = sels.split('\\n').filter(Boolean);
        const pick = (arr) => { for (const s of arr){ let e; try{ e = document.querySelector(s); }catch(_){} if(e){ const t=(e.innerText||'').trim(); if(t.length>30) return t; } } return ''; };
        const t = pick(list);
        if (t) return t;
        const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4,.job-name,[class*=\"title\"],[class*=\"label\"],[class*=\"name\"]'))
            .filter(h => /职位描述|岗位职责|职位信息|工作职责|任职要求|岗位要求|职责描述/.test((h.innerText||'').trim()));
        if (heads.length) {
            const h = heads[heads.length - 1];
            let sib = h.nextElementSibling, parts = [];
            let guard = 0;
            while (sib && guard++ < 8) {
                const tx = (sib.innerText || '').trim();
                if (tx && /^(公司|团队|地址|福利|技能|地点|上班)/.test(tx)) break;
                if (tx) parts.push(tx);
                if (tx && (sib.querySelector('h2,h3,h4,[class*=\"title\"]'))) break;
                sib = sib.nextElementSibling;
            }
            if (parts.length) return parts.join('\\n');
        }
        return (document.body.innerText || '').slice(0, 3000);
    }"""
    try:
        return str(page.evaluate(js, [sels.replace("', '", "\\n")]) or "").strip()
    except Exception:
        return ""


def stable_job_id(title: str, city: str = "") -> str:
    """同职位重复同步不重复建岗：按 职位名+城市 生成稳定 ID（API/DOM 两通道结果一致）。"""
    key = f"{(title or '').strip()}|{(city or '').strip()}"
    return "job_boss_" + hashlib.md5(key.encode("utf-8")).hexdigest()[:12]


def list_jobs(session, selectors=None, pages=None, apis=None, open_codes=None, crawl_jd=True) -> list[dict]:
    """拉取在招岗位：打开职位管理页（新版 /web/chat/job/list）→ API 直调（主）→ 页面 DOM 解析（兜底）。

    只做一次导航：两条通道共用同一落地页，避免旧版多入口互跳导致的导航竞态。
    拿到在招岗位后，对缺 JD 的岗位逐个打开职位详情页「扒取职位描述」并截图存档（crawl_jd=True）。
    session 为已 open 的 BossSession；open_codes 为在招状态码集合（默认 OPEN_JOB_CODES）。
    """
    from boss_driver import DEFAULT_PAGES
    url = {**DEFAULT_PAGES, **(pages or {})}.get("manage_job")
    session.goto(url)
    session.assert_login("职位管理页")
    boss_api.assert_no_security(session.page)
    try:
        jobs = _list_jobs_api(session, url, apis, open_codes)
        if jobs:
            if crawl_jd:
                jobs = _crawl_jobs_jd(session, jobs, pages, selectors)
            return jobs
        print("[jobs] API 返回空职位列表，回退职位管理页 DOM 通道", flush=True)
    except SecurityCheckError:
        raise
    except Exception as e:
        print(f"[jobs] API 通道失败，回退职位管理页 DOM：{e}", flush=True)
    jobs = _list_jobs_dom(session, selectors, url)
    if crawl_jd and jobs:
        jobs = _crawl_jobs_jd(session, jobs, pages, selectors)
    return jobs


def _crawl_jobs_jd(session, jobs, pages=None, selectors=None) -> list[dict]:
    """对缺真实 JD 的在招岗位，逐个打开职位详情页扒取「职位描述」+ 截图存档。

    流程对应「点击职位管理→点岗位→定位职位描述→保存 JD」：详情页 URL 模板
    DEFAULT_JOB_DETAIL_PAGE（可被 config.pages.job_detail 覆盖）；取不到 JD 沿用占位不中断同步。
    """
    from boss_driver import DEFAULT_PAGES
    detail_page = {**DEFAULT_PAGES, **(pages or {})}.get("job_detail") or DEFAULT_JOB_DETAIL_PAGE
    manage_back = session.page.url
    for job in jobs:
        need = not (job.get("meta") or {}).get("jdComplete")
        if not need:
            continue
        boss_id = (job.get("meta") or {}).get("bossJobId") or ""
        if not boss_id:
            continue
        detail_url = detail_page.format(bossJobId=boss_id)
        jd, ok = _fetch_job_detail(session.page, detail_url)
        if ok and jd:
            job["jdRaw"] = jd[:2000]
            job.setdefault("meta", {})["jdComplete"] = True
            job.setdefault("meta", {})["jdCrawled"] = True
            print(f"[jobs] 已扒取岗位 JD：{job.get('jobTitle')}（{len(jd)} 字）", flush=True)
        else:
            print(f"[jobs] 岗位 JD 扒取失败（沿用占位）：{job.get('jobTitle')} {boss_id}", flush=True)
    # 结束回职位管理页，保持后续通道落地页一致
    try:
        if manage_back and session.page.url != manage_back:
            session.page.goto(manage_back, wait_until="domcontentloaded")
            session.page.wait_for_timeout(1200)
    except Exception:
        pass
    return jobs


def _fetch_job_detail(page, detail_url: str) -> tuple[str, bool]:
    """导航到职位详情页并抽取「职位描述」文本 + 截图存档。返回 (jd 文本, 是否成功)。"""
    try:
        page.goto(detail_url, wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        txt = _extract_jd_text(page)
        # 截图存档（供人工核验扒取的 JD 是否准确）
        try:
            from pathlib import Path as _P
            shot_dir = _P(__file__).resolve().parent / "job_shots"
            shot_dir.mkdir(exist_ok=True, parents=True)
            _boss_id = detail_url.rstrip("/").split("/")[-1].split(".")[0].replace("?", "")
            page.screenshot(path=str(shot_dir / f"job_{_boss_id or 'x'}.png"), type="png", full_page=True)
        except Exception:
            pass
        if txt and len(txt) > 20:
            return txt, True
        print(f"[jobs] 详情页未抽到 JD 文本：{detail_url}", flush=True)
    except Exception as e:
        print(f"[jobs] 详情页打开失败：{e}", flush=True)
    return "", False


def _list_jobs_api(session, url: str, apis=None, open_codes=None) -> list[dict]:
    """API 通道：页面已在职位管理页（活会话）→ httpx 直调职位列表接口（带翻页）。

    只返回在招岗位（jobStatus ∈ open_codes）：暂停/关闭的岗位不进系统，
    避免招聘同学在岗位列表里看到不可用的岗位。
    """
    client = boss_api.build_client(session.page, referer=url)
    try:
        raw = boss_api.list_jobs_api(client, apis)
        print(f"[jobs] API 直调成功：{len(raw)} 条职位记录", flush=True)
        _dump_raw_sample(raw)
        codes = tuple(open_codes) if open_codes else OPEN_JOB_CODES
        jobs, seen, closed = [], set(), 0
        for j in (_norm_job(r, codes) for r in raw):
            if not j or j["jobId"] in seen:
                continue
            if j["status"] != "open":
                closed += 1
                continue
            seen.add(j["jobId"])
            jobs.append(j)
        print(f"[jobs] 在招 {len(jobs)} 个（过滤非在招 {closed} 个，按 职位名+城市 去重）", flush=True)
        return jobs
    finally:
        client.close()


def _dump_raw_sample(raw: list[dict], n: int = 5):
    """保存原始职位记录样本（前 n 条）：供「开放/未开放」状态字段校准与排查过滤准确性。"""
    try:
        path = Path(__file__).with_name("jobs_raw_sample.json")
        path.write_text(json.dumps(raw[:n], ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[jobs] 原始样本已存 {path.name}（前 {min(n, len(raw))} 条，用于状态字段校准）", flush=True)
    except Exception as e:
        print(f"[jobs] 原始样本保存失败（不影响同步）：{e}", flush=True)


def _s(v) -> str:
    """API 字段宽松转字符串：BOSS 各端点字段类型不统一（薪资/状态偶为数字）。"""
    return "" if v is None else str(v).strip()


def _norm_job(raw: dict, open_codes=None) -> dict | None:
    title = _s(raw.get("jobName") or raw.get("name") or raw.get("positionName")
               or raw.get("jobTitle"))
    if not title:
        return None
    city = _s(raw.get("locationName") or raw.get("cityName") or raw.get("city"))
    salary = _s(raw.get("salaryDesc") or raw.get("salary"))
    # jobStatus 码语义见 OPEN_JOB_CODES 注释；仅「开放中」采集，待开放/已关闭按非在招处理
    codes = tuple(open_codes) if open_codes else OPEN_JOB_CODES
    status_code = raw.get("jobStatus")
    try:
        is_open = status_code is not None and int(status_code) in codes
    except (TypeError, ValueError):
        is_open = False
    status_raw = "开放中" if is_open else (
        "已关闭" if str(status_code) == "3" else f"待开放（jobStatus={status_code}）")
    real_desc = _s(raw.get("postDescription") or raw.get("jobDesc"))
    desc = real_desc
    experience = _s(raw.get("experienceName"))
    degree = _s(raw.get("degreeName"))
    job_type = _s(raw.get("jobTypeName"))
    skills = [s.strip() for s in _s(raw.get("skillRequire")).replace("，", ",").split(",")
              if s.strip()][:12]
    if not desc:
        parts = [f"{title}｜{city}｜{salary}", experience, degree, job_type,
                 _s(raw.get("skillRequire"))]
        desc = "；".join(p for p in parts if p) + "（从 BOSS 同步，JD 详情可在系统内补全）"
    return {
        "jobId": stable_job_id(title, city),
        "jobTitle": title,
        "location": city,
        "salary": salary,
        "experience": experience,
        "degree": degree,
        "jobType": job_type,
        "hardSkills": skills,
        "bossStatus": status_raw,
        "status": "open" if (is_open and not raw.get("deleted")) else "closed",
        "jdRaw": desc[:2000],
        "meta": {
            "createdAt": now_iso(), "syncedFrom": "boss",
            "bossJobId": _s(raw.get("encryptJobId") or raw.get("encryptId") or raw.get("jobId")),
            "bossJobStatusCode": status_code if status_code is not None else "",
            # JD 是否已是「真实详情」：列表接口通常不含完整职位描述，false 时同步流程会自动补扒
            "jdComplete": bool(real_desc.strip()),
        },
    }


def _list_jobs_dom(session, selectors=None, url: str = "") -> list[dict]:
    """DOM 兜底：解析当前职位管理页的在招岗位（选择器需真实账号校准）。"""
    sel = {**DEFAULT_JOB_SELECTORS, **(selectors or {})}

    cards = session.page.locator(sel["job_cards"]).all()
    if not cards:
        raise RuntimeError(
            f"职位条目未命中或列表为空：若账号确有在招职位，请用真实账号打开 "
            f"{url or '职位管理页'} 校对 config.json 的 selectors.job_*"
        )
    jobs = []
    for card in cards:
        title = _text(card, sel["job_title"])
        if not title:
            continue
        city = _text(card, sel["job_city"])
        salary = _text(card, sel["job_salary"])
        status_raw = _text(card, sel["job_status"])
        jobs.append({
            "jobId": stable_job_id(title, city),
            "jobTitle": title,
            "location": city,
            "salary": salary,
            "bossStatus": status_raw,
            "status": "open" if ("开放中" in status_raw or "招聘中" in status_raw or not status_raw) else "closed",
            "jdRaw": f"{title}｜{city}｜{salary}（从 BOSS 同步，JD 详情可在系统内补全）",
            "meta": {"createdAt": now_iso(), "syncedFrom": "boss"},
        })
        time.sleep(0.2)
    return jobs


def _text(card, selector) -> str:
    loc = card.locator(selector)
    try:
        return loc.first.inner_text().strip() if loc.count() else ""
    except Exception:
        return ""
