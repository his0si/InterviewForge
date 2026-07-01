-- sk_hynix_contexts(전용) → company_contexts(통합) 1회 마이그레이션. 멱등(여러 번 실행 안전).
-- 기존 sk_hynix_contexts 는 보존한다(삭제하지 않음). 면접 어댑터만 company_contexts 로 전환.

BEGIN;

\i 03_company_contexts.sql

-- 18행 복사. company_key='sk_hynix'. (company_key, source_url, content_hash) 충돌 시 무시 → 재실행 안전.
INSERT INTO company_contexts
  (company_key, content_type, title, source_name, source_url, published_at,
   source_text, extracted_data, content_hash, fetched_at, model_name, prompt_version, created_at)
SELECT
  'sk_hynix', content_type, title, source_name, source_url, published_at,
  source_text, extracted_data, content_hash, fetched_at, model_name, prompt_version, created_at
FROM sk_hynix_contexts
ON CONFLICT (company_key, source_url, content_hash) DO NOTHING;

COMMIT;

SELECT company_key, content_type, count(*)
FROM company_contexts GROUP BY 1, 2 ORDER BY 1, 2;
