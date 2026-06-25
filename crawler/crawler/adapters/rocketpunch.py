"""로켓펀치 어댑터 (보류).

확인 결과: 풍부한 헤더로 200 은 받지만, /jobs 목록의 공고 링크가 정적/렌더 HTML 모두에
노출되지 않는다(로그인 또는 추가 인터랙션 후 XHR 로 로드되는 것으로 보임).
→ 내부 API(예: /api/jobs/template) 분석 또는 로그인 세션이 필요. 추후 구현.
"""
from __future__ import annotations

import logging

from ..base import Adapter
from ..models import JobPosting

log = logging.getLogger("crawler.rocketpunch")


class RocketpunchAdapter(Adapter):
    source = "rocketpunch"
    label = "로켓펀치"
    enabled = False  # 보류: 내부 API/로그인 필요

    def fetch(self) -> list[JobPosting]:
        return []
