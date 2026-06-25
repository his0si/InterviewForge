-- InterviewForge 테이블 스키마.
-- 참고: 서버가 부팅할 때 initDb() 가 동일한 테이블을 자동 생성/마이그레이션하므로
-- 이 파일을 직접 실행하지 않아도 된다. (DBeaver 로 미리 보고 싶을 때 참고용)
--
-- 메일 인증 토큰은 별도 테이블 없이 users 행에 컬럼으로 보관한다(사용자당 하나면 충분).

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
