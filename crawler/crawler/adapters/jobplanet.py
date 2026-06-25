"""잡플래닛 어댑터 (보류).

확인 결과: 채용 검색 페이지가 403(헤더를 갖춰도 차단) + 상당 부분 로그인 필요.
→ 로그인 세션 쿠키 또는 우회가 필요. 추후 구현.
"""
from __future__ import annotations

import logging

from ..base import Adapter
from ..models import JobPosting

log = logging.getLogger("crawler.jobplanet")


class JobplanetAdapter(Adapter):
    source = "jobplanet"
    label = "잡플래닛"
    enabled = False  # 보류: 403 + 로그인 필요

    def fetch(self) -> list[JobPosting]:
        return []
