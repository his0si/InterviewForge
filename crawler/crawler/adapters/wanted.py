"""원티드 어댑터 — 내부 JSON API (목록 + 상세).

목록: GET /api/v4/jobs?country=kr&job_sort=job.latest_order&years=-1&limit&offset
상세: GET /api/chaos/jobs/v1/{id}/details  → intro/main_tasks/requirements/preferred_points/benefits
"""
from __future__ import annotations

import logging
import time
from datetime import datetime

from ..base import Adapter
from ..config import MAX_PER_SOURCE
from ..models import JobPosting

log = logging.getLogger("crawler.wanted")

LIST_URL = "https://www.wanted.co.kr/api/v4/jobs"
DETAIL_URL = "https://www.wanted.co.kr/api/chaos/jobs/v1/{id}/details"
PAGE = 50


def _parse_due(v) -> tuple[None, str | None] | tuple[object, None]:
    """due_time → (deadline_date, deadline_text). null 이면 상시채용."""
    if not v:
        return None, "상시채용"
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(str(v)[: len(fmt) + 2], fmt).date(), None
        except ValueError:
            continue
    return None, str(v)


class WantedAdapter(Adapter):
    source = "wanted"
    label = "원티드"
    enabled = True

    def fetch(self) -> list[JobPosting]:
        out: list[JobPosting] = []
        with self.client() as c:
            c.headers["Accept"] = "application/json"
            offset = 0
            while len(out) < MAX_PER_SOURCE:
                r = c.get(
                    LIST_URL,
                    params={
                        "country": "kr",
                        "job_sort": "job.latest_order",
                        "years": -1,
                        "limit": PAGE,
                        "offset": offset,
                    },
                )
                r.raise_for_status()
                data = r.json().get("data") or []
                if not data:
                    break
                for j in data:
                    out.append(self._parse(c, j))
                    if len(out) >= MAX_PER_SOURCE:
                        break
                offset += PAGE
                time.sleep(0.4)  # 예의상 지연
        log.info("원티드 %d건 수집", len(out))
        return out

    def _parse(self, c, j: dict) -> JobPosting:
        jid = str(j.get("id"))
        addr = j.get("address") or {}
        deadline, deadline_text = _parse_due(j.get("due_time"))
        cat = [str(t.get("id")) for t in (j.get("category_tags") or []) if t.get("id")]

        # 상세(자격요건/우대/본문/복지)
        detail: dict = {}
        try:
            rd = c.get(DETAIL_URL.format(id=jid))
            if rd.status_code == 200:
                detail = ((rd.json().get("job") or {}).get("detail")) or {}
            time.sleep(0.3)
        except Exception:
            log.debug("원티드 상세 실패 id=%s", jid)

        return JobPosting(
            source=self.source,
            source_job_id=jid,
            source_url=f"https://www.wanted.co.kr/wd/{jid}",
            title=detail.get("position") or j.get("position") or "(제목 없음)",
            company=(j.get("company") or {}).get("name"),
            location=" ".join(x for x in [addr.get("location"), addr.get("district")] if x)
            or addr.get("full_location"),
            experience_min=j.get("annual_from"),
            experience_max=j.get("annual_to"),
            experience_level=self._exp_label(j.get("annual_from"), j.get("annual_to")),
            deadline=deadline,
            deadline_text=deadline_text,
            job_categories=cat,
            qualifications=detail.get("requirements"),
            preferred=detail.get("preferred_points"),
            benefits=detail.get("benefits"),
            description="\n\n".join(
                s for s in [detail.get("intro"), detail.get("main_tasks")] if s
            )
            or None,
            detail_fetched=bool(detail),  # 상세 API 까지 받았으면 True
            raw={"list": j, "detail": detail},
        )

    @staticmethod
    def _exp_label(a, b) -> str | None:
        if a is None and b is None:
            return None
        if not a:
            return "신입"
        return f"경력 {a}~{b}년" if b else f"경력 {a}년+"
