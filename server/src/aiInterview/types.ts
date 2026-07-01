// AI 모의면접(LangGraph) 진행에 필요한 타입 정의.
//
// sandbox(interview-graph-sandbox)에서 검증한 엔진을 InterviewForge 서버로 이식한 것.
//  - 입력은 resumeText(이력서 원문) + context(지원 직무/공고 요약)로 다룬다.
//    resumeText 는 resumes.extracted_text, context 는 users.jobs + job_postings 요약에서 만든다.
//  - 질문/평가/리포트의 실제 텍스트 생성은 interviewLLM.ts 가, 진행 순서/상태는 interviewGraph.ts 가 맡는다.

/** 면접 진행 상태. 완료되면 "completed". */
export type InterviewStatus = "in_progress" | "completed";

/** 질문 종류: 메인 질문 / 직전 답변을 파고드는 꼬리질문. 둘 다 질문 수에 포함한다. */
export type QuestionType = "main" | "followup";

/** 한 개의 면접 질문. */
export interface InterviewQuestion {
  /** 누적 질문 번호(1-base). 꼬리질문 포함, 면접 전체에서 유일. */
  index: number;
  type: QuestionType;
  /** 질문 텍스트. */
  question: string;
  /** 이 질문이 근거로 삼은 resumeText/context 상의 경험·역량·요건. */
  basis: string;
  /**
   * 이 질문이 다루는 "이력서 주제"의 식별자(같은 프로젝트/경험 반복 방지용 코드 키).
   *  - 예: "langgraph", "react", "t-크롤링". 같은 topicKey 메인 질문은 최대 2개까지만 허용.
   *  - 꼬리질문은 직전 메인 질문의 topicKey 를 물려받고, 주제별 횟수에는 포함하지 않는다.
   */
  topicKey: string;
  /**
   * 이 질문이 취한 "질문 관점"의 식별자(같은 각도 반복 방지용).
   *  - 예: "tech-choice", "design-impl". 메인 질문에만 부여(꼬리질문은 비움).
   */
  perspectiveKey?: string;
}

/**
 * 첫 메인 질문을 "회사 DB 자료"에 근거시키기 위한 앵커.
 *  - companyContextAdapter 가 DB 행에서 결정적으로 만들고, 첫 질문에만 쓰인다.
 *  - 질문 텍스트는 기존 generateInterviewQuestion 경로로 생성하되, 출력 근거(basis)는
 *    이 앵커의 사전 렌더 문자열(content_type 표시명·공식 항목명·실제 핵심 내용)을 그대로 쓴다.
 */
export interface CompanyAnchor {
  /** 근거가 된 DB content_type. */
  contentType: "work_culture" | "official_article" | "external_news";
  /** content_type 사용자 표시명(예: "공식 일하는 방식(Work Culture)"). */
  contentTypeLabel: string;
  /** 공식 항목명(예: "Bar Raising" / 직무명 / 기사 제목). */
  officialName: string;
  /** 실제 핵심 내용(설명/행동 기준/요구 역량/요약에서 뽑은 인용문). */
  coreContent: string;
  /** 질문 출력에 그대로 쓸 사전 렌더된 근거 문자열. */
  basis: string;
  /** 첫 질문 프롬프트에 넣을 회사 자료 텍스트(grounding source 겸용). */
  promptMaterial: string;
}

/** 답변 평가(0~100 점수 + 보조 필드). */
export interface AnswerEvaluation {
  /** 어떤 질문(InterviewQuestion.index)에 대한 평가인지. */
  questionIndex: number;
  /** 종합 점수(0-100). */
  score: number;
  /** 구체성(0-100). */
  specificity: number;
  /** resumeText 와의 일관성(0-100). */
  resumeConsistency: number;
  /** 문제 해결력(0-100). */
  problemSolving: number;
  /** 역할과 기여도의 명확성(0-100). */
  roleClarity: number;
  /** 답변 구조(0-100). */
  structure: number;
  /** 성과/결과를 수치/사실로 제시했는지 여부. */
  resultPresented: boolean;
  /** 꼬리질문이 필요한지(구체성·일관성이 약할 때 true). */
  needsFollowup: boolean;
  /** 강점 요약. */
  strengths: string[];
  /** 보완점. */
  improvements: string[];
  /** 평가 근거 한두 줄. */
  rationale: string;
}

/** 최종 리포트의 답변별 피드백 항목. */
export interface PerAnswerFeedback {
  index: number;
  question: string;
  feedback: string;
  score: number;
}

/** 최종 리포트. */
export interface FinalReport {
  summary: string;
  strengths: string[];
  improvements: string[];
  perAnswerFeedback: PerAnswerFeedback[];
  expectedQuestions: string[];
  nextSteps: string[];
}

/** LangGraph 가 관리하는 면접 상태. */
export interface InterviewState {
  interviewId: string;
  /** 이력서 원문(resumes.extracted_text). */
  resumeText: string;
  /** 지원 직무 + 겨냥한 공고 요약을 자연어로 직렬화한 추가 근거(없으면 ""). */
  context: string;
  /** 현재 사용자에게 던져진(답변 대기 중인) 질문. */
  currentQuestion: InterviewQuestion | null;
  /** 현재 질문에 대한 사용자의 답변. */
  currentAnswer: string | null;
  /** 지금까지 던진 모든 질문(메인+꼬리). */
  questionHistory: InterviewQuestion[];
  /** questionHistory 와 순서가 대응되는 답변들. */
  answerHistory: string[];
  /** 답변별 평가들. */
  evaluations: AnswerEvaluation[];
  /** 지금까지 던진 질문 수(꼬리질문 포함). */
  questionCount: number;
  /** 주제(topicKey)별 "메인 질문" 횟수. 값이 2 이상이면 소진된 주제로 보고 다음 메인 질문에서 제외. */
  topicCounts: Record<string, number>;
  /** 질문 관점(perspectiveKey)별 "메인 질문" 횟수. 값이 2 이상이면 소진된 관점으로 보고 제외. */
  perspectiveCounts: Record<string, number>;
  /** 최대 질문 수(기본 5). */
  maxQuestions: number;
  /** 면접 종료 시 생성되는 리포트. */
  finalReport: FinalReport | null;
  /** 첫 메인 질문을 회사 DB 자료에 근거시키는 앵커(없으면 null → 기존 흐름). */
  companyAnchor: CompanyAnchor | null;
  status: InterviewStatus;
}

// ── 공개 API 의 입출력 타입 ────────────────────────────────────────────────

/** startInterview 입력. */
export interface StartInterviewInput {
  resumeText: string;
  /** 지원 직무/공고 요약(선택). 질문 grounding 의 추가 근거로 쓰인다. */
  context?: string;
  /** 첫 메인 질문을 회사 DB 자료에 근거시키는 앵커(선택). 없으면 기존 resume-only 흐름. */
  companyAnchor?: CompanyAnchor;
  /** 최대 질문 수(선택, 기본 5). */
  maxQuestions?: number;
}

/** startInterview 결과. */
export interface StartInterviewResult {
  interviewId: string;
  status: InterviewStatus;
  question: InterviewQuestion;
}

/** submitAnswer 입력. */
export interface SubmitAnswerInput {
  interviewId: string;
  answer: string;
}

/** submitAnswer 결과. */
export interface SubmitAnswerResult {
  interviewId: string;
  status: InterviewStatus;
  evaluation: AnswerEvaluation;
  nextQuestion?: InterviewQuestion;
  finalReport?: FinalReport;
}
