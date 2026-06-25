# Playwright 공식 파이썬 이미지(크로미움 + 시스템 의존성 사전 설치) — 헤드리스 어댑터용.
FROM mcr.microsoft.com/playwright/python:v1.48.0-jammy

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY db ./db
COPY crawler ./crawler

# 기본은 상시 스케줄러(매일 자동). 1회만: docker compose run --rm crawler python -m crawler run
CMD ["python", "-m", "crawler", "schedule"]
