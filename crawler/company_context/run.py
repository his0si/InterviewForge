"""드라이버 / CLI — 레지스트리 기반 company_contexts 수집.

모드:
  --company <key>     : 등록된 회사 1곳 수집(work_culture/official_articles/external_news 중 설정된 것).
  --top N             : job_postings.company 빈도 상위 N개를 해석해 수집.
                        레지스트리 항목이 있으면 전체 소스, 없으면 회사명 쿼리로 external_news 만 시도.
  --jit <companyName> : 원시 회사명 1건 즉석 수집(앱이 데이터 없는 회사 선택 시 on-demand 호출).

기본 DRY-RUN(PLAN, 쓰기 없음). --execute 로 실제 INSERT.
견고성: 한 회사/소스 실패가 전체 배치를 멈추지 않는다(catch -> company_ingest_runs.note 기록 -> 계속).
DATABASE_URL/비밀번호 미출력.

실행:
  cd /home/ewhaian/E-LIFETHON/InterviewForge/crawler
  .venv/bin/python -m company_context.run --company sk_hynix
  .venv/bin/python -m company_context.run --top 5
  .venv/bin/python -m company_context.run --jit "삼성전자"
  ... --execute 를 붙이면 실제 저장.
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import date, datetime, timezone
from urllib.parse import quote, urlparse

import httpx
from bs4 import BeautifulSoup

from . import engine
from . import registry as reg

# 외부 뉴스 매체별: media_key -> (검색 URL 템플릿, 기사 URL 정규식)
#  - {q} 자리에 URL 인코딩된 쿼리가 들어간다.
#  - SK 스크립트의 OUTLETS 를 회사 비종속(쿼리 파라미터화)으로 일반화한 것.
MEDIA_ADAPTERS = {
    "yna":      ("연합뉴스", "https://www.yna.co.kr/search/index?query={q}",
                 r"https?://www\.yna\.co\.kr/view/AKR\d+"),
    "hankyung": ("한국경제", "https://search.hankyung.com/search/news?query={q}",
                 r"https?://www\.hankyung\.com/article/\d{6,}"),
    "mk":       ("매일경제", "https://www.mk.co.kr/search/?word={q}",
                 r"https?://www\.mk\.co\.kr/news/[\w-]+/\d{6,}"),
    "donga":    ("동아일보", "https://www.donga.com/news/search?query={q}",
                 r"https?://www\.donga\.com/news/[\w/]*?article/all/\d+/\d+/\d+"),
    "khan":     ("경향신문", "https://search.khan.co.kr/search.html?stb=khan&q={q}",
                 r"https?://(?:www\.)?khan\.co\.kr/article/\d+"),
    "hani":     ("한겨레", "https://search.hani.co.kr/search?searchword={q}",
                 r"https?://www\.hani\.co\.kr/arti/[\w/]+/\d+\.html"),
    "chosun":   ("조선일보", "https://www.chosun.com/nsearch/?query={q}",
                 r"https?://www\.chosun\.com/[\w/-]+/\d{4}/\d{2}/\d{2}/[\w-]+/?"),
}

# 이 환경에서 정적 수집이 막히는 매체(사유 기록용).
MEDIA_EXCLUDED_NOTE = {
    "kbs": "검색 페이지 JS 렌더링(정적 httpx 불가)",
    "sbs": "검색 도메인 접근 불가",
    "mbc": "검색 페이지 빈 응답(정적 httpx 불가)",
}

# 외부 뉴스에서 시황/주가성 기사를 1차 제외하기 위한 제목 패턴(SK 스크립트와 동일 취지).
STRONG_STOCK = re.compile(r"(코스피|코스닥|증시|시황|장세|상한가|하한가|목표주가|종목\s*추천|"
                          r"투자의견|순매수|순매도|마감\s*시황|서학개미|레버리지)")
TITLE_COLUMN = re.compile(r"(\[기고\]|\[칼럼\]|\[사설\]|\[오피니언\])")


# ──────────────────────────────────────────────────────────────────────────
# 소스별 수집 함수 — 각각 row 리스트(또는 [])를 반환. 절대 예외를 위로 던지지 않음.
# ──────────────────────────────────────────────────────────────────────────


def ingest_work_culture(entry: dict, log: list[str]) -> list[dict]:
    cfg = entry.get("work_culture")
    if not cfg:
        return []
    url = cfg["url"]
    hints = (cfg.get("selectors") or {}).get("culture_hints")
    res = engine.fetch_clean(url, culture_hints=hints, min_len=80)
    if not res["ok"]:
        log.append(f"work_culture fetch 실패: {res['reason']} ({url})")
        return []
    extracted, notes = engine.exaone_extract(
        "work_culture", res["source_text"], entry["display_name"],
        prompt_version=cfg.get("prompt_version", ""), num_ctx=8192,
    )
    if extracted is None:
        log.append(f"work_culture EXAONE 실패: {'; '.join(notes)[:300]}")
        return []
    row = engine.build_row(
        entry["company_key"], "work_culture",
        title=cfg.get("title") or f"{entry['display_name']} 일하는 방식",
        source_name=cfg.get("source_name") or f"{entry['display_name']} 공식 홈페이지",
        source_url=url, published_at=None, source_text=res["source_text"],
        extracted_data=extracted, fetched_at=res["fetched_at"],
        prompt_version=cfg.get("prompt_version", ""),
    )
    log.append(f"work_culture OK: values={len(extracted.get('values', []))}")
    return [row]


def _parse_list_date(s):
    if not s:
        return None
    m = re.search(r"(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})", s)
    if not m:
        return None
    try:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def ingest_official_articles(entry: dict, log: list[str], limit: int) -> list[dict]:
    cfg = entry.get("official_articles")
    if not cfg:
        return []
    tag_url = cfg["tag_url"]
    since = _parse_list_date(cfg.get("since")) or date(2025, 1, 1)
    item_sel = cfg.get("list_item_selector", "article.item")
    body_sel = cfg.get("body_selector")
    rows: list[dict] = []
    try:
        with httpx.Client(timeout=20, follow_redirects=True, headers=engine.UA) as cli:
            r = cli.get(tag_url)
            if r.status_code != 200:
                log.append(f"official_articles 태그 HTTP {r.status_code}: {tag_url}")
                return []
            soup = BeautifulSoup(r.text, "lxml")
            cands, seen = [], set()
            for it in soup.select(item_sel):
                a = it.find("a", href=True)
                if not a:
                    continue
                from urllib.parse import urljoin
                u = urljoin(str(r.url), a["href"]).split("#")[0].split("?")[0]
                if u in seen:
                    continue
                seen.add(u)
                t = it.find("time")
                draw = (t.get("datetime") if t and t.get("datetime")
                        else (t.get_text(strip=True) if t else it.get_text(" ")))
                d = _parse_list_date(draw)
                if d is None or d < since:
                    continue
                cands.append((u, d))
            log.append(f"official_articles 후보 {len(cands)}건(since={since.isoformat()})")
            if limit:
                cands = cands[:limit]
            for u, d in cands:
                res = engine.fetch_clean(u, body_selector=body_sel, min_len=200)
                engine.polite_sleep()
                if not res["ok"]:
                    log.append(f"  기사 fetch 실패: {res['reason']} ({u})")
                    continue
                extracted, notes = engine.exaone_extract(
                    "official_article", res["source_text"], entry["display_name"],
                    title=res.get("title") or "", prompt_version=cfg.get("prompt_version", ""),
                )
                if extracted is None:
                    log.append(f"  기사 EXAONE 실패({u}): {'; '.join(notes)[:160]}")
                    continue
                rows.append(engine.build_row(
                    entry["company_key"], "official_article",
                    title=res.get("title") or "(제목 미상)",
                    source_name=cfg.get("source_name") or f"{entry['display_name']} Newsroom",
                    source_url=u, published_at=d.isoformat() + "T00:00:00+09:00",
                    source_text=res["source_text"], extracted_data=extracted,
                    fetched_at=res["fetched_at"], prompt_version=cfg.get("prompt_version", ""),
                ))
    except Exception as e:
        log.append(f"official_articles 예외: {type(e).__name__}: {e}")
    log.append(f"official_articles OK rows={len(rows)}")
    return rows


# Naver 뉴스 통합검색(정적 HTML 에 회사별 실기사 링크가 그대로 노출됨 → 회사별 수집 가능).
#  각 매체 자체 검색은 JS 렌더라 쿼리 무관하게 같은 기사만 나와서 신뢰 불가 → Naver 를 1순위로 쓴다.
NAVER_SEARCH_TMPL = "https://search.naver.com/search.naver?where=news&query={q}&sort=0"
NAVER_ART_PAT = r"https?://n\.news\.naver\.com/mnews/article/\d+/\d+"


def _clean_query(name: str) -> str:
    """검색어 정제: 회사 식별 키는 그대로 두되, 뉴스 검색에는 깔끔한 회사명을 쓴다.
    '(주)카카오'→'카카오', '토스뱅크(주)'→'토스뱅크', '씨제이올리브영(CJ올리브영)'→'씨제이올리브영'."""
    s = (name or "").strip()
    s = re.sub(r"주식회사|\(주\)|㈜|\(유\)|유한회사", " ", s)
    s = re.sub(r"\([^)]*\)", " ", s)  # 괄호 보조표기 제거.
    s = re.sub(r"\s+", " ", s).strip()
    return s or (name or "").strip()


# 흔한 한국어 조사/어미 첫 글자 — 회사명 바로 뒤에 와도 "깨끗한 언급"으로 인정.
_PARTICLE_NEXT = set("은는이가을를와과의에도만로으랑께서부터까지보다며고나든")


def _is_hangul(ch: str) -> bool:
    return bool(ch) and "가" <= ch <= "힣"


def _company_mentioned(text: str, name: str) -> bool:
    """text 에 회사명 name 이 '단어 경계'로 등장하는지 본다.
    짧고 흔한 회사명이 더 긴 단어의 일부로 헛매칭되는 것을 막는다(예: '시제'⊂'시제기/시제품').
    - 5글자 이상 고유명사는 부분일치도 신뢰(조사·합성 영향이 작다).
    - 그 외에는 앞 글자가 한글이 아니고, 뒤 글자가 한글이 아니거나 흔한 조사일 때만 인정."""
    if not text or not name:
        return False
    t = text.lower()
    nm = name.lower().strip()
    if not nm:
        return False
    trust = len(nm) >= 5
    i = t.find(nm)
    while i != -1:
        before = t[i - 1] if i > 0 else ""
        after = t[i + len(nm)] if i + len(nm) < len(t) else ""
        before_ok = not _is_hangul(before)
        after_ok = (not _is_hangul(after)) or (after in _PARTICLE_NEXT)
        if trust or (before_ok and after_ok):
            return True
        i = t.find(nm, i + 1)
    return False


def discover_naver_news(query: str, log: list[str]) -> list[str]:
    """Naver 뉴스 검색 1페이지에서 n.news.naver.com 기사 URL 후보를 모은다(회사별·정적)."""
    q = quote(query)
    try:
        with httpx.Client(timeout=20, follow_redirects=True, headers=engine.UA) as cli:
            r = cli.get(NAVER_SEARCH_TMPL.format(q=q))
        urls = list(dict.fromkeys(u.rstrip("/") for u in re.findall(NAVER_ART_PAT, r.text)))
        log.append(f"  Naver 뉴스검색: status={r.status_code} 후보={len(urls)}")
        return urls
    except Exception as e:  # noqa: BLE001
        log.append(f"  Naver 뉴스검색 실패: {type(e).__name__}: {e}")
        return []


def discover_external_news(query: str, media: list[str], log: list[str]) -> list[tuple[str, str]]:
    """매체 검색 1페이지에서 (url, outlet_name) 후보 수집. 회사 비종속(쿼리만 바뀜).
    (구) 매체 자체검색 경로 — JS 렌더 매체는 신뢰 낮음. Naver 가 0건일 때 폴백으로만 쓴다."""
    q = quote(query)
    cands, seen = [], set()
    try:
        with httpx.Client(timeout=20, follow_redirects=True, headers=engine.UA) as cli:
            for mkey in media:
                if mkey in MEDIA_EXCLUDED_NOTE:
                    log.append(f"  매체 제외[{mkey}]: {MEDIA_EXCLUDED_NOTE[mkey]}")
                    continue
                ad = MEDIA_ADAPTERS.get(mkey)
                if not ad:
                    log.append(f"  미지원 매체 키: {mkey}")
                    continue
                outlet, tmpl, pat = ad
                try:
                    r = cli.get(tmpl.format(q=q))
                    hits = 0
                    for m in re.findall(pat, r.text):
                        u = m.rstrip("/")
                        if u in seen:
                            continue
                        seen.add(u)
                        cands.append((u, outlet))
                        hits += 1
                    log.append(f"  {outlet}: status={r.status_code} 후보={hits}")
                except Exception as e:
                    log.append(f"  {outlet} 검색 실패: {type(e).__name__}: {e}")
                engine.polite_sleep(1.5)
    except Exception as e:
        log.append(f"external_news discover 예외: {type(e).__name__}: {e}")
    return cands


def _fetch_news_detail(cli, url):
    r = cli.get(url)
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}")
    soup = BeautifulSoup(r.text, "lxml")
    # 게시일/제목 메타.
    title = None
    og = soup.find("meta", property="og:title")
    if og and og.get("content"):
        title = og["content"].strip()
    pub = None
    for prop in ("article:published_time",):
        t = soup.find("meta", property=prop)
        if t and t.get("content"):
            pub = t["content"]; break
    if not pub:
        t = soup.find("meta", attrs={"itemprop": "datePublished"})
        if t and t.get("content"):
            pub = t["content"]
    # 언론사명: Naver 기사는 og:article:author 가 "연합뉴스 | 네이버" 형태.
    press = None
    a = soup.find("meta", property="og:article:author")
    if a and a.get("content"):
        press = a["content"].split("|")[0].strip() or None
    if title and " | " in title:  # og:title 끝의 " | 네이버" 등 제거.
        title = title.rsplit(" | ", 1)[0].strip()
    paywall = any(k in r.text for k in ["회원만 열람", "회원 전용", "로그인 후 이용", "유료회원"])
    # 본문은 engine.fetch_clean 제너릭으로 재추출(이미 받은 페이지지만 일관성 위해 동일 규칙).
    return soup, title, pub, paywall, press


def ingest_external_news(entry_or_query: dict | str, display: str, company_key: str,
                         log: list[str], limit: int) -> list[dict]:
    """external_news 수집.

    entry_or_query: 레지스트리 entry(dict) 또는 쿼리 문자열(미등록 회사용).
    """
    if isinstance(entry_or_query, dict):
        cfg = entry_or_query.get("external_news") or {}
        query = cfg.get("query") or display
        media = cfg.get("media") or reg.DEFAULT_MEDIA
        subject_keys = [k.lower() for k in (cfg.get("subject_keys") or [])]
        prompt_version = cfg.get("prompt_version", "")
    else:
        query = entry_or_query
        media = reg.DEFAULT_MEDIA
        subject_keys = []
        prompt_version = f"{company_key}-external-news-v1"

    # 뉴스 검색에는 깔끔한 회사명을 쓴다(키/식별은 원본 그대로 유지).
    search_query = _clean_query(query)
    # 회사 식별 키가 비어 있으면 쿼리 토큰으로 보강(원본+정제본 둘 다 → 게이트가 회사 언급을 잡도록).
    if not subject_keys:
        subject_keys = list(dict.fromkeys(
            [query.lower().replace(" ", ""), query.lower(),
             search_query.lower().replace(" ", ""), search_query.lower()]
        ))

    # 1순위: Naver 뉴스검색(회사별 정적). 0건이면 (구) 매체 자체검색으로 폴백.
    naver_urls = discover_naver_news(search_query, log)
    cands: list[tuple[str, str]] = [(u, "네이버뉴스") for u in naver_urls]
    if not cands:
        cands = discover_external_news(search_query, media, log)
    if limit:
        cands = cands[:limit]
    log.append(f"external_news 후보 합계 {len(cands)}건 (분석 대상 {len(cands)})")

    rows: list[dict] = []
    fetched_at = engine.now_iso()
    try:
        with httpx.Client(timeout=25, follow_redirects=True, headers=engine.UA) as cli:
            for url, outlet0 in cands:
                try:
                    soup, title, pub, paywall, press = _fetch_news_detail(cli, url)
                except Exception as e:
                    log.append(f"  detail 실패({url}): {e}")
                    engine.polite_sleep(1.2)
                    continue
                outlet = press or outlet0  # Naver 기사면 실제 언론사명으로 교체.
                engine.polite_sleep(1.2)
                if paywall:
                    log.append(f"  skip 유료/회원전용: {url}")
                    continue
                pubd = _parse_list_date(pub)
                # 본문 추출(제너릭).
                res = engine.fetch_clean(url, min_len=400)
                if not res["ok"]:
                    log.append(f"  본문 미발견: {res['reason']} ({url})")
                    continue
                body = res["source_text"]
                # 회사명이 '단어 경계'로 실제 언급될 때만 채택(짧은 이름의 헛매칭 차단).
                names = [k for k in subject_keys if k]
                title_hit = any(_company_mentioned(title or "", k) for k in names)
                body_hit = any(_company_mentioned(body, k) for k in names)
                # 2글자 이하 모호한 회사명(예: '시제'=시제품/시제기)은 본문 경계일치도 헛매칭이 잦다.
                #  → 제목에 회사명이 등장할 때만 채택(회사 기사면 보통 제목에 회사명이 있다).
                short_name = len((search_query or query).replace(" ", "")) <= 2
                ok = title_hit if short_name else (title_hit or body_hit)
                if not ok:
                    log.append(f"  skip 주제 불일치(회사 미언급): {url}")
                    continue
                if title and (STRONG_STOCK.search(title) or TITLE_COLUMN.search(title)):
                    log.append(f"  skip 시황/칼럼: {title[:30]}")
                    continue
                extracted, notes = engine.exaone_extract(
                    "external_news", body, display,
                    title=title or "", outlet=outlet,
                    published=(pubd.isoformat() if pubd else ""),
                    prompt_version=prompt_version,
                )
                if extracted is None:
                    log.append(f"  EXAONE 실패({url}): {'; '.join(notes)[:140]}")
                    continue
                # 저작권: 전문 미저장. source_text 는 핵심사실 요약만.
                ev = extracted["event"]
                lines = [f"[핵심사건] {ev.get('eventTitle', '')}",
                         f"[요약] {extracted['articleSummaryKo']}"]
                if ev.get("keyFacts"):
                    lines.append("[핵심사실] " + " / ".join(ev["keyFacts"][:6]))
                if ev.get("numbers"):
                    lines.append("[핵심수치] " + " / ".join(
                        f"{n['label']}:{n['value']}" for n in ev["numbers"][:6]))
                lines.append("[관련성] " + (extracted["companyContext"].get("summary") or ""))
                source_text = "\n".join(x for x in lines if x).strip()
                rows.append(engine.build_row(
                    company_key, "external_news", title=title or "(제목 미상)",
                    source_name=outlet, source_url=url,
                    published_at=(pubd.isoformat() + "T00:00:00+09:00") if pubd else None,
                    source_text=source_text, extracted_data=extracted,
                    fetched_at=fetched_at, prompt_version=prompt_version,
                ))
                log.append(f"  OK {outlet}: {(title or '')[:36]}")
    except Exception as e:
        log.append(f"external_news 예외: {type(e).__name__}: {e}")
    log.append(f"external_news OK rows={len(rows)}")
    return rows


# ──────────────────────────────────────────────────────────────────────────
# 회사 단위 오케스트레이션
# ──────────────────────────────────────────────────────────────────────────


def ingest_company(company_key: str, display: str, entry: dict | None, *,
                   execute: bool, limit: int, query_fallback: str | None = None) -> dict:
    """한 회사 수집(설정된 소스만). 소스 실패는 격리되어 배치를 멈추지 않는다."""
    started = engine.now_iso()
    log: list[str] = []
    rows: list[dict] = []

    print(f"\n===== [{company_key}] {display} "
          f"({'레지스트리 등록' if entry else '미등록(외부뉴스만)'}) =====")

    if entry is not None:
        for fn, name in (
            (lambda: ingest_work_culture(entry, log), "work_culture"),
            (lambda: ingest_official_articles(entry, log, limit), "official_articles"),
            (lambda: ingest_external_news(entry, display, company_key, log, limit), "external_news"),
        ):
            try:
                rows.extend(fn())
            except Exception as e:
                log.append(f"{name} 치명 예외(격리): {type(e).__name__}: {e}")
    else:
        # 미등록 회사: 회사명 쿼리로 external_news 만.
        q = query_fallback or display
        try:
            rows.extend(ingest_external_news(q, display, company_key, log, limit))
        except Exception as e:
            log.append(f"external_news 치명 예외(격리): {type(e).__name__}: {e}")

    # PLAN/INSERT.
    plan = engine.insert_rows(company_key, rows, execute=execute,
                              started_at=started, note=" | ".join(log)[:1900])
    # PLAN 모드에서는 insert_rows 가 run 로깅을 안 하므로(쓰기 없음) 여기서 별도 기록 안 함.

    # 로그 출력.
    for line in log:
        print("  " + line)
    print(f"  -> rows 생성: {len(rows)} | INSERT 예정: {plan['planned']} | "
          f"중복 skip: {plan['skipped']} | 실제 insert: {plan['inserted']} | status: {plan['status']}")
    return {"company_key": company_key, "display": display, "rows": len(rows),
            "planned": plan["planned"], "inserted": plan["inserted"],
            "skipped": plan["skipped"], "status": plan["status"]}


def top_companies(n: int) -> list[str]:
    """job_postings.company 빈도 상위 N개(읽기 전용). DB 없으면 []."""
    import psycopg
    url = engine.load_database_url()
    if not url:
        print("NO_DATABASE_URL: job_postings 조회 불가", file=sys.stderr)
        return []
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            rows = conn.execute(
                """SELECT company, count(*) AS c FROM public.job_postings
                   WHERE company IS NOT NULL AND btrim(company) <> ''
                   GROUP BY company ORDER BY c DESC LIMIT %s""",
                (n,),
            ).fetchall()
        return [r[0] for r in rows]
    except Exception as e:
        print(f"job_postings 조회 실패: {type(e).__name__}: {e}", file=sys.stderr)
        return []


def _covered_and_recent_keys(exclude_days: int) -> tuple[set, set]:
    """이미 데이터가 있는 company_key + 최근 exclude_days 내 수집 시도한 company_key."""
    import psycopg

    url = engine.load_database_url()
    covered: set = set()
    recent: set = set()
    if not url:
        return covered, recent
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            for (k,) in conn.execute(
                "SELECT DISTINCT company_key FROM public.company_contexts"
            ).fetchall():
                covered.add(k)
            for (k,) in conn.execute(
                "SELECT DISTINCT company_key FROM public.company_ingest_runs "
                "WHERE started_at > now() - make_interval(days => %s)",
                (exclude_days,),
            ).fetchall():
                recent.add(k)
    except Exception as e:  # noqa: BLE001
        print(f"coverage 조회 실패: {type(e).__name__}: {e}", file=sys.stderr)
    return covered, recent


# 명백한 헤드헌팅/서치펌 표식 — 자사 채용이 아니라 '채용 대행'이라 회사 페르소나 의미가 없다.
#  (휴리스틱이라 놓친 대행사는 뉴스 자가필터로 0건 처리되고, 잘못 제외돼도 사용자가 고르면 JIT로 수집됨.)
_AGENCY_MARKERS = (
    "헤드헌팅", "헤드헌터", "써치", "서치", "search", "recruit", "리크루", "채용대행",
    "에이전시", "agency", "인재파견", "파견", "스탭", "staffing", "잡매칭", "hr컨설팅",
)


def _looks_like_agency(name: str) -> bool:
    low = (name or "").lower()
    return any(m in low for m in _AGENCY_MARKERS)


def uncovered_top_companies(n: int, exclude_days: int = 14) -> list[str]:
    """공고 빈도 상위 회사 중 '아직 데이터 없고 최근 재시도 안 한' 회사 n개(원본 회사명).
    - 이미 수집된 회사(covered)·최근 exclude_days 내 시도한 회사(헤드헌팅사 0건 포함)는 건너뛴다.
    - 명백한 헤드헌팅/서치펌 이름은 건너뛴다(실제 고용주가 아님).
    → 매일 다른 실제 기업으로 순환하며 보드를 훑고, 다 훑으면 배치 비용은 0에 수렴한다."""
    covered, recent = _covered_and_recent_keys(exclude_days)
    pool = top_companies(max(n * 30, 600))  # 필터 여유분 확보(상위 다수가 대행사/기수집일 수 있음).
    out: list[str] = []
    seen: set = set()
    for name in pool:
        if _looks_like_agency(name):
            continue
        key = reg.resolve(name)["company_key"]
        if not key or key in seen or key in covered or key in recent:
            continue
        seen.add(key)
        out.append(name)
        if len(out) >= n:
            break
    return out


def run_daily(n: int, limit: int, execute: bool) -> list[dict]:
    """하루치 파이프라인: (1) JIT 큐(사용자 수요) → (2) 아직 데이터 없는 공고 상위 N곳(순환)."""
    summaries: list[dict] = []
    print("[daily] 1) JIT 큐 처리(사용자가 면접 본 회사)")
    summaries.extend(drain_requests(execute=execute, limit=limit))
    names = uncovered_top_companies(n)
    print(f"\n[daily] 2) 신규 대상 {len(names)}곳(공고 많은 순, 미수집): {names}")
    for name in names:
        r = reg.resolve(name)
        if not r["company_key"]:
            continue
        summaries.append(ingest_company(
            r["company_key"], r["display_name"], r["entry"],
            execute=execute, limit=limit, query_fallback=name))
    return summaries


def drain_requests(execute: bool, limit: int) -> list[dict]:
    """company_ingest_requests 의 'pending' 요청을 집어 JIT 수집한다(앱 서버가 enqueue 한 것).

    - DRY-RUN: pending 목록만 출력하고 상태는 바꾸지 않는다(수집/쓰기 없음).
    - EXECUTE: 각 요청을 'running' 으로 잠그고(SKIP LOCKED) 수집 후 'done'/'failed' 로 마감.
      한 요청 실패가 다른 요청을 막지 않는다.
    """
    import psycopg

    url = engine.load_database_url()
    if not url:
        print("NO_DATABASE_URL: 요청 큐 조회 불가", file=sys.stderr)
        return []

    summaries: list[dict] = []
    with psycopg.connect(url, autocommit=True) as conn:
        pending = conn.execute(
            "SELECT id, company_key, company_name FROM public.company_ingest_requests "
            "WHERE status = 'pending' ORDER BY requested_at ASC"
        ).fetchall()

    if not pending:
        print("[drain] 대기 중인 수집 요청 없음.")
        return []

    print(f"[drain] 대기 요청 {len(pending)}건: "
          f"{[(r[1]) for r in pending]}")
    if not execute:
        print("[drain] DRY-RUN — 상태 변경/수집 없음. --execute 시 실제 처리.")
        return []

    for req_id, company_key, company_name in pending:
        # 요청을 'running' 으로 잠근다(동시에 도는 다른 drain 이 같은 요청을 집지 않게 SKIP LOCKED).
        with psycopg.connect(url, autocommit=True) as conn:
            locked = conn.execute(
                "UPDATE public.company_ingest_requests "
                "SET status='running', picked_at=NOW(), attempts=attempts+1 "
                "WHERE id=%s AND status='pending' "
                "  AND id IN (SELECT id FROM public.company_ingest_requests "
                "             WHERE id=%s FOR UPDATE SKIP LOCKED) "
                "RETURNING id",
                (req_id, req_id),
            ).fetchone()
        if not locked:
            continue  # 다른 워커가 이미 집음.

        try:
            r = reg.resolve(company_name or company_key)
            s = ingest_company(
                r["company_key"] or company_key, r["display_name"] or company_name,
                r["entry"], execute=True, limit=limit,
                query_fallback=company_name or company_key,
            )
            summaries.append(s)
            ok = s["status"] not in ("error",)
            note = f"inserted={s['inserted']} status={s['status']}"
            with psycopg.connect(url, autocommit=True) as conn:
                conn.execute(
                    "UPDATE public.company_ingest_requests "
                    "SET status=%s, finished_at=NOW(), note=%s WHERE id=%s",
                    ("done" if ok else "failed", note[:500], req_id),
                )
        except Exception as e:  # noqa: BLE001
            with psycopg.connect(url, autocommit=True) as conn:
                conn.execute(
                    "UPDATE public.company_ingest_requests "
                    "SET status='failed', finished_at=NOW(), note=%s WHERE id=%s",
                    (f"{type(e).__name__}: {e}"[:500], req_id),
                )
            print(f"  요청 {req_id}({company_key}) 실패: {type(e).__name__}", file=sys.stderr)
    return summaries


# ──────────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description="레지스트리 기반 company_contexts 수집기")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--company", help="등록된 company_key 1곳 수집")
    g.add_argument("--top", type=int, help="job_postings 빈도 상위 N개 수집")
    g.add_argument("--jit", help="원시 회사명 1건 즉석 수집(앱 on-demand 용)")
    g.add_argument("--drain", action="store_true",
                   help="company_ingest_requests 의 pending 요청을 처리(앱 서버가 enqueue 한 JIT)")
    g.add_argument("--daily", nargs="?", type=int, const=20,
                   help="하루치 파이프라인: JIT 큐 + 아직 데이터 없는 공고 상위 N곳(기본 20). cron 용.")
    ap.add_argument("--execute", action="store_true", help="실제 INSERT(미지정 시 DRY-RUN/PLAN)")
    ap.add_argument("--limit", type=int, default=0,
                    help="소스별 처리 상한(0=무제한). 빠른 PLAN 확인용.")
    args = ap.parse_args()

    mode = "EXECUTE(쓰기)" if args.execute else "DRY-RUN(PLAN, 쓰기 없음)"
    print(f"[mode] {mode} | model={engine.MODEL}")

    summaries = []

    if args.company:
        entry = reg.get_by_key(args.company)
        if not entry:
            print(f"미등록 company_key: {args.company} "
                  f"(등록: {[e['company_key'] for e in reg.REGISTRY]})", file=sys.stderr)
            return 4
        summaries.append(ingest_company(
            entry["company_key"], entry["display_name"], entry,
            execute=args.execute, limit=args.limit))

    elif args.jit:
        r = reg.resolve(args.jit)
        if not r["company_key"]:
            print("빈 회사명", file=sys.stderr)
            return 4
        summaries.append(ingest_company(
            r["company_key"], r["display_name"], r["entry"],
            execute=args.execute, limit=args.limit, query_fallback=args.jit))

    elif args.drain:
        summaries.extend(drain_requests(execute=args.execute, limit=args.limit))

    elif args.daily is not None:
        # 하루치: 소스별 상한은 4로 고정(과수집 방지). JIT 큐 → 미수집 상위 N곳.
        summaries.extend(run_daily(args.daily, limit=(args.limit or 4), execute=args.execute))

    elif args.top is not None:
        names = top_companies(args.top)
        if not names:
            print("상위 회사 목록을 가져오지 못함(빈 결과 또는 DB 미접속).", file=sys.stderr)
            return 4
        covered, registry_hits, generic = [], 0, 0
        print(f"\n[top {args.top}] job_postings 상위 회사: {names}")
        for name in names:
            r = reg.resolve(name)
            if not r["company_key"]:
                print(f"  skip(빈 키): {name!r}")
                continue
            covered.append(r["company_key"])
            if r["entry"] is not None:
                registry_hits += 1
            else:
                generic += 1
            summaries.append(ingest_company(
                r["company_key"], r["display_name"], r["entry"],
                execute=args.execute, limit=args.limit, query_fallback=name))
        print(f"\n[커버리지] 입력 {len(names)} | 처리 {len(covered)} | "
              f"레지스트리 매칭 {registry_hits} | 외부뉴스 일반 경로 {generic} | "
              f"무시 {len(names) - len(covered)}")

    # 최종 요약(쓰기 여부 무관).
    print("\n========== SUMMARY ==========")
    tot_planned = sum(s["planned"] for s in summaries)
    tot_inserted = sum(s["inserted"] for s in summaries)
    for s in summaries:
        print(f"  {s['company_key']:24s} rows={s['rows']:3d} planned={s['planned']:3d} "
              f"inserted={s['inserted']:3d} skipped={s['skipped']:3d} [{s['status']}]")
    print(f"  TOTAL planned={tot_planned} inserted={tot_inserted} "
          f"({'쓰기 수행됨' if args.execute else 'DRY-RUN — 쓰기 없음'})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
