# BOSS 内部 API 直调：数据获取不解析页面 DOM，直接取接口 JSON。
# 通道（按优先级，调用方依次回退）：
#   1. httpx 直调（主通道）：从活会话（CDP 附着 / cookie 注入后的页面）导出 cookie + UA，
#      构建独立 httpx 客户端直发内部接口——快、稳、无 DOM 依赖；zp_stoken 等会话 cookie 随头部携带。
#   2. 页面 fetch（兜底）：page.evaluate 在页面上下文发请求，token/UA/cookie 全由浏览器自动生成，
#      httpx 被风控参数拦截时回退（两通道返回的数据形态一致）。
# 端点与请求方式均为社区逆向共识值，可被 config.json 的 api 字段覆盖；首次真实运行失败请按日志提示校准。
import urllib.parse

BOSS_ORIGIN = "https://www.zhipin.com"

# 搜索牛人（招聘端）端点链：社区逆向共识值（boss-zhipin-mcp / Auto-Recruiting 等），
# 首个失败依次回退；全部可被 config.json 的 api 字段覆盖（键名见 search_geeks）
API_SEARCH_GEEKS = "/wapi/zpgeek/searchgeek/geeks.json"      # 主：搜索流（GET，query/city/page）
API_SEARCH_GEEKS_ZPJOB = "/wapi/zpjob/rec/geek/list"         # 备：新版 zpjob 招聘端（POST 表单）
API_RECOMMEND_GEEKS = "/wapi/zpgeek/recommend/recommendgeek.json"  # 兜底：推荐牛人流
# 打招呼（建立沟通关系）端点链；jobId/jid 为 BOSS 端职位 ID
API_ADD_RELATION = "/wapi/zpboss/chat/addRelation.json"      # 主（securityId/jobId/expectId/lid）
API_GREET_ZPJOB = "/wapi/zpjob/chat/start"                   # 备：新版 zpjob（expectId/jid/securityId）
# 在招职位列表（岗位同步用；Auto-Recruiting 同源）
API_JOB_LIST = "/wapi/zpjob/job/data/list"
# BOSS 安全验证页特征（URL 级）
SECURITY_URL_MARKS = ("security-check", "/web/common/security", "captcha", "verify")
# 登录页特征（httpx 通道识别会话失效）
LOGIN_URL_MARKS = ("/web/user/", "login")

# BOSS 城市编码（搜索接口 city 参数用）；未知城市回退空 = 平台默认城市
CITY_CODES = {
    "北京": "101010100", "上海": "101020100", "广州": "101280100", "深圳": "101280600",
    "杭州": "101210100", "成都": "101270100", "南京": "101190100", "武汉": "101200100",
    "西安": "101110100", "苏州": "101190400", "天津": "101030100", "重庆": "101040100",
    "长沙": "101250100", "郑州": "101180100", "东莞": "101281600", "青岛": "101120200",
    "合肥": "101220100", "佛山": "101280800", "宁波": "101210400", "厦门": "101230200",
    "大连": "101070200", "福州": "101230100", "济南": "101120100", "珠海": "101280700",
    "无锡": "101190200", "昆明": "101290100", "哈尔滨": "101050100", "沈阳": "101070100",
    "长春": "101060100", "石家庄": "101090100", "太原": "101100100", "南宁": "101300100",
    "贵阳": "101260100", "兰州": "101160100", "海口": "101310100",
}


class ApiError(RuntimeError):
    """内部接口调用失败（非安全验证类），调用方可回退下一通道。"""


class SecurityCheckError(RuntimeError):
    """命中平台安全验证（风控），必须停止并提示人工处理，禁止自动重试。"""


# httpx 为可选依赖（仅 httpx 直调通道需要）：缺失时该通道降级到「页面 fetch / iframe DOM」，
# 不阻断推荐页 DOM 采集流。惰性加载，避免模块加载即硬崩（无论解释器是否自带 httpx）。
_httpx_mod = None
def _http():
    global _httpx_mod
    if _httpx_mod is None:
        try:
            import httpx as _m
        except Exception as e:  # noqa: BLE001
            raise ApiError(f"httpx 未安装（{e}）：httpx 直调通道降级，改走页面 fetch / iframe DOM 通道")
        _httpx_mod = _m
    return _httpx_mod


def city_code(city: str) -> str:
    return CITY_CODES.get((city or "").strip(), "")


def assert_no_security(page):
    """URL / 标题级安全验证检测：命中即抛 SecurityCheckError（冷却 + 人工介入）。"""
    url = page.url or ""
    if any(m in url for m in SECURITY_URL_MARKS):
        raise SecurityCheckError(
            f"检测到 BOSS 安全验证页面（{url}）：请在弹出的浏览器窗口中手动完成验证后重试；"
            "本会话已自动停止以保护账号"
        )
    # IP / 账号风控拦截页（403.html：访问受限·多次违规访问已被暂时禁止），也按安全验证停止，避免空转抓取
    if "403.html" in url:
        raise SecurityCheckError(
            f"检测到 BOSS 访问受限页（{url}）：账号/IP 已被暂时限制访问，"
            "请等待页面提示的恢复时间后重试；本会话已自动停止以保护账号"
        )
    try:
        title = page.title() or ""
        if "安全验证" in title or "验证码" in title:
            raise SecurityCheckError(
                "检测到 BOSS 安全验证（页面标题含验证字样）：请手动完成验证后重试；本会话已自动停止"
            )
    except SecurityCheckError:
        raise
    except Exception:
        pass


# ---------------- httpx 主通道 ----------------

def build_client(page, referer: str = "", proxy: str = ""):
    """从活会话导出 cookie 与 UA，构建 httpx 客户端（主通道）。

    需在页面已打开 zhipin.com 且登录态校验通过后调用——此时 zp_stoken 等
    动态 cookie 已由页面写入，导出后 httpx 直发即可带上完整凭证。
    proxy 留空 = 直连（与浏览器对中国站点的一致路径）；需走代理时在 config.api.proxy 配置。
    """
    from playwright.sync_api import Page
    if not isinstance(page, Page):
        raise ApiError("构建 httpx 客户端需 playwright 页面（仅页面通道可用时跳过直调）")
    cookies = {c["name"]: c["value"] for c in page.context.cookies(["https://www.zhipin.com"])}
    if not cookies:
        raise ApiError("活会话未取到 zhipin.com cookie：请先打开招聘端页面确认登录态")
    try:
        ua = page.evaluate("() => navigator.userAgent")
    except Exception:
        ua = ""
    headers = {
        "User-Agent": ua or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": referer or f"{BOSS_ORIGIN}/web/chat/recommend",
        "Origin": BOSS_ORIGIN,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
    }
    kwargs = {
        "base_url": BOSS_ORIGIN, "headers": headers, "cookies": cookies,
        "timeout": 15.0, "follow_redirects": False, "trust_env": False,
    }
    if proxy:
        kwargs["proxies"] = proxy
    return _http().Client(**kwargs)


def fetch_httpx(client, method: str, path: str,
                params: dict | None = None, data: dict | None = None) -> dict:
    """httpx 直调内部接口：安全验证 / 风控 / 登录失效统一在此识别。

    不跟随重定向——302 目标是安全验证页还是登录页，由我们判定而非浏览器。
    """
    httpx = _http()
    clean = {k: v for k, v in (params or {}).items() if v not in (None, "")}
    try:
        r = client.request(method.upper(), path, params=clean, data=data)
    except httpx.HTTPError as e:
        raise ApiError(f"httpx 请求失败: {e}") from e
    if r.is_redirect:
        loc = r.headers.get("location", "")
        if any(m in loc for m in SECURITY_URL_MARKS):
            raise SecurityCheckError(
                f"接口被重定向到安全验证页（→ {loc[:100]}）：请手动完成验证后重试；本会话已自动停止"
            )
        if any(m in loc for m in LOGIN_URL_MARKS):
            raise ApiError("登录态已失效（接口被重定向到登录页）：请到系统重新扫码登录 BOSS")
        raise ApiError(f"接口 {path} 被重定向: HTTP {r.status_code} → {loc[:80]}")
    if r.status_code == 403:
        raise SecurityCheckError("接口返回 403（风控拦截）：请手动完成安全验证并稍后再试")
    try:
        data_json = r.json()
    except Exception as e:
        raise ApiError(f"接口 {path} 返回非 JSON: HTTP {r.status_code} {r.text[:80]}") from e
    if not isinstance(data_json, dict):
        raise ApiError(f"接口 {path} 返回异常: HTTP {r.status_code} data={str(data_json)[:120]}")
    code = data_json.get("code")
    if code == 1001 or code == 37 or code == 36:
        raise SecurityCheckError(
            f"接口返回风控拦截（code={code} message={data_json.get('message')}）："
            "请手动完成安全验证并稍后再试"
        )
    if r.status_code != 200:
        raise ApiError(f"接口 {path} 返回异常: HTTP {r.status_code} data={str(data_json)[:120]}")
    if code not in (0, None):
        raise ApiError(f"接口 {path} 业务错误: code={code} message={data_json.get('message')}")
    return data_json


# ---------------- 页面 fetch 兜底通道 ----------------

def fetch_page(page, method: str, path: str, params: dict | None = None, body=None) -> dict:
    """在页面上下文 fetch BOSS 内部接口（兜底通道）：token/UA/cookie 由浏览器自动携带。"""
    qs = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v not in (None, "")})
    url = BOSS_ORIGIN + path + (f"?{qs}" if qs else "")
    if isinstance(body, dict):
        body = urllib.parse.urlencode(body)
    expr = """async ([u, m, b]) => {
        const r = await fetch(u, { method: m, credentials: 'include',
            headers: b ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
            body: b || undefined });
        let data = null; try { data = await r.json(); } catch (e) {}
        return { status: r.status, url: r.url, data };
    }"""
    try:
        res = page.evaluate(expr, [url, method.upper(), body])
    except Exception as e:
        raise ApiError(f"页面 fetch 执行失败: {e}") from e
    status, data = res.get("status"), res.get("data") or {}
    # 被重定向到安全验证页（fetch 跟随后 url 变化）
    if any(m in str(res.get("url", "")) for m in SECURITY_URL_MARKS):
        raise SecurityCheckError(
            "接口请求被重定向到安全验证页：请手动在浏览器完成验证后重试；本会话已自动停止"
        )
    code = data.get("code") if isinstance(data, dict) else None
    if status == 403 or code in (1001, 37, 36):
        raise SecurityCheckError(
            f"接口返回风控拦截（HTTP {status} code={code}）：请手动完成验证并稍后再试"
        )
    if status != 200 or not isinstance(data, dict):
        raise ApiError(f"接口 {path} 返回异常: HTTP {status} data={str(data)[:120]}")
    if data.get("code") not in (0, None):
        raise ApiError(f"接口 {path} 业务错误: code={data.get('code')} message={data.get('message')}")
    return data


def fetch_api(hub, method: str, path: str, params: dict | None = None, body=None) -> dict:
    """统一入口：hub 为 httpx.Client 时直调（主），为 playwright Page 时走页面 fetch（兜底）。"""
    if hasattr(hub, "request"):  # httpx.Client（惰性装不上时该通道本就不会构建成功）
        return fetch_httpx(hub, method, path, params=params, data=body if isinstance(body, dict) else None)
    return fetch_page(hub, method, path, params=params, body=body)


def export_cookies(page) -> str:
    """导出当前页面会话 cookie 串（诊断/外部工具复用）。"""
    pairs = page.context.cookies(["https://www.zhipin.com"])
    return "; ".join(f"{c['name']}={c['value']}" for c in pairs)


# ---------------- 业务封装（通道无关） ----------------

def _geek_list_of(zp: dict) -> list:
    """兼容各端点的 geekList 容器键（geekList / list / result.geekList / data）。"""
    for v in (zp.get("geekList"), zp.get("list"), (zp.get("result") or {}).get("geekList"), zp.get("data")):
        if isinstance(v, list) and v:
            return v
    return []


def _flat_geek(geek: dict) -> dict:
    """zpjob 推荐流（rec/geek/list）的关键字段嵌套在 geekCard（expectId/securityId/lid/geekName…）。

    拍平后与搜索流 / DOM 流的字段形态统一；幂等，对已是平铺结构的 geek 无副作用。
    """
    card = geek.get("geekCard")
    if not isinstance(card, dict):
        return geek
    return {**card, **geek, "geekCard": card}


def search_geeks(hub, query: str, city: str = "", job_id: str = "", page_no: int = 1,
                 page_size: int = 30, apis: dict | None = None) -> list[dict]:
    """搜索牛人：端点链依次尝试，返回原始 geekList（geekCard 已拍平到顶层）。

    带 job_id（BOSS 端 encryptJobId）时首选推荐流 rec/geek/list——按职位推荐候选人，
    GET + 查询串（jobId 必带），参数对齐 Auto-Recruiting；其余为关键词搜索兜底链。
    端点链与参数为社区逆向共识（boss-zhipin-mcp / Auto-Recruiting），
    config.json 的 api 字段可逐项覆盖（键 search / searchZpjob / recommend）。
    """
    overrides = apis or {}
    cc = city_code(city)
    endpoints = []
    if job_id:
        endpoints.append(("searchZpjob", "GET", API_SEARCH_GEEKS_ZPJOB,
                          {"jobId": job_id, "page": page_no}))
    endpoints += [
        ("search", "GET", API_SEARCH_GEEKS,
         {"query": query, "city": cc, "page": page_no, "pageSize": page_size}),
        ("recommend", "GET", API_RECOMMEND_GEEKS, {"city": cc, "page": page_no}),
    ]
    errors = []
    for key, method, default_path, payload in endpoints:
        path = overrides.get(key) or default_path
        try:
            data = fetch_api(hub, method, path, params=payload if method == "GET" else None,
                             body=payload if method == "POST" else None)
            geeks = _geek_list_of(data.get("zpData") or {})
            if geeks:
                print(f"[search] {key} 通道命中：{len(geeks)} 位候选", flush=True)
                return [_flat_geek(g) for g in geeks]
            errors.append(f"{path}: zpData 无候选（{str(data.get('zpData'))[:80]}）")
        except SecurityCheckError:
            raise
        except ApiError as e:
            errors.append(f"{path}: {e}")
    raise ApiError("搜索接口均未取到数据 → " + " | ".join(errors))


def greet_geek(hub, job_id: str, geek: dict, apis: dict | None = None) -> bool:
    """对单个牛人打招呼（建立沟通关系）。securityId/expectId/lid 来自搜索结果携带。

    job_id 必须是 BOSS 端职位 ID（encryptJobId）：chat/start 缺 jid 报 code=17，
    缺 securityId 报 code=1092（Auto-Recruiting 实测注释）；系统内部岗位 ID 无效。
    端点链：addRelation（boss-zhipin-mcp 共识）→ zpjob/chat/start（Auto-Recruiting）；
    每个端点先 POST 表单后 GET 参数，config.api.addRelationMethod 可指定优先方式。
    """
    cfg = apis or {}
    g = _flat_geek(geek)
    security_id = g.get("securityId") or g.get("encryptGeekId") or ""
    expect_id = g.get("encryptExpectId") or g.get("expectId") or ""
    lid = g.get("lid") or ""
    boss_job = str(g.get("jobId") or g.get("encryptJobId") or job_id or "")
    if not security_id:
        return False
    greet_payloads = [
        ("addRelation", API_ADD_RELATION, "POST",
         {"securityId": security_id, "jobId": boss_job, "expectId": str(expect_id), "lid": lid}),
        ("greet", API_GREET_ZPJOB, "POST",
         {"securityId": security_id, "jid": boss_job, "expectId": str(expect_id), "lid": lid, "gid": ""}),
    ]
    errors = []
    for key, default_path, method, payload in greet_payloads:
        path = cfg.get(key) or default_path
        m = str(cfg.get("addRelationMethod", method)).upper() if key == "addRelation" else method
        try:
            data = fetch_api(hub, m, path, params=payload if m == "GET" else None,
                             body=payload if m == "POST" else None)
            return bool(data.get("zpData"))
        except SecurityCheckError:
            raise
        except ApiError as e:
            errors.append(f"{path} {m}: {e}")
    raise ApiError("打招呼端点均未成功 → " + " | ".join(errors))


def list_jobs_api(hub, apis: dict | None = None, max_pages: int = 10) -> list[dict]:
    """拉取当前账号在招职位（API 通道）：GET zpjob/job/data/list，自动翻页聚合。

    参数对齐社区实现（zhipin-js）：page/type/position + 时间戳；返回原始职位列表。
    """
    import time as _time
    path = (apis or {}).get("jobList") or API_JOB_LIST
    out: list[dict] = []
    for page_no in range(1, max_pages + 1):
        data = fetch_api(hub, "GET", path,
                         params={"page": page_no, "type": 0, "position": 0, "_": int(_time.time() * 1000)})
        zp = data.get("zpData") or {}
        chunk = next((v for v in (zp.get("data"), zp.get("list"), zp.get("jobList"))
                      if isinstance(v, list)), [])
        if not chunk:
            break
        out.extend(chunk)
        if zp.get("hasMore") is False:
            break  # 服务端明确无更多页，早停减少请求（降低风控暴露）
    if not out:
        raise ApiError(f"{path}: zpData 无职位列表（{str(zp)[:80]}）")
    return out


def normalize_geek(raw: dict, job_id: str, keyword: str, greet_message: str = "") -> dict:
    """API 原始 geek → 系统 candidate 契约（主键 = expectId，天然跨关键词去重）。

    兼容两种原始形态：搜索流平铺（workExpDesc/salaryDesc）与推荐流 geekCard
    （geekWorkYear/salary/geekDegree/geekDesc.content，2026-09 实测字段名）。
    """
    from safety import now_iso
    raw = _flat_geek(raw)
    expect = str(raw.get("encryptExpectId") or raw.get("expectId") or raw.get("encryptGeekId") or "")
    name = raw.get("geekName") or raw.get("name") or "候选*"
    desc = raw.get("geekDesc")
    if isinstance(desc, dict):
        desc = desc.get("content") or ""
    return {
        "candidateId": f"cand_boss_{expect}",
        "source": "boss",
        "jobId": job_id,
        "name": (name[:1] + "**") if len(name) > 1 else "候选*",
        "status": "sourced",
        "workExperienceYears": _years(raw.get("workExpDesc") or raw.get("workExp")
                                      or raw.get("geekWorkYear") or ""),
        "expectSalary": raw.get("salaryDesc") or raw.get("expectSalary")
                        or raw.get("salary") or "",
        "resume": {
            # 契约枚举只允许 pdf/docx/html/image/text；BOSS 结构化字段已拼为纯文本 rawText
            "status": "pending", "format": "text",
            "rawText": _raw_text(raw, desc),
        },
        "meta": {
            "createdAt": now_iso(), "masked": True,
            "sourceLink": f"boss:expect={expect}",
            "expectId": expect,
            "geekId": raw.get("encryptGeekId") or raw.get("encGeekId") or "",
            "securityId": raw.get("securityId") or "",
            "lid": raw.get("lid") or "",
            "sourceKeyword": keyword,
            "greeted": False,
            "greetMessage": greet_message,
            "city": raw.get("city") or "",
            "expectPosition": raw.get("expectPositionName") or "",
            "skills": _skills(raw),
        },
    }


def _years(desc: str) -> int:
    import re as _re
    m = _re.search(r"(\d{1,2})", str(desc))
    return int(m.group(1)) if m else 0


def _skills(raw: dict) -> list[str]:
    for key in ("skills", "skillTags", "advantage", "geekTags"):
        v = raw.get(key)
        if isinstance(v, list):
            return [str(x)[:20] for x in v[:8]]
        if isinstance(v, str) and v:
            return [p.strip() for p in v.replace("，", ",").split(",") if p.strip()][:8]
    return []


def _raw_text(raw: dict, desc: str = "") -> str:
    # 不放明文姓名（name 字段已脱敏），只保留结构化要素
    parts = [
        raw.get("expectPositionName") or "",
        raw.get("salaryDesc") or raw.get("salary") or "",
        raw.get("workExpDesc") or raw.get("geekWorkYear") or "",
        raw.get("eduLevel") or raw.get("education") or raw.get("geekDegree") or "",
        " ".join(_skills(raw)),
        desc or raw.get("advantage") or raw.get("selfDesc") or "",
    ]
    return "｜".join(p for p in parts if p)[:500]
