// 평정심 점수 계산 — 타이밍(지연) + 말(채움말·회피) + 영상(눈·시선·고개)을 종합한다.
// 각 항목 0~100(높을수록 안정). 측정 안 된 항목(영상/STT 미지원)은 총점에서 제외한다.

import type { ComposureReport, ComposureSubScore } from "@e-lifethon/shared";
import type { FaceWindowMetrics } from "./faceTracker";

export interface PerAnswerSignal {
  index: number;
  responseDelayMs: number | null; // 질문 표시 → 첫 발화(ms). STT 없으면 null.
  questionChars: number; // 질문 글자 수(읽는 시간 추정용)
  answerChars: number; // 답변 실질 글자 수
  fillerCount: number;
  hedgeCount: number;
  face: FaceWindowMetrics | null; // 그 답변 구간의 영상 신호
}

// 질문 읽는 시간 추정: 한국어 묵독 ~8자/초 + 최소 이해 여유. 이만큼은 '지연'으로 보지 않는다.
const READ_CHARS_PER_SEC = 8;
const MIN_READ_MS = 1800;
function readingAllowanceMs(questionChars: number): number {
  return Math.max(MIN_READ_MS, (questionChars / READ_CHARS_PER_SEC) * 1000);
}
/** 질문 읽는 시간을 뺀 순수 생각/머뭇 시간(음수는 0). */
function thinkingDelayMs(p: PerAnswerSignal): number | null {
  if (p.responseDelayMs == null) return null;
  return Math.max(0, p.responseDelayMs - readingAllowanceMs(p.questionChars));
}

export interface ComposureInput {
  perAnswer: PerAnswerSignal[];
  totalSpeakingSec: number; // 발화가 진행된 총 시간(대략 duration)
  faceSummary: FaceWindowMetrics | null;
  sttMeasured: boolean; // STT 로 타이밍/텍스트를 실제로 측정했는지
}

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x: number) => Math.round(x);

const WEIGHTS: Record<ComposureSubScore["key"], number> = {
  responseDelay: 0.18,
  fluency: 0.18,
  engagement: 0.14,
  gaze: 0.18,
  eyeStability: 0.18,
  posture: 0.14,
};

export function computeComposure(input: ComposureInput): ComposureReport {
  const { perAnswer, totalSpeakingSec, faceSummary, sttMeasured } = input;

  // ── 타이밍/말 지표 ──
  const delays = perAnswer.map((p) => p.responseDelayMs).filter((d): d is number => d != null);
  const avgDelay = delays.length ? avg(delays) : null;
  const maxDelay = delays.length ? Math.max(...delays) : null;
  // 질문 읽는 시간을 뺀 '순수 생각/머뭇' 시간(점수 기준). 긴 질문일수록 읽는 시간을 더 준다.
  const thinkDelays = perAnswer.map(thinkingDelayMs).filter((d): d is number => d != null);
  const avgThink = thinkDelays.length ? avg(thinkDelays) : null;
  const totalFillers = perAnswer.reduce((a, p) => a + p.fillerCount, 0);
  const totalHedges = perAnswer.reduce((a, p) => a + p.hedgeCount, 0);
  const fillerPerMin = sttMeasured && totalSpeakingSec > 5 ? totalFillers / (totalSpeakingSec / 60) : null;
  const answerCharsArr = perAnswer.map((p) => p.answerChars);
  const avgAnswerChars = answerCharsArr.length ? avg(answerCharsArr) : null;
  const totalChars = answerCharsArr.reduce((a, b) => a + b, 0);
  const charsPerSec = sttMeasured && totalSpeakingSec > 5 ? totalChars / totalSpeakingSec : null;

  const subs: ComposureSubScore[] = [];

  // 1) 응답 순발력 — 질문 읽는 시간을 뺀 '생각/머뭇' 시간으로 채점(1.5초까지는 만점).
  if (sttMeasured && avgThink != null) {
    const s = clamp(100 - Math.max(0, avgThink - 1500) / 75);
    subs.push({
      key: "responseDelay",
      label: "응답 순발력",
      score: round(s),
      detail:
        `질문 읽는 시간 제외, 평균 ${(avgThink / 1000).toFixed(1)}초 뒤 답변 시작` +
        (avgDelay != null ? ` (원지연 평균 ${(avgDelay / 1000).toFixed(1)}초)` : ""),
      measured: true,
    });
  }

  // 2) 유창성 — 분당 채움말.
  if (fillerPerMin != null) {
    const s = clamp(100 - fillerPerMin * 6);
    subs.push({
      key: "fluency",
      label: "말 유창성",
      score: round(s),
      detail: `분당 채움말(음·어·그…) ${fillerPerMin.toFixed(1)}회`,
      measured: true,
    });
  }

  // 3) 답변 충실도 — 짧은 답/회피 표현.
  if (sttMeasured && avgAnswerChars != null) {
    let s = clamp(40 + (avgAnswerChars - 20) * 0.6); // 20자 40점 → 120자 100점
    s = clamp(s - totalHedges * 6); // 회피/불확실 표현 감점
    subs.push({
      key: "engagement",
      label: "답변 충실도",
      score: round(s),
      detail: `답변 평균 ${round(avgAnswerChars)}자` + (totalHedges ? `, 회피·불확실 표현 ${totalHedges}회` : ""),
      measured: true,
    });
  }

  // ── 영상 지표 ──
  const f = faceSummary;
  const faceOk = !!f?.faceMeasured;

  // 4) 시선 안정.
  subs.push(
    faceOk && f!.gazeAwayPct != null
      ? {
          key: "gaze",
          label: "시선 안정",
          score: round(clamp(100 - f!.gazeAwayPct * 120)),
          detail: `시선이 정면을 벗어난 시간 ${round(f!.gazeAwayPct * 100)}%`,
          measured: true,
        }
      : unmeasured("gaze", "시선 안정")
  );

  // 5) 눈 안정 — 눈 떨림 + 과도한 깜빡임.
  if (faceOk && f!.eyeJitter != null) {
    const blinkPenalty = f!.blinkPerMin != null ? Math.max(0, f!.blinkPerMin - 25) * 1.5 : 0;
    const s = clamp(100 - f!.eyeJitter * 90 - blinkPenalty);
    subs.push({
      key: "eyeStability",
      label: "눈 안정(떨림·깜빡임)",
      score: round(s),
      detail:
        `눈 떨림 지표 ${(f!.eyeJitter * 100).toFixed(0)}/100` +
        (f!.blinkPerMin != null ? `, 깜빡임 분당 ${round(f!.blinkPerMin)}회` : ""),
      measured: true,
    });
  } else {
    subs.push(unmeasured("eyeStability", "눈 안정(떨림·깜빡임)"));
  }

  // 6) 자세 안정 — 고개 흔들림.
  subs.push(
    faceOk && f!.headJitter != null
      ? {
          key: "posture",
          label: "자세 안정",
          score: round(clamp(100 - f!.headJitter * 110)),
          detail: `고개 흔들림 지표 ${(f!.headJitter * 100).toFixed(0)}/100`,
          measured: true,
        }
      : unmeasured("posture", "자세 안정")
  );

  // ── 종합 ──
  const measured = subs.filter((s) => s.measured);
  const wsum = measured.reduce((a, s) => a + WEIGHTS[s.key], 0);
  const overall = wsum > 0 ? round(measured.reduce((a, s) => a + s.score * WEIGHTS[s.key], 0) / wsum) : 0;
  const grade: ComposureReport["grade"] = overall >= 75 ? "안정" : overall >= 55 ? "보통" : "긴장";

  const notes = buildNotes(measured, { avgThink, fillerPerMin, totalHedges, face: f });

  return {
    overall,
    grade,
    subs,
    metrics: {
      avgResponseDelayMs: avgDelay,
      maxResponseDelayMs: maxDelay,
      avgThinkingDelayMs: avgThink,
      fillerPerMin,
      fillerCount: sttMeasured ? totalFillers : null,
      avgAnswerChars,
      speakingCharsPerSec: charsPerSec,
      faceMeasured: faceOk,
      facePresencePct: f?.facePresencePct ?? null,
      blinkPerMin: f?.blinkPerMin ?? null,
      eyeJitter: f?.eyeJitter ?? null,
      gazeAwayPct: f?.gazeAwayPct ?? null,
      headJitter: f?.headJitter ?? null,
      tension: f?.tension ?? null,
    },
    perAnswer: perAnswer.map((p) => ({
      index: p.index,
      responseDelayMs: p.responseDelayMs,
      answerChars: p.answerChars,
      fillerCount: p.fillerCount,
      eyeJitter: p.face?.eyeJitter ?? null,
      gazeAwayPct: p.face?.gazeAwayPct ?? null,
    })),
    notes,
  };
}

function unmeasured(key: ComposureSubScore["key"], label: string): ComposureSubScore {
  return { key, label, score: 0, detail: "측정 안 됨(카메라/브라우저 미지원)", measured: false };
}

function buildNotes(
  measured: ComposureSubScore[],
  ctx: {
    avgThink: number | null;
    fillerPerMin: number | null;
    totalHedges: number;
    face: FaceWindowMetrics | null;
  }
): string[] {
  const notes: string[] = [];
  const weakest = [...measured].sort((a, b) => a.score - b.score).slice(0, 2);
  for (const w of weakest) {
    if (w.score >= 80) continue; // 다 좋으면 굳이 지적 안 함
    if (w.key === "responseDelay" && ctx.avgThink != null && ctx.avgThink > 2500)
      notes.push(`질문을 다 읽은 뒤에도 평균 ${(ctx.avgThink / 1000).toFixed(1)}초 머뭇거려요. 첫 문장을 미리 준비하면 순발력이 올라갑니다.`);
    else if (w.key === "fluency" && ctx.fillerPerMin != null && ctx.fillerPerMin > 4)
      notes.push(`"음·어·그…" 채움말이 분당 ${ctx.fillerPerMin.toFixed(1)}회예요. 한 박자 쉬고 말하면 줄어듭니다.`);
    else if (w.key === "engagement")
      notes.push(ctx.totalHedges > 0 ? "회피·불확실 표현이 보여요. 모르면 아는 범위까지 구조적으로 답해보세요." : "답변이 다소 짧아요. 상황-행동-결과로 구체화해보세요.");
    else if (w.key === "gaze" && ctx.face?.gazeAwayPct != null && ctx.face.gazeAwayPct > 0.25)
      notes.push(`시선이 정면을 ${Math.round(ctx.face.gazeAwayPct * 100)}% 벗어났어요. 카메라를 면접관 눈이라 생각하고 응시해보세요.`);
    else if (w.key === "eyeStability" && ctx.face)
      notes.push(`긴장하면 눈 떨림·깜빡임이 늘어요${ctx.face.blinkPerMin != null ? ` (분당 ${Math.round(ctx.face.blinkPerMin)}회)` : ""}. 깊게 호흡하고 시선을 고정해보세요.`);
    else if (w.key === "posture" && ctx.face)
      notes.push("고개 움직임이 잦아요. 어깨를 펴고 상체를 고정하면 안정적으로 보입니다.");
  }
  if (!notes.length) notes.push("전반적으로 안정적인 대응력을 보였어요. 이 페이스를 유지하세요.");
  return notes;
}
