import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ComposureReport, InterviewReport, InterviewRecording, PublicUser } from "@e-lifethon/shared";
import { deleteRecording, getRecordings, recordingVideoUrl } from "../api";
import AppShell from "../components/AppShell";
import PageHeader from "../components/PageHeader";
import Splash from "../components/Splash";
import { ChevronDownIcon, CopyIcon, FilmIcon, PlayIcon, SparkleIcon, TrashIcon } from "../components/icons";
import { formatSpeech } from "../format";
import "./practice.css";

// 면접 기록: 저장된 녹화 목록 → 선택하면 영상 재생 + 변환된 자막 전체를 본다.

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}분 ${s}초` : `${s}초`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// 목록 썸네일: 녹화 영상의 한 프레임을 보여준다.
// 카메라를 끈(영상 트랙이 없는) 녹화면 프레임이 없으므로 기존 필름 아이콘으로 대체한다.
function RecordingThumb({ id, open }: { id: number; open: boolean }) {
  const [fallback, setFallback] = useState(false);

  if (fallback) {
    return (
      <span className="acc-thumb" aria-hidden>
        {open ? <PlayIcon size={16} /> : <FilmIcon size={16} />}
      </span>
    );
  }

  return (
    <span className="acc-thumb acc-thumb-video" aria-hidden>
      <video
        src={`${recordingVideoUrl(id)}#t=0.1`}
        muted
        playsInline
        preload="metadata"
        tabIndex={-1}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (!v.videoWidth || !v.videoHeight) {
            setFallback(true); // 영상 트랙 없음(카메라 끈 녹화) → 아이콘
            return;
          }
          // 첫 프레임이 그려지도록 살짝 탐색.
          try {
            v.currentTime = Math.min(0.1, v.duration || 0.1);
          } catch {
            /* 탐색 실패는 무시(포스터 프레임 사용) */
          }
        }}
        onError={() => setFallback(true)}
      />
      <span className="acc-thumb-overlay">
        {open ? <PlayIcon size={15} /> : <FilmIcon size={13} />}
      </span>
    </span>
  );
}

export function History({
  user,
  onUser,
  onLogout,
}: {
  user: PublicUser;
  onUser: (u: PublicUser) => void;
  onLogout: () => void;
}) {
  const [items, setItems] = useState<InterviewRecording[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      const list = await getRecordings();
      setItems(list);
      setSelectedId((cur) => cur ?? list[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "불러오기에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onDelete(id: number) {
    if (!window.confirm("이 면접 기록을 삭제할까요? 영상과 자막이 모두 삭제됩니다.")) return;
    try {
      await deleteRecording(id);
      setItems((prev) => {
        const next = prev.filter((r) => r.id !== id);
        setSelectedId((cur) => (cur === id ? next[0]?.id ?? null : cur));
        return next;
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : "삭제에 실패했습니다.");
    }
  }

  const [copied, setCopied] = useState(false);
  async function onCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 클립보드 접근 불가 시 무시 */
    }
  }


  if (loading) return <Splash />;

  return (
    <AppShell user={user} onUser={onUser} onLogout={onLogout}>
      <PageHeader title="면접 기록">
        면접 연습에서 녹화한 영상과 실시간 자막은 물론, AI 모의면접 리포트(질문별 평가·강점/보완점·예상 질문)와 평정심 점수를 PDF로 저장할 수 있습니다.
      </PageHeader>

      {error && <div className="pr-alert">{error}</div>}

      {items.length === 0 ? (
        <div className="pr-empty">
          아직 저장된 면접 기록이 없습니다.{" "}
          <Link to="/practice" className="pr-link">
            면접 연습
          </Link>{" "}
          에서 녹화를 시작해 보세요.
        </div>
      ) : (
        <ul className="acc-list">
          {items.map((r) => {
            const open = r.id === selectedId;
            const cmp = r.interview_report?.composure;
            return (
              <li key={r.id} className={`acc-card${open ? " open" : ""}`}>
                <div className="acc-head">
                  <button
                    type="button"
                    className="acc-head-btn"
                    onClick={() => setSelectedId(open ? null : r.id)}
                  >
                    <RecordingThumb id={r.id} open={open} />

                    <span className="acc-head-text">
                      <span className="acc-title">{r.title}</span>
                      <span className="acc-meta">
                        {fmtDate(r.created_at)} · {fmtDuration(r.duration_sec)} · {fmtSize(r.size_bytes)}
                      </span>
                    </span>
                    {cmp && <span className="acc-badge">평정심 {cmp.overall}</span>}
                  </button>
                  <button
                    type="button"
                    className="acc-act danger"
                    title="이 기록 삭제"
                    aria-label="삭제"
                    onClick={() => onDelete(r.id)}
                  >
                    <TrashIcon size={16} />
                  </button>
                  <button
                    type="button"
                    className="acc-chev-btn"
                    onClick={() => setSelectedId(open ? null : r.id)}
                    aria-label={open ? "접기" : "펼치기"}
                  >
                    <span className="acc-chev">
                      <ChevronDownIcon size={16} />
                    </span>
                  </button>
                </div>

                {open && (
                  <div className="acc-body">
                    <div className="pr-hist-stage">
                      <video
                        key={r.id}
                        className="pr-video"
                        controls
                        playsInline
                        src={recordingVideoUrl(r.id)}
                      />
                    </div>

                    <div className="pr-hist-transcript-card">
                      <div className="pr-transcript-head">
                        <span>답변</span>
                        {r.transcript.trim() && (
                          <button
                            type="button"
                            className="pr-copy-btn"
                            onClick={() => onCopy(r.transcript)}
                          >
                            <CopyIcon size={14} /> {copied ? "복사됨" : "복사"}
                          </button>
                        )}
                      </div>
                      <div className="pr-hist-transcript">
                        {r.transcript.trim() ? (
                          formatSpeech(r.transcript).map((ln, k) => (
                            <p key={k} className="pr-answer-line">
                              {ln}
                            </p>
                          ))
                        ) : (
                          <span className="pr-transcript-empty">자막이 없습니다.</span>
                        )}
                      </div>
                    </div>

                    {/* AI 모의면접으로 녹화한 기록이면 질문·평가·리포트를 함께 보여준다 */}
                    {r.interview_report && (
                      <InterviewReportDoc
                        report={r.interview_report}
                        title={r.title}
                        dateIso={r.created_at}
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </AppShell>
  );
}

// 리포트 상단에 표시할 날짜 — "2026. 7. 1.(수)" 형태(참고 디자인의 공식 보고서 양식).
function fmtReportDate(iso: string): string {
  const d = new Date(iso);
  const dow = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.(${dow})`;
}

// 브라우저 인쇄(PDF로 저장). 격리는 @media print 에서 .rep-doc 기준으로 처리하므로
// 여기서는 인쇄 대화상자만 연다(모바일에서 afterprint 조기 발생 이슈 회피).
function printReportDoc() {
  window.print();
}

function barClass(score: number): string {
  return score >= 75 ? "rep-bar-good" : score >= 55 ? "rep-bar-mid" : "rep-bar-low";
}

const GRADE_CLASS: Record<ComposureReport["grade"], string> = {
  안정: "calm",
  보통: "mid",
  긴장: "tense",
};

// 점수 → 배지 색 등급(평정심 배지와 동일 기준). 75+ 초록 · 55~74 노랑 · 0~54 빨강.
function scoreGradeClass(score: number | null): string {
  if (score == null) return "";
  return score >= 75 ? "calm" : score >= 55 ? "mid" : "tense";
}

// 저장된 AI 모의면접 결과를 공식 보고서(A4) 형식으로 보여준다.
// 순서: AI 모의면접 리포트 → 평정심 점수 리포트. PDF 다운로드(인쇄) 지원.
function InterviewReportDoc({
  report,
  title,
  dateIso,
}: {
  report: InterviewReport;
  title: string;
  dateIso: string;
}) {
  const fr = report.finalReport;
  const cmp = report.composure;
  const basedOn = report.basedOn;

  const scored = report.evaluations.filter((e) => e && typeof e.score === "number");
  const avg = scored.length
    ? Math.round(scored.reduce((sum, e) => sum + e.score, 0) / scored.length)
    : null;

  return (
    <div className="rep-doc">
      <div className="rep-toolbar">
        <button type="button" className="rep-pdf-btn" onClick={printReportDoc}>
          PDF 다운로드
        </button>
      </div>

      <article className="rep-page">
        <span className="rep-tag">模擬</span>

        <header className="rep-titleblock">
          <h1 className="rep-title">모의면접 리포트</h1>
          <p className="rep-sub">
            {fmtReportDate(dateIso)} · InterviewForge
            {basedOn?.jobTitle ? ` · ${basedOn.jobTitle}` : ""}
            {basedOn?.companyName ? ` (${basedOn.companyName})` : ""}
          </p>
          <p className="rep-sub rep-sub-title">{title}</p>
        </header>

        {/* 종합 평가 */}
        <section className="rep-section">
          <h2 className="rep-h">
            <SparkleIcon size={15} /> 종합 평가
          </h2>
          <div className="rep-overview">
            <div className={`rep-score-badge ${scoreGradeClass(avg)}`}>
              <span className="rep-score-num">{avg ?? "–"}</span>
              <span className="rep-score-unit">/ 100</span>
            </div>
            <div className="rep-overview-body">
              {fr?.summary ? (
                <p>{fr.summary}</p>
              ) : (
                <p className="rep-muted">최종 리포트가 생성되지 않은 기록입니다(중간 종료).</p>
              )}
              <div className="rep-meta-row">
                <span>
                  <b>질문 수</b>
                  {report.questions.length}개
                </span>
                {cmp && (
                  <span>
                    <b>평정심</b>
                    {cmp.overall} ({cmp.grade})
                  </span>
                )}
                <span>
                  <b>이력서</b>
                  {basedOn?.resumeName
                    ? basedOn.resumeName
                    : basedOn?.resumeUsed
                    ? "사용함"
                    : "미사용"}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* 질문별 평가 */}
        {report.questions.length > 0 && (
          <section className="rep-section">
            <h2 className="rep-h">□ 질문별 평가</h2>
            <div className="rep-table-wrap">
            <table className="rep-table">
              <thead>
                <tr>
                  <th className="rep-qnum">Q</th>
                  <th>질문 · 답변</th>
                  <th className="rep-cell-score">점수</th>
                  <th className="rep-eval-col">평가</th>
                </tr>
              </thead>
              <tbody>
                {report.questions.map((q, i) => {
                  const ev = report.evaluations[i];
                  const lines = formatSpeech(report.answers[i] ?? "");
                  return (
                    <tr key={q.index}>
                      <td className="rep-qnum">
                        {q.index}
                        {q.type === "followup" && <span className="rep-follow">꼬리 질문</span>}
                      </td>
                      <td>
                        <p className="rep-q">{q.question}</p>
                        <div className="rep-a">
                          {lines.length ? (
                            lines.map((ln, k) => (
                              <span key={k} className="rep-a-line">
                                {ln}
                              </span>
                            ))
                          ) : (
                            <span className="rep-a-empty">(인식된 답변 없음)</span>
                          )}
                        </div>
                      </td>
                      <td className="rep-cell-score">{ev ? ev.score : "–"}</td>
                      <td className="rep-eval-col">
                        {ev ? (
                          <>
                            <div className="rep-eval-sub">
                              구체성 {ev.specificity} · 역할 {ev.roleClarity} · 일관성{" "}
                              {ev.resumeConsistency}
                            </div>
                            {ev.rationale && <p className="rep-eval-txt">{ev.rationale}</p>}
                          </>
                        ) : (
                          <span className="rep-muted">–</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </section>
        )}

        {/* 강점 / 보완점 */}
        {fr && (fr.strengths.length > 0 || fr.improvements.length > 0) && (
          <section className="rep-section">
            <h2 className="rep-h">□ 강점 및 보완점</h2>
            <div className="rep-two">
              <div>
                <h3 className="rep-h3">강점</h3>
                <ul className="rep-ul">
                  {fr.strengths.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="rep-h3">보완점</h3>
                <ul className="rep-ul">
                  {fr.improvements.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        )}

        {/* 다음 준비 조언 */}
        {fr && fr.nextSteps.length > 0 && (
          <section className="rep-section">
            <h2 className="rep-h">○ 다음 면접 준비 조언</h2>
            <ul className="rep-ul">
              {fr.nextSteps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </section>
        )}

        {/* 예상 질문 */}
        {fr && fr.expectedQuestions.length > 0 && (
          <section className="rep-section">
            <h2 className="rep-h">○ 더 준비하면 좋은 예상 질문</h2>
            <ul className="rep-ul">
              {fr.expectedQuestions.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </section>
        )}

        {/* 평정심 점수 리포트 — AI 리포트 아래로 이동 */}
        {cmp && <ComposureSection composure={cmp} />}

        <footer className="rep-footer">
          본 리포트는 InterviewForge AI가 자동 생성했습니다 · 참고용
        </footer>
      </article>
    </div>
  );
}

// 평정심 점수 리포트 — 보고서 문서 안에 표 형식으로 렌더링한다.
function ComposureSection({ composure }: { composure: ComposureReport }) {
  const c = composure;
  const measured = c.subs.filter((s) => s.measured);
  const unmeasured = c.subs.filter((s) => !s.measured);

  return (
    <section className="rep-section">
      <h2 className="rep-h">□ 평정심 점수 리포트</h2>
      <p className="rep-note-line">
        답변 지연·채움말·회피 + 영상(눈 떨림·시선·표정)을 분석한 압박 대응력
      </p>
      <div className="rep-overview">
        <div className={`rep-score-badge ${GRADE_CLASS[c.grade]}`}>
          <span className="rep-score-num">{c.overall}</span>
          <span className="rep-score-unit">/ 100</span>
        </div>
        <div className="rep-overview-body">
          <div className="rep-table-wrap">
          <table className="rep-table">
            <thead>
              <tr>
                <th>항목</th>
                <th className="rep-barcol">점수</th>
                <th>근거</th>
              </tr>
            </thead>
            <tbody>
              {measured.map((s) => (
                <tr key={s.key}>
                  <td className="rep-cmp-label">{s.label}</td>
                  <td className="rep-barcol">
                    <div className="rep-barcell">
                      <span className="rep-bar">
                        <span className={barClass(s.score)} style={{ width: `${s.score}%` }} />
                      </span>
                      <b>{s.score}</b>
                    </div>
                  </td>
                  <td className="rep-eval-txt">{s.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      </div>

      {c.notes.length > 0 && (
        <ul className="rep-ul">
          {c.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      {unmeasured.length > 0 && (
        <p className="rep-muted rep-small">
          측정 안 됨: {unmeasured.map((s) => s.label).join(" · ")}
          {!c.metrics.faceMeasured &&
            " — 카메라 얼굴 인식이 안 돼 영상 항목이 빠졌어요(조명·정면·최신 브라우저 권장)."}
        </p>
      )}
    </section>
  );
}
