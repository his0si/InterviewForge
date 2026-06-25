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
