// PostgreSQL 연결 풀.
// 앱과 DB 가 같은 호스트(RT-Server)에서 돌기 때문에 SSH 터널은 필요 없다.
//  - 컨테이너에서는 host.docker.internal:5433 로 호스트의 Postgres 에 직접 붙는다
//    (docker-compose 의 extra_hosts: host.docker.internal:host-gateway 덕분).
//  - 개발 중 호스트에서 직접 실행하면 .env 의 DATABASE_URL 을 그대로 쓴다.
// DBeaver(맥)에서 들여다볼 때만 SSH 터널(121.131.184.229:20022)을 쓴다.
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL 환경변수가 없습니다. .env 또는 docker-compose 에 설정하세요."
  );
}

export const pool = new Pool({ connectionString });

// 부팅 시 스키마를 보장한다. (interviewforge DB 는 미리 만들어 두고,
//  테이블은 앱이 자동 생성 → 배포만으로 준비 완료)
// 메일 인증 토큰은 별도 테이블 없이 users 행에 컬럼으로 보관한다(사용자당 하나면 충분).
export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                      SERIAL PRIMARY KEY,
      email                   TEXT UNIQUE NOT NULL,
      password                TEXT NOT NULL,
      nickname                TEXT NOT NULL DEFAULT '',
      jobs                    TEXT[] NOT NULL DEFAULT '{}',  -- 직무(최소 1개, 여러 개 가능)
      is_verified             BOOLEAN NOT NULL DEFAULT FALSE,
      verification_token      TEXT,           -- 미인증 동안만 채워짐, 인증되면 NULL
      verification_expires_at TIMESTAMPTZ,    -- 토큰 만료 시각(24시간)
      created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // 기존 DB 마이그레이션: 컬럼 추가 + 옛 email_verifications 테이블 제거
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT NOT NULL DEFAULT '';`
  );
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS jobs TEXT[] NOT NULL DEFAULT '{}';`
  );
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token TEXT;`
  );
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMPTZ;`
  );
  await pool.query(`DROP TABLE IF EXISTS email_verifications;`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_users_verification_token ON users(verification_token);`
  );
}
