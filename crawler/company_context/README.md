# company_context — 레지스트리 기반 회사 컨텍스트 수집기

손수 돌리던 SK하이닉스 전용 파이프라인(`sandbox/scripts/sk_*.py`)을 **회사 비종속**으로 일반화한
패키지. 회사를 추가하려면 **코드가 아니라 `registry.py` 항목 하나**만 더하면 된다.
출력은 단일 테이블 `public.company_contexts`(스키마는 이미 존재; 이 패키지는 INSERT/SELECT 만).

```
company_context/
  registry.py   회사 → 소스 매핑(단일 진실 공급원) + slugify_company()
  engine.py     회사 비종속 코어: fetch_clean / exaone_extract / grounding / insert_rows / db url
  run.py        CLI 드라이버 (--company / --top N / --jit / --drain)
  persona.sh    운영 관리(install/uninstall/status/drain/sweep/logs) — deploy.sh 같은 단일 진입점
  README.md     이 문서
```

## 실행

항상 crawler 디렉터리의 venv 로 실행한다(`pip install` 금지).

```bash
cd /home/ewhaian/E-LIFETHON/InterviewForge/crawler

# 1) 등록 회사 1곳 (기본 DRY-RUN = PLAN, 쓰기 없음)
.venv/bin/python -m company_context.run --company sk_hynix
.venv/bin/python -m company_context.run --company samsung_electronics

# 2) job_postings 빈도 상위 N개
#    - 레지스트리 항목 있는 회사 → 전체 소스(work_culture/official/external)
#    - 미등록 회사 → 회사명 쿼리로 external_news 만(회사 비종속). 무시/커버 카운트 로그 출력.
.venv/bin/python -m company_context.run --top 5

# 3) JIT (앱 on-demand): 사용자가 데이터 없는 회사를 고르면 서버가 호출.
.venv/bin/python -m company_context.run --jit "삼성전자"
.venv/bin/python -m company_context.run --jit "어떤회사"

# 실제 저장은 --execute 추가 (없으면 절대 쓰지 않음)
.venv/bin/python -m company_context.run --company sk_hynix --execute

# 빠른 PLAN 확인용 소스별 상한
.venv/bin/python -m company_context.run --top 5 --limit 2
```

종료 코드: 0 정상, 4 입력/DB 문제(미등록 키, 빈 결과 등).

## 회사 추가 방법 (코드 수정 불필요)

`registry.py` 의 `REGISTRY` 리스트에 항목을 하나 더한다:

```python
{
  "company_key": slugify_company("새회사"),   # 또는 큐레이션 키 직접 지정
  "display_name": "새회사",
  "aliases": ["새회사", "New Co", ...],          # 표기 흔들림 흡수
  "work_culture":      {"url": "...", "source_name": "...", "title": "...",
                        "selectors": {"culture_hints": [...]},
                        "prompt_version": "newco-work-culture-v1"} | None,
  "official_articles": {"tag_url": "...", "source_name": "...",
                        "list_item_selector": "article.item",
                        "body_selector": "div.post-body",
                        "since": "2025-01-01",
                        "prompt_version": "newco-official-article-v1"} | None,
  "external_news":     {"query": "새회사", "media": ["yna","hankyung","mk","donga","hani","chosun","khan"],
                        "subject_keys": ["새회사", ...],
                        "prompt_version": "newco-external-news-v1"},
}
```

- `company_key` 는 `slugify_company()`(= 서버 TS `slugifyCompany` 와 동일: NFKC·소문자·
  `주식회사/(주)/㈜` 제거·영숫자/한글 외 → `_`)로 만들어 **파이프라인과 면접 어댑터가 같은 키**를 쓰게 한다.
- 설정하지 않은 소스(`None`)는 자동으로 건너뛴다. `external_news` 만 있어도 동작한다.

## 동작 규칙 (SK 스크립트에서 그대로 계승)

- **grounding**: 모든 `evidence`/`keyFacts`/`numbers.evidence` 는 정리된 원문의 verbatim
  substring(공백 정규화)이어야 한다. 통과 못 하는 항목은 버린다. 보수적 > 환각.
- **content_hash** = SHA-256(정리된 source_text). 중복은
  `ON CONFLICT (company_key, source_url, content_hash) DO NOTHING`.
- **단일 트랜잭션** INSERT + `company_ingest_runs` 한 줄 기록. 기본 PLAN(쓰기 없음), `--execute` 로만 쓴다.
- **견고성**: 한 회사/소스 실패가 전체 배치를 멈추지 않는다(catch → run note 기록 → 계속).
- robots/약관 존중, 로그인·유료 우회 없음, 기사 fetch 사이 정중한 지연(기본 3초; 검색은 1.5초).
- **DATABASE_URL/비밀번호/연결정보는 출력하지 않는다.**

## 서버에서 JIT 호출 (구현됨 — 명령 큐 방식)

면접 서버는 **Docker 컨테이너** 안에서 돌아 호스트의 이 파이프라인을 직접 exec 할 수 없다.
그래서 기존 `crawl_commands` 패턴처럼 **DB 큐(`company_ingest_requests`)로 분리**했다:

1. 앱(`companyContextAdapter.ts` → `enqueueCompanyIngest`)이 사용자가 고른 회사의
   `company_contexts` 행이 0건이면 `company_ingest_requests` 에 `pending` 한 줄 적재.
   - 회사당 `pending` 1건만 허용하는 부분 유니크 인덱스 → `ON CONFLICT DO NOTHING` 으로 **디바운스**.
   - 이번 면접은 즉시 resume-only 로 진행되고, **다음 면접부터** 페르소나 적용.
2. 호스트의 러너가 큐를 비운다(`--drain`):

```bash
cd /home/ewhaian/E-LIFETHON/InterviewForge/crawler
.venv/bin/python -m company_context.run --drain            # 대기 요청 미리보기(DRY-RUN)
.venv/bin/python -m company_context.run --drain --execute  # 실제 수집(요청별 done/failed 마감)
```

`--drain` 은 `pending` 요청을 `running` 으로 잠그고(동시 실행 안전: `FOR UPDATE SKIP LOCKED`)
회사명을 `resolve` 해 `--jit` 과 동일 경로로 수집한 뒤 `done`/`failed` 로 마감한다. 한 요청 실패가
다른 요청을 막지 않는다. 미등록 회사도 external_news 만이라도 채운다(best-effort, 0건 가능 → 앱은 resume-only fallback).

## 자동화 / 운영 — `persona.sh` (deploy.sh 처럼)

자동 수집은 **`persona.sh` 한 스크립트로 관리**한다(`crawler/company_context/persona.sh`).

```bash
./persona.sh install      # 자동 수집 cron 등록(하루 1회, 매일 04:00)
./persona.sh uninstall    # cron 해제(데이터·코드는 그대로)
./persona.sh status       # cron ON/OFF + 대기 큐 + 적재 회사수/행수/크기 + 최근 실행
./persona.sh daily [N]    # 지금 하루치 1회 실행(JIT 큐 + 미수집 상위 N곳, 기본 20)
./persona.sh drain        # 지금 JIT 큐만 1회 처리
./persona.sh sweep [N]    # 지금 공고 상위 N곳 1회(빈도순, 커버리지 무시 — 수동용)
./persona.sh company <키>  # 등록 회사 1곳 수집(예: samsung_electronics)
./persona.sh logs         # 수집 로그 tail
```

`install` 이 등록하는 cron — **하루 1회, 한 줄**:
```cron
0 4 * * *  … --daily 20 --execute       # 매일 04:00
```

### 하루치(`--daily N`)가 하는 일 — 회사 선정 기준
1. **JIT 큐 먼저(수요 기반)**: 사용자가 면접에서 고른 '데이터 없는 회사'(company_ingest_requests)를 전부 수집.
   보통 하루 0~수 건. **선정 기준 = 실제로 사람이 면접 본 회사.**
2. **미수집 실제기업 상위 N곳(공급 기반, 순환)**: `job_postings.company` 를 공고 많은 순으로 보되
   - 이미 데이터 있는 회사 / 최근 14일 내 시도한 회사 → **건너뜀**(매일 다른 회사로 순환, 중복 재시도 방지),
   - 명백한 헤드헌팅·서치펌 이름 → **건너뜀**(자사 채용이 아님),
   그중 **위에서부터 N곳**(기본 20)만 그날 수집. 다 훑고 나면 배치는 사실상 JIT 만 남아 비용이 0에 수렴한다.
   - **최종 필터 = "뉴스 있는 실제 기업"**: 뉴스가 없는 회사(대행사 등)는 EXAONE 전 게이트에서 0건으로 끝나
     비용이 거의 안 들고, 뉴스가 있는 회사만 페르소나가 채워진다(자가 필터링).

### "계속 도는 건가?" — 아니다(데몬 아님)
cron 은 **매일 04:00 명령을 1회 실행하고 종료**한다. 상주 프로세스/메모리 없음(잡 크롤러 데몬과 다름).
- 하루치 소요: JIT 큐 처리 + 최대 N=20곳 시도. 대행사는 빠른 0건(EXAONE 스킵), 실제기업만 EXAONE.
  대략 **20~40분**(오프피크 04:00라 라이브 면접의 Ollama 와 안 겹침).
- 며칠~몇 주에 걸쳐 보드의 실제 기업을 순환 수집 → 이후엔 JIT 위주로 하루 몇 분 이내.

### 리소스 / DB 증가량 (실측 기준)
- **DB**: 회사당 약 5행, **행당 ~3.6 KB**(source_text=핵심요약, extracted_data=작은 JSON; 기사 전문 미저장).
  → 회사 100곳 ≈ **~2 MB**, 500곳 ≈ **~10 MB**. (측정 시점 15개사 189행 = **736 KB**.)
  `ON CONFLICT (company_key, source_url, content_hash) DO NOTHING` 로 **중복 미적재** → 재실행해도 새 기사가
  생겼을 때만 늘어 증가가 완만하다. company_ingest_runs/requests 는 행 자체가 작고 운영용.
- **CPU/메모리**: cron 명령은 끝나면 사라짐(상주 0). 수집 1건당 python ~50~100 MB + Naver fetch 몇 회 +
  EXAONE(Ollama) 추론(채택 후보 수만큼). EXAONE 는 호스트의 기존 Ollama 를 공유(새 모델 안 띄움).
- **네트워크**: 회사당 Naver 검색 1회 + 채택 기사 상세 fetch. robots 준수, 기사 전문 미저장(저작권).

> 규모 조절: `PERSONA_DAILY_N=30 ./persona.sh install` 로 하루 N 변경. 끄려면 `./persona.sh uninstall`.

## 알려진 한계

- **정적 크롤러**라 JS 렌더링이 무거운 페이지는 본문을 못 가져온다.
  - 삼성전자 채용 페이지(`work_culture`)는 JS 셸일 가능성이 커서, 본문 미발견을 깔끔히 보고하고
    다음 소스로 넘어간다(에러로 배치를 멈추지 않음).
  - 삼성 뉴스룸(`news.samsung.com/kr`)은 인재/문화 전용 **정적 태그 목록**이 안정적이지 않아
    `official_articles` 를 `None` 으로 둔다(적합한 정적 태그 확인 시 sk_hynix 형태로 채우면 됨).
- **external_news discover 는 Naver 뉴스검색이 1순위**(`search.naver.com` → `n.news.naver.com` 정적 기사).
  - 각 매체 자체 검색 페이지(yna/hankyung/…)는 **JS 렌더라 쿼리와 무관하게 같은 기사**만 나와 회사별 수집이 안 됐다.
    그래서 Naver 통합검색을 1순위로 쓰고, 0건일 때만 (구) 매체검색으로 폴백한다. 언론사명은 기사 메타에서 추출.
  - 저작권상 기사 전문은 저장하지 않고 핵심사실 요약만 `source_text` 로 둔다. 검색 1페이지(약 10~19건)만 본다.
- 날짜 필터/시황·칼럼 제외 등 휴리스틱은 SK 스크립트 수준이며 매체 구조 변경에 취약할 수 있다.
```
