// LangGraph 면접 진행 — 상태/순서 오케스트레이션.
//
//  - 이 파일은 "면접 진행 순서와 상태"만 관리한다(몇 번째 질문인지, 꼬리질문을 달지, 끝낼지).
//  - 실제 질문/평가/리포트 "텍스트 생성"은 interviewLLM.ts 가 담당한다.
//  - 입력은 resumeText(이력서 원문) / context(지원 직무·공고 요약) / answer 다.
//
// human-in-the-loop:
//  - 면접은 요청과 요청 사이에 사용자의 답변을 기다리며 멈춰야 한다.
//  - LangGraph 의 interrupt() + MemorySaver 체크포인터로 세션 상태를 보존하고,
//    interviewId 를 thread_id 로 사용한다.
//
// Fastify 연동:
//  - startInterview({ resumeText, context }) 와 submitAnswer({ interviewId, answer }) 를 export 한다.
//  - 라우트(interview.ts)에서 이력서·직무·공고를 조회해 resumeText/context 를 만들어 넘긴다.

import { randomUUID } from "node:crypto";
import {
  Annotation,
  Command,
  END,
  interrupt,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { pool } from "../db.js";
import { extractResumeTopics } from "./resumeTopics.js";
import {
  evaluateInterviewAnswer,
  generateFinalReport,
  generateFollowupQuestion,
  generateInterviewQuestion,
} from "./interviewLLM.js";
import type {
  AnswerEvaluation,
  FinalReport,
  InterviewQuestion,
  InterviewStatus,
  StartInterviewInput,
  StartInterviewResult,
  SubmitAnswerInput,
  SubmitAnswerResult,
} from "./types.js";

/** 메인+꼬리질문을 합쳐 기본 최대 5개까지 진행한다. */
export const MAX_QUESTIONS = 5;

// ─────────────────────────────────────────────────────────────────────────────
// 상태 정의 — 채널마다 "마지막 값으로 덮어쓰기" reducer 사용.
// ─────────────────────────────────────────────────────────────────────────────
const last =
  <T>() =>
  (_prev: T, next: T) =>
    next;

const InterviewAnnotation = Annotation.Root({
  interviewId: Annotation<string>({ reducer: last<string>(), default: () => "" }),
  resumeText: Annotation<string>({ reducer: last<string>(), default: () => "" }),
  context: Annotation<string>({ reducer: last<string>(), default: () => "" }),
  currentQuestion: Annotation<InterviewQuestion | null>({
    reducer: last<InterviewQuestion | null>(),
    default: () => null,
  }),
  currentAnswer: Annotation<string | null>({
    reducer: last<string | null>(),
    default: () => null,
  }),
  questionHistory: Annotation<InterviewQuestion[]>({
    reducer: last<InterviewQuestion[]>(),
    default: () => [],
  }),
  answerHistory: Annotation<string[]>({ reducer: last<string[]>(), default: () => [] }),
  evaluations: Annotation<AnswerEvaluation[]>({
    reducer: last<AnswerEvaluation[]>(),
    default: () => [],
  }),
  questionCount: Annotation<number>({ reducer: last<number>(), default: () => 0 }),
  topicCounts: Annotation<Record<string, number>>({
    reducer: last<Record<string, number>>(),
    default: () => ({}),
  }),
  perspectiveCounts: Annotation<Record<string, number>>({
    reducer: last<Record<string, number>>(),
    default: () => ({}),
  }),
  maxQuestions: Annotation<number>({ reducer: last<number>(), default: () => MAX_QUESTIONS }),
  finalReport: Annotation<FinalReport | null>({
    reducer: last<FinalReport | null>(),
    default: () => null,
  }),
  status: Annotation<InterviewStatus>({ reducer: last<InterviewStatus>(), default: () => "in_progress" }),
});

type GraphState = typeof InterviewAnnotation.State;

// ─────────────────────────────────────────────────────────────────────────────
// 노드들
// ─────────────────────────────────────────────────────────────────────────────

/** 메인 질문 생성(첫 질문 포함). 누적 질문 번호를 부여한다. */
async function generateMainQuestionNode(state: GraphState): Promise<Partial<GraphState>> {
  const index = state.questionCount + 1;
  // 주제 카탈로그는 resumeText 만으로 결정되므로 호출 간 안정적이다(같은 주제 키).
  const topics = extractResumeTopics(state.resumeText);
  const gen = await generateInterviewQuestion({
    resumeText: state.resumeText,
    context: state.context,
    previousQuestions: state.questionHistory,
    previousAnswers: state.answerHistory,
    evaluations: state.evaluations,
    topics,
    topicCounts: state.topicCounts,
    perspectiveCounts: state.perspectiveCounts,
  });
  const question: InterviewQuestion = {
    index,
    type: "main",
    question: gen.question,
    basis: gen.basis,
    topicKey: gen.topicKey,
    perspectiveKey: gen.perspectiveKey,
  };
  // 메인 질문만 주제·관점 횟수에 포함한다(꼬리질문은 세지 않는다). 값이 2가 되면 다음부터 제외.
  const topicCounts = {
    ...state.topicCounts,
    [gen.topicKey]: (state.topicCounts[gen.topicKey] ?? 0) + 1,
  };
  const perspectiveCounts = {
    ...state.perspectiveCounts,
    [gen.perspectiveKey]: (state.perspectiveCounts[gen.perspectiveKey] ?? 0) + 1,
  };
  return {
    currentQuestion: question,
    questionHistory: [...state.questionHistory, question],
    questionCount: index,
    topicCounts,
    perspectiveCounts,
  };
}

/** 꼬리질문 생성. 직전(메인) 질문/답변의 약점을 파고든다. */
async function generateFollowupQuestionNode(state: GraphState): Promise<Partial<GraphState>> {
  const index = state.questionCount + 1;
  const prevQuestion = state.currentQuestion!;
  const prevAnswer = state.currentAnswer ?? "";
  const prevEval = state.evaluations[state.evaluations.length - 1];
  const gen = await generateFollowupQuestion({
    resumeText: state.resumeText,
    context: state.context,
    question: prevQuestion.question,
    answer: prevAnswer,
    evaluation: prevEval,
  });
  const question: InterviewQuestion = {
    index,
    type: "followup",
    question: gen.question,
    basis: gen.basis,
    // 꼬리질문은 직전 메인 질문과 같은 주제·관점을 더 깊이 파는 것이므로 키를 물려받는다.
    // (주제·관점별 횟수에는 포함하지 않는다 — 메인 질문만 센다.)
    topicKey: prevQuestion.topicKey,
    perspectiveKey: prevQuestion.perspectiveKey,
  };
  return {
    currentQuestion: question,
    questionHistory: [...state.questionHistory, question],
    questionCount: index,
  };
}

/**
 * 사람의 답변을 기다리는 노드.
 * interrupt() 가 그래프를 일시정지시키고, resume 될 때 답변 문자열을 돌려준다.
 */
async function humanAnswerNode(state: GraphState): Promise<Partial<GraphState>> {
  const current = state.currentQuestion!;
  const answer = interrupt<{ index: number; question: string }, string>({
    index: current.index,
    question: current.question,
  });
  return {
    currentAnswer: answer,
    answerHistory: [...state.answerHistory, answer],
  };
}

/** 직전 답변을 평가해 evaluations 에 누적한다. */
async function evaluateNode(state: GraphState): Promise<Partial<GraphState>> {
  const current = state.currentQuestion!;
  const evaluation = await evaluateInterviewAnswer({
    resumeText: state.resumeText,
    context: state.context,
    question: current.question,
    answer: state.currentAnswer ?? "",
    questionIndex: current.index,
  });
  return { evaluations: [...state.evaluations, evaluation] };
}

/** 최종 리포트 생성 후 면접 종료. */
async function generateReportNode(state: GraphState): Promise<Partial<GraphState>> {
  const report = await generateFinalReport({
    resumeText: state.resumeText,
    context: state.context,
    questionHistory: state.questionHistory,
    answerHistory: state.answerHistory,
    evaluations: state.evaluations,
  });
  return { finalReport: report, status: "completed" };
}

/** 꼬리질문 판단 점수 임계값. 이 값 미만이면 약점으로 본다. */
const FOLLOWUP_SCORE_THRESHOLD = 70;

/**
 * 답변이 약해 꼬리질문이 필요한지 점수 기반으로 결정적으로 판단한다.
 * LLM 의 needsFollowup 불리언은 변덕이 심해 신뢰하지 않고, 평가 점수만 본다.
 */
function answerNeedsFollowup(ev: AnswerEvaluation | undefined): boolean {
  if (!ev) return false;
  if (!ev.resultPresented) return true;
  return (
    ev.specificity < FOLLOWUP_SCORE_THRESHOLD ||
    ev.roleClarity < FOLLOWUP_SCORE_THRESHOLD ||
    ev.resumeConsistency < FOLLOWUP_SCORE_THRESHOLD
  );
}

/**
 * 평가 후 다음 행동 결정.
 *  - 누적 질문이 한도 도달 → 리포트
 *  - 현재가 메인이고 답변이 약함(점수 기반) → 꼬리질문 (메인당 1회)
 *  - 그 외 → 다음 메인 질문
 */
function routeAfterEvaluate(state: GraphState): "followup" | "next" | "report" {
  if (state.questionCount >= state.maxQuestions) return "report";
  const current = state.currentQuestion!;
  const lastEval = state.evaluations[state.evaluations.length - 1];
  if (current.type === "main" && answerNeedsFollowup(lastEval)) return "followup";
  return "next";
}

// ─────────────────────────────────────────────────────────────────────────────
// 그래프 컴파일(모듈 단위 싱글톤).
// 체크포인터를 Postgres 로 두어, 서버 재시작/다중 인스턴스에도 interrupt 지점에서
// 면접을 이어서 재개할 수 있게 한다. 앱과 같은 pg 풀(../db.js)을 공유한다.
// (체크포인트 테이블은 부팅 시 setupInterviewCheckpointer() 의 setup() 으로 생성된다.)
// ─────────────────────────────────────────────────────────────────────────────
const checkpointer = new PostgresSaver(pool);

/** 부팅 시 1회 호출. LangGraph 체크포인트 테이블(checkpoints 등)을 생성/마이그레이션한다. */
export async function setupInterviewCheckpointer(): Promise<void> {
  await checkpointer.setup();
}

const graph = new StateGraph(InterviewAnnotation)
  .addNode("generateQuestion", generateMainQuestionNode)
  .addNode("human", humanAnswerNode)
  .addNode("evaluate", evaluateNode)
  .addNode("generateFollowup", generateFollowupQuestionNode)
  .addNode("generateReport", generateReportNode)
  .addEdge(START, "generateQuestion")
  .addEdge("generateQuestion", "human")
  .addEdge("generateFollowup", "human")
  .addEdge("human", "evaluate")
  .addConditionalEdges("evaluate", routeAfterEvaluate, {
    followup: "generateFollowup",
    next: "generateQuestion",
    report: "generateReport",
  })
  .addEdge("generateReport", END)
  .compile({ checkpointer });

function configFor(interviewId: string) {
  return { configurable: { thread_id: interviewId } };
}

/** 체크포인터에서 현재 상태를 읽는다. 없는 세션이면 null. */
async function readValues(interviewId: string): Promise<GraphState | null> {
  const snapshot = await graph.getState(configFor(interviewId));
  const values = snapshot.values as GraphState | undefined;
  if (!values || !values.interviewId) return null;
  return values;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fastify 라우트에서 호출할 공개 API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 면접 시작. resumeText/context 를 분석해 첫 질문을 생성하고 답변 대기 상태로 멈춘다.
 */
export async function startInterview(input: StartInterviewInput): Promise<StartInterviewResult> {
  const resumeText = (input?.resumeText ?? "").trim();
  if (!resumeText) throw new Error("resumeText 가 비어 있습니다.");
  const context = (input?.context ?? "").trim();
  const maxQuestions = clampMax(input?.maxQuestions);

  const interviewId = randomUUID();
  const config = configFor(interviewId);

  // 그래프가 generateQuestion → human(interrupt) 까지 진행하고 멈춘다.
  await graph.invoke(
    {
      interviewId,
      resumeText,
      context,
      maxQuestions,
      questionCount: 0,
      topicCounts: {},
      perspectiveCounts: {},
      questionHistory: [],
      answerHistory: [],
      evaluations: [],
      currentQuestion: null,
      currentAnswer: null,
      finalReport: null,
      status: "in_progress",
    },
    config
  );

  const values = await readValues(interviewId);
  if (!values || !values.currentQuestion) {
    throw new Error("면접 상태 초기화에 실패했습니다.");
  }
  return { interviewId, status: values.status, question: values.currentQuestion };
}

/**
 * 답변 제출. 답변 저장 → 평가 → 꼬리질문/다음질문/리포트 결정까지 한 번에 진행한다.
 */
export async function submitAnswer(input: SubmitAnswerInput): Promise<SubmitAnswerResult> {
  const interviewId = input?.interviewId ?? "";
  const answer = (input?.answer ?? "").trim();
  if (!answer) throw new Error("answer 가 비어 있습니다.");

  const config = configFor(interviewId);
  const before = await readValues(interviewId);
  if (!before) throw new Error(`존재하지 않는 면접입니다: ${interviewId}`);
  if (before.status === "completed") throw new Error("이미 종료된 면접입니다.");

  // Command(resume) 로 human 노드를 재개 → evaluate → 분기
  //  → (다음 질문 생성 후 interrupt 로 멈춤) | (리포트 생성 후 END)
  await graph.invoke(new Command({ resume: answer }), config);

  const values = await readValues(interviewId);
  if (!values) throw new Error("면접 상태 조회에 실패했습니다.");

  const evaluation = values.evaluations[values.evaluations.length - 1];

  if (values.status === "completed" && values.finalReport) {
    return { interviewId, status: "completed", evaluation, finalReport: values.finalReport };
  }

  return {
    interviewId,
    status: "in_progress",
    evaluation,
    nextQuestion: values.currentQuestion ?? undefined,
  };
}

/** 디버깅/조회용: 현재 면접 상태 스냅샷. */
export async function getInterviewState(interviewId: string): Promise<GraphState | null> {
  return readValues(interviewId);
}

function clampMax(v: number | undefined): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return MAX_QUESTIONS;
  return Math.min(8, Math.max(3, n));
}
