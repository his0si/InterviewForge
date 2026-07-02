#!/usr/bin/env python3
"""데모/발표용 Amplitude 목업 이벤트 시더.

Amplitude HTTP API(/2/httpapi)로 커스텀 이벤트 샘플을 직접 주입해, 데이터가 없어 비어 보이는
대시보드에 바로 차트를 그릴 수 있게 한다. 실제 사용자 데이터가 쌓이기 전 발표 시연용.

- 모든 이벤트에 event_property `is_mock: true` + user_id `mock-user-XX` 를 달아 실제 데이터와 구분/필터 가능.
- API 키는 소스에 하드코딩하지 않고 환경변수에서 읽는다.

사용법:
    VITE_AMPLITUDE_API_KEY=xxxx python3 scripts/seed_amplitude_mock.py
    # 또는 인자로:  python3 scripts/seed_amplitude_mock.py <API_KEY>

실제 데이터만 보려면 차트 세그먼트에 필터 `is_mock 는 true 가 아님` 을 건다.
목업을 완전히 지우려면 Amplitude User Privacy API 로 mock-user-* 유저를 삭제한다.
"""
import json, os, sys, time, random, urllib.request

API_KEY = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VITE_AMPLITUDE_API_KEY", "")).strip()
if not API_KEY:
    sys.exit("API 키가 없습니다. VITE_AMPLITUDE_API_KEY 환경변수나 첫 번째 인자로 넘기세요.")

URL = "https://api2.amplitude.com/2/httpapi"
NOW = int(time.time() * 1000)
WEEK = 7 * 24 * 3600 * 1000
random.seed(42)

companies = ["삼성전자", "네이버", "카카오", "쿠팡", "토스", "LG전자", "배달의민족", "당근마켓", "라인", "우아한형제들"]
sources = ["잡코리아", "원티드", "사람인", "슈퍼루키", "인크루트"]
roles = ["프론트엔드 개발자", "백엔드 개발자", "데이터 분석가", "PM", "디자이너"]
queries = ["프론트엔드", "백엔드 신입", "데이터", "AI", "React", "인턴", "마케팅"]

# (이벤트, 대략 발생 횟수) — 막대그래프/퍼널이 보기 좋게 차등 분포
plan = [
    ("공고 상세 조회", 120),
    ("면접 답변 제출", 92),
    ("공고 검색", 60),
    ("모의면접 시작", 40),
    ("추천공고 조회", 35),
    ("채용공고 원문 클릭", 30),
    ("이력서 업로드", 25),
    ("모의면접 완료", 22),
    ("면접 녹화 저장", 18),
    ("이력서 재분석", 10),
]


def props(ev):
    p = {"is_mock": True}
    if ev in ("공고 상세 조회", "채용공고 원문 클릭"):
        p |= {"source": random.choice(sources), "company": random.choice(companies), "jobTitle": random.choice(roles) + " 채용"}
    elif ev == "공고 검색":
        p |= {"query": random.choice(queries)}
    elif ev == "모의면접 시작":
        p |= {"role": random.choice(roles), "hasResume": random.random() < 0.6, "fromJob": random.random() < 0.5, "company": random.choice(companies)}
    elif ev == "면접 답변 제출":
        p |= {"questionIndex": random.randint(0, 4), "answerChars": random.randint(80, 600)}
    elif ev == "모의면접 완료":
        p |= {"totalQuestions": 5}
    elif ev == "면접 녹화 저장":
        p |= {"durationSec": random.randint(120, 600)}
    elif ev == "이력서 업로드":
        p |= {"sizeKb": random.randint(80, 900)}
    return p


events = []
for ev, n in plan:
    for _ in range(n):
        u = random.randint(1, 18)
        events.append({
            "user_id": f"mock-user-{u:02d}",
            "device_id": f"mock-device-{u:02d}",
            "event_type": ev,
            "time": NOW - random.randint(0, WEEK),
            "event_properties": props(ev),
            "platform": "Web",
            "os_name": "Chrome",
            "country": "South Korea",
        })
random.shuffle(events)
print(f"생성한 목업 이벤트: {len(events)}개 (유저 18명, 최근 7일 분포)")

ingested = 0
for i in range(0, len(events), 100):
    body = json.dumps({"api_key": API_KEY, "events": events[i:i + 100]}).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    try:
        res = json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
        ingested += res.get("events_ingested", 0)
        print(f"  배치 {i // 100 + 1}: code={res.get('code')} ingested={res.get('events_ingested')}")
    except Exception as e:
        print(f"  배치 {i // 100 + 1} 실패: {e}")
    time.sleep(1)
print(f"\n총 수집(ingested): {ingested}개")
