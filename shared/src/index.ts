// client 와 server 가 함께 쓰는 타입을 여기에 둔다.
// 예: API 응답 형태를 한 번만 정의해서 양쪽에서 import → 타입 불일치 방지.

export interface HealthResponse {
  ok: boolean;
}

// ── 인증(Auth) ─────────────────────────────────────────────────────────────
// 클라이언트에 노출해도 되는 사용자 정보(비밀번호 제외).
export interface PublicUser {
  id: number;
  email: string;
  nickname: string;
  jobs: string[];
  is_verified: boolean;
  is_admin: boolean; // 마스터(관리자) 계정 여부 — 일반 가입자는 항상 false
  created_at: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  nickname: string;
  jobs: string[]; // 최소 1개
}

// 회원가입 직후 응답: 인증 메일을 보냈다는 안내.
export interface RegisterResponse {
  ok: true;
  message: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  ok: true;
  user: PublicUser;
}

export interface MeResponse {
  user: PublicUser | null;
}

// 모든 인증 API 의 공통 에러 형태.
export interface AuthError {
  ok: false;
  error: string;
}

// ── 채용 공고(크롤러가 채우는 job_postings 를 화면에 노출) ─────────────────
export interface JobPosting {
  id: number;
  source: string; // 출처 키(칩 라벨용): saramin, wanted, …
  source_url: string; // 원본 링크
  title: string;
  company: string | null;
  location: string | null;
  employment_type: string | null;
  experience_level: string | null;
  education: string | null;
  salary: string | null;
  job_categories: string[];
  skills: string[];
  posted_at: string | null;
  deadline: string | null;
  deadline_text: string | null;
  qualifications: string | null;
  preferred: string | null;
  hiring_process: string | null;
  documents: string | null;
  benefits: string | null;
  description: string | null;
  detail_fetched: boolean; // true면 상세까지 수집(빈 항목=실제 없음), false면 미수집(unknown)
  ai_summary: string | null; // 로컬 LLM이 정리한 마크다운 요약
}

export interface JobsResponse {
  items: JobPosting[];
  total: number;
  sources: string[]; // 현재 DB에 존재하는 출처 목록(필터칩용)
}

// 추천 공고: 공고 + 유사도 점수(0~1, 높을수록 적합).
export interface RecommendedJob extends JobPosting {
  score: number;
}

export interface RecommendedJobsResponse {
  items: RecommendedJob[];
  basedOn: {
    roles: string[]; // 추천에 사용된 직무
    resumeUsed: boolean; // 이력서 프로필 반영 여부
    method: "semantic" | "keyword"; // 임베딩 의미검색 / 키워드 폴백
  };
}

// ── 관리자: 사이트별 크롤링 설정 ───────────────────────────────────────────
// 마스터(is_admin) 계정만 조회·수정할 수 있다. 크롤러(파이썬 데몬)가 이 값을 읽어
// 사이트마다 정해진 주기로 자동 수집하거나(auto), 수동 실행만 받거나(manual),
// 비활성(enabled=false)이면 건너뛴다.
export type CrawlMode = "auto" | "manual";

export interface CrawlSetting {
  source: string; // 출처 키(saramin, wanted, …)
  label: string; // 사람이 읽는 이름(사람인 등)
  implemented: boolean; // 어댑터가 실제 구현돼 있는지(false면 켜도 수집 안 됨)
  interval_hours: number; // 자동 수집 주기(시간). auto 모드에서만 의미.
  mode: CrawlMode; // auto: 주기마다 자동 / manual: 수동 실행만
  enabled: boolean; // false면 자동·수동 모두 건너뜀(비활성화)
  last_run_at: string | null; // 마지막 수집 시각(ISO)
  next_run_at: string | null; // 다음 예정 시각(auto·enabled일 때만 계산)
  last_status: string | null; // 마지막 실행 결과 요약
  pending: boolean; // 수동 실행이 큐에 걸려 처리 대기/진행 중인지
}

export interface CrawlSettingsResponse {
  items: CrawlSetting[];
}

// ── 면접 연습 녹화(면접 기록) ──────────────────────────────────────────────
// 사용자가 면접 연습 화면에서 녹화한 영상과, 말한 내용을 실시간 변환한 자막(transcript)을
// 보관한다. 영상 바이트는 DB(BYTEA)에 함께 저장하고, 목록·재생은 아래 API 로 노출한다.
export interface InterviewRecording {
  id: number;
  title: string; // 사용자가 붙인 제목(없으면 날짜 기반 자동 제목)
  transcript: string; // 음성→텍스트 변환 결과(말한 내용 전체)
  duration_sec: number; // 녹화 길이(초)
  mime_type: string; // 예: video/webm
  size_bytes: number; // 영상 파일 크기
  created_at: string; // 생성 시각(ISO)
  interview_report: InterviewReport | null; // AI 모의면접으로 녹화했을 때의 질문·평가·리포트(아니면 null)
}

export interface RecordingsResponse {
  items: InterviewRecording[];
}

// ── 이력서 피드백(이력서 PDF 업로드·보관) ──────────────────────────────────
// 사용자가 올린 이력서 PDF 와, 추후 생성될 AI 피드백을 보관한다.
// 로컬 LLM 이 이력서 원문에서 뽑아낸 구조화 프로필.
// 면접 질문 생성·공고 추천의 공용 입력으로 재사용한다.
export interface ResumeProfile {
  summary: string; // 한 줄 요약
  roles: string[]; // 직무(예: 백엔드 개발자)
  skills: string[]; // 기술/역량
  years: number | null; // 총 경력 연수(모르면 null)
  domains: string[]; // 산업/도메인
  strengths: string[]; // 강점
  weaknesses: string[]; // 보완점
  keywords: string[]; // 매칭용 키워드
}

export type AnalysisStatus = "pending" | "processing" | "done" | "error";

export interface Resume {
  id: number;
  filename: string; // 원본 파일명
  mime_type: string; // application/pdf
  size_bytes: number;
  extracted_chars: number; // PDF 에서 추출한 원문 글자 수(추출 실패 시 0)
  analysis_status: AnalysisStatus; // 분석 진행 상태
  analysis: ResumeProfile | null; // 구조화 분석 결과(완료 전 null)
  feedback: string | null; // 마크다운 피드백(완료 전 null)
  analyzed_at: string | null; // 분석 완료 시각(ISO) 또는 null
  created_at: string; // 생성 시각(ISO)
}

export interface ResumesResponse {
  items: Resume[];
}

// ── 면접 예상 질문 ──────────────────────────────────────────────────────────
export interface InterviewQuestion {
  category: string; // 지원동기 / 직무역량 / 기술 / 경험기반 / 인성
  question: string;
  intent: string; // 이 질문이 평가하려는 포인트(없으면 빈 문자열)
}

export interface InterviewQuestionsRequest {
  resumeId?: number; // 생략 시 가장 최근 분석된 이력서를 사용
  jobId?: number; // 특정 채용 공고를 겨냥할 때
  count?: number; // 생성 개수(기본 8, 3~15)
}

export interface InterviewQuestionsResponse {
  questions: InterviewQuestion[];
  basedOn: {
    roles: string[]; // 질문 생성에 사용된 직무
    resumeUsed: boolean; // 이력서 프로필 반영 여부
    jobTitle: string | null; // 겨냥한 공고 제목(있으면)
  };
}

// ── AI 모의면접 (LangGraph 상호작용형) ──────────────────────────────────────
// 이력서 원문 + 직무/공고를 근거로 첫 질문을 만들고, 사용자의 답변(자막)을 평가해
// 논리를 파고드는 꼬리질문 또는 다음 질문을 이어가며, 끝나면 최종 리포트를 낸다.
// 서버 server/src/aiInterview 의 LangGraph 엔진 타입과 구조가 1:1 로 대응한다.
export type AiQuestionType = "main" | "followup"; // 메인 질문 / 직전 답변을 파고드는 꼬리질문

export interface AiInterviewQuestion {
  index: number; // 누적 질문 번호(1-base, 꼬리질문 포함)
  type: AiQuestionType;
  question: string;
  basis: string; // 이 질문이 근거로 삼은 이력서/공고 상의 경험·요건
}

export interface AiAnswerEvaluation {
  questionIndex: number;
  score: number; // 종합(0-100)
  specificity: number; // 구체성
  resumeConsistency: number; // 이력서 일관성
  problemSolving: number; // 문제 해결력
  roleClarity: number; // 역할/기여도 명확성
  structure: number; // 답변 구조
  resultPresented: boolean; // 성과를 수치/사실로 제시했는지
  needsFollowup: boolean; // 모델이 본 꼬리질문 필요 여부(참고용)
  strengths: string[];
  improvements: string[];
  rationale: string; // 평가 근거
}

export interface AiPerAnswerFeedback {
  index: number;
  question: string;
  feedback: string;
  score: number;
}

export interface AiFinalReport {
  summary: string;
  strengths: string[];
  improvements: string[];
  perAnswerFeedback: AiPerAnswerFeedback[];
  expectedQuestions: string[]; // 더 준비하면 좋은 예상 질문
  nextSteps: string[]; // 다음 면접 준비 조언
}

/** 어떤 정보로 면접을 시작했는지(이력서/공고 요약). */
export interface AiInterviewBasedOn {
  roles: string[];
  resumeUsed: boolean;
  /** 사용한 이력서 파일명(있으면). 리포트에 "이력서: 파일명" 으로 표시. */
  resumeName?: string | null;
  jobTitle: string | null;
  /** 겨냥한 공고의 회사명(없으면 null). */
  companyName?: string | null;
  /** 회사 페르소나(회사 DB 자료 기반 첫 질문 앵커)가 실제로 적용됐는지. */
  personaApplied?: boolean;
}

export interface StartAiInterviewRequest {
  resumeId?: number; // 생략 시 가장 최근 분석된 이력서 원문 사용
  jobId?: number; // 특정 채용 공고를 겨냥할 때
  role?: string; // 면접 볼 직무(users.jobs 중 하나). 생략 시 등록된 직무 전체를 근거로 사용
  maxQuestions?: number; // 3~8, 기본 5
}

export interface StartAiInterviewResponse {
  interviewId: string;
  status: "in_progress" | "completed";
  question: AiInterviewQuestion; // 첫 질문(main)
  basedOn: AiInterviewBasedOn;
}

export interface AiAnswerRequest {
  answer: string; // 자막에서 잘라낸 직전 질문에 대한 답변
}

export interface AiAnswerResponse {
  interviewId: string;
  status: "in_progress" | "completed";
  evaluation: AiAnswerEvaluation; // 방금 답변에 대한 평가
  nextQuestion?: AiInterviewQuestion; // 진행 중일 때: 다음 질문(꼬리 또는 메인)
  finalReport?: AiFinalReport; // 끝났을 때: 최종 리포트
}

// 면접 기록(녹화)에 함께 저장하는 AI 모의면접 결과. 녹화 업로드 시 JSON 으로 동봉한다.
export interface InterviewReport {
  questions: AiInterviewQuestion[]; // 실제로 진행된 질문들(메인+꼬리)
  answers: string[]; // questions 와 순서가 대응되는 답변(자막)
  evaluations: AiAnswerEvaluation[]; // 답변별 평가
  finalReport: AiFinalReport | null; // 최종 리포트(중간 종료면 null)
  basedOn?: AiInterviewBasedOn; // 어떤 이력서/공고로 시작했는지
  composure?: ComposureReport; // 평정심(압박 대응력) 분석(타이밍+말+영상). 없으면 미측정.
}

// ── 평정심 점수 리포트 ────────────────────────────────────────────────────
// 답변 지연·채움말·회피 + 영상(눈 떨림·시선·표정·고개)을 종합해 압박 상황 대응력을 정량화한다.
// 모든 신호는 브라우저에서 계산되며(영상은 MediaPipe FaceLandmarker), 서버는 이 JSON 을 그대로 보관한다.
export interface ComposureSubScore {
  key:
    | "responseDelay" // 응답 지연(생각하느라 멈춘 시간)
    | "fluency" // 유창성(채움말·말더듬 적음)
    | "engagement" // 답변 충실도(회피/짧은답 적음)
    | "gaze" // 시선 안정(카메라 응시 유지)
    | "eyeStability" // 눈 안정(눈 떨림·과도한 깜빡임 적음)
    | "posture"; // 자세 안정(고개 흔들림 적음)
  label: string; // 사람이 읽는 항목명
  score: number; // 0~100 (높을수록 안정)
  detail: string; // 근거 한 줄(측정 수치 기반)
  measured: boolean; // 실제 측정됐는지(영상/STT 미지원 시 false → 총점에서 제외)
}

export interface ComposureReport {
  overall: number; // 0~100 종합 평정심 점수(측정된 항목 가중평균)
  grade: "안정" | "보통" | "긴장"; // 한눈에 보는 등급
  subs: ComposureSubScore[]; // 세부 항목
  metrics: {
    // 원자료(디버그·상세 표시용). 미측정은 null.
    avgResponseDelayMs: number | null; // 질문 표시 → 첫 발화까지 평균(ms, 읽는 시간 포함 원값)
    maxResponseDelayMs: number | null;
    avgThinkingDelayMs: number | null; // 위에서 '질문 읽는 시간(길이 기반 추정)'을 뺀 순수 생각/머뭇 시간(점수 기준)
    fillerPerMin: number | null; // 분당 채움말(음/어/그…)
    fillerCount: number | null;
    avgAnswerChars: number | null; // 답변 평균 길이(회피 지표)
    speakingCharsPerSec: number | null; // 발화 속도
    faceMeasured: boolean; // 얼굴 인식이 됐는지
    facePresencePct: number | null; // 녹화 중 얼굴이 잡힌 비율
    blinkPerMin: number | null; // 분당 깜빡임
    eyeJitter: number | null; // 눈 떨림 지표(0~1, 낮을수록 안정)
    gazeAwayPct: number | null; // 시선이 정면을 벗어난 비율(0~1)
    headJitter: number | null; // 고개 흔들림 지표(0~1, 낮을수록 안정)
    tension: number | null; // 표정 긴장도(0~1, 낮을수록 편안)
  };
  perAnswer: {
    index: number;
    responseDelayMs: number | null;
    answerChars: number;
    fillerCount: number;
    eyeJitter: number | null;
    gazeAwayPct: number | null;
  }[];
  notes: string[]; // 코칭 코멘트(예: "생각이 길어질 때 눈 깜빡임이 늘어요")
}

