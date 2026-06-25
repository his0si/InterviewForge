"""그룹바이 어댑터 (보류).

확인 결과: SPA(렌더 후에도 공고 링크가 노출되지 않음 — 데이터가 별도 내부 API/상호작용으로 로드).
→ 내부 XHR 엔드포인트 분석 필요. 추후 구현.
"""
from __future__ import annotations

import logging

from ..base import Adapter
from ..models import JobPosting

log = logging.getLogger("crawler.groupby")


class GroupbyAdapter(Adapter):
    source = "groupby"
    label = "그룹바이"
    enabled = False  # 보류: 내부 API 분석 필요

    def fetch(self) -> list[JobPosting]:
        return []
