"""어댑터 레지스트리. 오케스트레이터는 enabled=True 인 어댑터만 실행한다."""
from __future__ import annotations

from ..base import Adapter
from .saramin import SaraminAdapter
from .wanted import WantedAdapter
from .rocketpunch import RocketpunchAdapter
from .jasoseol import JasoseolAdapter
from .linkareer import LinkareerAdapter
from .jobkorea import JobkoreaAdapter
from .incruit import IncruitAdapter
from .peoplenjob import PeoplenjobAdapter
from .superookie import SuperookieAdapter
from .jobplanet import JobplanetAdapter
from .groupby import GroupbyAdapter

# 등록 순서대로 실행. 새 사이트 어댑터를 만들면 여기에 추가한다.
ALL_ADAPTERS: list[Adapter] = [
    SaraminAdapter(),
    WantedAdapter(),
    RocketpunchAdapter(),
    JasoseolAdapter(),
    LinkareerAdapter(),
    JobkoreaAdapter(),
    IncruitAdapter(),
    PeoplenjobAdapter(),
    SuperookieAdapter(),
    JobplanetAdapter(),
    GroupbyAdapter(),
]
