# BOSS 沟通会话扫描：识别候选人「已发简历 / 已同意发简历」事件 → 系统自动更新简历状态。
# 通道（按序回退）：
#   1. 被动捕获（主）：导航到聊天页，监听页面自身发出的 /wapi/ XHR 数据响应——
#      页面请求自带合法 __zp_stoken__ 等风控凭证，我们只读响应、零主动试探
#      （旧 zpchat/getFriendList 端点已 404 下线；主动重放未知参数会触发风控，默认不再直调）；
#   2. API 直调（仅显式校准）：config.api.friendList / api.chatList 配置了覆盖端点时启用；
#   3. 聊天页 DOM（兜底）：解析 .geek-item 会话条目，读「最新一条消息」预览。
# 首次真实运行落 chat_raw_sample.json（捕获端点清单 + 会话条目 + DOM 结构探针）供字段校准；
# 事件识别为保守关键词匹配，宁可漏判：漏判可用候选人详情页「手动登记简历已收到」兜底，误判会污染状态。
# watch（关注名单）由网关注入：[{geekId, name}]，只关注名单命中的会话（名单外会话无候选可更新）。
import json
import random
import re
import time
from datetime import datetime
from pathlib import Path

import boss_api
from boss_api import ApiError, SecurityCheckError
from safety import now_iso

API_FRIEND_LIST = "/wapi/zpchat/boss/getFriendList.json"       # 旧端点：已 404，仅作显式覆盖时的回退
API_FRIEND_LIST_ALT = "/wapi/zpchat/geek/getFriendList.json"   # 旧端点备路径
API_CHAT_LIST = "/wapi/zpchat/boss/getChatList.json"           # 旧端点：单会话消息历史
API_CHAT_LIST_ALT = "/wapi/zpchat/geek/getChatList.json"       # 备

# 已发简历（强语义：简历已实际送达；不含我方话术可能出现的措辞）。
# 不含「发我」类模式：那是招聘方请求用语（把简历发我看看），非候选人送达确认。
SENT_PATTERNS = (
    "发来了简历", "发来简历", "发送了简历", "已发送简历", "简历已发送", "简历已发",
    "已发简历", "发您简历", "发你简历", "附件简历", "发来了附件",
    "简历发过来", "简历发过去", "简历发您", "简历发你", "简历已通过", "简历已投",
    "简历请查收", "发了一份简历",
)
# 已同意发简历（组合规则，语序无关）：消息含「简历」+「发」且
#   ① 含时间/准备词（稍后/回头/这就/马上/整理…），或 ② 以应答词开头（好的/可以/嗯/我…）。
# 我方话术（请问方便发一份简历吗 / 如果感兴趣可以发一份简历给我）两条都不满足，不会误判。
AGREE_TIME_MARKERS = ("稍后", "稍候", "回头", "这就", "马上", "晚点", "待会", "等下", "整理")
AGREE_START_RE = re.compile(r"^(好的|好嘞|好滴|可以|行|没问题|嗯+|ok+|OK|Ok|哦|噢|收到|我)")

FRIEND_ID_KEYS = ("encryptFriendId", "friendId", "encryptGeekId", "encryptUserId",
                  "encryptUid", "uid", "targetId")
FRIEND_NAME_KEYS = ("name", "friendName", "geekName", "nickname", "userName")
LAST_MSG_KEYS = ("lastMessage", "lastMsg", "lastContent", "lastMsgContent",
                 "recentMsg", "msgPreview", "lastMsgText")
LAST_TIME_KEYS = ("lastMsgTime", "lastMessageTime", "lastTime", "updateTime",
                  "lastUpdateTime", "lastContactTime")

# 被动捕获：会话列表端点 URL 特征（message/list/box 为 2026-09 聊天页实测端点）
BOX_URL_MARKS = ("message/list/box", "friendlist", "friend/list")
# 结构探测兜底要求 URL 含 chat：聊天页数据端点都带 chat 字样，避免误吞职位列表等其他响应
CHAT_URL_MARK = "chat"
# 被动捕获等待上限：聊天页数据请求在导航后数秒内发出
PASSIVE_WAIT_MAX = 12.0


def scan_chat(session, selectors=None, pages=None, apis=None, watch=None, max_friends=60):
    """扫描沟通会话：返回关注名单内每个会话的简历事件（resumeSent / resumeAgreed）。

    session 为已 open 的 BossSession；关注名单为空时直接返回（无候选可更新，不发请求）。
    CDP 附着模式下新开专用标签页执行扫描（结束后关闭），不抢占招聘者正在操作的页面。
    """
    from boss_driver import DEFAULT_PAGES
    url = {**DEFAULT_PAGES, **(pages or {})}.get("chat")
    watch = [w for w in (watch or [])
             if isinstance(w, dict) and (_s(w.get("geekId")) or _s(w.get("name")))]
    if not watch:
        print("[chat] 关注名单为空（无待收简历候选人），本次跳过扫描", flush=True)
        return []
    own_page, original_page = None, None
    if session.via_cdp:
        try:
            original_page = session.page
            own_page = session.new_tab()
            session.page = own_page
            print("[chat] CDP 附着：已开独立扫描标签页（不影响当前浏览的页面）", flush=True)
        except Exception as e:
            print(f"[chat] 独立标签页创建失败，退回共享页面扫描：{e}", flush=True)
            own_page = original_page = None
    try:
        return _scan_chat_channels(session, url, selectors, pages, apis, watch, max_friends)
    finally:
        if own_page is not None:
            try:
                own_page.close()
            except Exception:
                pass
            session.page = original_page


def _scan_chat_channels(session, url, selectors, pages, apis, watch, max_friends):
    # 通道1：被动捕获（主）——页面自身带合法风控凭证请求，只读响应
    try:
        friends = _scan_passive(session, url, selectors, watch, max_friends)
        if friends is not None:
            return friends
    except SecurityCheckError:
        raise
    except Exception as e:
        print(f"[chat] 被动捕获通道失败，回退后续通道：{e}", flush=True)
    # 通道2：API 直调（仅显式校准：config.api.friendList 配置了覆盖端点时才启用）
    if (apis or {}).get("friendList"):
        try:
            session.goto(url)
            session.assert_login("沟通列表页")
            boss_api.assert_no_security(session.page)
            return _scan_api(session, url, apis, watch, max_friends)
        except SecurityCheckError:
            raise
        except Exception as e:
            print(f"[chat] API 通道失败，回退 DOM：{e}", flush=True)
    # 通道3：DOM 兜底
    return _scan_dom(session, url, selectors, watch)


# ---------------- 被动捕获通道（主） ----------------

def _scan_passive(session, url, selectors, watch, max_friends):
    """两阶段被动扫描，全程零主动接口请求：

    阶段1 导航到聊天页，捕获会话列表（getBossFriendListV2：真实姓名 + encryptUid + lastTS，
    但 lastMsg 为 null，不含消息内容）；
    阶段2 对关注命中的会话，在 DOM 中点击对应条目（与打招呼送达同款交互），
    捕获页面自行拉取的消息历史响应，按关键词识别简历事件。

    返回 list（含空列表=结果确定，不再回退）；返回 None=未捕获到会话列表（调用方走后续通道）。
    """
    p = session.page
    captured = []

    def on_response(resp):
        try:
            if resp.request.resource_type not in ("xhr", "fetch"):
                return
            u = resp.url
            if "/wapi/" not in u or resp.status != 200:
                return
            data = resp.json()
            if isinstance(data, dict):
                captured.append({"url": u, "data": data})
        except Exception:
            pass

    p.on("response", on_response)
    try:
        session.goto(url, settle=2.0)
        session.assert_login("沟通列表页")
        boss_api.assert_no_security(p)
        deadline = time.time() + PASSIVE_WAIT_MAX
        while time.time() < deadline and not _find_box(captured):
            time.sleep(0.5)
    finally:
        try:
            p.remove_listener("response", on_response)
        except Exception:
            pass

    box = _find_box(captured)
    _dump_passive_sample(captured, box, p)
    if not box:
        print(f"[chat] 被动捕获 {len(captured)} 个 /wapi/ 响应，未识别到会话列表"
              f"（端点清单已存 chat_raw_sample.json 供校准）", flush=True)
        return None
    items = box["items"]
    print(f"[chat] 被动捕获命中会话列表（{box['path']}）：{len(items)} 个会话", flush=True)
    targets = _pick_targets(items, watch, max_friends)
    print(f"[chat] 关注名单命中 {len(targets)} 个会话"
          + ("" if targets else "（名单内候选人未出现在沟通列表，可能尚未回复）"), flush=True)
    out = []
    for it in targets:
        out.append(_scan_one_conversation(session, it, selectors))
        if len(targets) > 1:
            time.sleep(random.uniform(1.0, 2.0))  # 会话切换间隔，贴近人工操作节奏
    return out


def _scan_one_conversation(session, item, selectors) -> dict:
    """单个命中会话：点击条目拉消息历史（被动捕获）→ 关键词识别简历事件。

    消息历史拉不到时退回会话条目自带的最新消息预览（V2 列表常为空，此时仅登记会话存在）。
    """
    name = _friend_name(item)
    fid = _friend_id(item)
    base = {"friendId": fid, "name": name,
            "resumeSent": False, "resumeSentAt": "",
            "resumeAgreed": False, "resumeAgreedAt": "", "lastMsg": ""}
    msgs = _load_history_by_click(session, item, selectors)
    if msgs:
        sent_at, agreed_at, last_msg = _detect_events(msgs, item)
        _dump_raw_sample("message", msgs)
        return {**base, "resumeSent": bool(sent_at), "resumeSentAt": sent_at,
                "resumeAgreed": bool(agreed_at) and not sent_at,
                "resumeAgreedAt": agreed_at if (agreed_at and not sent_at) else "",
                "lastMsg": last_msg, "via": "passive"}
    last = _last_msg_of(item)
    kind = _classify(last)
    at = _item_time(item)
    return {**base, "resumeSent": kind == "sent", "resumeSentAt": at if kind == "sent" else "",
            "resumeAgreed": kind == "agreed", "resumeAgreedAt": at if kind == "agreed" else "",
            "lastMsg": last[:60], "via": "passive-list"}


def _load_history_by_click(session, item, selectors, timeout=8.0) -> list[dict]:
    """在会话列表 DOM 中点击目标条目，捕获页面自行拉取的消息历史响应。

    只做 UI 点击（与人工查看会话一致），数据请求由页面带合法凭证发起；
    条目在可见列表中找不到时跳过（新打招呼的候选人会话靠前，通常可见）。
    """
    from boss_driver import CHAT_SELECTORS
    p = session.page
    name = _friend_name(item)
    if not name:
        return []
    sel = {**CHAT_SELECTORS, **(selectors or {})}
    history = []

    def on_response(resp):
        try:
            if resp.request.resource_type not in ("xhr", "fetch"):
                return
            u = resp.url
            if "/wapi/" not in u or resp.status != 200:
                return
            data = resp.json()
            if isinstance(data, dict):
                history.append({"url": u, "data": data})
        except Exception:
            pass

    p.on("response", on_response)
    try:
        try:
            p.wait_for_selector(sel["chat_item"], timeout=8000)
        except Exception:
            print(f"[chat] 会话列表条目（{sel['chat_item']}）未就绪，跳过「{name}」的消息历史", flush=True)
            return []
        clicked = False
        for el in p.locator(sel["chat_item"]).all()[:60]:
            try:
                txt = el.inner_text(timeout=1000) or ""
            except Exception:
                continue
            if name and name in txt:
                el.click()
                clicked = True
                break
        if not clicked:
            print(f"[chat] 会话列表可见条目中未找到「{name}」，跳过其消息历史", flush=True)
            return []
        deadline = time.time() + timeout
        while time.time() < deadline and not _find_message_list(history):
            time.sleep(0.4)
    finally:
        try:
            p.remove_listener("response", on_response)
        except Exception:
            pass
    msgs = _find_message_list(history)
    if not msgs and history:
        _dump_raw_sample("historyUrls", [c["url"] for c in history])  # 消息列表未识别：留 URL 供校准
    return msgs or []


def _find_message_list(captured) -> list[dict]:
    """从捕获响应中识别消息历史列表（结构探测）。

    不做 URL 过滤：实测消息端点 /wapi/zpmsg/history/pull 既不含 chat 也不含 message，
    点击窗口内捕获的响应本来就少，靠「条目像消息（含文本+时间）」的结构特征判定。
    """
    for c in captured:
        msgs = _deep_find_messages(c["data"])
        if msgs:
            return msgs
    return []


def _deep_find_messages(node, depth=0) -> list[dict]:
    """深度优先探测消息列表：多数条目含消息文本且部分含时间戳。"""
    if depth > 5 or not isinstance(node, (dict, list)):
        return []
    if isinstance(node, dict):
        for v in node.values():
            hit = _deep_find_messages(v, depth + 1)
            if hit:
                return hit
        return []
    dicts = [x for x in node if isinstance(x, dict)]
    if dicts and len(dicts) >= len(node) - 1 and _looks_like_messages(dicts):
        return dicts
    for x in node[:5]:
        hit = _deep_find_messages(x, depth + 1)
        if hit:
            return hit
    return []


def _looks_like_messages(items) -> bool:
    n = max(len(items), 1)
    with_text = sum(1 for it in items if _msg_text(it))
    with_time = sum(1 for it in items
                    if any(isinstance(it.get(k), (int, float)) and it.get(k) > 0
                           for k in ("time", "createTime", "ctime", "timestamp", "sendTime")))
    return with_text / n >= 0.5 and with_time / n >= 0.3


def _find_box(captured):
    """从捕获响应中识别会话列表：优先 URL 特征（message/list/box 实测端点），否则按结构探测。"""
    for c in captured:
        if any(m in c["url"].lower() for m in BOX_URL_MARKS):
            items = _find_conversation_list(c["data"])
            if items:
                return {"url": c["url"], "path": c["url"].split("?")[0], "items": items}
    for c in captured:
        if CHAT_URL_MARK in c["url"].lower():
            items = _find_conversation_list(c["data"])
            if items:
                return {"url": c["url"], "path": c["url"].split("?")[0], "items": items}
    return None


def _find_conversation_list(node, depth=0):
    """深度优先探测会话条目列表：返回首个「多数条目含姓名键+ID 键」的 dict 列表。"""
    if depth > 5 or not isinstance(node, (dict, list)):
        return []
    if isinstance(node, dict):
        for v in node.values():
            hit = _find_conversation_list(v, depth + 1)
            if hit:
                return hit
        return []
    dicts = [x for x in node if isinstance(x, dict)]
    if dicts and len(dicts) >= len(node) - 1 and _looks_like_conversations(dicts):
        return dicts
    for x in node[:5]:
        hit = _find_conversation_list(x, depth + 1)
        if hit:
            return hit
    return []


def _looks_like_conversations(items) -> bool:
    """列表是否像会话列表：多数条目同时带姓名键与 ID 键。"""
    n = max(len(items), 1)
    named = sum(1 for it in items if _friend_name(it))
    ided = sum(1 for it in items if _friend_id(it))
    return named / n >= 0.5 and ided / n >= 0.5


def _last_msg_of(item) -> str:
    """会话条目的最新消息文本：先取 lastMessage 类专用键，退回 content/text 类通用键。"""
    for k in LAST_MSG_KEYS:
        v = item.get(k)
        if isinstance(v, dict):
            s = _text_of_obj(v)
            if s:
                return s
        if isinstance(v, str) and v.strip():
            return v.strip()
    return _msg_text(item)


def _item_time(it) -> str:
    """会话条目的最近联系时间：数字时间戳转 ISO，字符串原样截断。"""
    for k in LAST_TIME_KEYS:
        v = it.get(k)
        if isinstance(v, (int, float)) and v > 0:
            ts = v / 1000 if v > 10 ** 12 else v
            try:
                return datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")
            except Exception:
                pass
        if isinstance(v, str) and v.strip():
            return v.strip()[:19]
    return now_iso()


def _dump_passive_sample(captured, box, page):
    """落校准样本：捕获端点清单（含 zpData 键名）+ 会话条目 + DOM 结构探针。"""
    try:
        path = Path(__file__).with_name("chat_raw_sample.json")
        sample = {
            "captured": [
                {"url": c["url"],
                 "zpKeys": sorted((c["data"].get("zpData") or {}).keys())
                 if isinstance(c["data"].get("zpData"), dict) else []}
                for c in captured[:40]
            ],
            "domProbe": _dom_probe(page),
        }
        if box:
            sample["boxEndpoint"] = box["url"]
            sample["boxItems"] = box["items"][:5]
        path.write_text(json.dumps(sample, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[chat] 被动捕获样本已存 {path.name}（端点清单+会话条目+DOM 探针，供校准）", flush=True)
    except Exception as e:
        print(f"[chat] 样本保存失败（不影响扫描）：{e}", flush=True)


def _dom_probe(page):
    """DOM 结构探针：左侧会话列表容器的候选选择器命中情况（供 selectors.chat_item 校准）。

    聊天页是 SPA，加载后常有一次内部跳转（Execution context destroyed）——重试 3 次。
    """
    for attempt in range(3):
        try:
            out = page.evaluate("""() => {
                const found = [];
                for (const sel of ['.geek-item', '[class*="chat-item"]', '[class*="friend"]',
                                   '[class*="conversation"]', '[class*="geek"]', '[class*="chat-list"]',
                                   '[class*="list-item"]']) {
                    const els = document.querySelectorAll(sel);
                    if (els.length) found.push({
                        sel, count: Math.min(els.length, 99),
                        firstClass: String(els[0].className).slice(0, 120),
                        firstText: (els[0].innerText || '').replace(/\\n/g, ' | ').slice(0, 160),
                    });
                }
                return found;
            }""")
            if out:
                return out
        except Exception as e:
            if attempt >= 2:
                return [f"DOM 探针失败: {e}"]
        time.sleep(1.5)
    return ["DOM 探针：页面无可识别的会话容器"]


# ---------------- API 通道（仅显式校准时启用） ----------------

def _scan_api(session, url, apis, watch, max_friends) -> list[dict]:
    client = boss_api.build_client(session.page, referer=url)
    try:
        items = _friend_list(client, apis, 5)
        targets = _pick_targets(items, watch, max_friends)
        print(f"[chat] 会话列表 {len(items)} 个，命中关注名单 {len(targets)} 个，逐个拉取聊天记录", flush=True)
        out, dumped = [], False
        for friend in targets:
            time.sleep(random.uniform(0.8, 1.6))  # 会话间隔，降低风控暴露
            msgs = _chat_history(client, friend, apis)
            if not dumped and msgs:
                _dump_raw_sample("message", msgs)
                dumped = True
            sent_at, agreed_at, last_msg = _detect_events(msgs, friend)
            out.append(_friend_result(friend, sent_at, agreed_at, last_msg))
        return out
    finally:
        client.close()


def _friend_list(client, apis, max_pages) -> list[dict]:
    overrides = apis or {}
    paths = [p for p in (overrides.get("friendList"), API_FRIEND_LIST, API_FRIEND_LIST_ALT) if p]
    errors = []
    for path in paths:
        items = []
        try:
            for page_no in range(1, max_pages + 1):
                data = boss_api.fetch_httpx(client, "GET", path,
                                            params={"page": page_no, "status": 0, "_": int(time.time() * 1000)})
                zp = data.get("zpData") or {}
                chunk = next((v for v in (zp.get("result"), zp.get("list"), zp.get("data"),
                                          zp.get("friendList")) if isinstance(v, list)), [])
                if not chunk:
                    break
                items.extend(chunk)
                if zp.get("hasMore") is False or len(chunk) < 10:
                    break  # 无更多页早停，减少请求
                time.sleep(random.uniform(0.6, 1.2))
            if items:
                print(f"[chat] 会话列表 {path} 命中：{len(items)} 条", flush=True)
                _dump_raw_sample("friend", items)
                return items
            errors.append(f"{path}: zpData 无会话（{str(zp)[:60]}）")
        except SecurityCheckError:
            raise
        except ApiError as e:
            errors.append(f"{path}: {e}")
    raise ApiError("会话列表端点均未取到数据 → " + " | ".join(errors))


def _chat_history(client, friend, apis) -> list[dict]:
    fid = _friend_id(friend)
    if not fid:
        return []
    overrides = apis or {}
    paths = [p for p in (overrides.get("chatList"), API_CHAT_LIST, API_CHAT_LIST_ALT) if p]
    for path in paths:
        try:
            data = boss_api.fetch_httpx(client, "GET", path,
                                        params={"friendId": fid, "page": 1, "_": int(time.time() * 1000)})
            zp = data.get("zpData") or {}
            return next((v for v in (zp.get("result"), zp.get("list"), zp.get("data"),
                                     zp.get("messages")) if isinstance(v, list)), [])
        except SecurityCheckError:
            raise
        except ApiError as e:
            print(f"  [chat] {path} 拉取失败，尝试下一端点：{e}", flush=True)
    return []


# ---------------- 会话匹配与事件识别 ----------------

def _pick_targets(items, watch, max_friends) -> list[dict]:
    out, seen = [], set()
    for it in items:
        hit = _watch_hit(it, watch)
        if not hit:
            continue
        fid = _friend_id(it)
        key = fid or f"name:{_friend_name(it)}"
        if key in seen:
            continue
        seen.add(key)
        out.append(it)
        if len(out) >= max_friends:
            break
    return out


def _watch_hit(it, watch):
    """会话条目 → 关注名单命中：geekId 精确匹配 > 姓氏唯一匹配（同姓多人无法定位则跳过，宁漏勿误）。"""
    ids = {_s(it.get(k)) for k in FRIEND_ID_KEYS if _s(it.get(k))}
    for w in watch:
        if _s(w.get("geekId")) and _s(w["geekId"]) in ids:
            return w
    first = _friend_name(it)[:1]
    if first:
        same = [w for w in watch if _s(w.get("name"))[:1] == first]
        if len(same) == 1:
            return same[0]
    return None


def _detect_events(msgs, friend):
    """扫描一个会话的消息历史：返回 (已发简历时间, 已同意发简历时间, 最新消息预览)。"""
    geek_ids = {_s(friend.get(k)) for k in FRIEND_ID_KEYS if _s(friend.get(k))}
    sent_at, agreed_at, last_msg = "", "", ""
    for m in msgs:
        text = _msg_text(m)
        if not text:
            continue
        if not last_msg:
            last_msg = text
        if _is_own_message(m, geek_ids):
            continue
        kind = _classify(text)
        if kind == "sent" and not sent_at:
            sent_at = _msg_time(m)
        elif kind == "agreed" and not agreed_at:
            agreed_at = _msg_time(m)
    return sent_at, agreed_at, last_msg[:60]


def _classify(text: str):
    """消息分类：sent=简历已送达 / agreed=已同意发送 / None。

    疑问句（吗/？结尾）一律不判定；两类同时命中且带时间词（稍后/回头/整理…）
    时判 agreed——「稍后把简历发您」是承诺而非已送达；真正送达通常带 了/过去/请查收 等完成语义。
    """
    t = (text or "").strip()
    if not t or t.endswith(("吗", "？", "?")):
        return None
    sent = _hit(t, SENT_PATTERNS)
    agree = _agree_hit(t)
    if sent and agree and any(m in t for m in AGREE_TIME_MARKERS):
        return "agreed"
    return "sent" if sent else ("agreed" if agree else None)


def _agree_hit(text: str) -> bool:
    """已同意发简历判定：含「简历」+「发」，且带时间/准备词或以应答词开头（语序无关）。

    请求用语（麻烦/能否/可否）不算承诺——那是招聘方向候选人索要简历的措辞。
    """
    t = (text or "").strip()
    if "简历" not in t or "发" not in t:
        return False
    if any(w in t for w in ("麻烦", "能否", "可否")):
        return False
    return any(m in t for m in AGREE_TIME_MARKERS) or bool(AGREE_START_RE.match(t))


def _msg_text(m) -> str:
    """消息文本提取：兼容 content 为字符串 / JSON 字符串 / 对象三种形态。"""
    if not isinstance(m, dict):
        return ""
    for key in ("content", "text", "msg", "message"):
        v = m.get(key)
        if isinstance(v, dict):
            s = _text_of_obj(v)
            if s:
                return s
        if isinstance(v, str) and v.strip():
            s = v.strip()
            if s.startswith("{") or s.startswith("["):
                try:
                    return _text_of_obj(json.loads(s))
                except Exception:
                    return s
            return s
    return ""


def _text_of_obj(obj) -> str:
    if isinstance(obj, str):
        return obj.strip()
    if isinstance(obj, dict):
        for key in ("text", "content", "title", "name", "desc", "fileName"):
            v = obj.get(key)
            s = _text_of_obj(v) if isinstance(v, (str, dict)) else ""
            if s:
                return s
    return ""


def _is_own_message(m, geek_ids) -> bool:
    """能明确识别为「我方（招聘者）发送」的消息：发送者 ID 存在且不等于牛人 ID。"""
    for k in ("fromUid", "from", "senderId", "sendId", "fromId"):
        sender = _s(m.get(k))
        if sender:
            return bool(geek_ids) and sender not in geek_ids
    return False  # 发送者未知：按牛人消息处理（关键词已避开我方话术措辞）


def _msg_time(m) -> str:
    raw = None
    for k in ("time", "createTime", "ctime", "timestamp", "sendTime"):
        v = m.get(k)
        if isinstance(v, (int, float)) and v > 0:
            raw = v
            break
    if not raw:
        return now_iso()
    ts = raw / 1000 if raw > 10 ** 12 else raw  # 毫秒/秒自适应
    try:
        return datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")
    except Exception:
        return now_iso()


def _friend_result(friend, sent_at, agreed_at, last_msg) -> dict:
    return {
        "friendId": _friend_id(friend),
        "name": _friend_name(friend),
        "resumeSent": bool(sent_at),
        "resumeSentAt": sent_at,
        "resumeAgreed": bool(agreed_at) and not sent_at,
        "resumeAgreedAt": agreed_at if (agreed_at and not sent_at) else "",
        "lastMsg": last_msg,
        "via": "api",
    }


# ---------------- DOM 兜底通道（仅会话列表预览，识别最新一条消息） ----------------

def _scan_dom(session, url, selectors, watch) -> list[dict]:
    from boss_driver import CHAT_SELECTORS
    if not watch:
        return []
    sel = {**CHAT_SELECTORS, **(selectors or {})}
    p = session.page
    if url and url not in (p.url or ""):
        try:
            session.goto(url)
            session.assert_login("沟通列表页")
        except Exception as e:
            print(f"[chat] DOM 兜底导航失败：{e}", flush=True)
            return []
    try:
        p.wait_for_selector(sel["chat_item"], timeout=8000)
    except Exception:
        print(f"[chat] DOM 通道未命中会话列表（{sel['chat_item']}）：请校准 config.json selectors.chat_item", flush=True)
        return []
    out = []
    for item in p.locator(sel["chat_item"]).all()[:80]:
        try:
            text = (item.inner_text(timeout=1500) or "").strip()
        except Exception:
            continue
        if not text:
            continue
        lines = [l.strip() for l in text.split("\n") if l.strip()]
        name = ""
        try:
            nl = item.locator(sel["chat_name"])
            if nl.count():
                name = nl.first.inner_text(timeout=800).strip()
        except Exception:
            pass
        if not name:
            name = lines[0]
        fid = ""
        for attr in ("data-id", "data-uid", "data-geek-id", "data-friend-id", "data-encrypt-id"):
            v = item.get_attribute(attr)
            if v:
                fid = v
                break
        if not _watch_hit({"name": name, "encryptFriendId": fid}, watch):
            continue
        preview = " ".join(lines[1:]) or text
        kind = _classify(preview)
        sent_at = now_iso() if kind == "sent" else ""
        agreed_at = now_iso() if kind == "agreed" else ""
        if sent_at or agreed_at:
            out.append({
                "friendId": fid, "name": name,
                "resumeSent": bool(sent_at), "resumeSentAt": sent_at,
                "resumeAgreed": bool(agreed_at), "resumeAgreedAt": agreed_at,
                "lastMsg": preview[:60], "via": "dom",
            })
    if out:
        print(f"[chat] DOM 通道识别到 {len(out)} 个简历事件（仅覆盖各会话最新一条消息）", flush=True)
    else:
        print("[chat] DOM 通道完成：会话列表已读取，关注名单无命中或无简历事件", flush=True)
    return out


# ---------------- 通用 ----------------

def _dump_raw_sample(kind: str, payload, n: int = 5):
    """按 kind 追加保存原始样本（friend=会话条目 / message=消息），供端点与字段校准。"""
    try:
        path = Path(__file__).with_name("chat_raw_sample.json")
        data = {}
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                data = {}
        data[kind] = payload[:n] if isinstance(payload, list) else payload
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[chat] 原始样本已存 {path.name}[{kind}]（用于端点/字段校准）", flush=True)
    except Exception as e:
        print(f"[chat] 原始样本保存失败（不影响扫描）：{e}", flush=True)


def _friend_id(it) -> str:
    for k in FRIEND_ID_KEYS:
        v = _s(it.get(k))
        if v:
            return v
    return ""


def _friend_name(it) -> str:
    for k in FRIEND_NAME_KEYS:
        v = _s(it.get(k))
        if v:
            return v
    return ""


def _hit(text: str, patterns) -> bool:
    t = text or ""
    return any(p in t for p in patterns)


def _s(v) -> str:
    return "" if v is None else str(v).strip()
