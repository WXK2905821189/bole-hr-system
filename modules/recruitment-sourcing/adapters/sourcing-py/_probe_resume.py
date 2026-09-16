# 只读探针：验证「点开牛人→截在线简历→算分」修复是否生效（不打招呼）
import os, sys
from pathlib import Path
from boss_driver import BossDriver
from safety import SafetyLimiter

HERE = Path(__file__).resolve().parent


def main():
    gateway = os.environ.get("GW") or "http://127.0.0.1:4700"
    auth = os.environ.get("HR_AUTH_TOKEN") or ""
    bid = os.environ.get("HR_BOSS_JOB_ID") or ""
    cookies = os.environ.get("HR_BOSS_COOKIES") or None
    cdp = os.environ.get("HR_BOSS_CDP") or None
    job_id = os.environ.get("JOB_ID") or ""

    d = BossDriver(
        account_name="boss", cookies=cookies, cdp=cdp,
        headless=False, use_edge=True, max_greet=1, boss_job_id=bid, keep_open=False,
        pre_match=True, pre_threshold=60, gateway_url=gateway, auth_token=auth,
    )
    lim = SafetyLimiter()
    try:
        d.session.open()
        d.session.goto(d.pages["recommend"], settle=2.5)
        try:
            d.session.assert_login("推荐牛人页")
            print("LOGIN_OK", flush=True)
        except Exception as e:
            print("LOGIN_FAIL", e, flush=True)
        d._client = None
        d._collect_recommend_cards()
        if not d._recommend_cards_sel:
            print("NO_CARDS_SELECTOR", flush=True)
            return 2
        # 重新取一次卡片（含 resumeHref）
        cards = BossDriver._extract_cards_dom(d.session.page, d._recommend_cards_sel, d._recommend_link_sel)
        print("CARDS=", len(cards), flush=True)
        if not cards:
            print("NO_CARDS", flush=True)
            return 2
        g = cards[0]
        print("FIRST_CARD=", json_dumps_small(g), flush=True)
        txt = d._extract_online_resume(g)
        print("RESUME_TEXT_LEN=", len(txt), flush=True)
        print("RESUME_TEXT_HEAD=", txt[:150], flush=True)
        if not txt:
            print("RESUME_EMPTY", flush=True)
            return 3
        score, passed, via = d._prematch_score(g, job_id or bid)
        print(f"SCORE={score} PASSED={passed} VIA={via}", flush=True)
        return 0
    finally:
        try:
            d.session.close()
        except Exception:
            pass


def json_dumps_small(dct):
    import json
    small = {k: (str(v)[:60] if isinstance(v, str) else v) for k, v in dct.items()}
    return json.dumps(small, ensure_ascii=False)


if __name__ == "__main__":
    sys.exit(main())