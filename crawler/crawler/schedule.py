"""상시 데몬(APScheduler). 컨테이너로 띄워두면 호스트 cron 없이 자동화된다.

예전엔 "매일 1회 전체 크롤링" 이었지만, 지금은 관리자(마스터) 화면에서 사이트별로
주기/자동·수동/활성화를 제어한다. 데몬은 POLL_SECONDS 마다 tick() 을 돌며:
  1) 수동 실행 큐(crawl_commands) 에 쌓인 요청을 먼저 처리하고,
  2) 자동(auto)·활성(enabled) 출처 중 주기가 지난 것(due)을 수집한다.
설정/큐는 InterviewForge 서버(Node)와 공유하는 crawl_settings / crawl_commands 테이블.
"""
from __future__ import annotations

import logging

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.interval import IntervalTrigger

from .adapters import ALL_ADAPTERS
from .config import POLL_SECONDS, TZ
from .db import (
    claim_command,
    connect,
    due_sources,
    finish_command,
    init_schema,
    seed_crawl_settings,
)
from .run import run_once

log = logging.getLogger("crawler.schedule")


def _seed() -> None:
    """알려진 어댑터들을 crawl_settings 에 시드(라벨/구현여부 최신화)."""
    sources = [(a.source, a.label, bool(a.enabled)) for a in ALL_ADAPTERS]
    with connect() as conn:
        seed_crawl_settings(conn, sources)


def _process_commands() -> None:
    """대기 중인 수동 실행 명령을 모두 처리한다(있는 만큼)."""
    while True:
        with connect() as conn:
            claimed = claim_command(conn)
        if not claimed:
            return
        cmd_id, source = claimed
        log.info("[수동] %s 실행 요청 처리 (cmd #%d)", source, cmd_id)
        try:
            results = run_once(only={source})
            n = results.get(source, 0)
            status = "done" if n >= 0 else "error"
            with connect() as conn:
                finish_command(conn, cmd_id, status, f"{source}: {n}건")
        except Exception as exc:
            log.exception("[수동] %s 실행 실패", source)
            with connect() as conn:
                finish_command(conn, cmd_id, "error", f"{exc}"[:200])


def _process_due() -> None:
    """주기가 지난 자동 출처를 수집한다."""
    with connect() as conn:
        due = due_sources(conn)
    if due:
        log.info("[자동] 주기 도래 출처: %s", due)
        run_once(only=set(due))


def tick() -> None:
    """폴링 1회: 수동 명령 → 자동 주기 순으로 처리. 예외가 나도 데몬은 계속 돈다."""
    try:
        _process_commands()
    except Exception:
        log.exception("수동 명령 처리 실패")
    try:
        _process_due()
    except Exception:
        log.exception("자동 주기 처리 실패")


def main() -> None:
    init_schema()
    _seed()
    log.info("부팅 즉시 1회 tick")
    tick()

    sched = BlockingScheduler(timezone=TZ)
    sched.add_job(
        tick,
        IntervalTrigger(seconds=POLL_SECONDS, timezone=TZ),
        id="crawl_tick",
        max_instances=1,
        coalesce=True,
    )
    log.info("스케줄러 시작 — %d초마다 설정/큐 확인", POLL_SECONDS)
    sched.start()
