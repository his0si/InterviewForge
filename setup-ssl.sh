#!/usr/bin/env bash
# 호스트 nginx에 interviewforge.kro.kr 등록 + ZeroSSL(acme.sh) 인증서 발급 (최초 1회).
# kro.kr 은 Let's Encrypt 주간 한도(*.kro.kr 공유)에 자주 막히므로 ZeroSSL 사용.
# acme.sh 는 sudo 실행을 거부하므로 현재 유저로 실행하고, 권한이 필요한 부분만 sudo 사용한다.
#
#   - nginx 설정 파일: /etc/nginx/conf.d/interviewforge.conf (전용)
#   - acme 챌린지 webroot: /var/www/acme-challenge-interviewforge (전용 — 기존 갱신에 영향 없음)
#   - 인증서 폴더: /etc/nginx/ssl/interviewforge.kro.kr (전용)
#   - sudoers 파일: /etc/sudoers.d/interviewforge-nginx-reload (전용)
#
# 권장 순서: 먼저 ./deploy.sh 로 컨테이너(127.0.0.1:8110)를 띄운 뒤 이 스크립트를 실행.
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then set -a; source .env; set +a; fi
DOMAIN="${DOMAIN_NAME:-interviewforge.kro.kr}"
EMAIL="${SSL_EMAIL:-admin@example.com}"

ACME="$HOME/.acme.sh/acme.sh"
WEBROOT="/var/www/acme-challenge-interviewforge"
CERT_DIR="/etc/nginx/ssl/$DOMAIN"
SUDOERS="/etc/sudoers.d/interviewforge-nginx-reload"
SYSTEMCTL="$(command -v systemctl || echo /usr/bin/systemctl)"

echo "$DOMAIN ZeroSSL 인증서 발급 ($EMAIL)"

# 1) acme.sh 설치 (현재 유저, 없을 때만) — 자동 갱신 cron 도 이 유저로 등록됨
if [ ! -f "$ACME" ]; then
  echo "acme.sh 설치..."
  curl -s https://get.acme.sh | sh -s email="$EMAIL"
fi

# 2) 자동 갱신 시 비번 없이 nginx reload 가능하도록 (정확히 이 명령 하나만 허용)
echo "nginx reload 권한 등록 (sudoers, 좁은 권한)..."
echo "$USER ALL=(root) NOPASSWD: $SYSTEMCTL reload nginx" | sudo tee "$SUDOERS" >/dev/null
sudo chmod 440 "$SUDOERS"
sudo visudo -cf "$SUDOERS"

# 3) 전용 웹루트·인증서 폴더를 현재 유저 소유로 (acme.sh가 sudo 없이 쓸 수 있게)
echo "디렉토리 준비..."
sudo mkdir -p "$WEBROOT/.well-known/acme-challenge" "$CERT_DIR"
sudo chown -R "$USER":"$USER" "$WEBROOT" "$CERT_DIR"

# 4) 챌린지 포함 HTTP 설정 적용 (기존 사이트 설정은 건드리지 않음)
echo "nginx HTTP(챌린지) 설정 적용..."
sudo cp deploy/http.conf /etc/nginx/conf.d/interviewforge.conf
sudo nginx -t
sudo systemctl reload nginx

# 5) ZeroSSL 계정 등록(멱등) + 인증서 발급 (webroot)
echo "ZeroSSL 계정 등록..."
"$ACME" --register-account -m "$EMAIL" --server zerossl
echo "인증서 발급..."
"$ACME" --issue -d "$DOMAIN" -w "$WEBROOT" --server zerossl

# 6) 인증서 설치 + 갱신 시 자동 reload 훅
echo "인증서 설치..."
"$ACME" --install-cert -d "$DOMAIN" \
  --key-file       "$CERT_DIR/privkey.pem" \
  --fullchain-file "$CERT_DIR/fullchain.pem" \
  --reloadcmd      "sudo $SYSTEMCTL reload nginx"

# 7) HTTPS 설정으로 교체
echo "nginx HTTPS 설정 적용..."
sudo cp deploy/ssl.conf /etc/nginx/conf.d/interviewforge.conf
sudo nginx -t
sudo systemctl reload nginx

echo "완료! https://$DOMAIN"
