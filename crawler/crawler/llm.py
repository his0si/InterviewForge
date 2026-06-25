"""로컬 LLM(Ollama) 으로 채용 공고 본문을 정갈한 마크다운 요약으로 정리."""
from __future__ import annotations

import logging
import re

import httpx

from .config import OLLAMA_URL, OLLAMA_MODEL

log = logging.getLogger("crawler.llm")

PROMPT = """너는 채용 공고 정리 도우미다. 아래 '원문'만 근거로, 지원자가 한눈에 보도록 한국어 마크다운으로 정리하라.

규칙:
- 원문에 있는 사실만 사용. 추측·과장·창작 금지.
- 날짜·금액·숫자는 원문 그대로 옮긴다(임의 변경 금지).
- 해당 항목 내용이 원문에 없으면 그 줄은 "명시되지 않음" 으로 적는다.
- 군더더기(메뉴/버튼/안내문)는 무시한다.

출력 형식(이 형식만, 다른 말 붙이지 말 것):
**한 줄 요약**: 회사·직무·핵심을 1문장
**주요 업무**:
- (불릿)
**자격 요건**:
- (불릿)
**우대 사항**:
- (불릿)
**고용형태/급여/근무지/마감**: 원문에 있는 것만 한 줄로

원문:
---
{body}
"""

FIELDS_PROMPT = """아래 채용공고에서 정보를 추출해 JSON으로만 답하라. 본문에 명확히 없으면 null. 추측 금지.
키:
- company: 회사명(문자열) 또는 null
- role: 직무를 한국어 한 단어로(예: 백엔드 개발자, 디자이너, PM, 마케터, 회계) 또는 null
- location: 근무지를 시·구 단위로만(예: "서울 서초구", "경기 성남시"). 상세주소·건물명·층 제외. 또는 null
- experience_level: 신입 / 경력N년 / 경력무관 등(문자열) 또는 null
- employment_type: 정규직 / 계약직 / 인턴 등(문자열) 또는 null
제목: {title}
본문(일부): {body}"""


def _clean(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, list):
        v = ", ".join(str(x) for x in v if x)
    v = str(v).strip()
    return v or None


_REGION = re.compile(r"([가-힣]+(?:특별자치시|특별시|광역시|특별자치도|도|시))\s*([가-힣]+(?:구|군|시))?")


def _region(loc: str | None) -> str | None:
    """근무지를 시·구 단위로 축약(상세주소 제거). 여러 곳이면 첫 번째."""
    if not loc:
        return loc
    loc = loc.split(",")[0].split("/")[0].strip()
    m = _REGION.search(loc)
    if m:
        return (m.group(1) + (" " + m.group(2) if m.group(2) else "")).strip()
    parts = loc.split()
    return " ".join(parts[:2]) if parts else (loc or None)


def extract_fields(title: str, body: str) -> dict:
    """본문에서 company/role/location/experience_level/employment_type 추출(JSON). 실패 시 {}."""
    text = (body or "").strip()
    if len(text) < 30:
        return {}
    prompt = FIELDS_PROMPT.format(title=title or "", body=text[:3000])
    try:
        r = httpx.post(
            f"{OLLAMA_URL}/api/generate",
            json={"model": OLLAMA_MODEL, "prompt": prompt, "stream": False,
                  "format": "json", "options": {"temperature": 0.1, "num_ctx": 8192}},
            timeout=120,
        )
        r.raise_for_status()
        import json
        d = json.loads(r.json().get("response") or "{}")
        out = {k: _clean(d.get(k)) for k in
               ("company", "role", "location", "experience_level", "employment_type")}
        out["location"] = _region(out.get("location"))  # 지역을 시·구 단위로 축약
        return out
    except Exception as e:
        log.warning("필드 추출 실패(%s): %s", (title or "")[:20], e)
        return {}


def summarize(title: str, body: str) -> str | None:
    """본문을 요약한 마크다운 반환. 실패 시 None."""
    text = (body or "").strip()
    if len(text) < 40:  # 본문이 너무 짧으면 요약 의미 없음
        return None
    prompt = PROMPT.format(body=text[:5000])
    try:
        r = httpx.post(
            f"{OLLAMA_URL}/api/generate",
            json={
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.15, "num_ctx": 8192},
            },
            timeout=180,
        )
        r.raise_for_status()
        out = (r.json().get("response") or "").strip()
        return out or None
    except Exception as e:
        log.warning("요약 실패(%s): %s", title[:20], e)
        return None
