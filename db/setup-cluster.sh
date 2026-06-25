#!/usr/bin/env bash
# InterviewForge 전용 PostgreSQL "클러스터"를 새로 만든다 (hansolax 클러스터와 같은 방식).
#  - 별도 포트(5434) + localhost & docker0(172.17.0.1) 바인딩
#    → 컨테이너는 host.docker.internal:5434 로, DBeaver 는 SSH 터널 → localhost:5434 로 접속
#  - 슈퍼유저(postgres)와 앱 유저(interviewforge) 비밀번호를 life0635 로 설정
#  - interviewforge 데이터베이스 생성 (테이블은 앱이 부팅 때 자동 생성)
#
# 실행(루트 권한 필요):
#   sudo bash db/setup-cluster.sh
set -euo pipefail

PG_VER=14
CLUSTER=interviewforge
PORT=5434
DB_PASS=life0635

if [[ $EUID -ne 0 ]]; then
  echo "이 스크립트는 root 로 실행해야 합니다:  sudo bash db/setup-cluster.sh" >&2
  exit 1
fi

CONF_DIR="/etc/postgresql/${PG_VER}/${CLUSTER}"

# 1) 클러스터 생성 (이미 있으면 건너뜀)
if pg_lsclusters -h 2>/dev/null | awk '{print $1"/"$2}' | grep -qx "${PG_VER}/${CLUSTER}"; then
  echo "클러스터 ${PG_VER}/${CLUSTER} 가 이미 있습니다. 생성 단계 건너뜀."
else
  echo "==> 클러스터 ${PG_VER}/${CLUSTER} (포트 ${PORT}) 생성"
  pg_createcluster "${PG_VER}" "${CLUSTER}" --port "${PORT}"
fi

# 2) listen_addresses: localhost + docker0 게이트웨이 (hansolax 와 동일)
echo "==> listen_addresses / port 설정"
sed -i "s/^[#[:space:]]*listen_addresses.*/listen_addresses = 'localhost,172.17.0.1'/" "${CONF_DIR}/postgresql.conf"
sed -i "s/^[#[:space:]]*port .*/port = ${PORT}/" "${CONF_DIR}/postgresql.conf"

# 3) pg_hba: 로컬(SSH 터널) + 도커 컨테이너 대역에서 비밀번호 접속 허용
HBA="${CONF_DIR}/pg_hba.conf"
if ! grep -q "interviewforge-app-rules" "${HBA}"; then
  echo "==> pg_hba 규칙 추가"
  cat >> "${HBA}" <<'EOF'

# interviewforge-app-rules  (SSH 터널 localhost + 도커 컨테이너 대역)
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             172.16.0.0/12           scram-sha-256
EOF
fi

# 4) 시작 / 재시작
echo "==> 클러스터 기동"
pg_ctlcluster "${PG_VER}" "${CLUSTER}" restart || pg_ctlcluster "${PG_VER}" "${CLUSTER}" start

# 5) 비밀번호 + DB/유저 (멱등)
echo "==> postgres 비밀번호 설정"
su - postgres -c "psql -p ${PORT} -v ON_ERROR_STOP=1 -c \"ALTER USER postgres WITH PASSWORD '${DB_PASS}';\""

echo "==> interviewforge 역할 생성/갱신"
if su - postgres -c "psql -p ${PORT} -tAc \"SELECT 1 FROM pg_roles WHERE rolname='interviewforge'\"" | grep -q 1; then
  su - postgres -c "psql -p ${PORT} -c \"ALTER ROLE interviewforge WITH PASSWORD '${DB_PASS}';\""
else
  su - postgres -c "psql -p ${PORT} -c \"CREATE ROLE interviewforge LOGIN PASSWORD '${DB_PASS}';\""
fi

echo "==> interviewforge 데이터베이스 생성"
if su - postgres -c "psql -p ${PORT} -tAc \"SELECT 1 FROM pg_database WHERE datname='interviewforge'\"" | grep -q 1; then
  echo "    이미 존재 — 건너뜀"
else
  su - postgres -c "psql -p ${PORT} -c \"CREATE DATABASE interviewforge OWNER interviewforge;\""
fi

echo
echo "완료 ✅  포트 ${PORT} 에 ${CLUSTER} 클러스터 + interviewforge DB 준비됨."
echo "    앱:     postgresql://interviewforge:${DB_PASS}@host.docker.internal:${PORT}/interviewforge"
echo "    DBeaver: SSH 터널 후 localhost:${PORT} / DB interviewforge / user interviewforge"
pg_lsclusters
