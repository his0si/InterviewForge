"""한국 채용공고 상세 본문을 공통 머리말 기준으로 섹션 분리.

대부분의 공고가 '자격요건/우대사항/전형절차/제출서류/복리후생/급여/주요업무' 같은
표준 머리말을 쓰므로, 사이트별 셀렉터 대신 텍스트 머리말로 잘라 재사용한다.
"""
from __future__ import annotations

import re

# (정규식, 섹션키) — 머리말 매칭. 위에서부터 먼저 맞는 것.
_HEADINGS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"^\s*(자격\s*요건|지원\s*자격|지원\s*요건|필수\s*(요건|역량|사항)|자격조건)\b"), "qualifications"),
    (re.compile(r"^\s*(우대\s*사항|우대\s*요건|이런\s*분|preferred)\b", re.I), "preferred"),
    (re.compile(r"^\s*(전형\s*절차|채용\s*절차|전형\s*방법|채용\s*과정|선발\s*절차)\b"), "hiring_process"),
    (re.compile(r"^\s*(제출\s*서류|지원\s*방법|접수\s*방법|지원\s*서류|구비\s*서류)\b"), "documents"),
    (re.compile(r"^\s*(복리\s*후생|복지\s*제도|복지\s*및|혜택|benefits)\b", re.I), "benefits"),
    (re.compile(r"^\s*(급여|연봉|보수|salary)\b", re.I), "salary"),
    (re.compile(r"^\s*(주요\s*업무|담당\s*업무|업무\s*내용|직무\s*내용|main\s*tasks|업무)\b", re.I), "main_tasks"),
]
_KEYS = {"qualifications", "preferred", "hiring_process", "documents", "benefits", "salary", "main_tasks"}


def apply_sections(posting, text: str, max_len: int = 4000) -> None:
    """상세 본문 텍스트에서 섹션을 뽑아 posting 의 빈 필드를 채우고 detail_fetched=True 로 표시.
    원문이 항상 보이도록 description 에는 상세 본문 '전체'를 저장한다(섹션은 별도 추출)."""
    sec = parse_sections(text)
    for key in ("qualifications", "preferred", "hiring_process", "documents", "benefits", "salary"):
        val = sec.get(key)
        if val and not getattr(posting, key):
            setattr(posting, key, val[:max_len])
    # 원문 본문 전체 저장(과도하게 길면 컷). 섹션 파싱 실패와 무관하게 원문은 항상 채워진다.
    body = text.strip()
    if body:
        posting.description = body[:15000]
    posting.detail_fetched = True


def parse_sections(text: str) -> dict[str, str]:
    """본문 텍스트 → {section_key: 내용}. 머리말이 없으면 빈 dict."""
    if not text:
        return {}
    lines = [ln.strip() for ln in re.split(r"[\r\n]+", text)]
    out: dict[str, list[str]] = {}
    current: str | None = None
    for ln in lines:
        if not ln:
            continue
        matched = None
        for rx, key in _HEADINGS:
            m = rx.match(ln)
            if m and len(ln) <= 40:  # 머리말은 짧다(본문 문장 오탐 방지)
                matched = key
                rest = ln[m.end():].lstrip(" :：-·").strip()
                out.setdefault(key, [])
                if rest:
                    out[key].append(rest)
                break
        if matched:
            current = matched
        elif current:
            out[current].append(ln)
    return {k: "\n".join(v).strip() for k, v in out.items() if "".join(v).strip()}
