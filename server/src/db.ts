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
      is_admin                BOOLEAN NOT NULL DEFAULT FALSE,  -- 마스터(관리자) 계정만 TRUE, 일반 가입은 FALSE
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
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;`
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

  // ── 관리자: 사이트별 크롤링 설정 + 수동 실행 큐 ──────────────────────────
  // 크롤러(파이썬 데몬)와 공유하는 테이블. 서버는 마스터 화면에서 읽고/수정하고,
  // 수동 실행은 crawl_commands 에 한 줄 넣어두면 크롤러가 폴링해서 처리한다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crawl_settings (
      source         TEXT PRIMARY KEY,                       -- 출처 키(saramin 등)
      label          TEXT NOT NULL DEFAULT '',               -- 사람이 읽는 이름
      implemented    BOOLEAN NOT NULL DEFAULT TRUE,           -- 어댑터 구현 여부
      interval_hours INT NOT NULL DEFAULT 24,                 -- 자동 수집 주기(시간)
      mode           TEXT NOT NULL DEFAULT 'auto',            -- 'auto' | 'manual'
      enabled        BOOLEAN NOT NULL DEFAULT TRUE,           -- 비활성화 토글
      last_run_at    TIMESTAMPTZ,                             -- 마지막 수집 시각
      last_status    TEXT,                                    -- 마지막 실행 결과 요약
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crawl_commands (
      id           BIGSERIAL PRIMARY KEY,
      source       TEXT NOT NULL,                             -- 수동 실행할 출처
      status       TEXT NOT NULL DEFAULT 'pending',           -- pending|running|done|error
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at   TIMESTAMPTZ,
      finished_at  TIMESTAMPTZ,
      result       TEXT
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_crawl_commands_pending ON crawl_commands(status, requested_at);`
  );

  // ── 면접 연습 녹화(면접 기록) ────────────────────────────────────────────
  // 면접 연습 화면에서 녹화한 영상(webm)과 실시간 변환 자막을 사용자별로 보관한다.
  // 영상 바이트는 BYTEA 로 DB 에 직접 저장한다(요청: 모든 데이터를 DB 에).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interview_recordings (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title         TEXT NOT NULL DEFAULT '',
      transcript    TEXT NOT NULL DEFAULT '',   -- 음성→텍스트 변환 결과(말한 내용 전체)
      duration_sec  INTEGER NOT NULL DEFAULT 0, -- 녹화 길이(초)
      mime_type     TEXT NOT NULL DEFAULT 'video/webm',
      size_bytes    INTEGER NOT NULL DEFAULT 0,
      video         BYTEA NOT NULL,             -- 영상 원본 바이트
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_recordings_user ON interview_recordings(user_id, created_at DESC);`
  );

  // ── 이력서 피드백: 업로드한 이력서 PDF 보관 ───────────────────────────────
  // 사용자가 올린 이력서(PDF)를 DB(BYTEA)에 저장한다. (AI 피드백은 추후 추가)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS resumes (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename      TEXT NOT NULL DEFAULT 'resume.pdf',
      mime_type     TEXT NOT NULL DEFAULT 'application/pdf',
      size_bytes    INTEGER NOT NULL DEFAULT 0,
      file          BYTEA NOT NULL,            -- 이력서 PDF 원본 바이트
      extracted_text TEXT,                     -- PDF 에서 추출한 원문 텍스트(분석/피드백 입력)
      feedback      TEXT,                      -- 추후 AI 피드백 결과(현재는 NULL)
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // 기존 DB 마이그레이션: PDF 원문 텍스트 + 로컬 LLM 분석 컬럼 추가
  await pool.query(`ALTER TABLE resumes ADD COLUMN IF NOT EXISTS extracted_text TEXT;`);
  await pool.query(`ALTER TABLE resumes ADD COLUMN IF NOT EXISTS analysis JSONB;`);
  await pool.query(
    `ALTER TABLE resumes ADD COLUMN IF NOT EXISTS analysis_status TEXT NOT NULL DEFAULT 'pending';`
  );
  await pool.query(`ALTER TABLE resumes ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ;`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_resumes_user ON resumes(user_id, created_at DESC);`
  );

  // ── 채용 공고 임베딩(추천용) ──────────────────────────────────────────────
  // job_postings 는 크롤러가 만든다. 테이블이 있을 때만 pgvector 컬럼을 보강한다.
  // (vector 확장은 슈퍼유저가 1회 생성해야 함: setup-cluster.sh / db/02_schema.sql 참고)
  try {
    const hasVector = await pool.query(
      `SELECT 1 FROM pg_extension WHERE extname = 'vector'`
    );
    const hasJobs = await pool.query(`SELECT to_regclass('public.job_postings') AS t`);
    if (hasVector.rowCount && hasJobs.rows[0].t) {
      await pool.query(`ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS embedding vector(1024);`);
      await pool.query(`ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS embedding_at TIMESTAMPTZ;`);
      // 코사인 거리 ANN 인덱스(대량일 때 추천 정렬 가속). 이미 있으면 무시.
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_job_postings_embedding
           ON job_postings USING hnsw (embedding vector_cosine_ops);`
      );
    }
  } catch (err) {
    console.warn("job_postings 임베딩 컬럼 준비 건너뜀:", (err as Error).message);
  }

  // 알려진 출처를 시드(이미 있으면 라벨/구현여부만 최신화, 사용자 설정은 보존).
  for (const s of KNOWN_SOURCES) {
    await pool.query(
      `INSERT INTO crawl_settings (source, label, implemented)
       VALUES ($1, $2, $3)
       ON CONFLICT (source) DO UPDATE
         SET label = EXCLUDED.label, implemented = EXCLUDED.implemented`,
      [s.source, s.label, s.implemented]
    );
  }
}

// 화면/시드용 알려진 출처 목록. implemented=false 는 어댑터 미구현(켜도 수집 안 됨).
// 크롤러의 ALL_ADAPTERS 와 일치시킨다.
export const KNOWN_SOURCES: { source: string; label: string; implemented: boolean }[] = [
  { source: "saramin", label: "사람인", implemented: true },
  { source: "wanted", label: "원티드", implemented: true },
  { source: "jasoseol", label: "자소설닷컴", implemented: true },
  { source: "linkareer", label: "링커리어", implemented: true },
  { source: "jobkorea", label: "잡코리아", implemented: true },
  { source: "incruit", label: "인크루트", implemented: true },
  { source: "peoplenjob", label: "피플앤잡", implemented: true },
  { source: "superookie", label: "슈퍼루키", implemented: true },
  { source: "rocketpunch", label: "로켓펀치", implemented: false },
  { source: "jobplanet", label: "잡플래닛", implemented: false },
  { source: "groupby", label: "그룹바이", implemented: false },
];
