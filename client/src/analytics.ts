// 커스텀 이벤트 추적 헬퍼.
// autocapture(페이지뷰·일반 클릭)로는 구분되지 않는 InterviewForge 고유 행동
// (이력서 업로드 / 모의면접 시작·완료 / 채용공고 원문 클릭 등)을 명시적으로 기록한다.
// 이벤트 이름과 속성을 이 파일 한곳에서 관리해 대시보드 분석 시 일관성을 유지한다.
import * as amplitude from "@amplitude/unified";

// 대시보드에서 필터/그룹할 이벤트 이름 상수. 문자열 오타로 이벤트가 갈라지는 걸 막는다.
export const Events = {
  RESUME_UPLOAD: "이력서 업로드",
  RESUME_REANALYZE: "이력서 재분석",
  JOB_DETAIL_VIEW: "공고 상세 조회",
  JOB_RECOMMEND_VIEW: "추천공고 조회",
  JOB_SEARCH: "공고 검색",
  JOB_SOURCE_CLICK: "채용공고 원문 클릭",
  INTERVIEW_START: "모의면접 시작",
  INTERVIEW_ANSWER: "면접 답변 제출",
  INTERVIEW_COMPLETE: "모의면접 완료",
  RECORDING_SAVE: "면접 녹화 저장",
} as const;

type EventName = (typeof Events)[keyof typeof Events];

// 이벤트 전송. amplitude 초기화 이전에 호출돼도 SDK 내부 큐가 처리하므로 안전하다.
export function track(event: EventName, props?: Record<string, unknown>): void {
  amplitude.track(event, props);
}

// 로그인 사용자와 이벤트를 연결한다(비로그인 시 null 로 익명 처리).
// 개인정보를 줄이기 위해 이메일이 아닌 내부 사용자 id 만 식별자로 쓴다.
export function identify(userId: number | null): void {
  amplitude.setUserId(userId == null ? undefined : String(userId));
}
