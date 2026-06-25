"""슈퍼루키 어댑터 — Playwright 렌더 후 /jobs/{hash} 추출.

목록: https://www.superookie.com/jobs (SPA). 카드 텍스트에 마감(MM/DD)·신입/경력·지역·학력 포함.
"""
from __future__ import annotations

import logging
import re
from datetime import date

from ..base import Adapter
from ..browser import render, extract_links
from ..config import MAX_PER_SOURCE
from ..models import JobPosting

log = logging.getLogger("crawler.superookie")

LIST = "https://www.superookie.com/jobs"
BASE = "https://www.superookie.com"
_CUT = re.compile(r"\s*(?:\d{1,2}/\d{1,2}|채용시\s*마감|상시\s*채용|D-\d+|\d+일\s*후)")
_DUE = re.compile(r"(\d{1,2})/(\d{1,2})")


def _deadline(text):
    if "채용시" in text or "상시" in text:
        return None, "상시채용"
    m = _DUE.search(text)
    if not m:
        return None, None
    mm, dd = int(m.group(1)), int(m.group(2))
    y = date.today().year + (1 if mm < date.today().month else 0)
    try:
        return date(y, mm, dd), None
    except ValueError:
        return None, None


class SuperookieAdapter(Adapter):
    source = "superookie"
    label = "슈퍼루키"
    enabled = True
    # SPA 라 본문 컨테이너가 모달과 섞임 → 전체 본문 사용(JD 포함). 메뉴 일부가 앞에 붙을 수 있음.

    def fetch(self) -> list[JobPosting]:
        try:
            html = render(LIST, wait_selector='a[href*="/jobs/"]', scrolls=8)
        except Exception as e:
            log.warning("슈퍼루키 렌더 실패: %s", e)
            return []
        rows = extract_links(html, r"/jobs/([0-9a-f]{16,})", BASE)[:MAX_PER_SOURCE]
        out = []
        for jid, url, _atext, card in rows:
            title = _CUT.split(card)[0].strip()
            if not title:
                continue
            deadline, dtext = _deadline(card)
            exp = "신입" if "신입" in card else ("경력" if "경력" in card else None)
            out.append(JobPosting(
                source=self.source, source_job_id=jid,
                source_url=f"{BASE}/jobs/{jid}", title=title[:200],
                experience_level=exp, deadline=deadline, deadline_text=dtext,
                raw={"card": card[:300]},
            ))
        self.enrich_details(out)  # 상세(SSR)에서 자격요건/서류 등 보강
        log.info("슈퍼루키 %d건 수집", len(out))
        return out
