"""CLI 진입점.

  python -m crawler initdb     # 테이블/인덱스만 생성
  python -m crawler run        # 한 번 크롤링 + AI 요약 백필
  python -m crawler fields     # 크롤링 없이 구조화 필드(회사/직무/지역/경력/고용형태) 백필
  python -m crawler summarize  # 크롤링 없이 AI 요약만 백필(기존 본문 대상)
  python -m crawler schedule   # 상시 데몬(매일 자동 실행) — 컨테이너 기본 모드
"""
from __future__ import annotations

import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "initdb":
        from .db import init_schema
        init_schema()
    elif cmd == "run":
        from .run import run_once
        run_once()
    elif cmd == "summarize":
        from .run import summarize_pending
        summarize_pending()
    elif cmd == "fields":
        from .run import enrich_fields_pending
        enrich_fields_pending()
    elif cmd == "schedule":
        from .schedule import main as sched_main
        sched_main()
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
