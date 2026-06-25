"""링커리어 어댑터 — Playwright 렌더 후 /activity/{id} 추출.

목록: https://linkareer.com/list/recruit (SPA). 카드 텍스트에 직무 카테고리 포함.
"""
from __future__ import annotations

import logging
import re

from ..base import Adapter
from ..browser import render, extract_links
from ..config import MAX_PER_SOURCE
from ..models import JobPosting

log = logging.getLogger("crawler.linkareer")

LIST = "https://linkareer.com/list/recruit"
BASE = "https://linkareer.com"


class LinkareerAdapter(Adapter):
    source = "linkareer"
    label = "링커리어"
    enabled = True
    detail_selector = "main, article"

    def fetch(self) -> list[JobPosting]:
        try:
            html = render(LIST, wait_selector='a[href*="/activity/"]', scrolls=6)
        except Exception as e:
            log.warning("링커리어 렌더 실패: %s", e)
            return []
        rows = extract_links(html, r"/activity/(\d+)", BASE)[:MAX_PER_SOURCE]
        out = []
        for jid, url, atext, _card in rows:
            title = re.sub(r"^(추천|마감임박|D-\d+)\s*", "", atext).strip()
            if not title:
                continue
            out.append(JobPosting(
                source=self.source, source_job_id=jid,
                source_url=f"{BASE}/activity/{jid}", title=title[:200], raw={},
            ))
        self.enrich_details(out)  # 상세(SSR)에서 자격요건/우대 등 보강
        log.info("링커리어 %d건 수집", len(out))
        return out
