# InterviewForge

기업별 면접 스타일을 재현하는 **AI 압박면접 시뮬레이터**의 풀스택 베이스.
Node 기반 npm workspaces 모노레포로 구성하고, Docker + 호스트 nginx(ZeroSSL)로
[interviewforge.kro.kr](https://interviewforge.kro.kr) 에 배포된다.

> 현재는 client ↔ server ↔ shared 가 연결된 **기본 골격** 상태이며, 여기에 면접 기능을 쌓아 올린다.

## 기술 스택

| 영역 | 사용 기술 |
|---|---|
| 프론트엔드 | Vite + React + TypeScript (`client/`) |
| 백엔드 | Fastify + TypeScript (`server/`) — 프로덕션에선 client 정적 빌드도 함께 서빙 |
| 공유 코드 | `shared/` — client·server 공용 TypeScript 타입 |
| 배포 | Docker(단일 컨테이너) + 호스트 nginx 리버스 프록시 + ZeroSSL(acme.sh) |

## 디렉토리 구조

```
InterviewForge/
├─ client/                  Vite + React 프론트엔드
│  ├─ src/                  화면 코드 (App.tsx 등)
│  └─ vite.config.ts        개발 시 /health·/api 를 백엔드(:8787)로 프록시
├─ server/                  Fastify API 서버
│  └─ src/index.ts          /health + 프로덕션 정적 서빙
├─ shared/                  client·server 공용 타입
│  └─ src/index.ts          예) HealthResponse
├─ deploy/                  호스트 nginx 설정
│  ├─ http.conf             인증서 발급 전 임시(챌린지)
│  └─ ssl.conf              최종 HTTPS
├─ Dockerfile               멀티스테이지: client 빌드 + server 런타임
├─ docker-compose.prod.yml  프로덕션 컨테이너 (127.0.0.1:8110)
├─ setup-ssl.sh             (최초 1회) 도메인 등록 + 인증서 발급
├─ deploy.sh              (수정 후) 빌드 + 컨테이너 재기동
└─ .env.example            환경변수 템플릿
```

### `shared` 는 왜 있나
client와 server가 같이 쓰는 타입(예: API 응답 형태)을 한 곳에 정의해 양쪽이 import 한다.
서버 응답 모양을 바꾸면 프론트에서 타입 에러로 바로 잡혀, 풀스택 TS의 실수를 줄여준다.

## 로컬 개발

```bash
npm install
npm run dev          # client(:5173) + server(:8787) 동시 실행
```

브라우저에서 http://localhost:5173 → **서버 연결 확인** 버튼 → `서버 연결 OK ✅` 가 뜨면
client → shared(타입) → server 까지 정상 연결된 것.
(client는 항상 상대경로 `/health` 로 호출하고, 개발 땐 Vite 프록시가 `:8787` 로 넘긴다.)

## 배포 (interviewforge.kro.kr)

호스트의 다른 사이트와 **겹치지 않도록** 모든 리소스를 전용 네임스페이스로 분리했다.

| 항목 | 값 | 비고 |
|---|---|---|
| 호스트 포트 | `127.0.0.1:8110` | 외부 미노출, nginx만 접근 |
| nginx 설정 | `/etc/nginx/conf.d/interviewforge.conf` | 전용 파일 |
| 인증서 | `/etc/nginx/ssl/interviewforge.kro.kr/` | ZeroSSL, 자동 갱신 |
| acme 챌린지 | `/var/www/acme-challenge-interviewforge/` | 전용 — 기존 사이트 갱신에 영향 없음 |
| 컨테이너 | `interviewforge` | compose 프로젝트 `interviewforge` |

### 최초 배포

```bash
# 0) DNS: interviewforge.kro.kr A 레코드 → 서버 공인 IP (kro.kr 관리페이지)
# 0) 환경변수: cp .env.example .env  후 SSL_EMAIL 을 본인 이메일로 채움

./deploy.sh        # 1) 앱 컨테이너 빌드 & 기동 (127.0.0.1:8110)
./setup-ssl.sh       # 2) 도메인 등록 + 인증서 발급 (sudo 비밀번호 입력 필요, 최초 1회)
```

완료 후 https://interviewforge.kro.kr 접속.

### 코드 수정 후 재배포

```bash
./deploy.sh        # 재빌드 + 컨테이너 재기동. 이것만 실행하면 됨.
```

## 동작 방식

- 호스트 nginx 한 대가 443에서 `server_name` 으로 사이트를 분기 → 각 컨테이너로 리버스 프록시.
- 이 앱은 단일 컨테이너의 Fastify가 API(`/health` 등)와 빌드된 React 정적파일을 **같은 출처**로 서빙.
- 인증서 자동 갱신: acme.sh(현재 유저 cron) → 갱신 시 `sudo systemctl reload nginx` (좁은 sudoers 권한).

## 환경변수

`.env` 는 **배포 설정 전용**(`setup-ssl.sh` 가 읽음)이며 git에 올라가지 않는다(`.gitignore`).
템플릿 `.env.example` 을 복사해서 만든다: `cp .env.example .env`

| 변수 | 용도 |
|---|---|
| `DOMAIN_NAME` | 인증서를 발급할 도메인 |
| `SSL_EMAIL` | ZeroSSL 갱신 알림 이메일 |

> 앱 포트(8787)는 도커(`docker-compose.prod.yml`)와 서버 기본값으로 정해지므로 `.env` 에 둘 필요가 없다.
