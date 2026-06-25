# InterviewForge 채용 공고 크롤러

여러 채용 사이트의 공고를 **매일 자동 수집**해 InterviewForge DB(`interviewforge`, 5434 클러스터)의
**`job_postings` 한 테이블**에 모은다. 출처는 `source` 컬럼으로 구분(화면 칩), 원본은 `source_url` 로 연결.
InterviewForge 앱과 한 폴더(`InterviewForge/crawler`) 아래 있으며 앱(서버/클라)이 같은 DB 를 읽는다.

## AI 요약 (로컬 LLM)
수집 본문(`description`)을 로컬 Ollama(`exaone3.5`, 한국어 특화)로 정갈한 마크다운으로 요약해
`ai_summary` 컬럼에 적재한다. **재크롤링 없이** 본문만 있으면 백필 가능:
```bash
python -m crawler summarize   # 요약만 백필(ai_summary 비어있는 것 대상)
```
`run`/`schedule` 시 수집 후 자동 요약. 설정: `.env` 의 `OLLAMA_URL`, `OLLAMA_MODEL`, `SUMMARY_LIMIT`.
호스트 Ollama 가 11434 에서 떠 있어야 한다.

```
[APScheduler 데몬 컨테이너] --매일 05:00 KST--> run_once()
        │  어댑터들(사람인 API / 잡코리아 / 원티드 …) 순회
        ▼  정규화(JobPosting) → UPSERT
[interviewforge.job_postings]  <-- InterviewForge 앱이 /api/jobs 로 읽어 목록 표시
```

## 데이터 저장 전략 (모든 항목을 어떻게 쌓을까)

공고마다 있는 필드가 제각각이라 **"공통 컬럼 + 원본 JSONB"** 하이브리드로 저장한다.

1. **자주 조회·필터하는 항목 → 정규화 컬럼** (`db/schema.sql`)
   - 마감(`deadline` / 날짜가 아니면 `deadline_text` 예: "상시채용")
   - 경력(`experience_level` 원문 + `experience_min/max` 숫자), 신입/경력 구분도 여기서
   - 고용형태(`employment_type`), 학력(`education`), 급여(`salary`, 형식이 제각각이라 텍스트)
   - 직군/스택(`job_categories TEXT[]`, `skills TEXT[]`)
   - 상세 본문(`qualifications` 자격요건, `preferred` 우대사항, `hiring_process` 전형절차,
     `documents` 제출서류, `benefits` 복리후생, `description` 본문 전체)
2. **없으면 NULL** — 모든 상세 컬럼은 nullable. 공고에 해당 항목이 없으면 그냥 비워둔다.
3. **원본 전체 → `raw JSONB`** — 사이트마다 다른 잡다한 필드까지 통째로 보존.
   나중에 새 항목이 필요하면 `raw` 에서 꺼내 컬럼으로 승격하면 되고, 원본은 절대 잃지 않는다.
4. **중복 없이 갱신(UPSERT)** — `(source, source_job_id)` 유일키. 매일 재크롤링해도 같은 공고는
   덮어쓰기만 한다. 사이트가 ID 를 안 주면 `source_url` 해시로 `source_job_id` 를 만든다.
5. **이력/만료** — `first_seen_at`(최초 수집), `last_crawled_at`(최근 갱신), `is_active`(마감 표시).

> 사람인 공식 API 는 목록 메타(제목/회사/경력/학력/급여/마감/직무코드/키워드)만 주고
> 자격요건·우대사항·전형절차·제출서류 같은 **상세 본문은 제공하지 않는다** → 해당 컬럼은 NULL.
> 이 상세들은 HTML 스크레이핑 어댑터(잡코리아·인크루트 등)에서 채운다.

## 실행

### A. 매일 자동 (권장 — 컨테이너 상시 데몬)
```bash
cd ~/E-LIFETHON/InterviewForge/crawler
cp .env.example .env          # 이미 있으면 생략. SARAMIN_API_KEY 채우기
docker compose up -d --build  # 부팅 즉시 1회 + 매일 05:00(KST) 자동 실행
docker logs -f interviewforge-crawler
```

### B. 수동 1회 (호스트 venv)
```bash
cd ~/E-LIFETHON/InterviewForge/crawler
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# 호스트에서 직접 붙을 땐 localhost 로:
DATABASE_URL=postgresql://interviewforge:life0635@localhost:5434/interviewforge \
  python -m crawler run
```

### C. 호스트 cron 으로 매일 (컨테이너 대신)
```cron
0 5 * * * cd /home/ewhaian/E-LIFETHON/crawler && docker compose run --rm crawler python -m crawler run >> /var/log/if-crawler.log 2>&1
```

## 새 사이트 어댑터 추가하기
1. `crawler/adapters/<site>.py` 에 `Adapter` 상속 클래스 작성, `fetch()` 가 `list[JobPosting]` 반환.
2. `source`(=칩에 보일 키), `label`(한글 이름), `enabled = True` 설정.
3. `crawler/adapters/__init__.py` 의 `ALL_ADAPTERS` 에 등록.
4. `python -m crawler run` 으로 검증. 한 어댑터가 예외를 던져도 나머지는 계속 수집된다.

## 현재 상태 (실측 기준)

동작 확인됨(enabled=True, 실제 수집·DB 저장 검증) — **8개 사이트**:

| 사이트 | 방식 | 수집 항목 |
|---|---|---|
| 사람인 `saramin` | 검색 HTML(키 불필요) | 제목·회사·지역·경력·학력·고용형태·마감·직무 |
| 원티드 `wanted` | 내부 JSON API | 위 + **자격요건·우대사항·복지·본문**(풍부) |
| 잡코리아 `jobkorea` | 목록 HTML | 제목·회사·마감 |
| 인크루트 `incruit` | 검색 HTML(euc-kr) | 제목·링크(회사 추후) |
| 피플앤잡 `peoplenjob` | 목록 HTML | 제목·링크(회사 추후) |
| 링커리어 `linkareer` | Playwright 렌더 | 제목·링크 |
| 슈퍼루키 `superookie` | Playwright 렌더 | 제목·경력·마감 |
| 자소설닷컴 `jasoseol` | Playwright 렌더 | 회사/공고·링크 |

보류(enabled=False — 로그인/내부 API 분석 필요):
- 🔴 **로켓펀치**: 목록이 인터랙션 후 XHR 로드(내부 API 분석 필요)
- 🔴 **잡플래닛**: 403 + 로그인 필요
- 🟡 **그룹바이**: SPA 내부 API 분석 필요

헤드리스 어댑터(링커리어/슈퍼루키/자소설)는 **Playwright + 크로미움**을 쓴다 → Dockerfile 이
`mcr.microsoft.com/playwright/python` 베이스라 컨테이너엔 이미 포함. (호스트 venv 실행 시엔
`python -m playwright install chromium` 한 번 필요)

> 인크루트/피플앤잡 회사명, 잡코리아/사람인 상세(자격요건·전형·서류 등)는 상세 페이지 파싱으로
> 점차 보강 가능. 1차 목표(출처별 공고 + 원본 링크 집계 + 자동화)는 달성.
