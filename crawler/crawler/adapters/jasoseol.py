"""자소설닷컴 어댑터 — Playwright 렌더 후 /recruit/{id} 추출.

목록: https://jasoseol.com/recruit (SPA, 채용 캘린더). 렌더 타이밍이 다소 불안정해
wait_selector + 스크롤로 최대한 끌어온다(수집량이 회차마다 다를 수 있음).
"""
from __future__ import annotations

import logging
import re

from ..base import Adapter
from ..browser import render, extract_links
from ..config import MAX_PER_SOURCE
from ..models import JobPosting

log = logging.getLogger("crawler.jasoseol")

LIST = "https://jasoseol.com/recruit"
BASE = "https://jasoseol.com"


class JasoseolAdapter(Adapter):
    source = "jasoseol"
    label = "자소설닷컴"
    enabled = True

    def fetch(self) -> list[JobPosting]:
        try:
            html = render(LIST, wait_selector='a[href*="/recruit/"]', scrolls=8, timeout=35000)
        except Exception as e:
            log.warning("자소설 렌더 실패: %s", e)
            return []
        rows = extract_links(html, r"/recruit/(\d+)", BASE)[:MAX_PER_SOURCE]
        out = []
        for jid, url, atext, _card in rows:
            title = re.sub(r"^(끝|마감|추천|D-\d+|D-DAY)\s*", "", atext).strip()
            if not title or len(title) < 2:
                continue
            out.append(JobPosting(
                source=self.source, source_job_id=jid,
                source_url=f"{BASE}/recruit/{jid}", title=title[:200], raw={},
            ))
        self.enrich_details(out)  # /recruit/{id} 가 SSR → 본문 수집 가능
        log.info("자소설 %d건 수집", len(out))
        return out
