"""DB 연결 + 스키마 보장 + 공고 UPSERT (psycopg3, interviewforge DB)."""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path

import psycopg
from psycopg.types.json import Json

from .config import DATABASE_URL
from .models import JobPosting

log = logging.getLogger("crawler.db")

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "db" / "schema.sql"

# UPSERT 시 갱신할 컬럼들(매 크롤링마다 최신화). first_seen_at 은 유지.
_UPDATABLE = [
    "source_url", "title", "company", "location", "employment_type",
    "experience_level", "experience_min", "experience_max", "education",
    "salary", "job_categories", "skills", "posted_at", "deadline",
    "deadline_text", "qualifications", "preferred", "hiring_process",
    "documents", "benefits", "description", "detail_fetched", "raw",
]
_INSERT_COLS = ["source", "source_job_id", *_UPDATABLE, "is_active"]


def connect() -> psycopg.Connection:
    return psycopg.connect(DATABASE_URL, autocommit=True)


def init_schema() -> None:
    """db/schema.sql 을 실행해 테이블/인덱스를 보장한다(멱등)."""
    sql = SCHEMA_PATH.read_text(encoding="utf-8")
    with connect() as conn:
        conn.execute(sql)
    log.info("schema ensured")


def _derive_job_id(p: JobPosting) -> str:
    if p.source_job_id:
        return p.source_job_id
    return "url:" + hashlib.sha1(p.source_url.encode("utf-8")).hexdigest()[:24]


# ── 관리자 크롤링 설정 / 수동 실행 큐 ─────────────────────────────────────────

def seed_crawl_settings(conn: psycopg.Connection, sources: list[tuple[str, str, bool]]) -> None:
    """알려진 출처(source, label, implemented)를 시드. 라벨/구현여부만 최신화하고
    사용자가 바꾼 주기/모드/활성화 값은 보존한다."""
    for source, label, implemented in sources:
        conn.execute(
            """INSERT INTO crawl_settings (source, label, implemented)
               VALUES (%s, %s, %s)
               ON CONFLICT (source) DO UPDATE
                 SET label = EXCLUDED.label, implemented = EXCLUDED.implemented""",
            (source, label, implemented),
        )


def due_sources(conn: psycopg.Connection) -> list[str]:
    """지금 자동 수집해야 할 출처 목록.
    enabled=TRUE, mode='auto', implemented=TRUE 이고, 한 번도 안 돌았거나
    (마지막 실행 + 주기) 가 지난 출처."""
    rows = conn.execute(
        """SELECT source FROM crawl_settings
           WHERE enabled = TRUE AND mode = 'auto' AND implemented = TRUE
             AND (last_run_at IS NULL
                  OR last_run_at + (interval_hours || ' hours')::interval <= now())
           ORDER BY source"""
    ).fetchall()
    return [r[0] for r in rows]


def mark_source_run(conn: psycopg.Connection, source: str, status: str) -> None:
    """한 출처의 마지막 실행 시각/결과를 기록."""
    conn.execute(
        "UPDATE crawl_settings SET last_run_at = now(), last_status = %s, updated_at = now() WHERE source = %s",
        (status, source),
    )


def claim_command(conn: psycopg.Connection) -> tuple[int, str] | None:
    """대기 중(pending) 수동 실행 명령 하나를 'running' 으로 선점해 (id, source) 반환.
    없으면 None. 동시 실행 안전(SKIP LOCKED)."""
    row = conn.execute(
        """UPDATE crawl_commands SET status = 'running', started_at = now()
           WHERE id = (
             SELECT id FROM crawl_commands WHERE status = 'pending'
             ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED
           )
           RETURNING id, source"""
    ).fetchone()
    return (row[0], row[1]) if row else None


def finish_command(conn: psycopg.Connection, cmd_id: int, status: str, result: str) -> None:
    """수동 실행 명령을 done/error 로 마감."""
    conn.execute(
        "UPDATE crawl_commands SET status = %s, finished_at = now(), result = %s WHERE id = %s",
        (status, result, cmd_id),
    )


def upsert_jobs(conn: psycopg.Connection, postings: list[JobPosting]) -> int:
    """공고 목록을 UPSERT. 반환: 처리(삽입+갱신)된 건수."""
    if not postings:
        return 0

    set_clause = ", ".join(f"{c} = EXCLUDED.{c}" for c in _UPDATABLE)
    placeholders = ", ".join(["%s"] * len(_INSERT_COLS))
    sql = f"""
        INSERT INTO job_postings ({", ".join(_INSERT_COLS)})
        VALUES ({placeholders})
        ON CONFLICT (source, source_job_id) DO UPDATE
        SET {set_clause}, last_crawled_at = now(), is_active = TRUE
    """

    n = 0
    with conn.cursor() as cur:
        for p in postings:
            d = p.as_db_dict()
            row = [
                p.source,
                _derive_job_id(p),
                d["source_url"], d["title"], d["company"], d["location"],
                d["employment_type"], d["experience_level"], d["experience_min"],
                d["experience_max"], d["education"], d["salary"],
                d["job_categories"], d["skills"], d["posted_at"], d["deadline"],
                d["deadline_text"], d["qualifications"], d["preferred"],
                d["hiring_process"], d["documents"], d["benefits"],
                d["description"], d["detail_fetched"], Json(d["raw"]),
                True,  # is_active
            ]
            cur.execute(sql, row)
            n += 1
    return n
