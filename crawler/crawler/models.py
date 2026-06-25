"""정규화된 공고 데이터 모델. 모든 어댑터는 이 형태로 반환한다."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import date
from typing import Any


@dataclass
class JobPosting:
    # 필수
    source: str
    source_url: str
    title: str

    # 식별
    source_job_id: str | None = None

    # 핵심
    company: str | None = None
    location: str | None = None

    # 조건/분류
    employment_type: str | None = None
    experience_level: str | None = None
    experience_min: int | None = None
    experience_max: int | None = None
    education: str | None = None
    salary: str | None = None
    job_categories: list[str] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)

    # 일정
    posted_at: date | None = None
    deadline: date | None = None
    deadline_text: str | None = None

    # 상세(없으면 None)
    qualifications: str | None = None
    preferred: str | None = None
    hiring_process: str | None = None
    documents: str | None = None
    benefits: str | None = None
    description: str | None = None

    # 상세 페이지까지 파싱했는지 여부.
    #  True  + 필드 NULL → 실제로 그 항목이 원본에 없음(신뢰 가능)
    #  False + 필드 NULL → 아직 상세를 안 본 것(unknown)
    detail_fetched: bool = False

    # 원본 보존
    raw: dict[str, Any] = field(default_factory=dict)

    def as_db_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d
