"""엔진 — 회사 비종속 코어. SK 전용 스크립트(sandbox/scripts/sk_*.py)에서 추출/일반화.

제공:
- fetch_clean(url, ...)        : 단일 GET -> 비본문 제거 -> 정리된 본문 텍스트
- exaone_extract(...)          : EXAONE 3.5(Ollama, format=json) 구조화 + grounding + 1회 재시도
- grounding 헬퍼 / norm / content_hash(SHA-256)
- insert_rows(...)             : 단일 트랜잭션 INSERT(company_contexts) + company_ingest_runs 기록
- load_database_url()          : env 우선, crawler/.env 폴백, docker host -> 127.0.0.1, 값 미출력

규칙(SK 스크립트와 동일):
- evidence/keyFacts/numbers.evidence 는 정리된 원문의 verbatim substring 이어야 함(공백 정규화).
  통과 못 하면 해당 항목 제거. 보수적(conservative) > 환각(hallucinated).
- DATABASE_URL/비밀번호/연결정보는 절대 출력하지 않음.
- 기본은 PLAN(쓰기 없음). insert_rows(execute=False) 는 아무것도 쓰지 않음.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

import httpx
from bs4 import BeautifulSoup

CRAWLER_ENV = Path(__file__).resolve().parent.parent / ".env"

OLLAMA = (os.environ.get("OLLAMA_BASE_URL") or os.environ.get("OLLAMA_URL")
          or "http://localhost:11434")
MODEL = os.environ.get("OLLAMA_MODEL", "exaone3.5:latest")

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124 Safari/537.36 (InterviewForge research)"}

# fetch 간 정중한 지연(초).
REQUEST_DELAY_SEC = 3.0

# ──────────────────────────────────────────────────────────────────────────
# 텍스트 정규화 / grounding / 해시
# ──────────────────────────────────────────────────────────────────────────


def norm(s: str) -> str:
    """공백 정규화 + 따옴표 통일 + 소문자(grounding 비교용)."""
    s = (s or "").replace("“", '"').replace("”", '"')
    s = s.replace("’", "'").replace("‘", "'")
    s = re.sub(r"\s+", " ", s)
    return s.strip().lower()


def grounded(ev: str, body_norm: str, body_nospace: str, min_len: int = 5) -> bool:
    """evidence 가 본문에 실제로 등장하는가(공백 차이는 구제)."""
    e = norm(str(ev))
    if not e or len(e) < min_len:
        return False
    if e in body_norm:
        return True
    return e.replace(" ", "") in body_nospace


def content_hash(source_text: str) -> str:
    """content_hash = SHA-256(canonical source_text)."""
    return hashlib.sha256(source_text.encode("utf-8")).hexdigest()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def collapse(text: str) -> str:
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ──────────────────────────────────────────────────────────────────────────
# fetch_clean — 비본문 제거 + 본문 텍스트 추출(회사 비종속)
# ──────────────────────────────────────────────────────────────────────────

STRIP_TAGS = ["script", "style", "noscript", "nav", "footer", "header",
              "aside", "form", "button", "svg", "img", "iframe", "input",
              "select", "label", "link", "meta", "figure", "figcaption"]
STRIP_HINTS = ["cookie", "gnb", "lnb", "footer", "header", "nav", "menu",
               "popup", "modal", "lang", "language", "breadcrumb", "sitemap",
               "address", "copyright", "skip", "search", "related", "recommend",
               "popular", "comment", "reply", "share", "sns", "tag", "banner",
               "advert", "newsletter", "subscribe", "rank", "most-viewed"]

# 본문 안에서 잘라낼 사이트 자동 요약/저작권 보일러플레이트.
AI_SUMMARY_SPLIT = re.compile(r"\U0001F4A1|\U0001F310|\U0001F50D|\U0001F4CA|\U0001F916|✅|AI\s*요약|AI가 요약|\[AI")
COPYRIGHT_SPLIT = re.compile(r"개인정보 수집\s*·?\s*이용|무단[ ]*전재|저작권자|ⓒ|Copyright")


def _looks_like_strip(node) -> bool:
    attrs = getattr(node, "attrs", None)
    if not attrs:
        return False
    ident = " ".join(filter(None, [
        str(attrs.get("id") or ""),
        " ".join(attrs.get("class") or []),
        str(attrs.get("role") or ""),
    ])).lower()
    return any(h in ident for h in STRIP_HINTS)


def fetch_clean(
    url: str,
    *,
    culture_hints: list[str] | None = None,
    body_selector: str | None = None,
    min_len: int = 80,
    timeout: float = 25.0,
) -> dict[str, Any]:
    """단일 GET -> 비본문 제거 -> 정리된 본문 텍스트.

    반환: {"ok", "status", "final_url", "fetched_at", "source_text",
           "title", "selected", "len", "reason"}

    body_selector 가 주어지면 그 컨테이너 우선(뉴스 상세 본문 등).
    아니면 culture_hints 점수가 높은 블록을 고르는 제너릭 방식(work_culture 등).
    """
    out: dict[str, Any] = {
        "ok": False, "status": None, "final_url": url,
        "fetched_at": now_iso(), "source_text": "", "title": None,
        "selected": None, "len": 0, "reason": "",
    }
    try:
        with httpx.Client(follow_redirects=True, timeout=timeout, headers=UA) as cli:
            r = cli.get(url)
    except Exception as e:
        out["reason"] = f"HTTP_ERROR: {type(e).__name__}: {e}"
        return out

    out["status"] = r.status_code
    out["final_url"] = str(r.url)
    if r.status_code != 200:
        out["reason"] = f"HTTP_ERROR: status {r.status_code}"
        return out

    soup = BeautifulSoup(r.text, "lxml")

    # 제목(og:title 우선).
    og = soup.find("meta", property="og:title")
    if og and og.get("content"):
        out["title"] = og["content"].strip()
    elif soup.title:
        out["title"] = soup.title.get_text(strip=True)

    # (1) 지정 컨테이너 우선.
    #     주의: 본문 컨테이너를 '먼저' 격리한 뒤 그 안에서만 비본문 태그를 제거한다.
    #     (전체 문서에 STRIP_HINTS 를 먼저 돌리면 WordPress <body>/<article> 의 클래스에
    #      tag/footer/comment 같은 단어가 섞여 컨테이너 조상이 통째로 삭제될 수 있음.)
    if body_selector:
        cont = soup.select_one(body_selector)
        if cont is not None:
            for t in cont(STRIP_TAGS):
                t.decompose()
            for node in list(cont.find_all(True)):
                if node.parent is None:
                    continue
                if _looks_like_strip(node):
                    node.decompose()
            paras, seen = [], set()
            for el in cont.find_all(["p", "h2", "h3", "h4", "li"]):
                txt = el.get_text(" ", strip=True)
                if not txt or len(txt) < 2:
                    continue
                if txt.startswith("▲") or txt.startswith("△"):  # 이미지 캡션
                    continue
                atext = sum(len(a.get_text(" ", strip=True)) for a in el.find_all("a"))
                if atext / max(1, len(txt)) > 0.5:  # 링크 위주 블록
                    continue
                if txt in seen:
                    continue
                seen.add(txt)
                paras.append(txt)
            source_text = "\n\n".join(paras).strip()
            source_text = AI_SUMMARY_SPLIT.split(source_text)[0].strip()
            if len(source_text) >= min_len:
                out.update(ok=True, source_text=source_text,
                           selected=body_selector, len=len(source_text))
                return out
        # 컨테이너 미발견 시 제너릭으로 폴백.

    # 비본문 제거(제너릭 경로용 — 전체 문서 대상).
    for t in soup(STRIP_TAGS):
        t.decompose()
    for node in list(soup.find_all(True)):
        if node.parent is None:
            continue
        if _looks_like_strip(node):
            node.decompose()

    # (2) 제너릭: hints 점수 우선, 길이 보조.
    hints = [h.lower() for h in (culture_hints or [])]
    candidates = []
    for sel in ["main", "article", "section", "div"]:
        for node in soup.find_all(sel):
            txt = collapse(node.get_text("\n"))
            if len(txt) < min_len:
                continue
            low = txt.lower()
            hits = sum(1 for h in hints if h in low) if hints else 0
            candidates.append((hits, len(txt), txt, sel))
    candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)

    if not candidates:
        out["reason"] = "CONTENT_NOT_FOUND: 본문 블록 없음(JS 셸/구조 변경 의심)"
        return out
    # hints 가 있는데 적중 0 이면 본문 미발견으로 본다(엉뚱한 메뉴 텍스트 방지).
    if hints and candidates[0][0] == 0:
        out["reason"] = ("CONTENT_NOT_FOUND: culture 키워드 매칭 0 "
                         "(JS 렌더링/구조 변경 가능성)")
        return out

    best_hits, best_len, best_txt, best_sel = candidates[0]
    best_txt = AI_SUMMARY_SPLIT.split(best_txt)[0].strip()
    out.update(ok=True, source_text=best_txt, selected=best_sel, len=len(best_txt))
    return out


# ──────────────────────────────────────────────────────────────────────────
# EXAONE 추출(회사명 파라미터화)
# ──────────────────────────────────────────────────────────────────────────

WC_ALLOWED_KEYS = {"bar-raising", "ai-driven", "one-team",
                   "innovation", "customer-focus", "perfection"}
WC_REQUIRED = ["key", "originalTitle", "nameKo", "slogan", "description",
               "behaviors", "evidence"]

ART_CATEGORIES = {"technical", "problem_solving", "collaboration",
                  "communication", "attitude", "other"}
NEWS_ETYPES = {"technology", "product", "investment", "partnership", "customer",
               "earnings", "organization", "employment", "policy", "legal",
               "esg", "risk", "other"}
NEWS_IMPACT = {"confirmed", "expected", "opinion", "unknown"}
NEWS_FACTB = {"official_announcement", "company_statement", "interview",
              "government_source", "reporter_analysis", "mixed"}


def _call_ollama(prompt: str, *, num_ctx: int = 16384, timeout: float = 300.0) -> str:
    with httpx.Client(timeout=timeout) as cli:
        r = cli.post(f"{OLLAMA}/api/generate", json={
            "model": MODEL, "prompt": prompt, "stream": False, "format": "json",
            "options": {"temperature": 0.2, "num_ctx": num_ctx},
        })
        r.raise_for_status()
        return str(r.json().get("response", "")).strip()


def _try_parse(raw: str):
    try:
        return json.loads(raw)
    except Exception:
        m = re.search(r"\{[\s\S]*\}", raw)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return None
    return None


# ---- work_culture ----

def _prompt_work_culture(company: str, source_text: str, stricter: bool) -> str:
    head = (f"당신은 한국어 채용 도메인 분석가입니다. 아래는 {company} 공식 페이지가 소개한 "
            "'일하는 방식/조직문화(Work culture)' 정리 원문입니다. 원문에 실제로 존재하는 내용만 "
            "추출해 JSON 하나로 정리하세요.")
    rules = f"""
[규칙]
- 원문에 실제로 있는 내용만 사용. 원문에 없는 인재상/기술/채용기준/성과/수치를 만들지 말 것.
- "{company}가 이런 사람만 채용한다" 같은 확대 해석 금지. 공식 '일하는 방식/행동 기준'으로만 정리.
- 아래 6개 슬러그 중 원문에서 실제로 확인되는 것만 values 에 포함(중복 생성 금지):
  bar-raising / ai-driven / one-team / innovation / customer-focus / perfection
- 각 항목 evidence 는 원문에 그대로 등장하는 문장(또는 슬로건) 1~3개 발췌. 의역/창작 금지.
- description, behaviors 는 원문 근거에 기반해 자연스러운 한국어로 작성.
- key 는 위 슬러그만 사용.

[출력 JSON 형식(이 형식의 유효한 JSON 객체 하나만 출력)]
{{
  "company": "{company}",
  "sourceType": "official_work_culture",
  "values": [
    {{
      "key": "bar-raising",
      "originalTitle": "Bar Raising",
      "nameKo": "높은 기준 추구",
      "slogan": "원문 근거 슬로건",
      "description": "원문 근거 기반 한국어 설명",
      "behaviors": ["원문에서 확인되는 구체적 행동 방식"],
      "evidence": ["원문에 실제로 등장하는 문장"]
    }}
  ]
}}
"""
    strict = ("\n[재요청] 직전 출력이 형식/검증을 통과하지 못했습니다. 코드펜스/설명 없이 위 형식의 "
              "유효한 JSON 객체 하나만 출력하고, evidence 는 반드시 원문 문장을 그대로 발췌하세요.\n"
              ) if stricter else ""
    return f"{head}\n{rules}{strict}\n[원문]\n{source_text}\n"


def _validate_work_culture(obj, source_text: str) -> tuple[dict | None, list[str]]:
    notes: list[str] = []
    if not isinstance(obj, dict):
        return None, ["최상위가 객체가 아님"]
    vals = obj.get("values")
    if not isinstance(vals, list) or not vals:
        return None, ["values 가 비어있거나 배열이 아님"]
    bn, bns = norm(source_text), norm(source_text).replace(" ", "")
    seen, out_vals = set(), []
    for i, v in enumerate(vals):
        if not isinstance(v, dict):
            continue
        if any(f not in v for f in WC_REQUIRED):
            notes.append(f"values[{i}] 필수 필드 누락"); continue
        if v["key"] not in WC_ALLOWED_KEYS or v["key"] in seen:
            notes.append(f"values[{i}] key 무효/중복: {v.get('key')!r}"); continue
        if not isinstance(v.get("behaviors"), list) or not v["behaviors"]:
            notes.append(f"values[{i}] behaviors 비어있음"); continue
        ev = [e for e in (v.get("evidence") or [])
              if isinstance(e, str) and grounded(e, bn, bns)]
        if not ev:
            notes.append(f"values[{i}]({v['key']}) evidence grounding 실패"); continue
        seen.add(v["key"])
        out_vals.append({
            "key": v["key"], "originalTitle": v.get("originalTitle", ""),
            "nameKo": v.get("nameKo", ""), "slogan": v.get("slogan", ""),
            "description": v.get("description", ""),
            "behaviors": [x for x in v["behaviors"] if isinstance(x, str)],
            "evidence": ev,
        })
    if not out_vals:
        return None, notes + ["grounding 통과 value 0"]
    return {"company": obj.get("company"), "sourceType": "official_work_culture",
            "values": out_vals}, notes


# ---- official_article ----

def _prompt_official_article(company: str, title: str, body: str) -> str:
    schema = '''{
  "articleSummaryKo": "기사 핵심을 한국어로 요약",
  "jobRole": {"name": "직무명 또는 null", "aliases": [], "overview": "직무 설명 또는 null",
              "mainTasks": [], "subAreas": [], "requiredKnowledge": []},
  "competencies": [
    {"name": "역량명", "category": "technical|problem_solving|collaboration|communication|attitude|other",
     "description": "기사 근거 기반 한국어 설명", "explicitness": "explicit|inferred",
     "evidence": ["기사 본문에 실제로 존재하는 원문 문장"]}
  ]
}'''
    return (
        f"당신은 {company} 채용 도메인 분석가입니다. 아래 '기사 본문'만을 근거로, AI 면접 질문 생성에 쓸 "
        "구조화 JSON 하나를 만드세요.\n\n"
        "[엄격한 사실성 규칙]\n"
        "- 기사 본문에 실제로 있는 내용만 사용. 상식/배경지식/추측/다른 기사 내용 혼합 금지.\n"
        "- '이 직무면 보통 필요할 것' 같은 일반론 보충 금지. 본문에 없으면 넣지 말 것.\n"
        "- competencies 의 evidence 는 반드시 본문에 그대로 등장하는 한국어 원문 문장을 복사. 의역/창작 금지. "
        "근거 문장이 없으면 그 항목 자체를 넣지 말 것.\n"
        "- 수치/성과/기술명/도구명은 본문에 실제로 있을 때만. 없으면 만들지 말 것.\n"
        "- 회사 공식 입장과 개별 인터뷰 대상자의 개인 의견을 구분. 개인 발언을 회사 전체 공식 입장으로 확대하지 말 것.\n"
        f"[출력 형식 - 이 형식의 유효한 JSON 객체 하나만 출력]\n{schema}\n\n"
        f"[기사 제목]\n{title}\n\n[기사 본문]\n{body}\n"
    )


def _validate_official_article(obj, body: str) -> tuple[dict | None, list[str]]:
    notes: list[str] = []
    if not isinstance(obj, dict) or not isinstance(obj.get("articleSummaryKo"), str) \
            or not obj["articleSummaryKo"].strip():
        return None, ["articleSummaryKo 누락"]
    bn, bns = norm(body), norm(body).replace(" ", "")
    jr = obj.get("jobRole") or {}
    out = {
        "articleSummaryKo": obj["articleSummaryKo"].strip(),
        "jobRole": {
            "name": jr.get("name") if isinstance(jr.get("name"), str) and jr.get("name").strip() else None,
            "aliases": [x for x in (jr.get("aliases") or []) if isinstance(x, str)],
            "overview": jr.get("overview") if isinstance(jr.get("overview"), str) and jr.get("overview").strip() else None,
            "mainTasks": [x for x in (jr.get("mainTasks") or []) if isinstance(x, str)],
            "subAreas": [x for x in (jr.get("subAreas") or []) if isinstance(x, str)],
            "requiredKnowledge": [x for x in (jr.get("requiredKnowledge") or []) if isinstance(x, str)],
        },
        "competencies": [],
    }
    for c in obj.get("competencies") or []:
        if not isinstance(c, dict):
            continue
        ev = [e for e in (c.get("evidence") or []) if isinstance(e, str) and grounded(e, bn, bns)]
        if not ev:
            notes.append(f"competency 제거(근거없음): {c.get('name')!r}"); continue
        out["competencies"].append({
            "name": c.get("name", ""),
            "category": c.get("category") if c.get("category") in ART_CATEGORIES else "other",
            "description": c.get("description", ""),
            "explicitness": c.get("explicitness") if c.get("explicitness") in ("explicit", "inferred") else "inferred",
            "evidence": ev,
        })
    return out, notes


# ---- external_news ----

def _prompt_external_news(company: str, title: str, outlet: str, pub: str, body: str) -> str:
    schema = '''{
  "articleSummaryKo": "기사 핵심을 한국어로 정확히 요약",
  "event": {"eventType":"technology|product|investment|partnership|customer|earnings|organization|employment|policy|legal|esg|risk|other",
    "eventTitle":"사건 핵심 한 문장","eventDate":"YYYY-MM-DD 또는 null",
    "keyFacts":["기사에서 확인된 핵심 사실"],
    "numbers":[{"label":"수치 의미","value":"기사에 나온 수치","evidence":"짧은 원문 근거"}]},
  "companyContext": {"summary":"회사와의 관련성(기사 근거)","businessAreas":[],"productsOrTechnologies":[],"partnersOrCustomers":[],"locations":[]},
  "companyImpact": {"summary":"회사 영향(확인 불가 시 null)","positiveFactors":[],"riskFactors":[],"impactStatus":"confirmed|expected|opinion|unknown"},
  "sourceAssessment": {"factBasis":"official_announcement|company_statement|interview|government_source|reporter_analysis|mixed","hasDirectQuote":true,"notes":"사실/전망 구분 설명"},
  "evidence": [{"fact":"요약의 핵심 사실","sourceText":"짧은 원문 근거"}]
}'''
    return (
        f"당신은 한국어 뉴스 분석가입니다. 아래 기사 본문만 근거로 {company} 관련 뉴스를 구조화 JSON 하나로 정리하세요.\n\n"
        "[엄격한 사실성]\n"
        "- 기사 본문에 실제로 있는 내용만. 배경지식/추측/다른 기사 혼합 금지. 없는 수치 생성 금지.\n"
        "- 전망을 확정 사실로 쓰지 말 것. 기자 해석을 회사 공식입장으로 쓰지 말 것.\n"
        "- numbers/evidence 의 근거(sourceText/evidence)는 본문에 그대로 등장하는 '짧은' 문장/구절만 복사(저작권상 길게 복사 금지).\n"
        "- 확실하지 않으면 null 또는 빈 배열. impactStatus 는 confirmed/expected/opinion/unknown 중 본문에 맞게.\n"
        "- 면접 질문/예상질문 관련 필드는 절대 만들지 말 것.\n\n"
        f"[출력 형식 - 이 형식의 유효한 JSON 객체 하나만]\n{schema}\n\n"
        f"[언론사] {outlet}\n[게시일] {pub}\n[기사 제목] {title}\n\n[기사 본문]\n{body[:6000]}\n"
    )


def _ctx_grounded(c, body_nospace: str) -> dict:
    c = c or {}

    def gl(key):
        out = []
        for x in (c.get(key) or []):
            if not isinstance(x, str) or len(x.strip()) < 2:
                continue
            tok = norm(x).replace(" ", "")
            base = norm(x).split("(")[0].strip().replace(" ", "")
            if tok in body_nospace or (len(base) >= 2 and base in body_nospace):
                out.append(x)
        return out
    return {"summary": c.get("summary", ""),
            "businessAreas": gl("businessAreas"),
            "productsOrTechnologies": gl("productsOrTechnologies"),
            "partnersOrCustomers": gl("partnersOrCustomers"),
            "locations": gl("locations")}


def _imp(c) -> dict:
    c = c or {}
    return {"summary": c.get("summary"),
            "positiveFactors": [x for x in (c.get("positiveFactors") or []) if isinstance(x, str)],
            "riskFactors": [x for x in (c.get("riskFactors") or []) if isinstance(x, str)],
            "impactStatus": c.get("impactStatus") if c.get("impactStatus") in NEWS_IMPACT else "unknown"}


def _parse_date_iso(s):
    if not s or not isinstance(s, str):
        return None
    m = re.search(r"(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})", s)
    if not m:
        return None
    try:
        from datetime import date
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
    except ValueError:
        return None


def _validate_external_news(obj, body: str) -> tuple[dict | None, list[str]]:
    if not isinstance(obj, dict) or not isinstance(obj.get("articleSummaryKo"), str) \
            or not obj["articleSummaryKo"].strip():
        return None, ["articleSummaryKo 누락"]
    bn, bns = norm(body), norm(body).replace(" ", "")

    def g(s):
        return grounded(s, bn, bns)

    ev = obj.get("event") or {}
    nums = []
    for x in (ev.get("numbers") or []):
        if isinstance(x, dict) and x.get("value") and g(x.get("evidence", "")):
            nums.append({"label": x.get("label", ""), "value": str(x.get("value")),
                         "evidence": x.get("evidence", "")})
    evid = []
    for x in (obj.get("evidence") or []):
        if isinstance(x, dict) and x.get("fact") and g(x.get("sourceText", "")):
            evid.append({"fact": x["fact"], "sourceText": x["sourceText"]})
    sa = obj.get("sourceAssessment") or {}
    out = {
        "articleSummaryKo": obj["articleSummaryKo"].strip(),
        "event": {
            "eventType": ev.get("eventType") if ev.get("eventType") in NEWS_ETYPES else "other",
            "eventTitle": ev.get("eventTitle", ""),
            "eventDate": _parse_date_iso(ev.get("eventDate")),
            "keyFacts": [x for x in (ev.get("keyFacts") or []) if isinstance(x, str)],
            "numbers": nums,
        },
        "companyContext": _ctx_grounded(obj.get("companyContext"), bns),
        "companyImpact": _imp(obj.get("companyImpact")),
        "sourceAssessment": {
            "factBasis": sa.get("factBasis") if sa.get("factBasis") in NEWS_FACTB else "mixed",
            "hasDirectQuote": bool(sa.get("hasDirectQuote")),
            "notes": sa.get("notes", ""),
        },
        "evidence": evid,
    }
    return out, []


# ---- 통합 진입점 ----

def exaone_extract(
    content_type: str,
    source_text: str,
    company_display: str,
    *,
    title: str = "",
    outlet: str = "",
    published: str = "",
    prompt_version: str = "",
    num_ctx: int = 16384,
) -> tuple[dict | None, list[str]]:
    """content_type 별 구조화 추출. grounding 검증 + 1회 재시도.

    반환: (검증 통과 dict | None, notes[]). 모델/네트워크 실패 시 (None, [에러]).
    """
    builders = {
        "work_culture": lambda strict: _prompt_work_culture(company_display, source_text, strict),
        "official_article": lambda strict: _prompt_official_article(company_display, title, source_text),
        "external_news": lambda strict: _prompt_external_news(company_display, title, outlet, published, source_text),
    }
    validators = {
        "work_culture": lambda o: _validate_work_culture(o, source_text),
        "official_article": lambda o: _validate_official_article(o, source_text),
        "external_news": lambda o: _validate_external_news(o, source_text),
    }
    if content_type not in builders:
        return None, [f"미지원 content_type: {content_type}"]

    last_notes: list[str] = []
    for attempt in (1, 2):
        try:
            raw = _call_ollama(builders[content_type](attempt == 2), num_ctx=num_ctx)
        except Exception as e:
            return None, [f"OLLAMA_ERROR(attempt {attempt}): {type(e).__name__}: {e}"]
        obj = _try_parse(raw)
        if obj is None:
            last_notes = [f"JSON 파싱 실패(attempt {attempt})"]
            continue
        cleaned, notes = validators[content_type](obj)
        last_notes = notes
        if cleaned is not None:
            return cleaned, notes
    return None, last_notes + ["재시도 후에도 검증 실패"]


# ──────────────────────────────────────────────────────────────────────────
# DB — url 로더 + 단일 트랜잭션 INSERT + run 로깅
# ──────────────────────────────────────────────────────────────────────────


def load_database_url() -> str | None:
    """env 우선, 없으면 crawler/.env 폴백. docker host -> 127.0.0.1. 값은 절대 출력 금지."""
    url = os.environ.get("DATABASE_URL")
    if not url and CRAWLER_ENV.exists():
        for line in CRAWLER_ENV.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("DATABASE_URL="):
                url = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
    if not url:
        return None
    p = urlparse(url)
    if p.hostname in ("host.docker.internal", "gateway.docker.internal"):
        ui = ""
        if p.username:
            ui = p.username + (f":{p.password}" if p.password else "") + "@"
        netloc = f"{ui}127.0.0.1" + (f":{p.port}" if p.port else "")
        url = urlunparse((p.scheme, netloc, p.path, p.params, p.query, p.fragment))
    return url


INSERT_SQL = """INSERT INTO public.company_contexts
  (company_key, content_type, title, source_name, source_url, published_at,
   source_text, extracted_data, content_hash, fetched_at, model_name, prompt_version)
VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
ON CONFLICT (company_key, source_url, content_hash) DO NOTHING
RETURNING id"""


def build_row(
    company_key: str, content_type: str, *, title: str, source_name: str,
    source_url: str, published_at: str | None, source_text: str,
    extracted_data: dict, fetched_at: str, prompt_version: str,
) -> dict[str, Any]:
    """company_contexts 한 행 dict 생성(content_hash 포함)."""
    return {
        "company_key": company_key,
        "content_type": content_type,
        "title": title,
        "source_name": source_name,
        "source_url": source_url,
        "published_at": published_at,
        "source_text": source_text,
        "extracted_data": extracted_data,
        "content_hash": content_hash(source_text),
        "fetched_at": fetched_at,
        "model_name": MODEL,
        "prompt_version": prompt_version,
    }


def insert_rows(
    company_key: str,
    rows: list[dict[str, Any]],
    *,
    execute: bool = False,
    started_at: str | None = None,
    note: str = "",
    conn=None,
) -> dict[str, Any]:
    """company_contexts 단일 트랜잭션 INSERT(ON CONFLICT DO NOTHING) + run 로깅.

    execute=False(기본): 쓰기 없음. PLAN 정보만 반환(insert 예정/중복 분류는 읽기전용 SELECT).
    반환: {"inserted", "planned", "skipped", "status", "ids"}

    DATABASE_URL/비밀번호 미출력. conn 미지정 시 내부에서 열고 닫는다.
    """
    import psycopg
    from psycopg.types.json import Json

    result = {"inserted": 0, "planned": 0, "skipped": 0, "status": "PLAN", "ids": []}

    url = load_database_url()
    if not url:
        result["status"] = "NO_DATABASE_URL"
        return result

    own_conn = conn is None
    if own_conn:
        conn = psycopg.connect(url, autocommit=False)

    try:
        # 읽기전용 분류(중복 skip / insert 예정).
        to_insert, to_skip = [], []
        with conn.cursor() as cur:
            for r in rows:
                cur.execute(
                    "SELECT 1 FROM public.company_contexts "
                    "WHERE company_key=%s AND source_url=%s AND content_hash=%s",
                    (r["company_key"], r["source_url"], r["content_hash"]),
                )
                (to_skip if cur.fetchone() else to_insert).append(r)
        conn.rollback()  # SELECT 트랜잭션 정리
        result["planned"] = len(to_insert)
        result["skipped"] = len(to_skip)

        if not execute:
            result["status"] = "PLAN"
            return result

        # ---- 실제 INSERT(단일 트랜잭션) + run 로깅 ----
        run_started = started_at or now_iso()
        ids = []
        with conn:  # 정상 종료 commit, 예외 rollback
            with conn.cursor() as cur:
                for r in to_insert:
                    cur.execute(INSERT_SQL, (
                        r["company_key"], r["content_type"], r["title"], r["source_name"],
                        r["source_url"], r["published_at"], r["source_text"],
                        Json(r["extracted_data"]), r["content_hash"], r["fetched_at"],
                        r["model_name"], r["prompt_version"],
                    ))
                    got = cur.fetchone()
                    if got:
                        ids.append(got[0])
                cur.execute(
                    """INSERT INTO public.company_ingest_runs
                       (company_key, started_at, finished_at, status, inserted_rows, note)
                       VALUES (%s,%s,%s,%s,%s,%s)""",
                    (company_key, run_started, now_iso(), "ok", len(ids), note[:2000]),
                )
        result.update(inserted=len(ids), ids=ids, status="INSERTED_COMMITTED")
        return result
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        result["status"] = f"DB_ERROR: {type(e).__name__}: {e}"
        return result
    finally:
        if own_conn:
            try:
                conn.close()
            except Exception:
                pass


def log_run(company_key: str, started_at: str, status: str, inserted: int, note: str) -> None:
    """company_ingest_runs 에 실패/요약 run 한 줄 기록(별도 트랜잭션). 실패해도 조용히 무시."""
    import psycopg
    url = load_database_url()
    if not url:
        return
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute(
                """INSERT INTO public.company_ingest_runs
                   (company_key, started_at, finished_at, status, inserted_rows, note)
                   VALUES (%s,%s,%s,%s,%s,%s)""",
                (company_key, started_at, now_iso(), status, inserted, note[:2000]),
            )
    except Exception:
        pass


def polite_sleep(seconds: float = REQUEST_DELAY_SEC) -> None:
    time.sleep(seconds)
