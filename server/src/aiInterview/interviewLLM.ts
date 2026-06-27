// 면접 "텍스트 생성" 계층 — 질문 / 평가 / 꼬리질문 / 리포트.
//
//  - interviewGraph.ts(LangGraph)는 "언제 무엇을 호출할지(진행 순서/상태)"만 결정한다.
//  - 이 파일은 "실제 텍스트 생성"만 책임진다. 프롬프트가 모두 여기에 격리돼 있다.
//  - 로컬 Ollama(EXAONE 3.5)만 사용한다(서버 공용 ../ollama.js). 외부 API 키 불필요.
//  - 질문/평가는 resumeText(이력서 원문)와 context(지원 직무/공고 요약)를 근거로 한다.
//
// mock 모드:
//  - INTERVIEW_LLM_MOCK=1 이면 Ollama 를 호출하지 않고 결정적인 더미 응답을 낸다(흐름만 검증).

import { generateJson, OllamaJsonError } from "../ollama.js";
import { checkQuestionGrounding, pickResumeAnchor } from "./questionGuard.js";
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

// main 질문 전용 지침.
const MAIN_QUESTION_RULES = [
  `[main 질문 형식·자가점검]`,
  `- 질문은 다음 형식을 따른다: "resumeText 에 적힌 [구체적 경험/기능/역할]에 대해, [검증 포인트]를 설명해 주세요."`,
  `- 직전 답변을 더 캐묻지 말고, resumeText 에서 아직 검증하지 않은 "새" 경험/역량으로 주제를 연다(그 심화는 followup 의 몫).`,
  `- 지원 직무/공고가 있으면, 그 요건과 직결되는 resumeText 의 경험을 우선 골라 "직무 적합성"을 검증한다.`,
  `- 출력 전에 스스로 점검한다(하나라도 "아니오"면 질문을 버리고 다시 만든다):`,
  `  ① 이 질문의 모든 명사가 resumeText·지원 직무/공고에 근거가 있는가?`,
  `  ② 이 질문이 사용자가 실제로 "했다"고 적은 일에 대해 묻는가?`,
  `  ③ resumeText 에 없는 성과·판단·분석·식별을 끼워 넣지 않았는가?`,
  `  ④ basis 에 이 질문의 근거가 되는 resumeText/공고 문장을 짧게 요약했는가?`,
].join("\n");

// followup 질문 전용 지침.
const FOLLOWUP_QUESTION_RULES = [
  `[followup 질문 형식·자가점검]`,
  `- 꼬리질문은 resumeText 와 "방금 answer 에 실제로 나온 표현"만 근거로 한다. answer 에 없는 행위·성과를 했다고 가정하지 않는다.`,
  `- 직전 질문과 직전 답변에서 드러난 "약점 하나"만 더 깊이 파고든다. resumeText 의 새 경험/주제로 넘어가지 않는다(그건 main 의 몫).`,
  `- 출력 전에 스스로 점검한다(하나라도 "아니오"면 질문을 버리고 다시 만든다):`,
  `  ① 이 질문이 직전 답변(answer)의 특정 표현을 인용·지목하는가?`,
  `  ② resumeText·answer 에 없는 사실을 새로 지어내지 않았는가?`,
  `  ③ 새 주제로 넘어가지 않고 직전 답변의 약점을 더 깊이 파고드는가?`,
  `  ④ basis 에 어떤 약점을 어떤 표현(근거)으로 파는지 짧게 적었는가?`,
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
}

function normalizeQuestionGen(raw: Partial<QuestionGen> | null | undefined, fallbackQuestion: string): QuestionGen {
  const question = String(raw?.question ?? "").trim() || fallbackQuestion;
  const basis = String(raw?.basis ?? "").trim() || "resumeText 기반 경험 검증";
  return { question, basis };
}

function buildRetryNote(ungrounded: string[], kind: "main" | "followup"): string {
  const src = kind === "main" ? "resumeText·지원 직무/공고" : "resumeText·직전 answer";
  return [
    `[재생성 지시 — 직전 시도가 근거를 벗어났습니다]`,
    `- 다음 표현은 ${src} 에서 근거를 찾을 수 없습니다: ${ungrounded.join(", ") || "(불명)"}`,
    `- 이 표현들을 빼고, ${src} 에 "실제로 적힌" 내용만으로 question 과 basis 를 다시 만드세요.`,
  ].join("\n");
}

type GenOpts = Parameters<typeof generateJson>[1];

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
}): Promise<QuestionGen> {
  const { resumeText, context, previousQuestions, previousAnswers, evaluations } = input;

  if (isMockMode) {
    const n = previousQuestions.filter((q) => q.type === "main").length + 1;
    return {
      question: `[mock] 이력서에 적은 경험 중 ${n}번째로 검증하고 싶은 부분입니다. 가장 자신 있는 프로젝트에서 본인이 맡은 역할과 해결한 문제를 구체적으로 설명해 주세요.`,
      basis: `이력서 프로젝트/경험 #${n}`,
    };
  }

  const { covered, weak } = splitCoverage(previousQuestions, previousAnswers, evaluations);
  const coveredBlock = covered.length ? covered.join("\n") : "(아직 충분히 검증된 포인트 없음)";
  const weakBlock = weak.length ? weak.join("\n") : "(없음)";

  const buildPrompt = (retryNote: string) => [
    `당신은 한국 기업의 날카로운 면접관입니다. ${TONE}`,
    INTERVIEWER_GUIDE,
    ``,
    GROUNDING_RULES,
    ``,
    MAIN_QUESTION_RULES,
    ``,
    `지금 만드는 것은 "새 검증 주제를 여는 main 질문"입니다(직전 답변을 파고드는 followup 이 아님).`,
    `resumeText 에 "실제로 적힌" 경험/기능/역할/사용 기술 중 아직 충분히 검증하지 않은 것 하나를 골라 메인 질문 1개를 만드세요.`,
    `- 막연한 "~을 설명해 주세요"는 금지. resumeText 에 적힌 그 경험의 "구현 방식·설계 의도·역할 분담·동작 흐름·기술 선택 이유" 같은 검증 포인트 하나를 캐묻는다.`,
    `- 지원 직무/공고가 주어졌다면, 그 요건과 가장 관련된 resumeText 의 경험을 우선 골라 직무 적합성을 검증한다.`,
    `- resumeText 에 수치·역할·기능 표현이 있으면 그대로 인용해 근거로 삼는다. 단, resumeText 에 없는 수치·성과·분석은 새로 만들어 묻지 않는다.`,
    `- [중복 금지] 아래 "이미 충분히 다룬 검증 포인트"는 다시 묻지 않는다.`,
    `- 한 경험을 충분히 다뤘다면, 다음 main 질문은 resumeText 에 적힌 "다른" 경험/기능/역할로 넘어간다.`,
    `- 단, 아래 "아직 부족한 포인트"는 followup 의 몫이므로 main 에서 다시 캐묻지 말고 다른 영역을 우선한다.`,
    `- basis: 이 질문이 근거로 삼은 resumeText/공고 상의 실제 문장·표현을 짧게 요약한다(지어내지 말 것).`,
    ``,
    `[나쁜 예 — 근거에 없는 내용을 지어냄. 절대 이렇게 묻지 말 것]`,
    `- "사용자 피드백을 분석해 어떤 KPI를 개선했나요?" (피드백 분석·KPI는 근거에 없음)`,
    `- "대규모 트래픽 환경에서 어떤 성능 최적화를 했나요?" (트래픽·최적화는 근거에 없음)`,
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

  const anchor = pickResumeAnchor(resumeText);
  const fallbackQuestion = anchor
    ? `이력서에 적힌 ${anchor} 관련 경험에서 본인이 직접 맡은 역할과 구현 과정에서 어려웠던 점을 구체적으로 설명해 주세요.`
    : "이력서에 적은 경험 중 가장 자신 있는 프로젝트에서, 본인이 직접 맡은 역할과 해결한 문제를 구체적으로 설명해 주세요.";

  return generateGuardedQuestion({
    buildPrompt,
    genOpts: { temperature: 0.5 },
    // 직무/공고 요건도 grounding 근거에 포함(직무 적합성 질문이 drift 로 오판되지 않도록).
    sources: [resumeText, context],
    kind: "main",
    fallback: { question: fallbackQuestion, basis: anchor ? `resumeText 의 ${anchor} 경험` : "resumeText 기반 경험 검증" },
  });
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
    return {
      question: `[mock] 방금 답변이 다소 추상적입니다. 그 경험에서 본인이 직접 한 일과 수치로 드러나는 결과(예: 기간, 규모, 개선율)를 구체적으로 덧붙여 설명해 주세요.`,
      basis: `직전 답변 심화 (구체성/결과 보강)`,
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
    `- [중요] 약점 선택은 점수만 보고 정하지 말고, 아래 "평가자 판단 근거(rationale)"가 지적한 내용을 먼저 읽고 그 약점을 파고든다.`,
    `- "더 구체적으로", "예를 들어" 같은 막연한 질문은 금지. 방금 answer 의 특정 표현을 인용해 묻는다.`,
    `- [중요] 같은 검증 포인트를 더 구체적으로 다시 캐물어도 된다(예: "많이 좋아졌다"고만 답했다면 개선 전후 수치를 다시 요구).`,
    `- 아래 약점 중 가장 치명적인 하나만 파고든다(동시에 여러 개 금지):`,
    `  ① resumeText↔answer 불일치  ② 논리 비약(원인→해결→결과 단절)  ③ 역할 불명확  ④ 수치 근거 부족`,
    `- basis: 어떤 약점(①~④)을 어떤 표현을 근거로 파고드는지 짧게 적는다.`,
    ``,
    `[좋은 예] "'성과가 좋았다'고 하셨는데, 이력서엔 420ms로 개선했다고 적혀 있습니다. 이 수치의 측정 기준과 본인이 직접 기여한 부분만 분리해 설명해 주세요."`,
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
    `# 지원자 답변`,
    answer,
    `# 평가가 지적한 약점(참고)`,
    `구체성=${evaluation.specificity}, resumeText일관성=${evaluation.resumeConsistency}, 역할명확성=${evaluation.roleClarity}, 문제해결력=${evaluation.problemSolving}`,
    `보완점: ${evaluation.improvements.join(", ") || "(없음)"}`,
    `평가자 판단 근거(rationale): ${evaluation.rationale?.trim() || "(없음)"}`,
    ...(retryNote ? [``, retryNote] : []),
  ].join("\n");

  const fallbackQuestion =
    "방금 답변에서 본인이 직접 한 일과, 그 결과를 기간·규모·개선 정도로 분리해 구체적으로 다시 설명해 주세요.";

  return generateGuardedQuestion({
    buildPrompt,
    genOpts: { temperature: 0.5 },
    sources: [resumeText, answer, evaluation.rationale ?? "", context],
    kind: "followup",
    fallback: { question: fallbackQuestion, basis: "직전 답변 심화 (구체성/결과 보강)" },
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
    `- needsFollowup: ① specificity·roleClarity·resumeConsistency 가 모두 70 이상, ② resultPresented=true, ③ 질문에 직접 답함 — 셋을 모두 만족하면 false, 하나라도 어긋나면 true.`,
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
    strengths: arr(raw.strengths),
    improvements: arr(raw.improvements),
    rationale: String(raw.rationale ?? "").trim() || "평가 근거를 생성하지 못해 기본값으로 진행합니다.",
  };
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
    return {
      index: q.index,
      question: q.question,
      feedback: ev?.improvements.join(" ") || "피드백을 생성하지 못했습니다.",
      score: ev?.score ?? 0,
    };
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
    ? raw.perAnswerFeedback.map((p: any, i: number) => ({
        index: num(p?.index, questionHistory[i]?.index ?? i + 1),
        question: String(p?.question ?? questionHistory[i]?.question ?? "").trim(),
        feedback: String(p?.feedback ?? "").trim(),
        score: num(p?.score, 0),
      }))
    : perAnswerFallback;
  return {
    summary: String(raw.summary ?? "").trim() || "리포트 요약 생성에 실패했습니다.",
    strengths: arr(raw.strengths),
    improvements: arr(raw.improvements),
    perAnswerFeedback: per,
    expectedQuestions: arr(raw.expectedQuestions),
    nextSteps: arr(raw.nextSteps),
  };
}

// ── 소소한 정규화 헬퍼 ──────────────────────────────────────────────────────
/**
 * generateJson 을 호출하되, "JSON 파싱 실패(재시도 후)"만 삼키고 null 을 돌려준다.
 * → 호출부가 필수 필드 fallback 으로 흐름을 계속 진행시킨다.
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
