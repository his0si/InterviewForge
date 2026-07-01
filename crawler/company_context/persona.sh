#!/usr/bin/env bash
# 기업 페르소나 수집 파이프라인 관리 (deploy.sh 처럼 한 번에).
#
#   ./persona.sh install      # 자동 수집 cron 등록(하루 1회, 매일 04:00)
#   ./persona.sh uninstall    # cron 해제(데이터·코드는 그대로 둠)
#   ./persona.sh status       # cron 등록 여부 + 큐/적재/최근 실행 현황
#   ./persona.sh daily [N]    # 지금 하루치 1회 실행(JIT 큐 + 미수집 상위 N곳, 기본 20)
#   ./persona.sh drain        # 지금 JIT 큐만 1회 처리
#   ./persona.sh sweep [N]    # 지금 공고 상위 N곳 1회 수집(빈도순, 커버리지 무시)
#   ./persona.sh company <키>  # 등록 회사 1곳 수집(예: samsung_electronics)
#   ./persona.sh logs         # 수집 로그 tail
#
# 중요: cron 은 "상시 데몬"이 아니다. 매일 04:00 명령을 1회 실행하고 끝난다(상주 프로세스 0).
#  하루치(--daily N) = (1) JIT 큐(사용자가 면접 본 회사) + (2) 아직 데이터 없는 실제 기업 상위 N곳.
#  대행사/기수집 회사는 건너뛰고, 뉴스 없는 회사는 EXAONE 전 게이트에서 0건(비용 0)으로 처리된다.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CRAWLER="$(cd "$HERE/.." && pwd)"
PYBIN="$CRAWLER/.venv/bin/python"
ENVFILE="$CRAWLER/../.env"
LOGDIR="$CRAWLER/logs"
MARK="company_context.run"   # cron 라인 식별자
mkdir -p "$LOGDIR"

# 하루 1회(매일 04:00) 단일 작업: JIT 큐 처리 + 아직 데이터 없는 실제 기업 상위 20곳 수집.
DAILY_N="${PERSONA_DAILY_N:-20}"
cron_lines() {
  cat <<CRON
# InterviewForge 기업 페르소나 자동 수집 ($MARK) — 하루 1회
0 4 * * * cd $CRAWLER && $PYBIN -m company_context.run --daily $DAILY_N --execute >> $LOGDIR/persona_daily.log 2>&1
CRON
}

db_url() {
  grep '^DATABASE_URL=' "$ENVFILE" | cut -d= -f2- | tr -d '"'"'"'' \
    | sed 's#host.docker.internal#127.0.0.1#;s#gateway.docker.internal#127.0.0.1#'
}

case "${1:-status}" in
  install)
    ( crontab -l 2>/dev/null | grep -v "$MARK"; cron_lines ) | crontab -
    echo "✓ cron 등록 완료. 현재:"; crontab -l | grep -E "$MARK|페르소나" || true
    ;;
  uninstall)
    if crontab -l 2>/dev/null | grep -q "$MARK"; then
      crontab -l 2>/dev/null | grep -v "$MARK" | grep -v "기업 페르소나 자동 수집" | crontab -
      echo "✓ cron 해제 완료(데이터·코드는 보존)."
    else
      echo "등록된 페르소나 cron 이 없습니다."
    fi
    ;;
  status)
    echo "── cron 등록 상태 ──"
    crontab -l 2>/dev/null | grep -E "$MARK" && echo "  → 자동 수집 ON" || echo "  (미등록 — 자동 수집 OFF)"
    URL="$(db_url)"
    echo "── 큐/적재 현황 ──"
    psql "$URL" -P pager=off -c "SELECT count(*) AS pending_요청 FROM company_ingest_requests WHERE status='pending';" 2>/dev/null || echo "  (DB 조회 실패)"
    psql "$URL" -P pager=off -c "SELECT count(distinct company_key) AS 회사수, count(*) AS 총행, pg_size_pretty(pg_total_relation_size('company_contexts')) AS 크기 FROM company_contexts;" 2>/dev/null || true
    echo "── 최근 수집 실행 5건 ──"
    psql "$URL" -P pager=off -c "SELECT company_key, status, inserted_rows, to_char(started_at,'MM-DD HH24:MI') AS 시각 FROM company_ingest_runs ORDER BY started_at DESC LIMIT 5;" 2>/dev/null || true
    ;;
  daily)
    cd "$CRAWLER" && "$PYBIN" -m company_context.run --daily "${2:-20}" --execute
    ;;
  drain)
    cd "$CRAWLER" && "$PYBIN" -m company_context.run --drain --execute
    ;;
  sweep)
    cd "$CRAWLER" && "$PYBIN" -m company_context.run --top "${2:-60}" --limit 4 --execute
    ;;
  company)
    [ -n "${2:-}" ] || { echo "사용법: ./persona.sh company <company_key>"; exit 1; }
    cd "$CRAWLER" && "$PYBIN" -m company_context.run --company "$2" --execute
    ;;
  logs)
    tail -n 40 "$LOGDIR"/persona_*.log 2>/dev/null || echo "(아직 로그 없음)"
    ;;
  *)
    echo "사용법: ./persona.sh {install|uninstall|status|daily [N]|drain|sweep [N]|company <키>|logs}"; exit 1
    ;;
esac
