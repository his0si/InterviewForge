"""인크루트 어댑터 — 검색 목록 HTML 파싱(euc-kr).

목록: https://search.incruit.com/list/search.asp?col=job&kw=<키워드>&page=N
공고 링크: job.incruit.com/jobdb_info/jobpost.asp?job=<id> (텍스트=제목).
회사/마감은 같은 리스트 아이템에서 best-effort 로 추출.
"""
from __future__ import annotations

import logging
import re
import time
from urllib.parse import quote

from bs4 import BeautifulSoup

from ..base import Adapter
from ..config import MAX_PER_SOURCE, KEYWORDS
from ..models import JobPosting

log = logging.getLogger("crawler.incruit")

LIST = "https://search.incruit.com/list/search.asp?col=job&kw={kw}&page={page}"
_JOB = re.compile(r"jobpost\.asp\?job=(\d+)")


class IncruitAdapter(Adapter):
    source = "incruit"
    label = "인크루트"
    enabled = True
    detail_encoding = "euc-kr"
    detail_selector = "[id*=content]"

    def fetch(self) -> list[JobPosting]:
        out: list[JobPosting] = []
        seen: set[str] = set()
        with self.client() as c:
            for kw in KEYWORDS or ["개발자"]:
                page = 1
                while len(out) < MAX_PER_SOURCE and page <= 10:
                    r = c.get(LIST.format(kw=quote(kw, encoding="euc-kr"), page=page))
                    r.encoding = "euc-kr"
                    if r.status_code != 200:
                        break
                    soup = BeautifulSoup(r.text, "lxml")
                    links = [a for a in soup.select("a[href]") if _JOB.search(a.get("href", ""))]
                    if not links:
                        break
                    new = 0
                    for a in links:
                        jid = _JOB.search(a["href"]).group(1)
                        title = a.get_text(" ", strip=True)
                        if not title or jid in seen:
                            continue
                        seen.add(jid)
                        new += 1
                        # 회사: 같은 아이템(li/div) 내 다른 텍스트에서 추정
                        parent = a.find_parent(["li", "div", "tr"])
                        company = None
                        if parent:
                            corp = parent.select_one('a[href*="company"], .cpname, .corp, strong')
                            if corp:
                                company = corp.get_text(strip=True)
                        out.append(JobPosting(
                            source=self.source,
                            source_job_id=jid,
                            source_url=a["href"] if a["href"].startswith("http")
                            else "https://job.incruit.com" + a["href"],
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
        self.enrich_details(out)  # 상세에서 자격요건/우대/전형 등 보강
        log.info("인크루트 %d건 수집", len(out))
        return out
