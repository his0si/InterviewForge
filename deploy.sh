#!/usr/bin/env bash
# 빌드 + 재배포 (코드 수정 후 이거 한 번이면 됨).
# ewhaian 유저는 docker 그룹 소속이라 sudo 없이 docker 사용.
set -euo pipefail
cd "$(dirname "$0")"

echo "이미지 빌드 & 컨테이너 재기동..."
docker compose -f docker-compose.prod.yml up -d --build

echo "사용하지 않는 이전 이미지 정리..."
docker image prune -f >/dev/null 2>&1 || true

echo "현재 상태:"
docker compose -f docker-compose.prod.yml ps
