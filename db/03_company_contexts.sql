-- 회사 중립 통합 컨텍스트 테이블.
-- 기존 sk_hynix_contexts(회사 전용)를 일반화한 것. 회사 추가 = INSERT 만, DDL 변경 없음.
-- company_key 로 회사를 구분한다(예: 'sk_hynix', 'samsung_electronics').
-- 면접 어댑터는 이 테이블을 SELECT only 로만 읽는다. FK 없음, 기존 테이블과 무관.

CREATE TABLE IF NOT EXISTS company_contexts (
  id BIGSERIAL PRIMARY KEY,
  company_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  title TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  published_at TIMESTAMPTZ NULL,
  source_text TEXT NOT NULL,
  extracted_data JSONB NOT NULL,
  content_hash TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  model_name TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT company_contexts_type_check CHECK (
    content_type IN (
      'work_culture',
      'talent_profile',
      'official_article',
      'external_news'
    )
  ),

  -- 같은 회사·같은 URL·같은 내용은 한 번만. 내용이 바뀌면 새 content_hash 로 새 행 append.
  CONSTRAINT company_contexts_company_source_hash_unique
    UNIQUE (company_key, source_url, content_hash)
);

-- 최신 조회: 회사·유형별 가장 최근 자료 1건.
CREATE INDEX IF NOT EXISTS idx_company_contexts_company_type_fetched
  ON company_contexts (company_key, content_type, fetched_at DESC);

-- 회사 단위 전체 조회.
CREATE INDEX IF NOT EXISTS idx_company_contexts_company_fetched
  ON company_contexts (company_key, fetched_at DESC);

-- 수집 메타(어떤 회사를 언제 마지막으로 수집했는지). 파이프라인 스케줄러가 읽고/쓴다.
-- 면접 경로는 이 테이블을 사용하지 않는다(수집 운영용).
CREATE TABLE IF NOT EXISTS company_ingest_runs (
  id BIGSERIAL PRIMARY KEY,
  company_key TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL DEFAULT 'running',   -- running | ok | partial | failed
  inserted_rows INT NOT NULL DEFAULT 0,
  note TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_company_ingest_runs_company_started
  ON company_ingest_runs (company_key, started_at DESC);

-- JIT 수집 요청 큐. 컨테이너 안의 면접 서버가 "데이터 없는 회사"를 만나면 여기 한 줄 넣고(enqueue),
-- 호스트의 파이프라인 러너(run.py --drain, cron)가 집어서 수집한다. 서버↔파이프라인을 DB 로 분리.
-- (기존 crawl_commands 패턴과 동일한 발상.)
CREATE TABLE IF NOT EXISTS company_ingest_requests (
  id BIGSERIAL PRIMARY KEY,
  company_key TEXT NOT NULL,
  company_name TEXT NOT NULL,                  -- 원본 회사명(--jit 입력으로 사용)
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | running | done | failed
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  picked_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  attempts INT NOT NULL DEFAULT 0,
  note TEXT NULL
);

-- 회사당 'pending' 1건만 허용 → 서버는 ON CONFLICT DO NOTHING 으로 중복 enqueue 방지(디바운스).
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_ingest_requests_pending
  ON company_ingest_requests (company_key) WHERE status = 'pending';
