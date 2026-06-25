"""어댑터 공통 인터페이스 + HTTP 유틸. 새 사이트는 Adapter 를 상속해 fetch() 만 구현하면 된다."""
from __future__ import annotations

import logging
import time

import httpx
from bs4 import BeautifulSoup

from .config import DETAIL_LIMIT, REQUEST_TIMEOUT, USER_AGENT
from .models import JobPosting
from .sections import apply_sections

log = logging.getLogger("crawler.adapter")


class Adapter:
    # 출처 키(= job_postings.source, 화면 칩에 표시). 예: 'saramin'
    source: str = ""
    # 사람이 읽는 이름(로그/칩 라벨용). 예: '사람인'
    label: str = ""
    # False 면 오케스트레이터가 건너뜀(아직 미구현 사이트).
    enabled: bool = False

    def client(self) -> httpx.Client:
        return httpx.Client(
            headers={"User-Agent": USER_AGENT, "Accept-Language": "ko-KR,ko;q=0.9"},
            timeout=REQUEST_TIMEOUT,
            follow_redirects=True,
        )

    # 상세 페이지 인코딩(인크루트 euc-kr 등). 기본은 자동.
    detail_encoding: str | None = None
    # 상세 본문 컨테이너 CSS(메뉴/사이드 제외하고 본문만). 여러 개 매칭 시 가장 긴 텍스트 선택.
    detail_selector: str | None = None
    # 상세 요청 간 지연(초). 429 민감한 사이트는 어댑터에서 크게 둔다.
    detail_delay: float = 0.6

    def fetch(self) -> list[JobPosting]:
        """공고 목록을 수집해 정규화된 JobPosting 리스트로 반환."""
        raise NotImplementedError

    def detail_url(self, p: JobPosting) -> str:
        """상세 본문을 가져올 URL. 기본은 원본 링크지만, 본문이 별도 엔드포인트에
        있는 사이트(사람인 iframe 등)는 어댑터에서 오버라이드한다."""
        return p.source_url

    def enrich_details(self, postings: list[JobPosting]) -> list[JobPosting]:
        """각 공고의 source_url(상세 페이지)을 열어 자격요건/우대/전형/서류/급여/본문을 채운다.
        상세가 SSR(HTML) 인 사이트용. DETAIL_LIMIT 만큼만, 예의상 지연을 두고 가져온다."""
        with self.client() as c:
            for p in postings[:DETAIL_LIMIT]:
                url = self.detail_url(p)
                try:
                    r = c.get(url)
                    # 429(요청 과다)면 백오프 후 1회 재시도, 그래도면 건너뜀
                    if r.status_code == 429:
                        time.sleep(5)
                        r = c.get(url)
                        if r.status_code == 429:
                            log.debug("429 지속 → 건너뜀: %s", p.source_url)
                            time.sleep(self.detail_delay)
                            continue
                    if self.detail_encoding:
                        r.encoding = self.detail_encoding
                    if r.status_code == 200:
                        soup = BeautifulSoup(r.text, "lxml")
                        # 네비게이션/푸터/스크립트 등 잡음 제거 → 본문 위주로
                        for tag in soup(["script", "style", "nav", "header", "footer", "aside", "noscript"]):
                            tag.decompose()
                        root = soup
                        if self.detail_selector:
                            els = soup.select(self.detail_selector)
                            if els:  # 가장 텍스트가 긴 컨테이너 = 본문
                                root = max(els, key=lambda e: len(e.get_text(strip=True)))
                        text = root.get_text("\n", strip=True)
                        apply_sections(p, text)
                    time.sleep(self.detail_delay)
                except Exception:
                    log.debug("상세 수집 실패: %s", p.source_url)
        return postings
