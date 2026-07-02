"""레지스트리 — company_key -> 소스 매핑의 단일 진실 공급원(single source of truth).

회사를 추가하려면 여기에 항목 하나만 더하면 된다(새 회사별 코드 작성 불필요).
company_key 규칙은 server/src/aiInterview/companyRegistry.ts 의 slugifyCompany 와
동일하게 맞춘다(lowercase, NFKC, 주식회사/(주)/㈜ 제거, 영숫자/한글 외 -> 언더스코어).

각 항목 형태:
  {
    "company_key": "sk_hynix",
    "display_name": "SK하이닉스",
    "aliases": [...],                       # 표기 흔들림 흡수(정규화 비교)
    "work_culture":      {...} | None,      # 단일 work_culture 페이지
    "official_articles": {...} | None,      # 뉴스룸 태그/카테고리 목록
    "external_news":     {...},             # 외부 언론 검색(쿼리 + 매체 목록)
  }
"""
from __future__ import annotations

import re
import unicodedata
from typing import Any

# ──────────────────────────────────────────────────────────────────────────
# slugify — TS slugifyCompany 와 동일 규칙(파이프라인과 면접 어댑터가 같은 키를 공유).
# ──────────────────────────────────────────────────────────────────────────


def slugify_company(name: str) -> str:
    """회사명 -> company_key.

    TS 규칙과 1:1:
      .normalize("NFKC").trim().toLowerCase()
      .replace(/\\(주\\)|주식회사|㈜/g, "")
      .replace(/[^0-9a-z가-힣]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80)
    """
    s = unicodedata.normalize("NFKC", name or "")
    s = s.strip().lower()
    s = re.sub(r"\(주\)|주식회사|㈜", "", s)
    s = re.sub(r"[^0-9a-z가-힣]+", "_", s)
    s = re.sub(r"^_+|_+$", "", s)
    return s[:80]


def _norm(s: str) -> str:
    """별칭 비교용 정규화(TS normalize 와 동일)."""
    s = unicodedata.normalize("NFKC", s or "").strip()
    s = re.sub(r"\s+", " ", s)
    return s.lower()


# ──────────────────────────────────────────────────────────────────────────
# 공통 상수
# ──────────────────────────────────────────────────────────────────────────

# 외부 뉴스 기본 매체 목록(정적 httpx 로 검색 가능한 곳). engine 이 코드로 해석.
DEFAULT_MEDIA = ["yna", "hankyung", "mk", "donga", "hani", "chosun", "khan"]

# work_culture 추출에 쓰는 표준 슬러그(회사 무관 universal value set).
# 회사가 다른 명칭을 쓰면 가장 가까운 슬러그로 매핑하되, 근거 없으면 버린다.
WORK_CULTURE_KEYS = [
    "bar-raising", "ai-driven", "one-team",
    "innovation", "customer-focus", "perfection",
]

# ──────────────────────────────────────────────────────────────────────────
# 레지스트리 본체
# ──────────────────────────────────────────────────────────────────────────

REGISTRY: list[dict[str, Any]] = [
    {
        "company_key": "sk_hynix",
        "display_name": "SK하이닉스",
        "aliases": ["SK하이닉스", "sk하이닉스", "SK hynix", "SK Hynix",
                    "sk hynix", "하이닉스", "에스케이하이닉스"],
        # work_culture: SK하이닉스 공식 채용 '일하는 방식' 페이지.
        "work_culture": {
            "url": "https://www.skhynix.com/careers/UI-FR-CR0203/",
            "source_name": "SK하이닉스 공식 홈페이지",
            "title": "SK하이닉스 일하는 방식",
            # CULTURE_HINTS: 본문 컨테이너를 고르는 키워드(한/영). engine fetch_clean 이 사용.
            "selectors": {
                "culture_hints": [
                    "일하는 방식", "조직문화", "기업문화", "work", "culture",
                    "bar raising", "bar-raising", "one team", "ai", "innovation",
                    "customer", "perfection", "data", "way", "value",
                ],
            },
            "prompt_version": "sk-hynix-work-culture-v1",
        },
        # official_articles: SK하이닉스 뉴스룸 '인재상' 태그.
        "official_articles": {
            "tag_url": "https://news.skhynix.co.kr/tag/%EC%9D%B8%EC%9E%AC%EC%83%81/",
            "source_name": "SK hynix Newsroom",
            "list_item_selector": "article.item",   # 목록 항목 CSS
            "body_selector": "div.post-body",        # 상세 본문 컨테이너
            "title_suffix": r"\s*\|\s*SK hynix Newsroom\s*$",
            "since": "2025-01-01",
            "prompt_version": "sk-hynix-official-article-v1",
        },
        # external_news: 외부 언론 검색.
        "external_news": {
            "query": "SK하이닉스",
            "media": DEFAULT_MEDIA,
            # body/제목 안에서 회사를 식별하는 키(관련성 판정용).
            "subject_keys": ["sk하이닉스", "에스케이하이닉스", "sk hynix", "하이닉스"],
            "prompt_version": "sk-hynix-external-news-v1",
        },
    },
    {
        "company_key": "samsung_electronics",
        "display_name": "삼성전자",
        "aliases": ["삼성전자", "Samsung Electronics", "samsung electronics",
                    "samsung", "삼성"],
        # work_culture: 삼성 채용 '인재상/문화' 페이지.
        #  주의: 삼성 채용 사이트는 JS 렌더링이 많아 정적(httpx) 크롤이 실패할 수 있다.
        #  그래도 항목 자체는 정확/사용 가능해야 하므로 정식 URL 을 둔다(엔진이 본문 미발견을
        #  깔끔히 보고하고 다음 소스로 넘어감).
        "work_culture": {
            "url": "https://www.samsung.com/sec/aboutsamsung/careers/",
            "source_name": "삼성전자 채용 공식 페이지",
            "title": "삼성전자 인재상·일하는 방식",
            "selectors": {
                "culture_hints": [
                    "인재상", "핵심가치", "조직문화", "기업문화", "일하는 방식",
                    "value", "culture", "talent", "people", "innovation",
                    "challenge", "passion", "creativity", "integrity", "co-prosperity",
                ],
            },
            "prompt_version": "samsung-work-culture-v1",
        },
        # official_articles: 삼성전자 뉴스룸.
        #  뉴스룸(news.samsung.com/kr)은 인재/문화 전용 태그 페이지가 정적 목록으로
        #  안정적으로 노출되지 않아(주로 JS 카드/무한스크롤) 안전하게 None 으로 둔다.
        #  적합한 정적 태그가 확인되면 sk_hynix 항목과 같은 형태로 채우면 된다.
        "official_articles": None,
        # external_news: SK 와 동일 경로(회사명만 다름).
        "external_news": {
            "query": "삼성전자",
            "media": DEFAULT_MEDIA,
            "subject_keys": ["삼성전자", "samsung electronics", "삼성"],
            "prompt_version": "samsung-external-news-v1",
        },
    },
    {
        "company_key": "카카오뱅크",   # slugify_company("카카오뱅크") == "카카오뱅크"
        "display_name": "카카오뱅크",
        "aliases": ["카카오뱅크", "kakaobank", "kakao bank", "Kakao Bank",
                    "카뱅"],
        # work_culture: 카카오뱅크 채용 사이트.
        #  주의: recruit.kakaobank.com 은 JS 렌더(SPA)라 정적(httpx) 크롤로는 본문이
        #  거의 안 잡힌다(삼성전자와 동일 상황). 항목 자체는 정확/사용 가능하도록 정식
        #  URL 을 두고, 엔진이 본문 미발견을 깔끔히 보고한 뒤 다음 소스로 넘어가게 한다.
        "work_culture": {
            "url": "https://recruit.kakaobank.com/",
            "source_name": "카카오뱅크 채용 공식 사이트",
            "title": "카카오뱅크 인재상·일하는 방식",
            "selectors": {
                "culture_hints": [
                    "인재상", "핵심가치", "조직문화", "기업문화", "일하는 방식",
                    "value", "culture", "talent", "people", "innovation",
                    "challenge", "growth", "collaboration", "customer", "trust",
                ],
            },
            "prompt_version": "kakaobank-work-culture-v1",
        },
        # official_articles: 카카오뱅크 뉴스룸.
        #  전용 뉴스룸(newsroom.kakaobank.com)이 응답하지 않고, 인재/문화 전용 정적 태그
        #  목록이 안정적으로 노출되지 않아 안전하게 None 으로 둔다. 적합한 정적 태그가
        #  확인되면 sk_hynix 항목과 같은 형태로 채우면 된다.
        "official_articles": None,
        # external_news: SK/삼성과 동일 경로(회사명만 다름). 현재 주력 소스.
        "external_news": {
            "query": "카카오뱅크",
            "media": DEFAULT_MEDIA,
            "subject_keys": ["카카오뱅크", "kakaobank", "kakao bank", "카뱅"],
            "prompt_version": "kakaobank-external-news-v1",
        },
    },
]


# ──────────────────────────────────────────────────────────────────────────
# 조회 헬퍼
# ──────────────────────────────────────────────────────────────────────────

_BY_KEY = {e["company_key"]: e for e in REGISTRY}


def get_by_key(company_key: str) -> dict[str, Any] | None:
    """company_key 로 레지스트리 항목 조회."""
    return _BY_KEY.get(company_key)


def resolve(company_name: str) -> dict[str, Any]:
    """회사명 문자열 -> {company_key, display_name, entry|None}.

    TS resolveCompany 와 동일 의미:
      1) 별칭 정규화 일치 시 해당 큐레이션 항목.
      2) 아니면 slug 로 키 생성(표시명은 입력 그대로). entry 는 None(레지스트리 미등록).
    """
    n = _norm(company_name)
    if not n:
        return {"company_key": "", "display_name": "", "entry": None}
    for e in REGISTRY:
        if any(_norm(a) == n for a in e.get("aliases", [])):
            return {"company_key": e["company_key"],
                    "display_name": e["display_name"], "entry": e}
    key = slugify_company(company_name)
    return {"company_key": key, "display_name": company_name.strip(), "entry": None}
