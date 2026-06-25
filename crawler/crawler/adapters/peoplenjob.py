"""피플앤잡 어댑터 — 채용 목록 HTML 파싱.

목록: https://www.peoplenjob.com/jobs (외국계/공기업 중심). 공고 링크 /jobs/{id}.
카드(.jd-card)에서 제목/회사 best-effort 추출.
"""
from __future__ import annotations

import logging
import re
import time

from bs4 import BeautifulSoup

from ..base import Adapter
from ..config import MAX_PER_SOURCE
from ..models import JobPosting

log = logging.getLogger("crawler.peoplenjob")

LIST = "https://www.peoplenjob.com/jobs?page={page}"
BASE = "https://www.peoplenjob.com"
_ID = re.compile(r"/jobs/(\d+)")


class PeoplenjobAdapter(Adapter):
    source = "peoplenjob"
    label = "피플앤잡"
    enabled = True
    detail_selector = "[class*=jd]"
    detail_delay = 1.5  # 429 민감 → 지연 크게

    def fetch(self) -> list[JobPosting]:
        out: list[JobPosting] = []
        seen: set[str] = set()
        with self.client() as c:
            page = 1
            while len(out) < MAX_PER_SOURCE and page <= 15:
                r = c.get(LIST.format(page=page))
                if r.status_code != 200:
                    break
                soup = BeautifulSoup(r.text, "lxml")
                links = [a for a in soup.select('a[href]') if _ID.search(a.get("href", ""))]
                if not links:
                    break
                new = 0
                for a in links:
                    jid = _ID.search(a["href"]).group(1)
                    if jid in seen:
                        continue
                    title = a.get_text(" ", strip=True)
                    if not title:
                        continue
                    seen.add(jid)
                    new += 1
                    card = a.find_parent(class_=re.compile("jd-card")) or a.find_parent(["li", "div"])
                    company = None
                    if card:
                        corp = card.select_one(".company, .corp, .jd-card-company, strong, em")
                        if corp and corp.get_text(strip=True) != title:
                            company = corp.get_text(strip=True)
                    out.append(JobPosting(
                        source=self.source,
                        source_job_id=jid,
                        source_url=a["href"] if a["href"].startswith("http") else BASE + a["href"],
                        title=title,
                        company=company,
                        raw={},
                    ))
                    if len(out) >= MAX_PER_SOURCE:
                        break
                if new == 0:
                    break
                page += 1
                time.sleep(0.5)
        self.enrich_details(out)  # 상세에서 자격요건/우대/전형/서류 등 보강
        log.info("피플앤잡 %d건 수집", len(out))
        return out
