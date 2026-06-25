"""오케스트레이터: 활성 어댑터를 순회하며 수집 → DB UPSERT. 어댑터 하나가 실패해도 전체는 계속."""
from __future__ import annotations

import logging

from .adapters import ALL_ADAPTERS
from .config import SUMMARY_LIMIT
from .db import connect, init_schema, upsert_jobs
from .llm import summarize, extract_fields

log = logging.getLogger("crawler.run")


def enrich_fields_pending(limit: int = SUMMARY_LIMIT) -> int:
    """본문은 있는데 회사 등 구조화 필드가 비어 있는 공고를 LLM 으로 추출·적재(백필).
    카드 한 줄(회사·직무·지역·경력·고용형태)을 채운다. 비어 있는 컬럼만 갱신."""
    init_schema()
    done = 0
    with connect() as conn:
        # 카드 한 줄(회사·직무·지역·경력·고용형태) 중 하나라도 비어 있으면 추출 대상.
        rows = conn.execute(
            """SELECT id, title, description, job_categories
               FROM job_postings
               WHERE description IS NOT NULL
                 AND (company IS NULL OR location IS NULL OR experience_level IS NULL
                      OR employment_type IS NULL OR job_categories = '{}')
               ORDER BY first_seen_at DESC LIMIT %s""",
            (limit,),
        ).fetchall()
        log.info("필드 추출 대상 %d건", len(rows))
        for jid, title, desc, cats in rows:
            f = extract_fields(title or "", desc or "")
            if not f:
                continue
            new_cats = cats if cats else ([f["role"]] if f.get("role") else [])
            conn.execute(
                """UPDATE job_postings SET
                     company = COALESCE(company, %s),
                     location = COALESCE(location, %s),
                     experience_level = COALESCE(experience_level, %s),
                     employment_type = COALESCE(employment_type, %s),
                     job_categories = %s
                   WHERE id = %s""",
                (f.get("company"), f.get("location"), f.get("experience_level"),
                 f.get("employment_type"), new_cats, jid),
            )
            done += 1
    log.info("필드 추출 완료 %d건", done)
    return done


def summarize_pending(limit: int = SUMMARY_LIMIT) -> int:
    """본문(description)은 있는데 ai_summary 가 비어 있는 공고를 LLM 으로 요약·적재(백필).
    재크롤링 없이 기존 데이터에 요약만 채운다. 반환: 요약한 건수."""
    init_schema()
    done = 0
    with connect() as conn:
        rows = conn.execute(
            """SELECT id, title, description FROM job_postings
               WHERE description IS NOT NULL AND ai_summary IS NULL
               ORDER BY first_seen_at DESC LIMIT %s""",
            (limit,),
        ).fetchall()
        log.info("요약 대상 %d건", len(rows))
        for jid, title, desc in rows:
            summary = summarize(title or "", desc or "")
            if summary:
                conn.execute(
                    "UPDATE job_postings SET ai_summary = %s, ai_summary_at = now() WHERE id = %s",
                    (summary, jid),
                )
                done += 1
    log.info("요약 완료 %d건", done)
    return done


def run_once() -> dict[str, int]:
    """한 번의 전체 크롤링 사이클. 반환: {source: 처리건수}."""
    init_schema()
    results: dict[str, int] = {}
    with connect() as conn:
        for adapter in ALL_ADAPTERS:
            if not adapter.enabled:
                log.info("[%s] 비활성(미구현) — 건너뜀", adapter.source)
                continue
            try:
                postings = adapter.fetch()
                n = upsert_jobs(conn, postings)
                results[adapter.source] = n
                log.info("[%s] %s: %d건 저장", adapter.source, adapter.label, n)
            except Exception:  # 한 사이트 실패가 전체를 막지 않도록
                log.exception("[%s] 크롤링 실패", adapter.source)
                results[adapter.source] = -1
    log.info("크롤링 사이클 완료: %s", results)
    # 수집 후, 새 공고에 구조화 필드(회사/직무/지역/경력/고용형태) + AI 요약 백필
    try:
        enrich_fields_pending()
    except Exception:
        log.exception("필드 추출 백필 실패")
    try:
        summarize_pending()
    except Exception:
        log.exception("AI 요약 백필 실패")
    return results
