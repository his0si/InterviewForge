-- ============================================================================
-- InterviewForge 채용 공고 수집 테이블 (interviewforge DB, 5434 클러스터)
-- 모든 사이트를 "한 테이블"에 모으되, source 컬럼으로 출처를 구분한다(칩 표시용).
--
-- 저장 전략
--  1) 자주 조회/필터하는 공통 필드는 "정규화 컬럼"으로 둔다
--     (마감일, 경력, 고용형태, 급여, 자격요건, 우대사항, 전형절차, 제출서류 …).
--  2) 공고마다 있는/없는 필드가 제각각이므로 "없으면 NULL" 을 허용한다.
--  3) 사이트별로 추가되는 잡다한 원본 필드는 raw(JSONB)에 통째로 보존한다
--     → 나중에 새 필드가 필요해지면 raw 에서 꺼내 컬럼으로 승격하면 되고,
--       크롤링 당시 원본을 잃지 않는다.
--  4) (source, source_job_id) 를 유일키로 두고 UPSERT → 매일 재크롤링해도
--     중복이 쌓이지 않고 변경분만 갱신된다. first_seen / last_crawled 로 이력 추적.
--  5) is_active 로 마감/삭제된 공고를 표시(soft-expire).
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_postings (
  id               BIGSERIAL PRIMARY KEY,

  -- 출처 식별 ----------------------------------------------------------------
  source           TEXT NOT NULL,                 -- 'saramin','wanted','jobkorea' …(칩에 표시)
  source_job_id    TEXT,                          -- 사이트 내부 공고 ID(있으면)
  source_url       TEXT NOT NULL,                 -- 원본 링크(칩 클릭 시 이동)

  -- 핵심 식별 정보 -----------------------------------------------------------
  title            TEXT NOT NULL,                 -- 공고 제목
  company          TEXT,                          -- 회사명
  location         TEXT,                          -- 근무지

  -- 조건/분류 ----------------------------------------------------------------
  employment_type  TEXT,                          -- 정규직/계약직/인턴 …
  experience_level TEXT,                          -- 신입/경력/경력무관(원문 그대로)
  experience_min   INT,                           -- 최소 경력(년), 알 수 있으면
  experience_max   INT,                           -- 최대 경력(년)
  education         TEXT,                         -- 학력 요건
  salary           TEXT,                          -- 급여(원문 텍스트 — 형식이 제각각이라 텍스트)
  job_categories   TEXT[] NOT NULL DEFAULT '{}',  -- 직군/직무 분류
  skills           TEXT[] NOT NULL DEFAULT '{}',  -- 기술스택/키워드

  -- 일정 ---------------------------------------------------------------------
  posted_at        DATE,                          -- 공고 게시일
  deadline         DATE,                          -- 마감일(날짜로 파싱되면)
  deadline_text    TEXT,                          -- '상시채용','채용시 마감' 등 날짜 아닌 경우

  -- 상세 본문(없는 공고도 많음 → NULL 허용) ---------------------------------
  qualifications   TEXT,                          -- 자격요건/지원자격
  preferred        TEXT,                          -- 우대사항
  hiring_process   TEXT,                          -- 전형 절차
  documents        TEXT,                          -- 제출 서류
  benefits         TEXT,                          -- 복리후생
  description      TEXT,                          -- 상세 본문 전체(정제 텍스트)

  -- 빈 칸의 의미 구분: TRUE 면 상세까지 파싱함(NULL=실제 없음), FALSE 면 미수집(NULL=unknown)
  detail_fetched   BOOLEAN NOT NULL DEFAULT FALSE,

  -- 로컬 LLM(Ollama) 이 본문을 정갈하게 정리한 마크다운 요약 + 생성 시각
  ai_summary       TEXT,
  ai_summary_at    TIMESTAMPTZ,

  -- 원본 보존 + 이력 ---------------------------------------------------------
  raw              JSONB NOT NULL DEFAULT '{}',   -- 사이트 원본 응답 전체
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_crawled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active        BOOLEAN NOT NULL DEFAULT TRUE
);

-- UPSERT 기준: 사이트 + 사이트 내 공고 ID.
-- (사이트가 ID 를 안 주면 크롤러가 source_url 해시로 source_job_id 를 채워 넣는다 → 항상 NOT NULL)
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_postings_source_jobid
  ON job_postings (source, source_job_id);

-- 목록/필터 조회용 인덱스
-- 기존 테이블 마이그레이션(이미 만들어진 경우 컬럼만 추가)
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS detail_fetched BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS ai_summary TEXT;
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS ai_summary_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_job_postings_source     ON job_postings (source);
CREATE INDEX IF NOT EXISTS idx_job_postings_deadline   ON job_postings (deadline);
CREATE INDEX IF NOT EXISTS idx_job_postings_active_seen ON job_postings (is_active, first_seen_at DESC);

-- ============================================================================
-- 관리자(마스터) 가 제어하는 사이트별 크롤링 설정 + 수동 실행 큐.
-- InterviewForge 서버(Node)와 공유한다: 서버가 마스터 화면에서 읽고/수정하고,
-- 수동 실행은 crawl_commands 에 한 줄 넣어두면 이 크롤러가 폴링해서 처리한다.
-- ============================================================================
CREATE TABLE IF NOT EXISTS crawl_settings (
  source         TEXT PRIMARY KEY,               -- 출처 키(saramin 등)
  label          TEXT NOT NULL DEFAULT '',       -- 사람이 읽는 이름
  implemented    BOOLEAN NOT NULL DEFAULT TRUE,  -- 어댑터 구현 여부(false면 켜도 수집 안 됨)
  interval_hours INT NOT NULL DEFAULT 24,        -- 자동 수집 주기(시간)
  mode           TEXT NOT NULL DEFAULT 'auto',   -- 'auto' | 'manual'
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,  -- 비활성화 토글
  last_run_at    TIMESTAMPTZ,                    -- 마지막 수집 시각
  last_status    TEXT,                           -- 마지막 실행 결과 요약
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crawl_commands (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL,                    -- 수동 실행할 출처
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|error
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  result       TEXT
);
CREATE INDEX IF NOT EXISTS idx_crawl_commands_pending ON crawl_commands (status, requested_at);
