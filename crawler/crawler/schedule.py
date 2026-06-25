"""매일 1회 자동 실행 데몬 (APScheduler). 컨테이너로 상시 띄워두면 호스트 cron 없이 자동화된다."""
from __future__ import annotations

import logging

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

from .config import CRAWL_HOUR, CRAWL_MINUTE, TZ
from .run import run_once

log = logging.getLogger("crawler.schedule")


def main() -> None:
    # 시작 시 1회 즉시 실행(부팅 직후 데이터 확보) 후, 매일 정해진 시각에 실행.
    log.info("부팅 즉시 1회 실행")
    try:
        run_once()
    except Exception:
        log.exception("초기 실행 실패")

    sched = BlockingScheduler(timezone=TZ)
    sched.add_job(
        run_once,
        CronTrigger(hour=CRAWL_HOUR, minute=CRAWL_MINUTE, timezone=TZ),
        id="daily_crawl",
        max_instances=1,
        coalesce=True,
    )
    log.info("스케줄러 시작 — 매일 %02d:%02d (%s)", CRAWL_HOUR, CRAWL_MINUTE, TZ)
    sched.start()
