// 면접 "텍스트 생성" 계층 — 질문 / 평가 / 꼬리질문 / 리포트.
//
//  - interviewGraph.ts(LangGraph)는 "언제 무엇을 호출할지(진행 순서/상태)"만 결정한다.
//  - 이 파일은 "실제 텍스트 생성"만 책임진다. 프롬프트가 모두 여기에 격리돼 있다.
//  - 로컬 Ollama(EXAONE 3.5)만 사용한다(서버 공용 ../ollama.js). 외부 API 키 불필요.
//  - 질문/평가는 resumeText(이력서 원문)와 context(지원 직무/공고 요약)를 근거로 한다.
//
// 반복 방지(코드 레벨):
//  - resumeTopics: 같은 프로젝트/경험을 메인 질문으로 최대 2회까지만(주제 반복 방지).
//  - questionPerspectives: 같은 "묻는 각도"(기술 선택 이유 등)를 최대 2회까지만(관점 반복 방지).
//
// mock 모드:
//  - INTERVIEW_LLM_MOCK=1 이면 Ollama 를 호출하지 않고 결정적인 더미 응답을 낸다(흐름만 검증).

import { generateJson, OllamaJsonError } from "../ollama.js";
import { checkQuestionGrounding, pickResumeAnchor } from "./questionGuard.js";
import {
  classifyQuestionTopic,
  exhaustedTopics,
  unusedTopics,
  type ResumeTopic,
} from "./resumeTopics.js";
import {
  availablePerspectives,
  classifyQuestionPerspective,
  exhaustedPerspectives,
  type QuestionPerspective,
} from "./questionPerspectives.js";
import type { AnswerEvaluation, FinalReport, InterviewQuestion } from "./types.js";

/** mock 모드 여부(모델 없이 그래프만 테스트). */
export const isMockMode = process.env.INTERVIEW_LLM_MOCK === "1";

// 압박면접 톤이되 무례/공격적이지 않게 하는 공통 지침.
const TONE = "정중하지만 날카롭게, 압박면접처럼 답변을 깊게 파고든다. 무례·공격적 표현은 쓰지 않는다.";

// 모든 프롬프트가 공유하는 "날카로운 면접관" 행동 지침.
const INTERVIEWER_GUIDE = [
  `[면접관 지침]`,
  `- 답변을 그대로 믿지 말고 resumeText 와 대조해 사실을 검증한다.`,
  `- 한 번에 검증 포인트 하나만 묻는다.`,
  `- "우리/팀에서/열심히/좋은 결과" 같은 모호한 표현이 나오면 본인의 구체적 역할과 측정 가능한 결과를 분리해 요구한다.`,
  `- 수치가 나오면 측정 기준·개선 전후·본인 기여도를 확인한다.`,
  `- resumeText·context·answer 에 적힌 내용만 근거로 삼고, 없는 사실은 지어내지 않는다.`,
].join("\n");

// 모든 JSON 프롬프트가 공유하는 출력 규칙. 파싱 안정성을 높이기 위해 강하게 못박는다.
const JSON_RULES = [
  `[출력 규칙]`,
  `- 아래 형식의 JSON 하나만 출력한다. 코드펜스(\`\`\`)·설명·주석·여는말 등 다른 텍스트를 절대 붙이지 않는다.`,
  `- 모든 키와 문자열 값은 큰따옴표(")로 감싸고, 마지막 항목 뒤 쉼표(trailing comma)는 쓰지 않는다.`,
  `- 문자열 안에서는 줄바꿈 대신 공백을 쓰고, 내부 큰따옴표는 \\" 로 escape 한다.`,
  `- 명시된 키만 포함하고, 모든 키를 빠짐없이 채운다.`,
].join("\n");

// 질문을 "지어내지 않게" 강제하는 공통 "사실성" 근거 규칙(main·followup 질문 생성이 공유).
const GROUNDING_RULES = [
  `[근거 규칙 — 가장 중요. 위반하면 실패한 질문이다]`,
  `- 질문은 "실제로 적힌 사실"만 근거로 한다(main: resumeText + 지원 직무/공고, followup: resumeText + 직전 answer).`,
  `- resumeText·지원 직무/공고에 없는 성과·분석·판단·식별·최적화·전략 수립·의사결정·문제 해결 과정을 지어내지 않는다.`,
  `- 사용자가 적지 않은 일, 하지 않았다고 적은 일을 "했다"고 가정하지 않는다.`,
  `- resumeText 에 없는 도메인·수치·KPI 를 새로 추가하지 않는다(단, 지원 직무/공고에 적힌 요건은 "지원자가 그 역량을 갖췄는지" 묻는 근거로 쓸 수 있다).`,
  `- 질문 안의 모든 명사(기능·기술·역할·도메인·성과)는 근거 문장(resumeText·지원 직무/공고 또는 answer)을 찾을 수 있어야 한다.`,
  `- 구체적으로 물을 근거가 부족하면, 적힌 사실 범위 안에서 "더 일반적인 질문"으로 후퇴한다(없는 구체 내용을 지어내는 것보다 낫다).`,
  `- basis 에도 지어낸 내용을 넣지 않는다. 반드시 실제로 적힌 문장/내용만 요약한다.`,
].join("\n");

// main 질문 전용 지침: resumeText 의 "아직 검증 안 된 새 경험/역량"을, 지원 직무 관점에서 여는 질문.
const MAIN_QUESTION_RULES = [
  `[main 질문 형식·자가점검]`,
  `- 질문은 다음 형식을 따른다: "resumeText 에 적힌 [구체적 경험/기능/역할]에 대해, [검증 포인트]를 설명해 주세요."`,
  `- 직전 답변을 더 캐묻지 말고, resumeText 에서 아직 검증하지 않은 "새" 경험/역량으로 주제를 연다(그 심화는 followup 의 몫).`,
  `- [직무가 프로젝트 "선택"을 좌우한다 — 가장 중요] 지원 직무가 주어지면, 그 직무의 핵심 역량을 가장 잘 검증할 수 있는 프로젝트/경험을 resumeText 전체에서 직접 찾아 고른다.`,
  `  · [기계적 선택 금지] resumeText 맨 앞이나 가장 눈에 띄는 프로젝트를 무조건 고르지 마라. 직무 적합성이 가장 높은 프로젝트를 고른다.`,
  `  · 각 직무의 신호 키워드가 가장 풍부한 프로젝트를 고른다:`,
  `    - 백엔드 개발자 → 서버/API, DB·스키마·쿼리, 비동기 큐·작업 처리(Celery·RabbitMQ 등), 데이터 파이프라인·크롤링·임베딩, 인프라(서버 구축·Nginx·Docker·SSL), 성능·트랜잭션·안정성, 결제·인증·정산. (FastAPI/Express/Postgres/Redis 등이 쓰인 프로젝트)`,
  `    - 프론트엔드 개발자 → 화면·컴포넌트 설계, 상태 관리, 렌더링·성능, 접근성, 사용자 상호작용·UX. (React/Next.js 등 화면 구현 중심 프로젝트)`,
  `    - 그 외 직무도 그 직무의 핵심 역량 키워드가 풍부한 프로젝트를 고른다.`,
  `  · resumeText 에 "(Frontend)", "(Backend)", "(기획)" 처럼 성격이 표기돼 있으면 직무와 일치하는 표기를 우선한다. 백엔드 면접에서 "(Frontend)" 로만 표기·기술된 프로젝트는 피한다(직무에 맞는 다른 프로젝트가 있으면 그것을 고른다).`,
  `  · 프로젝트를 고른 뒤, 그 직무의 핵심 역량 관점에서 검증 포인트 하나를 캐묻는다. 같은 프로젝트라도 직무와 무관한 측면(백엔드 면접의 순수 UI/디자인 등)은 피한다.`,
  `  · 단, 반드시 resumeText 에 근거가 있는 범위에서만 묻는다. 직무에 맞는 프로젝트가 정말 하나도 없을 때만 일반적인 경험 검증으로 후퇴한다(없는 내용을 지어내지 말 것).`,
  `- 출력 전에 스스로 점검한다(하나라도 "아니오"면 질문을 버리고 다시 만든다):`,
  `  ① 이 질문의 모든 명사가 resumeText·지원 직무/공고에 근거가 있는가?`,
  `  ② 이 질문이 사용자가 실제로 "했다"고 적은 일에 대해 묻는가?`,
  `  ③ resumeText 에 없는 성과·판단·분석·식별을 끼워 넣지 않았는가?`,
  `  ④ 지원 직무가 있다면, 이 질문이 그 직무의 관점/핵심 역량에서 묻고 있는가?`,
  `  ⑤ basis 에 이 질문의 근거가 되는 resumeText/공고 문장을 짧게 요약했는가?`,
].join("\n");

// followup 질문 전용 지침: 직전 질문·직전 답변에서 드러난 "약점 하나"만 파고든다.
const FOLLOWUP_QUESTION_RULES = [
  `[followup 질문 형식·자가점검]`,
  `- 꼬리질문은 resumeText 와 "방금 answer 에 실제로 나온 표현"만 근거로 한다. answer 에 없는 행위·성과를 했다고 가정하지 않는다.`,
  `- 직전 질문과 직전 답변에서 드러난 "약점 하나"만 더 깊이 파고든다. resumeText 의 새 경험/주제로 넘어가지 않는다(그건 main 의 몫).`,
  `- [표현 인용 필수] 직전 answer 에 "실제로 적힌" 핵심 표현을 짧게 인용하거나 정확히 요약해 질문 첫머리에 둔다.`,
  `  · 나쁜 예: "특정 기능을 추가했다고 언급하셨습니다."  · 좋은 예: "답변 제출 후 버튼을 비활성화하고 '평가 중' 상태를 표시했다고 하셨는데..."`,
  `- [모호한 지시어 금지] "특정 기능", "해당 기술", "이러한 개선", "관련 기능", "어떤 요소" 처럼 대상이 불분명한 표현을 쓰지 않는다. 질문만 읽어도 무엇을 묻는지 알 수 있어야 한다.`,
  `- [이미 설명한 것 되묻기 금지] answer 에 이미 나온 내용을 "무엇을 했냐"고 다시 묻지 않는다. answer 에 여러 항목(예: 버튼 비활성화 / 평가 중 표시 / 오류 시 입력 유지)이 있으면 그중 하나를 골라 "구현 방식·판단 근거·본인 역할" 중 빠진 한 가지를 더 깊이 캐묻는다.`,
  `- [한 번에 하나] 직전 답변에서 가장 부족한 지점 "하나"만 묻는다. 여러 항목을 한 질문에 동시에 요구하지 않는다.`,
  `  · 구현 방식이 부족 → 어떻게 구현/관리했는지  · 본인 역할이 부족 → 본인이 직접 한 부분  · 판단 근거가 부족 → 왜 그 방식을 택했는지  · 결과 설명이 부족 → 어떤 사용자 문제를 줄이려 했는지`,
  `- [근거 없는 수치 요구 금지] 사용자가 실제 성과 측정·사용자 테스트를 했다고 말하지 않았다면 개선율·완료율·만족도·성공률·KPI·도입 전후 수치·피드백 통계를 요구하지 않는다.`,
  `  · 측정 데이터가 없으면 수치 대신 묻는다: "어떤 사용자 문제를 방지하려 했는가 / 정상 동작을 어떻게 확인했는가 / 어떤 오류 상황을 테스트했는가 / 향후 효과를 검증한다면 어떤 기준을 쓸 것인가".`,
  `  · 단, 직전 질문이 수치를 요구했는데 답변이 수치를 회피했거나, answer/resumeText 에 실제 측정값(예: 420ms, 91%)이 있거나, 사용자가 "측정 결과가 있다"고 말한 경우에는 수치를 다시 확인해도 된다.`,
  `- [전제 검증] 질문 전제가 직전 answer 에 실제로 존재하는 문장인지 먼저 확인한다. answer 에 없는 내용을 "말씀하셨다"고 표현하지 않는다.`,
  `- 출력 전에 스스로 점검한다(하나라도 "아니오"면 질문을 버리고 다시 만든다):`,
  `  ① 이 질문이 직전 answer 의 특정 표현을 인용·지목하는가(모호한 지시어가 아닌가)?`,
  `  ② answer 에 이미 설명된 내용을 그대로 되묻고 있지는 않은가?`,
  `  ③ resumeText·answer 에 없는 사실을 새로 지어내지 않았는가?`,
  `  ④ 부족한 지점 "하나"에만 집중하며, 측정하지 않은 성과(KPI·수치)를 근거 없이 요구하지 않는가?`,
  `  ⑤ basis 에 "어떤 표현을 인용해 어떤 약점을 파는지" 구체적으로 적었는가(막연한 평가 문구 금지)?`,
].join("\n");

/** context(지원 직무/공고)를 프롬프트 블록으로. 없으면 빈 배열(섹션 생략). */
function contextBlock(context: string): string[] {
  const c = context.trim();
  if (!c) return [];
  return [``, `# 지원 직무 / 겨냥한 공고 (직무 적합성 검증 근거)`, c];
}

/** 지금까지의 질문/답변/평가를 프롬프트용 텍스트로 직렬화. */
function transcriptText(
  questions: InterviewQuestion[],
  answers: string[],
  evaluations: AnswerEvaluation[]
): string {
  if (questions.length === 0) return "(아직 진행된 질문 없음)";
  return questions
    .map((q, i) => {
      const lines = [`Q${q.index} [${q.type}] ${q.question}  (근거: ${q.basis})`];
      if (answers[i]) lines.push(`A${q.index}: ${answers[i]}`);
      const ev = evaluations.find((e) => e.questionIndex === q.index);
      if (ev) lines.push(`평가: score=${ev.score}, 구체성=${ev.specificity}, 일관성=${ev.resumeConsistency}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/** "이미 충분히 다룬 검증 포인트" 판정 임계값(interviewGraph 의 FOLLOWUP_SCORE_THRESHOLD 와 동일한 70). */
const COVERED_THRESHOLD = 70;
const MIN_ANSWERED_LEN = 1;

interface CoverageSplit {
  covered: string[];
  weak: string[];
}

/** 지금까지의 질문/답변/평가를 훑어 검증 포인트를 "충분히 다룸 / 아직 부족"으로 분류한다. */
function splitCoverage(
  questions: InterviewQuestion[],
  answers: string[],
  evaluations: AnswerEvaluation[]
): CoverageSplit {
  const covered: string[] = [];
  const weak: string[] = [];
  questions.forEach((q, i) => {
    const answered = (answers[i] ?? "").trim().length >= MIN_ANSWERED_LEN;
    if (!answered) return;
    const ev = evaluations.find((e) => e.questionIndex === q.index);
    if (!ev) return;
    const label = `- ${q.basis} (Q${q.index} [${q.type}]: ${q.question})`;
    const sufficiently =
      ev.specificity >= COVERED_THRESHOLD &&
      ev.roleClarity >= COVERED_THRESHOLD &&
      ev.resumeConsistency >= COVERED_THRESHOLD;
    if (sufficiently) covered.push(label);
    else weak.push(label);
  });
  return { covered, weak };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) 메인 질문 생성 (첫 질문 포함)
// ─────────────────────────────────────────────────────────────────────────────
export interface QuestionGen {
  question: string;
  basis: string;
  /** 이 질문이 다루는 이력서 주제 식별자. 메인 질문 생성기는 항상 채운다(꼬리질문은 그래프가 물려줌). */
  topicKey?: string;
  /** 이 질문이 취한 "질문 관점" 식별자. 메인 질문 생성기는 항상 채운다. */
  perspectiveKey?: string;
}

type GenOpts = Parameters<typeof generateJson>[1];

/** QuestionGen 의 필수 필드(question/basis)를 보장한다. basis 가 비면 기본값으로 채운다. */
function normalizeQuestionGen(raw: Partial<QuestionGen> | null | undefined, fallbackQuestion: string): QuestionGen {
  const question = String(raw?.question ?? "").trim() || fallbackQuestion;
  const basis = String(raw?.basis ?? "").trim() || "resumeText 기반 경험 검증";
  return { question, basis };
}

/** grounding 일탈 시 2번째 시도에 덧붙이는 재생성 지시. 어떤 표현이 근거 밖이었는지 알려 준다. */
function buildRetryNote(ungrounded: string[], kind: "main" | "followup"): string {
  const src = kind === "main" ? "resumeText·지원 직무/공고" : "resumeText·직전 answer";
  return [
    `[재생성 지시 — 직전 시도가 근거를 벗어났습니다]`,
    `- 다음 표현은 ${src} 에서 근거를 찾을 수 없습니다: ${ungrounded.join(", ") || "(불명)"}`,
    `- 이 표현들을 빼고, ${src} 에 "실제로 적힌" 내용만으로 question 과 basis 를 다시 만드세요.`,
  ].join("\n");
}

/**
 * 질문을 생성하되 코드 가드(checkQuestionGrounding)로 grounding 을 한 번 검사한다.
 * 일탈이면 1회 재생성, 그래도 일탈이면 근거 안전한 fallback 질문을 반환한다.
 */
async function generateGuardedQuestion(params: {
  buildPrompt: (retryNote: string) => string;
  genOpts: GenOpts;
  sources: string[];
  kind: "main" | "followup";
  fallback: QuestionGen;
}): Promise<QuestionGen> {
  const { buildPrompt, genOpts, sources, kind, fallback } = params;
  let ungrounded: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryNote = attempt === 0 ? "" : buildRetryNote(ungrounded, kind);
    const qg = normalizeQuestionGen(
      await tryGenerateJson<Partial<QuestionGen>>(buildPrompt(retryNote), genOpts),
      fallback.question
    );
    const g = checkQuestionGrounding(qg.question, qg.basis, sources);
    if (!g.drifted) return qg;
    ungrounded = g.ungrounded;
    console.warn(
      `[aiInterview] ${kind} 질문이 근거에서 벗어남(attempt ${attempt + 1}/2): ` +
        `미근거 키워드=[${g.ungrounded.join(", ")}] → ${attempt === 0 ? "재생성" : "fallback 사용"}`
    );
  }
  return fallback;
}

export async function generateInterviewQuestion(input: {
  resumeText: string;
  context: string;
  previousQuestions: InterviewQuestion[];
  previousAnswers: string[];
  evaluations: AnswerEvaluation[];
  /** resumeText 에서 추출한 주제 카탈로그(그래프가 결정적으로 만들어 넘긴다). */
  topics: ResumeTopic[];
  /** 주제별 "메인 질문" 누적 횟수. 값이 2 이상인 주제는 소진된 것으로 본다. */
  topicCounts: Record<string, number>;
  /** 질문 관점별 "메인 질문" 누적 횟수. 값이 2 이상인 관점은 소진된 것으로 본다. */
  perspectiveCounts: Record<string, number>;
}): Promise<Required<QuestionGen>> {
  const { resumeText, context, previousQuestions, previousAnswers, evaluations, topics, topicCounts, perspectiveCounts } =
    input;

  const exhausted = exhaustedTopics(topics, topicCounts);
  const exhaustedKeys = new Set(exhausted.map((t) => t.key));
  const unused = unusedTopics(topics, topicCounts);

  // 질문 관점(이력서 주제와 별개로 "묻는 각도") 소진 현황.
  const exhaustedPersp = exhaustedPerspectives(perspectiveCounts);
  const exhaustedPerspKeys = new Set(exhaustedPersp.map((p) => p.key));
  const availablePersp = availablePerspectives(perspectiveCounts);

  if (isMockMode) {
    const pick = unused[0] ?? topics.find((t) => !exhaustedKeys.has(t.key)) ?? topics[0];
    const n = previousQuestions.filter((q) => q.type === "main").length + 1;
    if (pick) {
      const question = `[mock] 이력서에 적힌 "${pick.label}" 경험에 대해, 본인이 직접 맡은 역할과 구현 과정에서 내린 판단을 구체적으로 설명해 주세요.`;
      const basis = `resumeText 의 ${pick.label}`;
      return { question, basis, topicKey: pick.key, perspectiveKey: classifyQuestionPerspective(question, basis) };
    }
    const question = `[mock] 이력서에 적은 경험 중 ${n}번째로 검증하고 싶은 부분입니다. 가장 자신 있는 프로젝트에서 본인이 맡은 역할과 해결한 문제를 구체적으로 설명해 주세요.`;
    const basis = `이력서 프로젝트/경험 #${n}`;
    return { question, basis, topicKey: `mock-topic-${n}`, perspectiveKey: classifyQuestionPerspective(question, basis) };
  }

  const { covered, weak } = splitCoverage(previousQuestions, previousAnswers, evaluations);
  const coveredBlock = covered.length ? covered.join("\n") : "(아직 충분히 검증된 포인트 없음)";
  const weakBlock = weak.length ? weak.join("\n") : "(없음)";
  const exhaustedBlock = exhausted.length ? exhausted.map((t) => `- ${t.label}`).join("\n") : "(아직 없음)";
  const unusedBlock = unused.length
    ? unused.map((t) => `- ${t.label}`).join("\n")
    : "(없음 — 남은 새 주제가 없다면 가장 덜 다룬 주제를 고른다)";
  const exhaustedPerspBlock = exhaustedPersp.length
    ? exhaustedPersp.map((p) => `- ${p.label}`).join("\n")
    : "(아직 없음)";
  const availablePerspBlock = availablePersp.length
    ? availablePersp.map((p) => `- ${p.label}`).join("\n")
    : "(없음 — 남은 관점이 없다면 가장 덜 쓴 관점을 고른다)";

  const buildPrompt = (retryNote: string) => [
    `당신은 한국 기업의 날카로운 면접관입니다. ${TONE}`,
    INTERVIEWER_GUIDE,
    ``,
    GROUNDING_RULES,
    ``,
    MAIN_QUESTION_RULES,
    ``,
    `지금 만드는 것은 "새 검증 주제를 여는 main 질문"입니다(직전 답변을 파고드는 followup 이 아님).`,
    `[이번 면접의 초점] 아래 "지원 직무"의 지원자를 평가하는 면접입니다. 그 직무의 핵심 역량을 가장 잘 검증할 수 있는 resumeText 의 프로젝트/경험을 "직접 골라" 메인 질문 1개를 만드세요.`,
    `- [기계적 선택 금지] resumeText 맨 앞·가장 눈에 띄는 프로젝트를 무조건 고르지 말 것. 백엔드 면접이면 서버/API/DB/비동기처리/인프라/성능이 풍부한 프로젝트를, 프론트엔드 면접이면 화면/상태/렌더링/UX 중심 프로젝트를 우선 고른다. "(Frontend)"/"(Backend)" 표기가 있으면 직무와 일치하는 것을 고른다.`,
    `- 막연한 "~을 설명해 주세요"는 금지. 고른 경험의 "구현 방식·설계 의도·역할 분담·동작 흐름·기술 선택 이유" 같은, 그 직무의 핵심 역량을 검증하는 포인트 하나를 캐묻는다.`,
    `- resumeText 에 수치·역할·기능 표현이 있으면 그대로 인용해 근거로 삼는다. 단, resumeText 에 없는 수치·성과·분석은 새로 만들어 묻지 않는다.`,
    `- [중복 금지] 아래 "이미 충분히 다룬 검증 포인트"는 이전 main/followup 에서 이미 검증이 끝났다. 같은 포인트를 다시 묻지 않는다.`,
    `- [주제 반복 금지 — 매우 중요] 아래 "소진된 주제"는 같은 프로젝트/경험/기능을 이미 메인 질문으로 2번 다룬 것이다. 검증 관점(구체성·논리성·역할·결과)만 바꿔서라도 같은 주제를 절대 다시 묻지 마라.`,
    `- 같은 경험에 대해 표현만 바꾼 유사 질문은 "같은 주제"다. 반드시 resumeText 에 적힌 "다른" 경험/기능/역할로 넘어간다.`,
    `- [질문 관점 반복 금지 — 매우 중요] "질문 관점"이란 묻는 각도를 말한다(예: 기술 선택 이유 / 구현 방식·설계 / 문제 해결 과정 / 본인 역할 / 성과). 이력서 주제가 달라도 같은 관점이면 같은 질문 유형이다.`,
    `  · 예: "PDF 추출 기술을 선택한 이유는?", "LangGraph를 선택한 이유는?", "React를 선택한 이유는?" → 셋 다 "기술 선택 및 판단 이유"라는 같은 관점.`,
    `- 아래 "이미 2번 쓴 질문 관점"은 전체 메인 질문에서 이미 2번 사용했다. 그 관점으로는 절대 다시 묻지 말고, 아래 "아직 덜 쓴 질문 관점" 중 다른 각도로 질문하라.`,
    `- 아래 "아직 다루지 않은 주제"가 있으면(직무 적합성이 비슷하다면) 그중 하나를 우선 선택한다(없는 영역을 새로 만들지 말 것).`,
    `- 단, 아래 "아직 부족한 포인트"는 답변이 약했던 것이라 followup 의 몫이다. main 질문에서 이를 다시 캐묻지 말고, 다른 영역을 우선한다.`,
    `- basis: 이 질문이 근거로 삼은 resumeText 상의 실제 문장/표현을 짧게 요약한다(지어내지 말 것).`,
    ``,
    `[나쁜 예 — resumeText 에 없는 내용을 지어냄. 절대 이렇게 묻지 말 것]`,
    `- "사용자 피드백을 분석해 어떤 KPI를 개선했나요?" (피드백 분석·KPI는 근거에 없음)`,
    `- "대규모 트래픽 환경에서 어떤 성능 최적화를 했나요?" (트래픽·최적화는 근거에 없음)`,
    ``,
    `# 소진된 주제 (절대 다시 묻지 말 것 — 검증 관점만 바꾼 재질문도 금지)`,
    exhaustedBlock,
    ``,
    `# 아직 다루지 않은 주제 (직무에 맞으면 이 중에서 우선 선택)`,
    unusedBlock,
    ``,
    `# 이미 2번 쓴 질문 관점 (이 관점으로는 절대 다시 묻지 말 것)`,
    exhaustedPerspBlock,
    ``,
    `# 아직 덜 쓴 질문 관점 (가능하면 이 중 "다른 각도"로 질문)`,
    availablePerspBlock,
    ``,
    `# 이미 충분히 다룬 검증 포인트 (다음 main 질문에서 반복 금지)`,
    coveredBlock,
    ``,
    `# 아직 부족한 포인트 (followup 에서 더 캐물을 몫 — main 에서 반복하지 말 것)`,
    weakBlock,
    ``,
    JSON_RULES,
    `형식: {"question": string, "basis": string}`,
    ``,
    `# resumeText`,
    resumeText,
    ...contextBlock(context),
    ``,
    `# 지금까지의 질문/답변`,
    transcriptText(previousQuestions, previousAnswers, evaluations),
    ...(retryNote ? [``, retryNote] : []),
  ].join("\n");

  // 근거에 실제로 있는 앵커(프로젝트/기술명)가 있으면 fallback 을 그 경험 기반 일반 검증 질문으로 만든다.
  const anchor = pickResumeAnchor(resumeText);
  const fallbackQuestion = anchor
    ? `이력서에 적힌 ${anchor} 관련 경험에서 본인이 직접 맡은 역할과 구현 과정에서 어려웠던 점을 구체적으로 설명해 주세요.`
    : "이력서에 적은 경험 중 가장 자신 있는 프로젝트에서, 본인이 직접 맡은 역할과 해결한 문제를 구체적으로 설명해 주세요.";

  // 1) grounding 가드를 통과한 질문을 받되, 2) "소진된 주제/관점"이면 1회 재생성하고,
  //    3) 그래도 소진되면 아직 안 쓴 주제를 묻는 안전한 질문으로 대체한다.
  let retryNote = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const qg = await generateGuardedQuestion({
      buildPrompt: (groundingNote) =>
        [buildPrompt(groundingNote), ...(retryNote ? ["", retryNote] : [])].join("\n"),
      genOpts: { temperature: 0.5 },
      sources: [resumeText, context],
      kind: "main",
      fallback: {
        question: fallbackQuestion,
        basis: anchor ? `resumeText 의 ${anchor} 경험` : "resumeText 기반 경험 검증",
      },
    });
    const topicKey = classifyQuestionTopic(qg.question, qg.basis, topics);
    const perspectiveKey = classifyQuestionPerspective(qg.question, qg.basis);
    const topicExhausted = exhaustedKeys.has(topicKey);
    const perspExhausted = exhaustedPerspKeys.has(perspectiveKey);
    if (!topicExhausted && !perspExhausted) return { ...qg, topicKey, perspectiveKey };

    retryNote = [
      ...(topicExhausted ? [buildTopicRetryNote(exhausted, unused)] : []),
      ...(perspExhausted ? [buildPerspectiveRetryNote(exhaustedPersp, availablePersp)] : []),
    ].join("\n\n");
    console.warn(
      `[aiInterview] main 질문이 소진된 ${topicExhausted ? "주제" : ""}${topicExhausted && perspExhausted ? "·" : ""}${perspExhausted ? "관점" : ""}으로 생성됨(attempt ${attempt + 1}/2): ` +
        `topicKey=${topicKey}, perspectiveKey=${perspectiveKey} → ${attempt === 0 ? "재생성" : "안전 질문으로 대체"}`
    );
  }

  return buildSafeUnusedTopicQuestion(unused, topics, exhaustedKeys, fallbackQuestion, anchor);
}

/** 소진된 주제로 재생성됐을 때, 다음 시도에 덧붙이는 "다른 주제로 가라"는 지시. */
function buildTopicRetryNote(exhausted: ResumeTopic[], unused: ResumeTopic[]): string {
  return [
    `[재생성 지시 — 직전 질문이 이미 소진된 주제를 반복했습니다]`,
    `- 다음 주제는 이미 메인 질문으로 2번 다뤘습니다. 검증 관점만 바꿔서라도 다시 묻지 마세요: ${
      exhausted.map((t) => t.label).join(" / ") || "(없음)"
    }`,
    `- 대신 아직 다루지 않은 다른 경험으로 넘어가세요: ${
      unused.map((t) => t.label).join(" / ") || "(resumeText 의 다른 경험/기능/역할)"
    }`,
  ].join("\n");
}

/** 소진된 관점으로 재생성됐을 때, 다음 시도에 덧붙이는 "다른 관점으로 가라"는 지시. */
function buildPerspectiveRetryNote(
  exhausted: QuestionPerspective[],
  available: QuestionPerspective[]
): string {
  return [
    `[재생성 지시 — 직전 질문이 이미 소진된 "질문 관점"을 반복했습니다]`,
    `- 다음 관점은 전체 메인 질문에서 이미 2번 썼습니다. 이 각도로는 다시 묻지 마세요: ${
      exhausted.map((p) => p.label).join(" / ") || "(없음)"
    }`,
    `- 대신 아직 덜 쓴 다른 관점으로 질문하세요: ${
      available.map((p) => p.label).join(" / ") || "(기술 선택 이유 외의 다른 각도)"
    }`,
  ].join("\n");
}

/**
 * 소진 주제 반복이 끝내 멈추지 않을 때의 안전망:
 * 아직 안 쓴 주제(없으면 소진되지 않은 주제)를 골라 그 경험을 묻는 결정적 질문으로 대체한다.
 */
function buildSafeUnusedTopicQuestion(
  unused: ResumeTopic[],
  topics: ResumeTopic[],
  exhaustedKeys: Set<string>,
  fallbackQuestion: string,
  anchor: string | null
): Required<QuestionGen> {
  const target = unused[0] ?? topics.find((t) => !exhaustedKeys.has(t.key));
  if (target) {
    const question = `이력서에 적힌 "${target.label}" 경험에서 본인이 직접 맡은 역할과 그 과정에서 내린 판단, 그리고 결과를 구체적으로 설명해 주세요.`;
    const basis = `resumeText 의 ${target.label} 경험`;
    return { question, basis, topicKey: target.key, perspectiveKey: classifyQuestionPerspective(question, basis) };
  }
  return {
    question: fallbackQuestion,
    basis: anchor ? `resumeText 의 ${anchor} 경험` : "resumeText 기반 경험 검증",
    topicKey: anchor ? anchor.toLowerCase() : "t-misc",
    perspectiveKey: classifyQuestionPerspective(fallbackQuestion, anchor ?? ""),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) 꼬리질문 생성 — 직전 답변이 약할 때(논리 공격)
// ─────────────────────────────────────────────────────────────────────────────
export async function generateFollowupQuestion(input: {
  resumeText: string;
  context: string;
  question: string;
  answer: string;
  evaluation: AnswerEvaluation;
}): Promise<QuestionGen> {
  const { resumeText, context, question, answer, evaluation } = input;

  if (isMockMode) {
    const snippet = answer.trim().replace(/\s+/g, " ").slice(0, 40);
    return {
      question: snippet
        ? `[mock] 방금 "${snippet}…"라고 하셨는데, 그중 본인이 직접 구현하거나 판단한 지점 하나를 골라 어떻게 처리했고 왜 그 방식을 택했는지 구체적으로 설명해 주세요.`
        : `[mock] 방금 답변에서 본인이 직접 구현하거나 판단한 부분 하나를 골라, 어떻게 처리했고 왜 그 방식을 택했는지 구체적으로 설명해 주세요.`,
      basis: snippet
        ? `직전 답변의 표현 "${snippet}…" 인용 — 본인 역할·구현 방식·판단 근거가 불명확한 지점을 심화`
        : `직전 답변 심화 (본인 역할·구현 방식·판단 근거 보강)`,
    };
  }

  const buildPrompt = (retryNote: string) => [
    `당신은 한국 기업의 날카로운 면접관입니다. ${TONE}`,
    INTERVIEWER_GUIDE,
    ``,
    GROUNDING_RULES,
    ``,
    FOLLOWUP_QUESTION_RULES,
    ``,
    `지금 만드는 것은 직전 답변의 부족한 점을 "깊게 파고드는" followup 질문입니다(새 주제를 여는 main 이 아님).`,
    `직전 답변의 "가장 약한 지점 하나"만 정확히 찌르는 꼬리질문 1개를 만드세요.`,
    `- [표현 인용] 질문은 아래 "지원자 답변(원문)"에 실제로 나온 표현을 짧게 인용/요약해 시작한다. 그 표현이 답변 어디에 있는지 스스로 확인한 뒤 쓴다.`,
    `- [약점 선택] 점수만 보고 정하지 말고, 아래 "평가자 판단 근거(rationale)"·"보완점(improvements)"이 지적한 내용을 먼저 읽고 그 약점 하나를 파고든다.`,
    `- "더 구체적으로", "예를 들어" 같은 막연한 질문, "특정 기능 / 해당 기술 / 이러한 개선 / 관련 기능" 같은 모호한 지시어는 금지.`,
    `- 직전 답변에 이미 설명된 내용을 "무엇을 했냐"고 되묻지 말고, 그중 하나를 골라 "구현 방식·판단 근거·본인 역할" 중 빠진 한 가지를 더 깊이 캐묻는다.`,
    `- 아래 약점 중 가장 치명적인 하나만 파고든다(동시에 여러 개 금지):`,
    `  ① resumeText↔answer 불일치  ② 논리 비약(원인→해결→결과 단절)  ③ 역할 불명확  ④ 구현 방식·판단 근거 부족`,
    `- [수치 요구 조건] 직전 질문이 수치를 요구했는데 답변이 회피했거나, answer/resumeText 에 실제 측정값(예: 420ms, 91%)이 있을 때만 그 수치의 측정 기준·본인 기여도를 되묻는다. 측정한 적 없는 성과(개선율·완료율·만족도·성공률·KPI·도입 전후 수치·피드백 통계)는 새로 요구하지 않는다 — 대신 방지하려던 사용자 문제·정상 동작 확인 방법·테스트한 오류 상황·향후 검증 기준을 묻는다.`,
    `- basis: 어떤 표현을 인용해 어떤 약점(①~④)을 파고드는지 짧게 적는다(막연한 평가 문구 금지).`,
    ``,
    `[좋은 예 1 — answer/resumeText 에 실제 측정값이 있을 때] "'성과가 좋았다'고 하셨는데, 자소서엔 420ms로 개선했다고 적혀 있습니다. 이 수치의 측정 기준과 본인이 직접 기여한 부분만 분리해 설명해 주세요."`,
    `[좋은 예 2 — 측정값이 없을 때, 한 가지만 심화] "API 오류가 발생해도 사용자가 작성한 답변을 유지하도록 했다고 하셨는데, React에서 입력값과 오류 상태를 어떻게 분리해 관리했는지 설명해 주세요."`,
    `[나쁜 예 — 절대 이렇게 묻지 말 것] "특정 기능을 추가했다고 하셨는데 어떤 요소를 개선했는지 설명해 주세요."(모호·이미 답함) / "도입 전후 만족도와 완료율 수치를 제시해 주세요."(측정한 적 없는 KPI 요구)`,
    ``,
    JSON_RULES,
    `형식: {"question": string, "basis": string}`,
    ``,
    `# resumeText`,
    resumeText,
    ...contextBlock(context),
    ``,
    `# 직전 질문`,
    question,
    `# 지원자 답변 (원문 — 이 안에 실제로 적힌 표현만 인용할 수 있다)`,
    answer,
    `# 평가가 지적한 약점(참고)`,
    `종합점수=${evaluation.score}, 구체성=${evaluation.specificity}, resumeText일관성=${evaluation.resumeConsistency}, 역할명확성=${evaluation.roleClarity}, 문제해결력=${evaluation.problemSolving}`,
    `보완점(improvements): ${evaluation.improvements.join(", ") || "(없음)"}`,
    `평가자 판단 근거(rationale): ${evaluation.rationale?.trim() || "(없음)"}`,
    ...(retryNote ? [``, retryNote] : []),
  ].join("\n");

  const fallbackQuestion =
    "방금 답변에서 본인이 직접 구현하거나 판단한 부분 하나를 골라, 그 부분을 어떻게 처리했고 왜 그 방식을 택했는지 구체적으로 설명해 주세요.";

  return generateGuardedQuestion({
    buildPrompt,
    genOpts: { temperature: 0.5 },
    // followup 은 직전 answer 의 표현을 물고 들어갈 수 있으므로 answer·rationale·context 도 허용 근거에 포함.
    sources: [resumeText, answer, evaluation.rationale ?? "", context],
    kind: "followup",
    fallback: { question: fallbackQuestion, basis: "직전 답변 심화 (본인 역할·구현 방식·판단 근거 보강)" },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) 답변 평가
// ─────────────────────────────────────────────────────────────────────────────
export async function evaluateInterviewAnswer(input: {
  resumeText: string;
  context: string;
  question: string;
  answer: string;
  questionIndex: number;
}): Promise<AnswerEvaluation> {
  const { resumeText, context, question, answer, questionIndex } = input;

  if (isMockMode) {
    const specificity = Math.min(100, answer.trim().length);
    const needsFollowup = specificity < 60;
    return {
      questionIndex,
      score: needsFollowup ? 55 : 82,
      specificity,
      resumeConsistency: needsFollowup ? 50 : 80,
      problemSolving: needsFollowup ? 52 : 78,
      roleClarity: needsFollowup ? 48 : 80,
      structure: needsFollowup ? 55 : 76,
      resultPresented: !needsFollowup,
      needsFollowup,
      strengths: ["[mock] 질문 의도를 이해함"],
      improvements: needsFollowup ? ["[mock] 구체적 사례와 수치가 부족함"] : ["[mock] 결론을 더 간결하게"],
      rationale: "[mock] 답변 길이를 기준으로 한 임시 평가입니다.",
    };
  }

  const prompt = [
    `당신은 한국 기업 면접의 날카로운 답변 평가자입니다.`,
    INTERVIEWER_GUIDE,
    ``,
    `answer 를 resumeText(및 있으면 지원 직무/공고)와 대조해 각 항목을 0~100 으로 채점하세요(아래 문제가 보이면 해당 점수를 낮춘다):`,
    `- specificity: 모호한 표현("열심히/좋은 결과")만 있고 사실이 없으면 낮춤`,
    `- roleClarity: 역할이 불명확하거나 "우리/팀에서"로 기여가 가려지면 낮춤`,
    `- resultPresented(boolean): 성과 수치의 측정·비교·기여도 근거가 없으면 false`,
    `- problemSolving: 원인→해결의 인과 연결이 끊기면 낮춤`,
    `- structure: 질문에 직접 답하지 않고 겉돌면 낮춤`,
    `- resumeConsistency: resumeText 와 수치/사실이 어긋나거나 없는 내용을 덧붙이면 낮춤`,
    `- needsFollowup: 다음을 모두 만족하면 false(꼬리질문 불필요)로 판단한다 — ① specificity·roleClarity·resumeConsistency 가 모두 70 이상, ② resultPresented=true, ③ 질문에 직접 답함. 하나라도 어긋나면 true.`,
    `- rationale: answer 의 구체적 표현을 인용해 판단 근거를 쓴다(막연한 총평 금지).`,
    `- improvements: 무엇을 어떻게 보완할지 행동 단위로 적는다.`,
    ``,
    JSON_RULES,
    `형식: {"score": number, "specificity": number, "resumeConsistency": number, "problemSolving": number, "roleClarity": number, "structure": number, "resultPresented": boolean, "needsFollowup": boolean, "strengths": string[], "improvements": string[], "rationale": string}`,
    ``,
    `# resumeText`,
    resumeText,
    ...contextBlock(context),
    ``,
    `# 질문`,
    question,
    `# 답변`,
    answer,
  ].join("\n");

  const raw = (await tryGenerateJson<Partial<AnswerEvaluation>>(prompt, { temperature: 0.2 })) ?? {};
  return {
    questionIndex,
    score: num(raw.score, 60),
    specificity: num(raw.specificity, 60),
    resumeConsistency: num(raw.resumeConsistency, 60),
    problemSolving: num(raw.problemSolving, 60),
    roleClarity: num(raw.roleClarity, 60),
    structure: num(raw.structure, 60),
    resultPresented: Boolean(raw.resultPresented),
    needsFollowup: Boolean(raw.needsFollowup),
    // 사용자에게 그대로 노출되는 텍스트 필드는 내부 표현(필드명·true/false·점수)을 걸러서 담는다.
    strengths: sanitizeList(arr(raw.strengths)),
    improvements: sanitizeList(arr(raw.improvements)),
    rationale: sanitizeRationale(raw.rationale) || "평가 근거를 생성하지 못해 기본값으로 진행합니다.",
  };
}

/**
 * 평가 근거(rationale)를 사용자용 한 문장으로 정화한다.
 * EXAONE 이 한 문장 판단 근거 대신 항목별 점수 브레이크다운까지 흘려 내부 필드명이 노출되는 경우를 막는다.
 */
function sanitizeRationale(raw: unknown): string {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return "";
  const leakBullet =
    /^\s*(?:[-*•]|\d+[.)])\s*\**\s*(?:specificity|resumeConsistency|problemSolving|roleClarity|structure|resultPresented|needsFollowup|score)\b/i;
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (leakBullet.test(line)) break;
    kept.push(line);
  }
  return stripInternalTokens(kept.join(" ").replace(/\s+/g, " ").trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// 리포트 문장 정규화 — 내부 값(true/false·필드명)을 사용자용 한국어로 바꾼다.
// ─────────────────────────────────────────────────────────────────────────────

/** 점수가 이 값 미만이면 "보완이 필요한 약점"으로 보고 사용자용 문장을 만든다. */
const REPORT_WEAK_THRESHOLD = 70;

/** 평가 항목별 사용자용 보완 문장. */
const WEAKNESS_SENTENCES = {
  resultPresented: "답변에서 구체적인 성과나 결과가 충분히 드러나지 않았습니다.",
  needsFollowup: "답변이 다소 추상적이어서 추가 설명이 필요합니다.",
  resumeConsistency: "답변 내용과 이력서에 작성된 경험의 연결이 명확하지 않습니다.",
  roleClarity: "팀의 성과와 본인이 직접 담당한 역할을 구분해 설명할 필요가 있습니다.",
  specificity: "과정과 행동을 실제 사례 중심으로 더 구체적으로 설명해 주세요.",
  problemSolving: "문제의 원인, 해결 과정, 결과가 자연스럽게 이어지도록 정리해 주세요.",
  structure: "질문의 핵심에 먼저 답한 뒤 근거를 덧붙이면 전달이 더 명확해집니다.",
} as const;

/**
 * 평가(AnswerEvaluation)의 boolean·점수를 사용자용 보완 문장 배열로 바꾼다.
 * LLM 리포트가 비거나 실패했을 때의 fallback 피드백으로도 쓴다.
 */
function humanizeEvaluation(ev: AnswerEvaluation): string[] {
  const out: string[] = [];
  if (!ev.resultPresented) out.push(WEAKNESS_SENTENCES.resultPresented);
  if (ev.specificity < REPORT_WEAK_THRESHOLD) out.push(WEAKNESS_SENTENCES.specificity);
  if (ev.roleClarity < REPORT_WEAK_THRESHOLD) out.push(WEAKNESS_SENTENCES.roleClarity);
  if (ev.resumeConsistency < REPORT_WEAK_THRESHOLD) out.push(WEAKNESS_SENTENCES.resumeConsistency);
  if (ev.problemSolving < REPORT_WEAK_THRESHOLD) out.push(WEAKNESS_SENTENCES.problemSolving);
  if (ev.structure < REPORT_WEAK_THRESHOLD) out.push(WEAKNESS_SENTENCES.structure);
  if (ev.needsFollowup && out.length === 0) out.push(WEAKNESS_SENTENCES.needsFollowup);
  if (out.length === 0) out.push("질문의 핵심을 정확히 짚어 역할과 결과를 구체적으로 설명했습니다.");
  return out;
}

/** 내부 필드명 → 사용자용 한국어 라벨(문장으로 못 바꾼 잔여 토큰을 마지막에 치환). */
const FIELD_LABELS: Record<string, string> = {
  resultPresented: "성과·결과 제시",
  needsFollowup: "추가 설명 필요 정도",
  resumeConsistency: "이력서와의 연결성",
  roleClarity: "본인 역할의 명확성",
  problemSolving: "문제 해결 과정",
  specificity: "구체성",
  structure: "답변 구성",
  score: "점수",
};

/** "필드명 + (=true/false·낮음·부족)" 패턴을 사용자용 문장으로 바꾸는 규칙. */
const SANITIZE_RULES: Array<[RegExp, string]> = [
  [/\bscore\b\s*(?:=|:)\s*(\d+)점?/gi, "$1점"],
  [/(?:\bresultPresented\b|성과\s*제시|결과\s*제시)\s*(?:가|는|은|이|부분은)?\s*(?:=|:)?\s*(?:false|없음|미흡|부족|아니오)[가-힣]*/gi,
    WEAKNESS_SENTENCES.resultPresented],
  [/\bneedsFollowup\b\s*(?:=|:)?\s*(?:true|필요|예)[가-힣]*/gi, WEAKNESS_SENTENCES.needsFollowup],
  [/(?:\bresumeConsistency\b|이력서\s*일관성|일관성)\s*(?:가|는|은|이)?\s*(?:=|:)?\s*(?:낮|부족|미흡|false)[가-힣]*/gi,
    WEAKNESS_SENTENCES.resumeConsistency],
  [/(?:\broleClarity\b|역할\s*명확성|역할명확성)\s*(?:가|는|은|이)?\s*(?:=|:)?\s*(?:낮|불명확|부족|미흡|false)[가-힣]*/gi,
    WEAKNESS_SENTENCES.roleClarity],
  [/(?:\bspecificity\b|구체성)\s*(?:가|는|은|이|부분은)?\s*(?:=|:)?\s*(?:낮|부족|미흡|false)[가-힣]*/gi,
    WEAKNESS_SENTENCES.specificity],
  [/(?:\bproblemSolving\b|문제\s*해결력|문제해결력)\s*(?:가|는|은|이)?\s*(?:=|:)?\s*(?:낮|부족|미흡|false)[가-힣]*/gi,
    WEAKNESS_SENTENCES.problemSolving],
  [/(?:\bstructure\b|답변\s*구조|구조)\s*(?:가|는|은|이)?\s*(?:=|:)?\s*(?:낮|부족|미흡|false)[가-힣]*/gi,
    WEAKNESS_SENTENCES.structure],
];

/**
 * 사용자에게 보여줄 한 문장에서 내부 표현을 제거/치환한다(결과 정규화 단계의 안전망).
 * 프롬프트 지시가 지켜지면 대부분 무해하지만, 모델이 내부 값을 흘려도 사용자 문장엔 남지 않게 한다.
 */
export function stripInternalTokens(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [re, rep] of SANITIZE_RULES) out = out.replace(re, rep);
  for (const [field, label] of Object.entries(FIELD_LABELS)) {
    out = out.replace(new RegExp(`\\b${field}\\b`, "gi"), label);
  }
  out = out
    .replace(/\s*(?:=|:)\s*(?:true|false)\b/gi, "")
    .replace(/\b(?:true|false)\b/gi, "")
    .replace(/\.\s*(?:입니다|이다|임|합니다|됩니다|예요|에요)\.?/g, ".")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .replace(/([.!?])\s*\1+/g, "$1")
    .replace(/\.{2,}/g, ".")
    .trim();
  return out;
}

/** 문자열 배열의 각 항목을 정규화하고 빈 항목을 버린다. */
function sanitizeList(items: string[]): string[] {
  return items.map(stripInternalTokens).filter((s) => s.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) 최종 리포트
// ─────────────────────────────────────────────────────────────────────────────
export async function generateFinalReport(input: {
  resumeText: string;
  context: string;
  questionHistory: InterviewQuestion[];
  answerHistory: string[];
  evaluations: AnswerEvaluation[];
}): Promise<FinalReport> {
  const { resumeText, context, questionHistory, answerHistory, evaluations } = input;

  const perAnswerFallback = questionHistory.map((q) => {
    const ev = evaluations.find((e) => e.questionIndex === q.index);
    const feedback = ev ? humanizeEvaluation(ev).join(" ") : "이 답변에 대한 피드백을 생성하지 못했습니다.";
    return { index: q.index, question: q.question, feedback, score: ev?.score ?? 0 };
  });

  if (isMockMode) {
    return {
      summary: `[mock] 총 ${questionHistory.length}개 질문에 답한 면접 결과 요약입니다.`,
      strengths: ["[mock] 질문 의도 파악이 빠름"],
      improvements: ["[mock] 구체적 사례와 수치 보강 필요"],
      perAnswerFeedback: perAnswerFallback,
      expectedQuestions: ["[mock] 가장 어려웠던 협업 갈등 상황과 해결 과정을 설명해 주세요."],
      nextSteps: ["[mock] STAR 기법으로 경험을 수치화해 정리해 보세요."],
    };
  }

  const prompt = [
    `당신은 한국 기업 면접 결과를 정리하는 날카로운 평가자입니다.`,
    INTERVIEWER_GUIDE,
    ``,
    `아래 면접 기록으로 최종 리포트를 작성하세요. 칭찬·요약이 아니라 "반복적으로 드러난 약점" 진단이 목적입니다.`,
    `- summary: 여러 답변에 걸쳐 반복된 패턴(특히 약점)을 중심으로 진단한다.`,
    `- improvements: resumeText 주장 대비 부족했던 부분(추상 표현·역할 불명확·수치 근거 부족·인과 단절·불일치)을 정리한다.`,
    `- perAnswerFeedback: 질문 index 마다 1개씩, 가장 약한 지점을 짚는다.`,
    `- expectedQuestions: 답변의 빈틈을 파고드는, 다음에 받을 만한 예상 질문.`,
    `- nextSteps: "측정 기준·본인 역할·개선 전후 수치를 함께 말하라"처럼 바로 실행 가능한 조언.`,
    ``,
    `[사용자용 문장 규칙 — 반드시 지킬 것]`,
    `- 모든 문장은 지원자가 바로 이해할 수 있는 자연스러운 한국어로 쓴다.`,
    `- true/false, resultPresented, needsFollowup, resumeConsistency, roleClarity, specificity, problemSolving, structure, score 같은 내부 필드명·JSON 키·불리언·점수 표기를 문장에 절대 노출하지 않는다.`,
    `  · 예: "resultPresented가 false" (X) → "답변에서 구체적인 성과나 결과가 충분히 드러나지 않았습니다." (O)`,
    `  · 예: "resumeConsistency가 낮음" (X) → "답변 내용과 이력서에 작성된 경험의 연결이 명확하지 않습니다." (O)`,
    `- 점수만 나열하지 말고, 무엇이 좋았고 무엇을 어떻게 보완하면 되는지 행동 단위로 설명한다.`,
    `- 실제 답변에 없는 수치·성과를 지어내지 않는다. 측정하지 않은 KPI를 요구하지 말고, 수치가 없으면 역할·과정·판단 근거·결과 중 설명할 수 있는 것을 제안한다.`,
    ``,
    JSON_RULES,
    `형식: {"summary": string, "strengths": string[], "improvements": string[], "perAnswerFeedback": [{"index": number, "question": string, "feedback": string, "score": number}], "expectedQuestions": string[], "nextSteps": string[]}`,
    ``,
    `# resumeText`,
    resumeText,
    ...contextBlock(context),
    ``,
    `# 전체 면접 기록`,
    transcriptText(questionHistory, answerHistory, evaluations),
  ].join("\n");

  const raw = (await tryGenerateJson<Partial<FinalReport>>(prompt, { temperature: 0.3 })) ?? {};
  const per = Array.isArray(raw.perAnswerFeedback) && raw.perAnswerFeedback.length
    ? raw.perAnswerFeedback.map((p: any, i: number) => {
        const fb = stripInternalTokens(String(p?.feedback ?? "").trim());
        const index = num(p?.index, questionHistory[i]?.index ?? i + 1);
        // 점수는 실제 채점값(evaluations[].score)을 questionIndex 로 찾아 그대로 쓴다(모델이 빼먹으면 0으로 떨어짐).
        const ev = evaluations.find((e) => e.questionIndex === index);
        return {
          index,
          question: String(p?.question ?? questionHistory[i]?.question ?? "").trim(),
          feedback: fb || perAnswerFallback[i]?.feedback || "이 답변에 대한 보완점을 정리하지 못했습니다.",
          score: ev?.score ?? num(p?.score, 0),
        };
      })
    : perAnswerFallback;
  return {
    summary: stripInternalTokens(String(raw.summary ?? "").trim()) || "이번 면접 답변을 전반적으로 정리한 결과입니다.",
    strengths: sanitizeList(arr(raw.strengths)),
    improvements: sanitizeList(arr(raw.improvements)),
    perAnswerFeedback: per,
    expectedQuestions: sanitizeList(arr(raw.expectedQuestions)),
    nextSteps: sanitizeList(arr(raw.nextSteps)),
  };
}

// ── 소소한 정규화 헬퍼 ──────────────────────────────────────────────────────
/**
 * generateJson 을 호출하되, "JSON 파싱 실패(재시도 후)"만 삼키고 null 을 돌려준다.
 * 연결/네트워크 오류(OllamaError)는 그대로 위로 던져 표면화한다.
 */
async function tryGenerateJson<T>(prompt: string, opts: GenOpts): Promise<T | null> {
  try {
    return await generateJson<T>(prompt, opts);
  } catch (err) {
    if (err instanceof OllamaJsonError) {
      console.warn(`[aiInterview] JSON 파싱 실패 → fallback 으로 진행합니다: ${err.message.split("\n")[0]}`);
      return null;
    }
    throw err;
  }
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}
