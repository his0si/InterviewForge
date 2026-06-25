"""사람인 어댑터 — 검색 결과 HTML 스크레이핑(공식 API 키 불필요).

목록: https://www.saramin.co.kr/zf_user/search/recruit?searchword=<키워드>&recruitPage=N
카드(.item_recruit): 제목(.job_tit a) / 회사(.corp_name a) / 조건(.job_condition span: 지역·경력·학력·고용형태)
                     / 마감(.job_date .date) / 직무(.job_sector).
"""
from __future__ import annotations

import logging
import re
import time
from datetime import date
from urllib.parse import quote

from bs4 import BeautifulSoup

from ..base import Adapter
from ..config import MAX_PER_SOURCE, KEYWORDS
from ..models import JobPosting

log = logging.getLogger("crawler.saramin")

BASE = "https://www.saramin.co.kr"
LIST = BASE + "/zf_user/search/recruit?searchType=search&searchword={kw}&recruitPage={page}"
_REC = re.compile(r"rec_idx=(\d+)")
_DUE = re.compile(r"(\d{1,2})/(\d{1,2})")


def _deadline(text: str) -> tuple[date | None, str | None]:
    if "오늘마감" in text or "내일마감" in text:
        return None, text.strip()
    if "상시" in text or "채용시" in text:
        return None, "상시채용"
    m = _DUE.search(text)
    if not m:
        return None, text.strip() or None
    mm, dd = int(m.group(1)), int(m.group(2))
    today = date.today()
    year = today.year + (1 if mm < today.month else 0)
    try:
        return date(year, mm, dd), None
    except ValueError:
        return None, text.strip()


class SaraminAdapter(Adapter):
    source = "saramin"
    label = "사람인"
    enabled = True

    def fetch(self) -> list[JobPosting]:
        out: list[JobPosting] = []
        seen: set[str] = set()
        with self.client() as c:
            for kw in KEYWORDS or ["개발자"]:
                page = 1
                while len(out) < MAX_PER_SOURCE and page <= 10:
                    r = c.get(LIST.format(kw=quote(kw), page=page))
                    if r.status_code != 200:
                        break
                    soup = BeautifulSoup(r.text, "lxml")
                    items = soup.select(".item_recruit")
                    if not items:
                        break
                    new = 0
                    for it in items:
                        a = it.select_one(".job_tit a")
                        if not a:
                            continue
                        m = _REC.search(a.get("href", ""))
                        jid = m.group(1) if m else None
                        if not jid or jid in seen:
                            continue
                        seen.add(jid)
                        new += 1
                        conds = [x.get_text(strip=True) for x in it.select(".job_condition span")]
                        # conds 순서: [지역, 경력, 학력, 고용형태] (가변)
                        loc = conds[0] if len(conds) > 0 else None
                        exp = next((c2 for c2 in conds if "경력" in c2 or "신입" in c2), None)
                        edu = next((c2 for c2 in conds if "학력" in c2 or "졸" in c2 or "무관" in c2), None)
                        etype = next((c2 for c2 in conds if any(k in c2 for k in ("정규", "계약", "인턴", "파견", "아르바"))), None)
                        date_el = it.select_one(".job_date .date")
                        deadline, dtext = _deadline(date_el.get_text(strip=True) if date_el else "")
                        sector = it.select_one(".job_sector")
                        cats = [s.get_text(strip=True) for s in (sector.select("a, b") if sector else [])][:6]
                        out.append(JobPosting(
                            source=self.source,
                            source_job_id=jid,
                            source_url=f"{BASE}/zf_user/jobs/relay/view?rec_idx={jid}",
                            title=a.get("title") or a.get_text(strip=True),
                            company=(it.select_one(".corp_name a").get_text(strip=True)
                                     if it.select_one(".corp_name a") else None),
                            location=loc,
                            experience_level=exp,
                            education=edu,
                            employment_type=etype,
                            deadline=deadline,
                            deadline_text=dtext,
                            job_categories=cats,
                            raw={"conditions": conds},
                        ))
                        if len(out) >= MAX_PER_SOURCE:
                            break
                    if new == 0:
                        break
                    page += 1
                    time.sleep(0.6)
        # 상세 JD 는 view-detail 엔드포인트가 SSR 로 내려준다(iframe 우회) → 본문 수집 가능.
        self.enrich_details(out)
        log.info("사람인 %d건 수집", len(out))
        return out

    def detail_url(self, p) -> str:
        if p.source_job_id:
            return f"{BASE}/zf_user/jobs/relay/view-detail?rec_idx={p.source_job_id}"
        return p.source_url
