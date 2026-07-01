"""company_context — 레지스트리 기반, 회사 비종속 컨텍스트 수집 패키지.

SK하이닉스 전용으로 손수 돌리던 파이프라인(sandbox/scripts/sk_*.py)을 일반화한 것.
회사를 추가하려면 코드가 아니라 registry.py 에 항목 하나만 더한다.
출력은 단일 테이블 public.company_contexts.

모듈:
- registry : company_key -> 소스 매핑(단일 진실 공급원) + slugify_company()
- engine   : 회사 비종속 코어(fetch_clean / exaone_extract / grounding / insert_rows / db url)
- run      : CLI 드라이버 (--company / --top N / --jit name, 기본 DRY-RUN, --execute 로 쓰기)
"""
from __future__ import annotations

__all__ = ["registry", "engine", "run"]
