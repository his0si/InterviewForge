# InterviewForge

기업별 면접 스타일을 재현하는 **AI 압박면접 시뮬레이터**.
이력서·직무를 근거로 한 질문 → 실시간 답변 평가 → **꼬리(압박) 질문** → 최종 리포트까지,
실제 면접의 흐름을 한 번에 시뮬레이션한다. 논리력뿐 아니라 **평정심(비언어 신호)** 까지 정량화한다.

- 운영: **[interviewforge.kro.kr](https://interviewforge.kro.kr)**
- 구성: npm workspaces 모노레포(client · server · shared) + 별도 Python 크롤러
- 특징: **모든 AI 추론을 로컬 LLM(Ollama)** 으로 처리 → 이력서·면접 데이터가 외부로 나가지 않음

---

## 목차

1. [핵심 기능 한눈에](#핵심-기능-한눈에)
2. [기술 스택](#기술-스택)
3. [시스템 아키텍처](#시스템-아키텍처)
4. [모노레포 구조](#모노레포-구조)
5. [데이터베이스 스키마](#데이터베이스-스키마)
6. [기능별 구현 상세](#기능별-구현-상세)
   - [1. 회원 인증(가입·이메일 인증·로그인)](#1-회원-인증가입이메일-인증로그인)
   - [2. AI 모의면접 (LangGraph)](#2-ai-모의면접-langgraph)
   - [3. 이력서·직무 기반 질문](#3-이력서직무-기반-질문)
   - [4. 꼬리질문 / 압박 질문](#4-꼬리질문--압박-질문)
   - [5. 기업 페르소나](#5-기업-페르소나)
   - [6. 로컬 AI 로 보안 문제 해결](#6-로컬-ai-로-보안-문제-해결)
   - [7. 이력서 피드백](#7-이력서-피드백)
   - [8. 맞춤 채용 공고 추천](#8-맞춤-채용-공고-추천)
   - [9. 면접 연습(녹화·실시간 자막·실시간 분석)](#9-면접-연습녹화실시간-자막실시간-분석)
   - [10. 평정심 리포트](#10-평정심-리포트)
   - [11. 면접 복기(면접 기록·PDF)](#11-면접-복기면접-기록pdf)
   - [12. 채용 공고 크롤링](#12-채용-공고-크롤링)
   - [13. 관리자 크롤링 제어](#13-관리자-크롤링-제어)
   - [14. 반응형(PC·모바일)](#14-반응형pc모바일)
   - [15. 로딩 스플래시(UX)](#15-로딩-스플래시ux)
7. [보안 & 배포](#보안--배포)
8. [로컬 개발](#로컬-개발)
9. [배포 절차](#배포-절차)
10. [환경변수](#환경변수)
11. [사용자 행동 분석 (Amplitude)](#사용자-행동-분석-amplitude)

---

## 핵심 기능 한눈에

| 기능 | 한 줄 설명 | 핵심 구현 |
|---|---|---|
| AI 모의면접 | 이력서·직무·기업을 근거로 대화형 면접 진행 | LangGraph 상태 그래프 + 로컬 LLM |
| 꼬리질문/압박 질문 | 약한 답변을 파고드는 후속 질문 | 답변 점수 기반 라우팅(임계 70) |
| 평정심 리포트 | 답변 타이밍·채움말·표정/시선/자세 정량화 | MediaPipe FaceLandmarker + STT |
| 실시간 분석 HUD | 녹화 중 wpm·필러·시선/눈/자세를 영상 위에 표시 + **영상에 번인** | SVG 그래프 + `canvas.captureStream` 합성 |
| 기업 페르소나 | 회사 인재상·기사로 첫 질문을 앵커링 | `company_contexts` 테이블 + JIT 수집 |
| 이력서 피드백 | PDF 업로드 → 직무·강점·보완점 분석 | `unpdf` 추출 + 2-pass LLM |
| 맞춤 공고 추천 | 이력서·직무 임베딩으로 의미검색 | pgvector(HNSW) 코사인 유사도 |
| 면접 복기 | 녹화 영상·자막·리포트 다시보기 + PDF | DB 저장(webm/BYTEA) + `@media print` |
| 채용 공고 크롤링 | 11개 채용 사이트 자동 수집·요약 | Python(Playwright/httpx) + LLM 요약 |
| 관리자 제어 | 사이트별 수집 주기·on/off·수동 실행 | `crawl_settings`/`crawl_commands` |
| 반응형 | PC·모바일 지원(면접 연습은 PC 전용) | `matchMedia` 가드 + CSS 브레이크포인트 |

---

## 기술 스택

| 영역 | 사용 기술 |
|---|---|
| 프론트엔드 | React 18 · Vite 6 · TypeScript · React Router 6 (`client/`) |
| 실시간 분석(브라우저) | Web Speech API(STT) · MediaRecorder(녹화) · MediaPipe `tasks-vision`(얼굴) |
| 백엔드 | Fastify 5 · TypeScript (`server/`) — 프로덕션에선 client 정적 빌드도 함께 서빙 |
| AI 오케스트레이션 | `@langchain/langgraph` + `@langchain/langgraph-checkpoint-postgres` |
| 로컬 LLM | Ollama — 생성 `exaone3.5:latest`(한국어 특화), 임베딩 `bge-m3:latest`(1024차원) |
| 데이터베이스 | PostgreSQL 14(전용 클러스터, 포트 5434) + **pgvector**(의미검색) |
| 크롤러 | Python 3 · Playwright · httpx · BeautifulSoup · APScheduler (`crawler/`) |
| 공유 코드 | `shared/` — client·server 공용 TypeScript 타입(API 계약) |
| 배포 | Docker(멀티스테이지, 단일 컨테이너) + 호스트 nginx 리버스 프록시 + ZeroSSL(acme.sh) |

주요 서버 의존성: `fastify`, `@fastify/{cors,cookie,multipart,static}`, `pg`, `jsonwebtoken`, `bcryptjs`, `nodemailer`, `unpdf`, `@langchain/*`.

---

## 시스템 아키텍처

```
                        인터넷(HTTPS 443)
                              │
                    ┌─────────▼──────────┐
                    │  호스트 nginx       │  server_name 분기 + TLS 종료(ZeroSSL)
                    │  (리버스 프록시)     │  HSTS·보안 헤더·200M 업로드 허용
                    └─────────┬──────────┘
                     proxy → 127.0.0.1:8110 (외부 미노출)
                              │
        ┌─────────────────────▼─────────────────────┐
        │  Docker 컨테이너: Fastify(:8787)            │
        │   - /api/* REST API                         │
        │   - 빌드된 React 정적파일(client/dist) 서빙 │  ← 같은 출처(SPA)
        │   - 백그라운드 워커(임베딩·이력서 분석)     │
        └───┬───────────────┬───────────────┬────────┘
            │ host.docker.internal
            ▼               ▼               ▼
     PostgreSQL 14     Ollama(:11434)   (SMTP: Gmail)
     클러스터(:5434)   exaone3.5/bge-m3   이메일 인증
     + pgvector
            ▲
            │ (같은 DB 를 공유)
     ┌──────┴───────────────┐
     │  Python 크롤러(별도)  │  채용 공고 수집 + 기업 페르소나 수집
     │  Playwright/httpx     │  APScheduler 데몬(60초 폴링)
     └───────────────────────┘
```

- **단일 컨테이너 원칙**: 하나의 Fastify 프로세스가 API 와 React 정적파일을 **같은 출처**로 서빙 → CORS/쿠키 문제를 원천 제거.
- **크롤러는 앱과 분리**: 앱↔크롤러는 직접 호출하지 않고 **DB 를 통해서만** 소통(`crawl_commands`, `company_ingest_requests` 큐).

---

## 모노레포 구조

```
InterviewForge/
├─ client/                     Vite + React 프론트엔드
│  ├─ index.html               스플래시(부팅 전 첫 페인트) + 폰트 preload
│  └─ src/
│     ├─ App.tsx               라우팅 + 쿠키 기반 로그인 복원
│     ├─ api.ts                REST 클라이언트(credentials: include)
│     ├─ components/           AppShell(사이드바)·Splash·ComposureCard 등
│     ├─ pages/                Home·Jobs·JobDetail·ResumeFeedback·Practice·History·Login·Signup
│     └─ composure/            score.ts(점수)·faceTracker.ts(얼굴)·fillers.ts(채움말)
├─ server/                     Fastify API 서버
│  └─ src/
│     ├─ index.ts              부팅·정적 서빙·SPA 폴백·캐시 헤더
│     ├─ db.ts                 커넥션 풀 + initDb(스키마 자동 생성/마이그레이션)
│     ├─ auth.ts / email.ts    가입·인증·로그인 / 메일 발송
│     ├─ resumes.ts / resumeAnalysis.ts   이력서 업로드 / 2-pass 분석
│     ├─ jobs.ts / jobEmbeddings.ts       공고 목록·추천 / 임베딩 워커
│     ├─ interview.ts          모의면접 REST 라우트
│     ├─ aiInterview/          LangGraph 그래프·LLM 프롬프트·기업 컨텍스트·근거 검증
│     └─ ollama.ts             로컬 LLM 클라이언트(generate/generateJson/embed)
├─ shared/src/index.ts         client·server 공용 타입(API 응답 모양)
├─ crawler/                    Python 채용 공고 크롤러 + 기업 페르소나 수집
│  ├─ crawler/                 base·browser·run·schedule + adapters/(사이트별)
│  └─ company_context/         engine·registry·run(기업 컨텍스트 파이프라인)
├─ db/                         클러스터 생성 스크립트 + 참고용 스키마 SQL
├─ deploy/                     nginx 설정(http.conf 챌린지용 / ssl.conf 최종)
├─ Dockerfile                  멀티스테이지: client 빌드 + server 런타임
├─ docker-compose.prod.yml     프로덕션 컨테이너(127.0.0.1:8110)
├─ setup-ssl.sh               (최초 1회) 도메인 등록 + ZeroSSL 인증서 발급
└─ deploy.sh                  (수정 후) 빌드 + 컨테이너 재기동
```

> **`shared` 는 왜 있나** — client·server 가 같이 쓰는 타입(API 응답 모양)을 한 곳에 정의해 양쪽이 import 한다. 서버 응답을 바꾸면 프론트에서 **타입 에러로 즉시** 잡혀 풀스택 TS 의 실수를 줄인다.

---

## 데이터베이스 스키마

앱 부팅 시 `initDb()` 가 아래 테이블을 자동 생성/마이그레이션한다(멱등). 참고용 원본은 `db/*.sql`.

| 테이블 | 용도 | 핵심 컬럼 |
|---|---|---|
| `users` | 계정 | `email`(unique), `password`(bcrypt), `jobs TEXT[]`(직무), `is_verified`, `is_admin`, `verification_token`, `verification_expires_at` |
| `resumes` | 이력서 | `file BYTEA`(PDF), `extracted_text`, `analysis JSONB`(프로필), `analysis_status`(pending/processing/done/error), `feedback`(마크다운) |
| `interview_sessions` | 모의면접 세션 | `id TEXT`(=LangGraph thread_id), `status`, `based_on JSONB` |
| `interview_recordings` | 면접 기록(녹화) | `video BYTEA`(webm), `transcript`, `duration_sec`, `interview_report JSONB`(질문·평가·평정심) |
| `job_postings` | 채용 공고(크롤러) | `source`+`source_job_id`(unique), `ai_summary`, `embedding vector(1024)`, `is_active` |
| `crawl_settings` | 사이트별 수집 설정 | `source`(PK), `mode`(auto/manual), `enabled`, `interval_hours`, `last_run_at` |
| `crawl_commands` | 수동 실행 큐 | `source`, `status`(pending→running→done/error) |
| `company_contexts` | 기업 페르소나 자료 | `company_key`, `content_type`, `extracted_data JSONB`, `content_hash`(dedup) |
| `company_ingest_runs` / `..._requests` | 수집 로그 / JIT 요청 큐 | 앱↔파이프라인 분리용 |
| `checkpoints*` | LangGraph 체크포인트 | PostgresSaver 가 자동 생성(면접 재개용) |

- **pgvector** 확장은 슈퍼유저 권한이 필요해 클러스터 생성 시 1회 만든다. 이후 `job_postings.embedding`(1024차원)과 HNSW 코사인 인덱스는 서버가 보강한다.

---

## 기능별 구현 상세

### 1. 회원 인증(가입·이메일 인증·로그인)

파일: `server/src/auth.ts`, `server/src/email.ts` · 화면: `client/src/pages/{Signup,Login}.tsx`

- **가입** `POST /api/auth/register`
  - 이메일 형식 검사, 비밀번호 최소 8자, 직무(`jobs`) 최소 1개.
  - 비밀번호는 **bcrypt(cost 12)** 해시로 저장(`bcryptjs`).
  - `crypto.randomBytes(32)` 로 인증 토큰 생성, **24시간** 만료를 `users` 행에 컬럼으로 보관(토큰 전용 테이블 없이 사용자당 1개).
  - 이미 있으나 미인증이면 같은 행을 갱신(재가입 허용).
- **이메일 인증** `GET /api/auth/verify?token=…`
  - `nodemailer` + **Gmail SMTP(앱 비밀번호)** 로 인증 링크 발송(`email.ts`). SMTP 미설정(개발)이면 콘솔에 링크 출력.
  - 토큰·만료 확인 후 `is_verified=TRUE`, 토큰 제거 → `${APP_URL}/login?verify=success` 로 리다이렉트.
- **로그인** `POST /api/auth/login`
  - `bcrypt.compare` 후 **미인증이면 403**.
  - **JWT**(`jsonwebtoken`, `{ sub, email }`, 7일)를 서명해 **`if_token` 쿠키**로 발급.
  - 쿠키 플래그: `httpOnly`, `sameSite=lax`, **`secure`(프로덕션)**, `maxAge` 7일 → XSS 로 토큰 탈취 불가.
- **세션 복원** `GET /api/auth/me` — 쿠키의 JWT 검증. 프론트는 부팅 시 `me()` 로 로그인 상태를 복원한다.

### 2. AI 모의면접 (LangGraph)

파일: `server/src/aiInterview/interviewGraph.ts`, `interviewLLM.ts`, `server/src/interview.ts`

실제 면접의 "질문 → 답변 → 평가 → (약하면) 꼬리질문 → 다음 질문 → 리포트" 흐름을 **LangGraph 상태 그래프**로 구현했다.

```
START → generateQuestion → human(answer, interrupt) → evaluate ─┬─(약함)→ generateFollowup ┐
          ▲                                                      │                          │
          └──────────────────────(다음 메인 질문)────────────────┴──────────────────────────┘
                                                                 └─(질문 수 도달)→ generateReport → END
```

- **상태(Annotation)**: `resumeText`, `context`(직무+공고 요약), `companyAnchor`(기업 페르소나), 질문/답변/평가 이력, `questionCount`, `topicCounts`·`perspectiveCounts`(주제·관점 편중 방지), `maxQuestions`(기본 5, 3~8 클램프), `finalReport`, `status`.
- **`human` 노드는 LangGraph `interrupt()`** 로 그래프를 일시정지 → 사용자가 답변을 제출하면 `Command({ resume: answer })` 로 재개. 즉 한 번의 면접이 여러 HTTP 요청에 걸쳐 진행된다.
- **체크포인트**: `@langchain/langgraph-checkpoint-postgres` 의 `PostgresSaver` 로 상태를 DB 에 저장 → **서버가 재시작돼도** `interviewId`(=thread_id) 로 면접을 이어서 진행.
- **REST**
  - `POST /api/interview/session` — 이력서/직무/공고로 세션 시작 → 첫 질문 반환.
  - `POST /api/interview/session/:id/answer` — 답변 제출 → 평가 + (다음 질문 또는 최종 리포트).
- **답변 평가**(`evaluateInterviewAnswer`): 종합 점수 + 세부(구체성·이력서 일관성·문제해결·역할 명확성·구조) + `resultPresented`(성과를 수치로 제시했는지) + 강점/보완점/근거.
- **최종 리포트**(`generateFinalReport`): 총평 · 강점/보완점 · 질문별 피드백 · 예상 추가 질문 · 다음 준비 조언.

### 3. 이력서·직무 기반 질문

- 세션 시작 시 서버가 **컨텍스트를 조립**한다: 사용자가 고른 **직무(`users.jobs` 중 선택)** + **이력서**(특정 `resumeId` 또는 최근 분석 완료본)의 원문·프로필(skills/roles/summary) + 겨냥 공고 요약.
- 프론트(`Practice.tsx`)에서 **이력서와 직무를 드롭다운으로 선택** → `startAiInterview({ resumeId, role, jobId })`.
- **근거 검증(grounding guard)** `aiInterview/questionGuard.ts`: 생성된 질문/근거가 실제 이력서·컨텍스트에 등장하는 토큰(기술명·회사·숫자 등)을 담고 있는지 검사 → 없으면 최대 2회 재생성. **없는 경력·수치를 지어내지 못하게** 막는다.
- **개인정보/연락처 정제(`textUtil.stripContactInfo`)**: 이력서 상단의 이메일·전화번호·GitHub·연락처 라벨은 "경험"이 아니므로 질문 근거로 쓰기 전에 제거한다. (없애지 않으면 *"이력서에 적힌 'Contact Phone 010-… Email …' 경험에서…"* 같은 질문이 나온다. 성과 수치 `420ms`·`91%` 는 보존.) 또한 PDF 자간 벌림으로 공백이 뭉개진 이름+직함 토큰(예: `KIMHEESEOFull-stackDeveloper`)은 **20자 초과 토큰을 주제 앵커에서 제외**해 걸러낸다.
- **주제 편중 방지**: `resumeTopics.ts` 로 이력서를 주제로 쪼개고, 같은 프로젝트/주제가 메인 질문에 2회 넘게 안 나오도록 `topicCounts`/`perspectiveCounts` 로 제한한다.

### 4. 꼬리질문 / 압박 질문

- 답변 평가 직후 **라우팅**(`routeAfterEvaluate`)에서 결정:
  - 누적 질문 수가 `maxQuestions` 이상 → 리포트.
  - 방금 메인 질문 답변이 **약하면**(예: 성과 미제시 or 구체성/역할/이력서 일관성 < 70) → **꼬리질문(`generateFollowup`)**.
  - 그 외 → 다음 메인 질문.
- 꼬리질문은 직전 답변에서 **가장 약한 지점**(구체성·역할·일관성 중 낮은 축)을 파고들도록 프롬프트가 설계됨. 주제 카운트에는 포함하지 않아(꼬리는 같은 주제 심화) 압박의 깊이를 만든다.

### 5. 기업 페르소나

파일(앱): `server/src/aiInterview/companyContextAdapter.ts`, `companyRegistry.ts` · 파일(수집): `crawler/company_context/`

- 회사별 자료를 **`company_contexts`** 테이블에 유형별로 축적한다: `work_culture`(공식 일하는 방식/인재상), `official_article`(뉴스룸 직무 기사), `external_news`(외부 언론 기사).
- 겨냥 공고에 회사가 있으면 `resolveCompany()` 로 회사명을 **`company_key`(슬러그)** 로 정규화(예: "SK하이닉스"→`sk_hynix`). 정규화 규칙은 **크롤러(Python)와 앱(TS)이 동일**해 양쪽이 같은 키를 만든다.
- `buildCompanyContext()` 가 그 회사 자료를 **읽기 전용**으로 조회해 **첫 질문 앵커(`companyAnchor`)** 를 만든다 → "이 회사는 인재상 중 ○○을 강조합니다. 이와 관련된 본인의 경험은…" 처럼 회사색이 밴 첫 질문을 던진다.
- **JIT(방금 필요) 수집**: 자료가 없는 회사를 만나면 앱이 큐(`company_ingest_requests`)에 한 줄 넣고(막지 않음), 호스트의 파이프라인 러너가 나중에 수집 → 다음 면접부터 반영.
- **회사 추가 = 레지스트리에 1줄**: `crawler/company_context/registry.py`(와 대응하는 TS)에 회사 항목(별칭·소스 URL·셀렉터)만 추가하면 됨. DDL 변경 없음.

### 6. 로컬 AI 로 보안 문제 해결

파일: `server/src/ollama.ts` · 크롤러: `crawler/crawler/llm.py`

- **모든 LLM 추론을 로컬 Ollama** 로 처리 → 이력서·면접 답변·기업 자료가 **외부 API 로 전송되지 않는다**(개인정보/기밀 보호).
- 모델: 생성 **`exaone3.5:latest`**(한국어 특화), 임베딩 **`bge-m3:latest`**(1024차원).
- 컨테이너에서는 `host.docker.internal:11434` 로 호스트 Ollama 에 접속(`docker-compose` 의 `extra_hosts`).
- 클라이언트 헬퍼: `generate()`(텍스트), `generateJson()`(JSON 강제 + 최대 2회 재시도), `embed()`(벡터). 구조화 작업은 temperature 0.1~0.2 로 결정성 확보.

### 7. 이력서 피드백

파일: `server/src/resumes.ts`, `resumeAnalysis.ts` · 화면: `client/src/pages/ResumeFeedback.tsx`

- **업로드** `POST /api/resumes` — PDF(최대 20MB) multipart. 매직바이트로 PDF 검증.
- **텍스트 추출**: **`unpdf`** 로 원문 추출 + 글자 간격 붕괴 보정(`textUtil.ts`), `extracted_text` 저장.
- **2-pass LLM 분석**(백그라운드, `analysis_status`: pending→processing→done):
  1. **프로필 추출**(JSON): `summary`, `roles`, `skills`, `experiences[]`, `domains`, `strengths`, `weaknesses`, `keywords`.
     - **실무 경력(년)** 은 경험들의 기간을 파싱해 **정규직·계약직만** 합산(인턴·프로젝트 제외), 겹치는 구간은 병합.
  2. **사람이 읽는 마크다운 피드백**: 한 줄 총평 · 강점 · 보완점 · 예상 면접 약점.
- 서버 부팅 시 `analyzePendingResumes()` 가 밀린 pending 이력서를 순차 처리(단건 실패해도 전체는 계속).
- 분석된 이력서 프로필은 **모의면접·공고 추천의 입력**으로 재사용된다.

### 8. 맞춤 채용 공고 추천

파일: `server/src/jobs.ts`, `jobEmbeddings.ts` · 화면: `client/src/pages/{Home,Jobs}.tsx`

- **의미검색(semantic)**: `GET /api/jobs/recommended`
  - 쿼리 텍스트 = 사용자 직무 + 이력서 프로필(roles·skills·summary).
  - `embed()` 로 쿼리 벡터(1024) 생성 → **pgvector 코사인 거리(`<=>`)** 로 정렬, 마감 안 지난 활성 공고만. 적합도 = `1 - 거리`.
  - **HNSW 인덱스**(`vector_cosine_ops`)로 근사 최근접(ANN) 가속.
- **폴백(keyword)**: 임베딩 실패/무결과면 직무 키워드로 `ILIKE` 매칭(score 0).
- **임베딩 워커**(`jobEmbeddings.ts`): 부팅 시 + 30분마다, `embedding` 이 없는 활성 공고를 100개씩 배치로 임베딩(제목+회사+요약).
- 응답의 `basedOn.method` 로 semantic/keyword 여부를 프론트에 표시.

### 9. 면접 연습(녹화·실시간 자막·실시간 분석)

파일: `client/src/pages/Practice.tsx`

- **녹화**: `getUserMedia`(1280×720, 오디오) → **`MediaRecorder`**(webm/VP9, 1초 청크). 정지하면 Blob → `saveRecording()` 로 서버에 업로드(자막·길이·리포트 동봉).
- **실시간 자막(STT)**: **Web Speech API `SpeechRecognition`**(`lang: ko-KR`, `continuous`, `interimResults`).
  - **복원력**: 워치독 타이머가 6초 무입력을 감지하면 엔진 재시작, `onend`/`onerror` 시 새 인스턴스로 자동 재시작(크롬 버그 우회).
  - Web Speech API 는 **PC 크롬/엣지에서만** 안정적으로 동작 → 아래 [반응형](#14-반응형pc모바일)에서 모바일 가드.
- **실시간 분석 HUD**(0.7초 주기, 영상 위 보라색 글래스모피즘 패널 2개):
  - **SPEECH 패널**(우상단): **말하기 속도(wpm, 분당 어절 수)** + 추이 라인 그래프, **필러(어·음·그…) 사용** 횟수 + 구간별 막대 그래프. 그래프는 최근 ~28초 히스토리를 SVG 로 그린다.
  - **COMPOSURE 패널**(좌하단): **시선·눈·자세 안정**을 얼굴 트래커의 **최근 6초 롤링 구간**으로 계산해 막대로 표시(누적 평균이 아닌 현재 상태). 카메라 꺼짐이면 안내 문구로 대체.
- **HUD 를 녹화 영상에 번인(합성)**: DOM 오버레이는 카메라 스트림에 안 잡히므로, 숨은 `<canvas>` 에 매 프레임 (카메라 + 두 패널)을 다시 그리고 **`canvas.captureStream(30)` + 원본 마이크 오디오**를 `MediaRecorder` 로 녹화한다. → 저장된 영상·복기·PDF 어디서 봐도 지표가 함께 남는다(캔버스 미지원 시 원본 카메라로 폴백).
- **카메라 끄기**: 비디오 트랙만 끄고 녹화·자막은 계속. 이때 영상 기반 항목(시선/눈/자세)은 측정 제외됨을 안내하고, 합성 영상에는 "카메라 꺼짐" 프레임이 들어간다.

### 10. 평정심 리포트

파일: `client/src/composure/{score.ts,faceTracker.ts,fillers.ts}` · `client/src/components/ComposureCard.tsx`

압박 상황 대응력을 **6개 지표의 가중 평균(0~100)** 으로 정량화한다. **모든 신호는 브라우저에서 계산**되고(영상 원본은 서버로 보내지 않음), 서버는 결과 JSON 만 보관한다.

| 지표(가중치) | 계산 방식 | 신호원 |
|---|---|---|
| 응답 순발력(0.18) | 질문 읽는 시간(길이 기반)을 뺀 순수 머뭇 시간이 짧을수록 ↑ | STT 타이밍 |
| 말 유창성(0.18) | 분당 채움말(음·어·그…)이 적을수록 ↑ | STT + `fillers.ts` |
| 답변 충실도(0.14) | 답변 길이 ↑, 회피/불확실 표현 ↓ | STT |
| 시선 안정(0.18) | 정면 이탈 프레임 비율이 낮을수록 ↑ | MediaPipe `eyeLook*` |
| 눈 안정(0.18) | 눈 떨림(깜빡임 고주파 변동)·과도한 깜빡임이 적을수록 ↑ | MediaPipe `eyeBlink` |
| 자세 안정(0.14) | 고개(yaw/pitch) 흔들림이 적을수록 ↑ | 변환행렬 |

- **얼굴 분석**: **MediaPipe `FaceLandmarker`**(tasks-vision, CDN 로드, ~12.5fps 샘플링)로 블렌드셰이프(깜빡임·시선·표정)와 고개 각도를 추출. 모델 로드 실패/카메라 꺼짐이면 영상 항목은 "측정 안 됨"으로 총점에서 제외(가중 평균 재정규화).
- 등급: 총점 ≥75 안정 / ≥55 보통 / 그 외 긴장. 약한 2개 지표에 대해 **맞춤 코칭 문구**를 생성한다.
- 결과는 `interview_recordings.interview_report.composure` 에 저장돼 복기에서 다시 본다.

### 11. 면접 복기(면접 기록·PDF)

파일: `client/src/pages/History.tsx`

- **목록**: 녹화 카드(제목·날짜·길이·용량 + 평정심 배지). **썸네일**은 저장된 영상의 첫 프레임을 보여준다(서버가 HTTP **Range 요청**을 지원해 `#t=0.1` 로 앞부분만 내려받음; 카메라 끈 녹화는 아이콘으로 폴백).
- **상세**: 영상 재생 + 정리된 자막 + **모의면접 리포트**(종합 평가 → 질문별 평가 → 강점/보완점 → 평정심)를 **A4 공식 보고서** 형식으로 렌더. 우상단에 각진 빨간 `模擬`(모의) 도장, 상단에 사용한 **이력서 파일명** 표시, 꼬리질문은 "꼬리 질문" 배지로 구분.
- **점수 색 코딩**: 종합 평가·평정심 배지와 세부 막대는 점수에 따라 색이 바뀐다 — **75~100 초록(안정) · 55~74 주황(보통) · 0~54 빨강(주의)**. 동일 기준을 두 리포트가 공유한다.
- **PDF 출력**: `window.print()` + `@media print`. **`:has(.rep-doc)`** 로 리포트 문서만 격리 인쇄해 사이드바·영상·버튼을 제외(모바일에서 `window.print()` 가 블로킹되지 않아 생기던 격리 실패 문제를 CSS-only 방식으로 해결).

### 12. 채용 공고 크롤링

파일: `crawler/crawler/` (Python)

- **아키텍처**: 사이트마다 `base.Adapter` 를 상속한 **어댑터**가 `fetch()`(목록) + `enrich_details()`(상세)를 구현. 정적 HTML 은 **httpx + BeautifulSoup**, SPA 는 **Playwright(headless chromium)** 로 렌더.
- **어댑터(11개)**: `saramin`·`wanted`(내부 JSON API)·`incruit`(euc-kr)·`jobkorea`·`linkareer`·`jasoseol`(Playwright)·`peoplenjob`·`superookie`·`groupby`, 그리고 로그인/차단으로 **보류된** `rocketpunch`·`jobplanet`.
- **저장**: `job_postings` 에 **`(source, source_job_id)` 유니크**로 UPSERT(중복 없이 갱신, `last_crawled_at`·`is_active` 관리).
- **LLM 후처리(로컬 Ollama)**: 상세 본문에서 회사/직무/지역/경력/고용형태를 **근거 기반 추출**하고, 지원자용 **마크다운 요약(`ai_summary`)** 을 생성(원문 사실만, 날짜·금액 원문 유지). 공고 목록/추천은 `ai_summary` 가 있는 활성 공고만 노출.

### 13. 관리자 크롤링 제어

파일: `crawler/crawler/schedule.py`, `db.py` · 화면: `client/src/components/AdminCrawlPanel.tsx`(관리자만)

- **스케줄러 데몬**: APScheduler 가 **60초마다 폴링**하며 (1) `crawl_commands` 의 수동 실행을 먼저 처리(SKIP LOCKED 로 원자적 클레임), (2) `crawl_settings` 기준 자동 수집 대상(`enabled` && `mode='auto'` && `last_run + interval_hours ≤ now`)을 실행.
- **관리자 계정**(`users.is_admin`)으로 로그인하면 채용 공고 화면에 **크롤링 제어 패널**이 뜬다: 사이트별 **on/off**, **자동/수동 모드**, **수집 주기(시간)** 조정, **지금 수집(수동 트리거)**.
- 앱은 설정을 `crawl_settings` 에 쓰거나 `crawl_commands` 에 한 줄 넣을 뿐 — **크롤러와 DB 로만 소통**해 결합도를 낮췄다.
- **기업 페르소나 수집**도 별도 러너(`company_context/run.py`)와 cron(`persona.sh`, 매일 04:00)으로 동작하며 JIT 요청 큐를 소진한다.

### 14. 반응형(PC·모바일)

- 공통 화면(홈·채용 공고·이력서 피드백·면접 기록)은 CSS 브레이크포인트(720/860/640/480px)로 **PC·모바일 모두** 대응. 사이드바는 모바일에서 햄버거 드로어로 전환.
- **면접 연습은 PC 전용**: `matchMedia("(max-width: 720px)")` 로 모바일을 감지하면 녹화 UI 대신 **"PC에서 이용해 주세요"** 안내를 띄운다.
  - 이유: **실시간 자막(Web Speech API)** 이 사실상 **데스크톱 크롬/엣지** 에서만 안정적이고, 카메라 녹화·얼굴 분석도 PC 환경을 전제로 하기 때문. (모바일에서는 이 조합을 신뢰성 있게 보장하기 어려움.)
- 리포트 표 등 넓은 요소는 모바일에서 가로 스크롤 래퍼로 감싸 레이아웃이 깨지지 않게 처리.

### 15. 로딩 스플래시(UX)

파일: `client/index.html`, `client/src/components/Splash.tsx`

- **부팅 스플래시**: 번들이 로드되기 전에도 보이도록 로고+스피너를 **`index.html` 에 직접** 넣어 첫 페인트부터 표시하고, 앱이 준비되면(초기 인증 확인 후) 페이드아웃하며 제거한다(10초 안전 타이머 포함).
- **페이지 로딩 스플래시**: 홈·채용 공고·이력서 피드백·면접 기록 등 데이터 로딩 페이지는 완전히 뜨기 전까지 같은 스플래시(`Splash` 컴포넌트)로 덮어 "불러오는 중…" 텍스트가 노출되지 않게 한다(채용 공고는 최초 진입만, 필터 재조회는 제외).

---

## 보안 & 배포

### 네트워크·경계

- **컨테이너 포트는 `127.0.0.1:8110` 에만 바인딩** → 외부에서 앱 포트에 직접 접근 불가. 외부 노출은 **호스트 nginx(443)** 만 담당.
- nginx `ssl.conf`(`deploy/ssl.conf`): 443 → `127.0.0.1:8110` 프록시. 큰 영상 업로드를 위해 `client_max_body_size 200M`, `proxy_read/send_timeout 300s`, `proxy_request_buffering off`.

### HTTPS / TLS

- **ZeroSSL(acme.sh)** 로 인증서 발급(`setup-ssl.sh`). `*.kro.kr` 은 Let's Encrypt 주간 한도를 공유해 자주 막히므로 ZeroSSL 사용.
- `ssl_protocols TLSv1.2 TLSv1.3`, 강한 cipher, **HSTS(1년)**, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff` 보안 헤더.
- **자동 갱신**: acme.sh(현재 유저 cron) → 갱신 시 `sudo systemctl reload nginx`. **sudoers 는 이 명령 하나만** 무비번 허용(`/etc/sudoers.d/interviewforge-nginx-reload`)해 권한을 최소화.
- 80 포트는 HTTPS 로 301 리다이렉트하되 `/.well-known/acme-challenge/` 는 **전용 webroot** 로 유지(다른 사이트 갱신에 영향 없음).

### 애플리케이션 보안

- **인증**: JWT 를 `httpOnly`·`sameSite=lax`·`secure(prod)` 쿠키로만 전달(JS 접근·CSRF 표면 축소). 비밀번호는 bcrypt(cost 12).
- **로컬 LLM**: 이력서·면접 답변·기업 자료가 외부 API 로 나가지 않음(위 [6번](#6-로컬-ai-로-보안-문제-해결)).
- **캐시 정책**(`server/src/index.ts`): 해시가 박힌 정적 에셋(`/assets/*`)은 `immutable`(1년), **`index.html` 은 `no-cache`** → 재배포 후 옛 번들을 붙들지 않음.
- **DB 접근 최소화**: 기업 페르소나 조회는 읽기 전용 트랜잭션 + statement timeout. 회사 키는 항상 파라미터 바인딩(인젝션 차단).

### 데이터베이스 & SSH 터널링

- **전용 PostgreSQL 14 클러스터**(`db/setup-cluster.sh`): 다른 사이트와 겹치지 않게 **별도 포트 5434**, `listen_addresses='localhost,172.17.0.1'`.
  - **컨테이너**는 `host.docker.internal:5434`(도커 게이트웨이 172.17.0.1)로 접속.
  - `pg_hba.conf` 는 로컬(127.0.0.1)·도커 대역(172.16.0.0/12)에서 **`scram-sha-256`** 로만 허용.
  - **pgvector** 확장은 슈퍼유저로 1회 생성(공고 추천 의미검색용).
- **SSH 터널링**: DB 포트는 외부에 열지 않는다. DBeaver 같은 **원격 DB 관리 도구는 SSH 터널로 서버에 붙은 뒤 `localhost:5434`** 로 접속한다(앱은 터널 없이 도커 게이트웨이로 직접 접속). 즉 DB 는 **인터넷에 직접 노출되지 않고**, 관리 접근만 SSH 로 감싼다.

### 배포 파이프라인

- **멀티스테이지 Docker**(`Dockerfile`): build 스테이지에서 `npm ci` → `npm run build`(shared→server→client) → `npm prune --omit=dev`, runtime 스테이지는 `node server/dist/index.js` 만 실행(빌드 도구·devDeps 미포함).
- `deploy.sh` → `docker compose up -d --build` 한 번으로 재빌드·재기동. 소스가 바뀌면 `COPY . .` 레이어가 무효화돼 항상 새로 빌드된다.

---

## 로컬 개발

```bash
npm install
npm run dev          # client(:5173) + server(:8787) 동시 실행
```

- 사전 준비: `sudo bash db/setup-cluster.sh`(전용 Postgres 클러스터 생성), 호스트에 **Ollama** 실행 + `exaone3.5:latest`·`bge-m3:latest` 풀, `cp .env.example .env` 후 값 채우기.
- client 는 항상 상대경로 `/api` 로 호출하고, 개발 시 Vite 프록시가 `:8787` 로 넘긴다.
- 크롤러: `crawler/` 에서 `pip install -r requirements.txt && playwright install chromium` 후 `python -m crawler run`(1회) 또는 `python -m crawler schedule`(데몬).

---

## 배포 절차

```bash
# 최초 1회
sudo bash db/setup-cluster.sh   # 전용 Postgres 클러스터(5434) + pgvector
cp .env.example .env            # 값 채우기(DB/JWT/SMTP/OLLAMA/도메인)
./deploy.sh                     # 앱 컨테이너 빌드 & 기동 (127.0.0.1:8110)
./setup-ssl.sh                  # 도메인 등록 + ZeroSSL 인증서 발급 (sudo 필요)

# 코드 수정 후
./deploy.sh                     # 재빌드 + 컨테이너 재기동. 이것만 실행하면 됨.
```

---

## 환경변수

`.env`(git 미포함)를 `.env.example` 에서 복사해 만든다.

| 변수 | 용도 |
|---|---|
| `APP_URL` | 인증 링크/리다이렉트 베이스 URL(운영 도메인) |
| `DATABASE_URL` | `postgresql://interviewforge:…@host.docker.internal:5434/interviewforge` |
| `JWT_SECRET` | JWT 서명 키(`openssl rand -hex 32`) |
| `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Gmail SMTP(앱 비밀번호)로 인증 메일 발송 |
| `OLLAMA_URL` / `OLLAMA_MODEL` / `OLLAMA_EMBED_MODEL` | 로컬 LLM 엔드포인트·모델(기본값 있음) |
| `DOMAIN_NAME` / `SSL_EMAIL` | `setup-ssl.sh` 의 ZeroSSL 인증서 발급/갱신 |
| `VITE_AMPLITUDE_API_KEY` | Amplitude Analytics/Session Replay API 키(클라이언트 빌드 시 주입) — [사용자 행동 분석](#사용자-행동-분석-amplitude) 참고 |

> 앱 포트(8787)는 도커·서버 기본값으로 고정되므로 `.env` 에 둘 필요가 없다.
>
> ⚠️ **`VITE_` 접두사 변수는 서버가 아니라 클라이언트(Vite) 빌드 시점에 번들로 박힌다.** 그래서 다른 변수들과 달리 `docker-compose.prod.yml` 의 `environment`(런타임)가 아니라 **`build.args`(빌드타임)** 로 전달되며, `.dockerignore` 가 `.env` 를 빌드 컨텍스트에서 제외하므로 이 경로가 필수다. 값을 바꾸면 반드시 `./deploy.sh`(=`--build`)로 **다시 빌드**해야 반영된다.

---

## 사용자 행동 분석 (Amplitude)

방문자가 어떤 기능(채용 공고·이력서 피드백·모의면접)에 몰리는지, 어디서 이탈하는지를 [Amplitude](https://amplitude.com) 로 측정한다.

### 구성

- **SDK**: `@amplitude/unified`(Analytics + Session Replay 통합). 클라이언트 진입점 [`client/src/main.tsx`](client/src/main.tsx) 에서 **앱 생명주기 동안 딱 한 번** `amplitude.initAll(...)` 로 초기화한다(React 렌더 트리 밖이라 StrictMode 이중호출 영향 없음).
- **API 키**: `VITE_AMPLITUDE_API_KEY`(위 [환경변수](#환경변수)). 브라우저에 노출되는 public 키이며, 나머지 서버 시크릿은 `VITE_` 접두사가 없어 번들에 포함되지 않는다.
- **autocapture**: 페이지뷰(SPA 라우트 이동 포함)·클릭·세션·Web Vitals 를 **코드 수정 없이 자동 수집**.
- **Session Replay**: `sampleRate: 1`(전 세션 녹화).
- **사용자 식별**: [`client/src/App.tsx`](client/src/App.tsx) 에서 로그인 사용자의 내부 `id` 로 `setUserId` 를 호출(로그아웃 시 익명). 이메일 등 PII 는 보내지 않는다.

### 커스텀 이벤트

autocapture 로는 "버튼 클릭" 수준까지만 구분되므로, 제품 고유 행동은 [`client/src/analytics.ts`](client/src/analytics.ts) 에 이름을 모아 명시적으로 기록한다(`track(Events.XXX, { ... })`).

| 이벤트 이름 | 발생 시점 | 주요 속성 | 코드 위치 |
|---|---|---|---|
| `이력서 업로드` | 이력서 PDF 업로드 성공 | `sizeKb` | [ResumeFeedback.tsx](client/src/pages/ResumeFeedback.tsx) |
| `이력서 재분석` | 분석 다시 실행 | — | [ResumeFeedback.tsx](client/src/pages/ResumeFeedback.tsx) |
| `공고 상세 조회` | 채용공고 상세 페이지 진입 | `source`, `company`, `jobTitle` | [JobDetail.tsx](client/src/pages/JobDetail.tsx) |
| `추천공고 조회` | 목록을 추천순으로 전환 | — | [Jobs.tsx](client/src/pages/Jobs.tsx) |
| `공고 검색` | 검색어 입력(입력 멈춘 뒤 800ms 디바운스) | `query` | [Jobs.tsx](client/src/pages/Jobs.tsx) |
| `채용공고 원문 클릭` | 공고 상세에서 원문 바로가기 | `source`, `company`, `jobTitle` | [JobDetail.tsx](client/src/pages/JobDetail.tsx) |
| `모의면접 시작` | AI 모의면접 세션 시작 | `role`, `hasResume`, `fromJob`, `company` | [Practice.tsx](client/src/pages/Practice.tsx) |
| `면접 답변 제출` | 질문에 답변 제출 | `questionIndex`, `answerChars` | [Practice.tsx](client/src/pages/Practice.tsx) |
| `모의면접 완료` | 마지막 질문까지 끝 | `totalQuestions` | [Practice.tsx](client/src/pages/Practice.tsx) |
| `면접 녹화 저장` | 녹화 영상 저장 성공 | `durationSec` | [Practice.tsx](client/src/pages/Practice.tsx) |

이벤트를 추가할 땐 **`analytics.ts` 의 `Events` 에 상수를 먼저 등록**하고(오타로 이벤트가 갈라지는 것 방지) 해당 액션 성공 지점에서 `track()` 을 호출한다.

### 대시보드에서 보는 법

- **라이브 이벤트**(제품 → 라이브 이벤트): 실시간 원본 이벤트 스트림. **트래킹이 되는지 확인**하는 용도. (여기 목록은 즉시 뜨지만 **집계 차트는 색인에 1~2분** 지연될 수 있다. 상단 "실시간 이벤트 업데이트" 토글은 새로고침하면 꺼지는 게 정상.)
- **"어느 페이지/기능에 몰리나"** 는 원본 스트림이 아니라 **차트로 집계**해서 본다:
  1. 좌측 상단 `+` → **차트** → **이벤트 세그멘테이션(Event Segmentation)**
  2. 페이지별: 이벤트 `[Amplitude] Page Viewed` → **Group by** `[Amplitude] Page URL`(또는 Path)
  3. 커스텀 이벤트(`모의면접 시작` 등)로 바꾸면 기능별 사용량, 속성(`role`·`company` 등)으로 세그먼트 가능
- **이벤트별 발생 횟수 비교**(어느 이벤트가 제일 많나): 이벤트 세그멘테이션에서 `+ 이벤트 추가`로 **여러 이벤트를 한꺼번에** 넣고, **"다음으로 측정됨: 이벤트 총합"** + 차트 형식 **막대(Bar)** + 기간 **최근 7일**.
- **퍼널 분석**: `모의면접 시작` → `면접 답변 제출` → `모의면접 완료` → `면접 녹화 저장` 순서로 넣어 **단계별 이탈률**을 본다.
- **Session Replay**: 개별 세션에서 실제 사용 화면을 다시 보며 이탈 지점을 확인.
- **AI 에이전트**(좌측 "에이전트"): 자연어로 차트를 만든다. 예: *"최근 7일간 각 커스텀 이벤트의 발생 횟수를 막대그래프로 비교해줘"*, *"모의면접 시작 → 답변 제출 → 완료 → 녹화 저장 퍼널 그려줘"*.

> 💡 반영에 수십 초 지연이 있을 수 있고, 광고/트래킹 차단 확장프로그램이 `api2.amplitude.com` 요청을 막으면 이벤트가 누락된다. 확인 시 시크릿창을 쓰거나 DevTools → Network 에서 `httpapi` 요청이 200 인지(응답의 `events_ingested`) 본다.
