-- InterviewForge 테이블 스키마.
-- 참고: 서버가 부팅할 때 initDb() 가 동일한 테이블을 자동 생성/마이그레이션하므로
-- 이 파일을 직접 실행하지 않아도 된다. (DBeaver 로 미리 보고 싶을 때 참고용)
--
-- 메일 인증 토큰은 별도 테이블 없이 users 행에 컬럼으로 보관한다(사용자당 하나면 충분).
--
-- 공고 추천(의미검색)을 위해 pgvector 확장이 필요하다. 확장 생성은 슈퍼유저 권한이
-- 있어야 하므로 1회 수동으로 만든다(앱 유저로는 불가):
--     sudo -u postgres psql -p 5434 -d interviewforge -c "CREATE EXTENSION IF NOT EXISTS vector;"
-- 그 후 job_postings.embedding 컬럼은 서버 initDb() 가 자동으로 보강한다.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id                      SERIAL PRIMARY KEY,
  email                   TEXT UNIQUE NOT NULL,   -- 도메인 제한 없음, 형식만 검사
  password                TEXT NOT NULL,          -- bcrypt 해시 ($2b$12$...)
  nickname                TEXT NOT NULL DEFAULT '',
  jobs                    TEXT[] NOT NULL DEFAULT '{}',  -- 직무(최소 1개, 여러 개 가능)
  is_verified             BOOLEAN NOT NULL DEFAULT FALSE,
  verification_token      TEXT,                   -- 미인증 동안만 채워짐, 인증되면 NULL
  verification_expires_at TIMESTAMPTZ,            -- 토큰 만료(발급 후 24시간)
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_verification_token ON users(verification_token);

-- 면접 연습 녹화(면접 기록): 영상(webm) + 실시간 변환 자막을 사용자별로 보관.
-- 영상 바이트는 BYTEA 로 DB 에 직접 저장한다.
CREATE TABLE IF NOT EXISTS interview_recordings (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT '',
  transcript    TEXT NOT NULL DEFAULT '',
  duration_sec  INTEGER NOT NULL DEFAULT 0,
  mime_type     TEXT NOT NULL DEFAULT 'video/webm',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  video         BYTEA NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recordings_user ON interview_recordings(user_id, created_at DESC);

-- 이력서 피드백: 업로드한 이력서 PDF 를 BYTEA 로 보관(AI 피드백은 추후).
CREATE TABLE IF NOT EXISTS resumes (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL DEFAULT 'resume.pdf',
  mime_type     TEXT NOT NULL DEFAULT 'application/pdf',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  file          BYTEA NOT NULL,
  extracted_text TEXT,                      -- PDF 에서 추출한 원문 텍스트(분석/피드백 입력)
  analysis      JSONB,                      -- 로컬 LLM 구조화 분석 결과(프로필: skills/roles/years 등)
  analysis_status TEXT NOT NULL DEFAULT 'pending', -- pending|processing|done|error
  analyzed_at   TIMESTAMPTZ,               -- 분석 완료 시각
  feedback      TEXT,                       -- 사람이 읽는 마크다운 피드백
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_resumes_user ON resumes(user_id, created_at DESC);
