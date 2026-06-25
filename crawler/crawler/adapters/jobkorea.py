"""잡코리아 어댑터 — 목록 HTML 파싱(tr.devloopArea).

목록: https://www.jobkorea.co.kr/recruit/joblist?menucode=duty&Page_No=N
각 행: 회사(a.normalLog[0]) / 제목(GI_Read 링크) / 마감("~MM/DD") .
상세(자격요건 등)는 GI_Read 상세 페이지에 있으나 1차 구현은 목록 레벨.
"""
from __future__ import annotations

import logging
import re
import time
from datetime import date

from bs4 import BeautifulSoup

from ..base import Adapter
from ..config import MAX_PER_SOURCE
from ..models import JobPosting

log = logging.getLogger("crawler.jobkorea")

LIST = "https://www.jobkorea.co.kr/recruit/joblist?menucode=duty&Page_No={page}"
BASE = "https://www.jobkorea.co.kr"
_GI = re.compile(r"/Recruit/GI_Read/(\d+)")
_DUE = re.compile(r"~\s*(\d{1,2})/(\d{1,2})")


def _deadline(text: str) -> tuple[date | None, str | None]:
    m = _DUE.search(text)
    if not m:
        if "상시" in text:
            return None, "상시채용"
        return None, None
    mm, dd = int(m.group(1)), int(m.group(2))
    today = date.today()
    year = today.year + (1 if mm < today.month else 0)
    try:
        return date(year, mm, dd), None
    except ValueError:
        return None, f"~{mm}/{dd}"


class JobkoreaAdapter(Adapter):
    source = "jobkorea"
    label = "잡코리아"
    enabled = True

    def fetch(self) -> list[JobPosting]:
        out: list[JobPosting] = []
        seen: set[str] = set()
        with self.client() as c:
            page = 1
            while len(out) < MAX_PER_SOURCE and page <= 20:
                r = c.get(LIST.format(page=page))
                if r.status_code != 200:
                    break
                soup = BeautifulSoup(r.text, "lxml")
                rows = soup.select("tr.devloopArea")
                if not rows:
                    break
                new = 0
                for row in rows:
                    link = row.select_one('a[href*="/Recruit/GI_Read/"]')
                    if not link:
                        continue
                    m = _GI.search(link.get("href", ""))
                    if not m:
                        continue
                    jid = m.group(1)
                    if jid in seen:
                        continue
                    seen.add(jid)
                    new += 1
                    anchors = row.select("a.normalLog")
                    company = anchors[0].get_text(strip=True) if anchors else None
                    title = link.get("title") or link.get_text(strip=True)
                    deadline, dtext = _deadline(row.get_text(" ", strip=True))
                    out.append(JobPosting(
                        source=self.source,
                        source_job_id=jid,
                        source_url=f"{BASE}/Recruit/GI_Read/{jid}",
                        title=title or "(제목 없음)",
                        company=company,
                        deadline=deadline,
                        deadline_text=dtext,
                        raw={"list_row_text": row.get_text(" ", strip=True)[:500]},
                    ))
                    if len(out) >= MAX_PER_SOURCE:
                        break
                if new == 0:
                    break
                page += 1
                time.sleep(0.5)
        self.enrich_details(out)  # GI_Read 상세에서 자격요건/급여 등 보강
        log.info("잡코리아 %d건 수집", len(out))
        return out
