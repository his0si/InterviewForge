"""Playwright 헤드리스 렌더링 헬퍼. JS 로 목록을 그리는 사이트(SPA)나 봇 차단 사이트용.

render(url) → 최종 렌더된 HTML. 지연 로딩 목록을 위해 몇 번 스크롤한다.
Playwright/크로미움이 없으면 RuntimeError → 어댑터가 잡아 건너뛴다(나머지는 계속).
"""
from __future__ import annotations

import logging
import re

from bs4 import BeautifulSoup

from .config import USER_AGENT

log = logging.getLogger("crawler.browser")


def extract_links(html: str, pattern: str, base: str):
    """렌더된 HTML 에서 (id, url, anchor_text, card_text) 목록을 추출(중복 id 제거)."""
    rx = re.compile(pattern)
    soup = BeautifulSoup(html, "lxml")
    out: dict[str, tuple] = {}
    for a in soup.select("a[href]"):
        m = rx.search(a.get("href", ""))
        if not m:
            continue
        jid = m.group(1)
        if jid in out:
            continue
        href = a["href"]
        url = href if href.startswith("http") else base + href
        card = a.find_parent(["li", "div", "article"])
        out[jid] = (
            jid,
            url,
            a.get_text(" ", strip=True),
            card.get_text(" ", strip=True) if card else a.get_text(" ", strip=True),
        )
    return list(out.values())


def render(url: str, wait_selector: str | None = None, scrolls: int = 4, timeout: int = 30000) -> str:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:  # 패키지 없음
        raise RuntimeError("playwright 미설치") from e

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        ctx = browser.new_context(
            user_agent=USER_AGENT,
            locale="ko-KR",
            viewport={"width": 1366, "height": 900},
        )
        page = ctx.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=timeout)
        if wait_selector:
            try:
                page.wait_for_selector(wait_selector, timeout=timeout)
            except Exception:
                log.debug("wait_selector 타임아웃: %s", wait_selector)
        # 지연 로딩 목록을 끌어오기 위해 스크롤
        for _ in range(scrolls):
            page.mouse.wheel(0, 4000)
            page.wait_for_timeout(900)
        html = page.content()
        browser.close()
        return html


def render_frames_text(url: str, timeout: int = 30000) -> str:
    """페이지 + 모든 iframe 의 텍스트를 합쳐 반환(사람인처럼 JD 가 iframe 안에 있는 경우)."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:
        raise RuntimeError("playwright 미설치") from e
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        ctx = browser.new_context(user_agent=USER_AGENT, locale="ko-KR")
        page = ctx.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=timeout)
        page.wait_for_timeout(2500)  # iframe JD 로딩 대기
        parts = []
        for fr in page.frames:
            try:
                parts.append(fr.locator("body").inner_text(timeout=4000))
            except Exception:
                pass
        browser.close()
        return "\n".join(parts)
