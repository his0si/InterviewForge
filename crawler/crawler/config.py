"""환경설정 로딩. .env 또는 컨테이너 환경변수에서 읽는다."""
from __future__ import annotations

import os
from dotenv import load_dotenv

load_dotenv()


def _get(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


# interviewforge DB (5434 클러스터).
#  - 컨테이너에서 실행: host.docker.internal:5434
#  - 호스트 venv 로 실행: localhost:5434
DATABASE_URL = _get(
    "DATABASE_URL",
    "postgresql://interviewforge:life0635@localhost:5434/interviewforge",
)

# 사람인 공식 오픈 API 키 (https://oapi.saramin.co.kr). 없으면 사람인 어댑터는 건너뜀.
SARAMIN_API_KEY = _get("SARAMIN_API_KEY")

# 매일 크롤링할 시각(시/분) + 타임존. APScheduler 데몬 모드에서 사용.
CRAWL_HOUR = int(_get("CRAWL_HOUR", "5"))
CRAWL_MINUTE = int(_get("CRAWL_MINUTE", "0"))
TZ = _get("TZ", "Asia/Seoul")

# 어댑터별 1회 수집 상한(과도한 요청 방지).
MAX_PER_SOURCE = int(_get("MAX_PER_SOURCE", "300"))

# 상세 페이지를 열어 원문/자격요건/우대/전형 등을 채울 최대 건수(런타임 보호).
# 원문이 항상 보이도록 기본을 크게 둔다(사실상 MAX_PER_SOURCE 전체).
DETAIL_LIMIT = int(_get("DETAIL_LIMIT", "1000"))

# 검색 키워드(면접 연습 대상 직무). 콤마로 구분.
KEYWORDS = [k.strip() for k in _get("KEYWORDS", "개발자,백엔드,프론트엔드,데이터").split(",") if k.strip()]

# 로컬 LLM(Ollama) 요약 설정.
#  - 컨테이너: http://host.docker.internal:11434, 호스트: http://localhost:11434
OLLAMA_URL = _get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = _get("OLLAMA_MODEL", "exaone3.5:latest")  # 한국어 특화
# 1회 실행에서 새로 요약할 최대 건수(LLM 이 느리므로 캡). 매일 누적 백필.
SUMMARY_LIMIT = int(_get("SUMMARY_LIMIT", "120"))

# HTTP 요청 공통 헤더(차단 완화용 UA).
USER_AGENT = _get(
    "USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
)
REQUEST_TIMEOUT = float(_get("REQUEST_TIMEOUT", "20"))
