// 평정심 점수 리포트 카드 — 타이밍(지연)·말(채움말/회피)·영상(눈·시선·고개)을 종합한 결과 표시.
import type { ComposureReport } from "@e-lifethon/shared";

const GRADE_CLASS: Record<ComposureReport["grade"], string> = {
  안정: "calm",
  보통: "mid",
  긴장: "tense",
};

function barClass(score: number): string {
  return score >= 75 ? "good" : score >= 55 ? "mid" : "low";
}

export default function ComposureCard({ composure }: { composure: ComposureReport }) {
  const c = composure;
  const measured = c.subs.filter((s) => s.measured);
  const unmeasured = c.subs.filter((s) => !s.measured);

  return (
    <div className="cmp-card">
      <div className="cmp-head">
        <div className="cmp-head-title">평정심 점수 리포트</div>
        <div className="cmp-head-sub">답변 지연·채움말·회피 + 영상(눈 떨림·시선·표정)을 분석한 압박 대응력</div>
      </div>

      <div className="cmp-top">
        <div className={`cmp-score ${GRADE_CLASS[c.grade]}`}>
          <span className="cmp-score-num">{c.overall}</span>
          <span className="cmp-score-unit">/100</span>
          <span className="cmp-score-grade">{c.grade}</span>
        </div>
        <ul className="cmp-bars">
          {measured.map((s) => (
            <li key={s.key} className="cmp-bar-row">
              <span className="cmp-bar-label">{s.label}</span>
              <span className="cmp-bar-track">
                <span className={`cmp-bar-fill ${barClass(s.score)}`} style={{ width: `${s.score}%` }} />
              </span>
              <span className="cmp-bar-score">{s.score}</span>
              <span className="cmp-bar-detail">{s.detail}</span>
            </li>
          ))}
        </ul>
      </div>

      {c.notes.length > 0 && (
        <ul className="cmp-notes">
          {c.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      {unmeasured.length > 0 && (
        <div className="cmp-unmeasured">
          측정 안 됨: {unmeasured.map((s) => s.label).join(" · ")}
          {!c.metrics.faceMeasured && " — 카메라 얼굴 인식이 안 돼 영상 항목이 빠졌어요(조명·정면·최신 브라우저 권장)."}
        </div>
      )}
    </div>
  );
}
