import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  AiAnswerEvaluation,
  AiFinalReport,
  AiInterviewBasedOn,
  AiInterviewQuestion,
  InterviewReport,
  PublicUser,
  Resume,
} from "@e-lifethon/shared";
import { getResumes, saveRecording, startAiInterview, submitAiInterviewAnswer } from "../api";
import AppShell from "../components/AppShell";
import PageHeader from "../components/PageHeader";
import { CameraIcon, CameraOffIcon, SparkleIcon } from "../components/icons";
import "./practice.css";

// 면접 연습: 웹캠으로 내 모습을 녹화하고, 말한 내용을 Web Speech API 로 실시간 자막화한다.
// 정지하면 영상(webm) + 자막을 DB 에 저장 → 면접 기록에서 다시 볼 수 있다.

type Phase = "idle" | "ready" | "recording" | "review" | "saving";

// 브라우저 내장 음성인식 생성자(webkit 접두사 포함) 가져오기. 미지원이면 null.
function getSpeechRecognition(): { new (): SpeechRecognition } | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// 이력서 선택 드롭다운에 보일 짧은 날짜(YY.MM.DD).
function fmtResumeDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear()).slice(2)}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

export function Practice({
  user,
  onUser,
  onLogout,
}: {
  user: PublicUser;
  onUser: (u: PublicUser) => void;
  onLogout: () => void;
}) {
  const navigate = useNavigate();
  const liveVideoRef = useRef<HTMLVideoElement>(null);
  const reviewVideoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  // 음성인식을 계속 살려둘지(녹화 중) 여부. onend/워치독 재시작의 게이트.
  const keepAliveRef = useRef<boolean>(false);
  // 마지막으로 인식 결과가 들어온 시각 — 워치독이 멈춤을 감지하는 기준.
  const lastResultAtRef = useRef<number>(0);
  // 인식 엔진이 멈췄는지 주기적으로 확인하는 워치독 타이머.
  const watchdogRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  // 확정된 자막 텍스트(최신 값을 저장 시점에 쓰기 위해 ref 로도 보관).
  const finalTranscriptRef = useRef<string>("");
  // 아직 확정되지 않은(말하는 중인) 자막. 정지 시 마지막 조각까지 본문에 합치려고 보관.
  const interimRef = useRef<string>("");

  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [finalText, setFinalText] = useState("");
  const [interimText, setInterimText] = useState("");
  const [cameraOn, setCameraOn] = useState(true);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sttSupported] = useState<boolean>(() => getSpeechRecognition() !== null);

  // AI 모의면접(LangGraph 상호작용형) 세션 상태
  const [interviewId, setInterviewId] = useState<string | null>(null);
  const [aiQuestion, setAiQuestion] = useState<AiInterviewQuestion | null>(null);
  const [aiEval, setAiEval] = useState<AiAnswerEvaluation | null>(null); // 방금 답변에 대한 평가
  const [aiReport, setAiReport] = useState<AiFinalReport | null>(null); // 면접 종료 시 리포트
  const [aiBasedOn, setAiBasedOn] = useState<AiInterviewBasedOn | null>(null);
  const [aiBusy, setAiBusy] = useState(false); // 시작/답변 처리 중(LLM 호출)
  const [aiError, setAiError] = useState<string | null>(null);
  // 면접 근거로 쓸 이력서 선택(원문이 추출된 것만 후보).
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [selectedResumeId, setSelectedResumeId] = useState<number | null>(null);
  // 면접 볼 직무 선택(회원정보 users.jobs 중 하나). 기본값은 첫 번째 직무.
  const [selectedRole, setSelectedRole] = useState<string | null>(user.jobs?.[0] ?? null);
  // 면접 종료 후 녹화에 동봉할 결과 누적(questions[i] ↔ answers[i] ↔ evaluations[i] 정렬).
  const aiQuestionsRef = useRef<AiInterviewQuestion[]>([]);
  const aiAnswersRef = useRef<string[]>([]);
  const aiEvalsRef = useRef<AiAnswerEvaluation[]>([]);
  // 직전 제출 이후의 자막만 "이번 답변"으로 잘라내기 위한 커서(finalTranscript 의 길이).
  const answeredUpToRef = useRef<number>(0);
  // 완성된 리포트(저장용). aiReport 와 같지만 저장 시점 최신값 보장을 위해 ref 로도 보관.
  const aiReportRef = useRef<AiFinalReport | null>(null);

  const transcriptBoxRef = useRef<HTMLDivElement>(null);

  // 자막이 길어지면 항상 맨 아래로 스크롤.
  useEffect(() => {
    const el = transcriptBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [finalText, interimText]);

  // 면접 근거로 쓸 이력서 목록 로드(원문이 추출된 것만). 기본값은 가장 최근 것.
  useEffect(() => {
    let alive = true;
    getResumes()
      .then((list) => {
        if (!alive) return;
        const usable = list.filter((r) => r.extracted_chars > 0);
        setResumes(usable);
        setSelectedResumeId((cur) => cur ?? usable[0]?.id ?? null);
      })
      .catch(() => {
        /* 목록 실패는 치명적이지 않음 — 시작 시 서버가 최근 이력서로 폴백/안내한다. */
      });
    return () => {
      alive = false;
    };
  }, []);

  // 카메라/마이크 권한 요청 + 미리보기 시작.
  const enableCamera = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: true,
      });
      streamRef.current = stream;
      if (liveVideoRef.current) {
        liveVideoRef.current.srcObject = stream;
        await liveVideoRef.current.play().catch(() => {});
      }
      setCameraOn(true);
      setPhase("ready");
    } catch (err) {
      setError(
        "카메라/마이크를 사용할 수 없습니다. 브라우저 권한을 허용했는지 확인해 주세요. (" +
          (err instanceof Error ? err.message : String(err)) +
          ")"
      );
    }
  }, []);

  // 아직 확정되지 않은 조각을 본문에 합쳐 누락을 막는다.
  const flushInterim = useCallback(() => {
    const tail = interimRef.current.trim();
    if (tail) {
      finalTranscriptRef.current = finalTranscriptRef.current
        ? finalTranscriptRef.current + "\n" + tail
        : tail;
      setFinalText(finalTranscriptRef.current);
    }
    interimRef.current = "";
    setInterimText("");
  }, []);

  // 실시간 음성인식 시작(한국어). 미지원 브라우저면 조용히 건너뛴다.
  // 끊기거나 멈추면 "같은 객체 재사용" 대신 항상 새 인스턴스로 재시작한다.
  // (Chrome 은 한 번 끝난 인식 객체를 다시 start 하면 조용히 죽는 일이 잦다.)
  const startRecognition = useCallback(() => {
    const Ctor = getSpeechRecognition();
    if (!Ctor) return;
    keepAliveRef.current = true;

    // 직전 인스턴스가 남아 있으면 콜백을 끊고 정리(중복 재시작 방지).
    const prev = recognitionRef.current;
    if (prev) {
      prev.onend = null;
      prev.onerror = null;
      prev.onresult = null;
      try {
        prev.abort();
      } catch {
        /* 무시 */
      }
      recognitionRef.current = null;
    }

    const rec = new Ctor();
    rec.lang = "ko-KR";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (ev: SpeechRecognitionEvent) => {
      lastResultAtRef.current = Date.now();
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const text = (res[0]?.transcript ?? "").trim();
        if (!text) continue;
        // 확정된 문장은 한 줄씩 본문에 누적해 대본처럼 전체가 남도록 한다.
        if (res.isFinal) {
          finalTranscriptRef.current = finalTranscriptRef.current
            ? finalTranscriptRef.current + "\n" + text
            : text;
        } else {
          interim += (interim ? " " : "") + text;
        }
      }
      interimRef.current = interim;
      setFinalText(finalTranscriptRef.current);
      setInterimText(interim);
    };
    rec.onerror = (ev: SpeechRecognitionErrorEvent) => {
      // 권한 거부는 사용자에게 알리고 재시작을 멈춘다.
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        keepAliveRef.current = false;
        setError("마이크 권한이 없어 자막을 만들 수 없습니다.");
      }
      // no-speech / network / aborted 등은 onend 의 재시작 로직이 회복시킨다.
    };
    // 자동으로 끊기면(엔진 타임아웃/네트워크) 새 인스턴스로 다시 살린다.
    rec.onend = () => {
      flushInterim();
      if (recognitionRef.current === rec) recognitionRef.current = null;
      if (keepAliveRef.current) {
        // 약간 지연 후 재시작 — start 충돌을 피한다.
        window.setTimeout(() => {
          if (keepAliveRef.current) startRecognition();
        }, 250);
      }
    };
    try {
      rec.start();
      recognitionRef.current = rec;
      lastResultAtRef.current = Date.now();
    } catch {
      // 중복 start 등 — 잠시 후 새 인스턴스로 재시도.
      window.setTimeout(() => {
        if (keepAliveRef.current) startRecognition();
      }, 350);
    }
  }, [flushInterim]);

  // 워치독: 결과가 일정 시간 안 들어오면 엔진이 멈춘 것으로 보고 강제 재가동.
  // 말하는 중에는 interim 결과가 계속 흐르므로 발화 중간을 끊지 않는다.
  const startWatchdog = useCallback(() => {
    if (watchdogRef.current) clearInterval(watchdogRef.current);
    watchdogRef.current = window.setInterval(() => {
      if (!keepAliveRef.current) return;
      if (Date.now() - lastResultAtRef.current > 6000) {
        // 멈춤(또는 침묵) 감지 → 새 인스턴스로 재시작.
        lastResultAtRef.current = Date.now();
        startRecognition();
      }
    }, 2000);
  }, [startRecognition]);

  const stopRecognition = useCallback(() => {
    keepAliveRef.current = false;
    if (watchdogRef.current) {
      clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }
    const rec = recognitionRef.current;
    if (rec) {
      rec.onend = null;
      rec.onerror = null;
      rec.onresult = null;
      try {
        rec.stop();
      } catch {
        /* 무시 */
      }
      recognitionRef.current = null;
    }
  }, []);

  // 녹화 시작.
  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    setError(null);
    chunksRef.current = [];
    finalTranscriptRef.current = "";
    interimRef.current = "";
    answeredUpToRef.current = 0; // 자막이 초기화되므로 답변 커서도 처음으로
    setFinalText("");
    setInterimText("");
    setRecordedBlob(null);
    if (reviewUrl) URL.revokeObjectURL(reviewUrl);
    setReviewUrl(null);

    // 지원되는 mimeType 을 고른다(webm/vp9 우선).
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    const mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || "video/webm",
      });
      setRecordedBlob(blob);
      const url = URL.createObjectURL(blob);
      setReviewUrl(url);
      setPhase("review");
    };
    recorder.start(1000); // 1초마다 청크 수집
    recorderRef.current = recorder;

    startedAtRef.current = Date.now();
    setElapsed(0);
    timerRef.current = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 250);

    lastResultAtRef.current = Date.now();
    startRecognition();
    startWatchdog();
    setPhase("recording");
  }, [reviewUrl, startRecognition, startWatchdog]);

  // 녹화 정지.
  const stopRecording = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    stopRecognition();
    // 마지막까지 말했지만 아직 확정되지 않은 조각도 본문에 합친다.
    flushInterim();
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop(); // onstop 에서 review 로 전환
    }
  }, [stopRecognition, flushInterim]);

  // 현재까지의 모의면접 결과를 녹화 저장용 객체로 만든다(없으면 null).
  const buildInterviewReport = useCallback((): InterviewReport | null => {
    if (!interviewId || aiAnswersRef.current.length === 0) return null;
    return {
      // 답변이 끝난 질문까지만 동봉(아직 답 안 한 마지막 질문은 제외).
      questions: aiQuestionsRef.current.slice(0, aiAnswersRef.current.length),
      answers: aiAnswersRef.current,
      evaluations: aiEvalsRef.current,
      finalReport: aiReportRef.current,
      basedOn: aiBasedOn ?? undefined,
    };
  }, [interviewId, aiBasedOn]);

  // 저장: 영상 + 자막을 서버로 업로드.
  const save = useCallback(async () => {
    if (!recordedBlob) return;
    setPhase("saving");
    setError(null);
    try {
      await saveRecording({
        video: recordedBlob,
        transcript: finalTranscriptRef.current.trim(),
        durationSec: elapsed,
        title: title.trim(),
        interviewReport: buildInterviewReport(),
      });
      navigate("/history");
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장에 실패했습니다.");
      setPhase("review");
    }
  }, [recordedBlob, elapsed, title, navigate, buildInterviewReport]);

  // 다시 녹화(리뷰 폐기하고 ready 로).
  const discard = useCallback(() => {
    if (reviewUrl) URL.revokeObjectURL(reviewUrl);
    setReviewUrl(null);
    setRecordedBlob(null);
    setFinalText("");
    setInterimText("");
    finalTranscriptRef.current = "";
    interimRef.current = "";
    setTitle("");
    setElapsed(0);
    setPhase("ready");
  }, [reviewUrl]);

  // 카메라 켜기/끄기 토글. 스트림은 살려두고 비디오 트랙만 on/off 하므로
  // 카메라를 꺼도 마이크·녹화·자막은 그대로 계속된다.
  const toggleCamera = useCallback(() => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCameraOn(track.enabled);
  }, []);

  // ── AI 모의면접 ────────────────────────────────────────────────────────────
  // 시작: 이력서/직무/공고로 첫 질문을 받아 세션을 연다.
  const startInterviewSession = useCallback(async () => {
    setAiBusy(true);
    setAiError(null);
    setAiEval(null);
    setAiReport(null);
    aiReportRef.current = null;
    try {
      const res = await startAiInterview({
        maxQuestions: 5,
        resumeId: selectedResumeId ?? undefined,
        role: selectedRole ?? undefined,
      });
      setInterviewId(res.interviewId);
      setAiQuestion(res.question);
      setAiBasedOn(res.basedOn);
      // 결과 누적 초기화. 첫 질문을 questions[0] 로 둔다.
      aiQuestionsRef.current = [res.question];
      aiAnswersRef.current = [];
      aiEvalsRef.current = [];
      // 새 답변 커서는 "지금까지 쌓인 자막 끝"부터(이미 녹화 중이었다면 그 이후 발화만 답변으로 본다).
      answeredUpToRef.current = finalTranscriptRef.current.length;
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "모의면접을 시작하지 못했습니다.");
    } finally {
      setAiBusy(false);
    }
  }, [selectedResumeId, selectedRole]);

  // 답변 제출: 직전 제출 이후의 자막 구간을 "이번 답변"으로 보내고, 평가+다음 질문을 받는다.
  const submitCurrentAnswer = useCallback(async () => {
    if (!interviewId || !aiQuestion) return;
    // 아직 확정되지 않은 마지막 발화 조각까지 본문에 합친다.
    flushInterim();
    const full = finalTranscriptRef.current;
    const answer = full.slice(answeredUpToRef.current).trim();
    if (!answer) {
      setAiError("답변이 인식되지 않았습니다. 말한 내용이 자막에 나타난 뒤 제출해 주세요.");
      return;
    }
    setAiBusy(true);
    setAiError(null);
    const prevCursor = answeredUpToRef.current;
    answeredUpToRef.current = full.length; // 다음 답변은 여기부터
    const answeredQuestion = aiQuestion;
    try {
      const res = await submitAiInterviewAnswer(interviewId, answer);
      // 결과 누적(정렬 유지): 방금 질문의 답변/평가를 기록.
      aiAnswersRef.current = [...aiAnswersRef.current, answer];
      aiEvalsRef.current = [...aiEvalsRef.current, res.evaluation];
      setAiEval(res.evaluation);

      if (res.status === "completed" && res.finalReport) {
        setAiReport(res.finalReport);
        aiReportRef.current = res.finalReport;
        setAiQuestion(null);
      } else if (res.nextQuestion) {
        setAiQuestion(res.nextQuestion);
        aiQuestionsRef.current = [...aiQuestionsRef.current, res.nextQuestion];
      }
    } catch (err) {
      // 실패 시 커서를 되돌려 같은 답변을 다시 제출할 수 있게 한다.
      answeredUpToRef.current = prevCursor;
      setAiQuestion(answeredQuestion);
      setAiError(err instanceof Error ? err.message : "답변을 처리하지 못했습니다.");
    } finally {
      setAiBusy(false);
    }
  }, [interviewId, aiQuestion, flushInterim]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      keepAliveRef.current = false;
      if (watchdogRef.current) clearInterval(watchdogRef.current);
      try {
        recognitionRef.current?.abort();
      } catch {
        /* 무시 */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (reviewUrl) URL.revokeObjectURL(reviewUrl);
    };
    // 언마운트 클린업만 — reviewUrl 최신값은 closure 로 충분.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const liveTranscript = (finalText + (interimText ? " " + interimText : "")).trim();

  return (
    <AppShell user={user} onUser={onUser} onLogout={onLogout}>
      <PageHeader title="면접 연습">
        녹화 버튼을 누르면 내 모습이 녹화되고, 말한 내용이 실시간으로 자막에 표시됩니다.
        정지하면 영상과 자막이 면접 기록에 저장됩니다.
      </PageHeader>

      {error && <div className="pr-alert">{error}</div>}
      {aiError && <div className="pr-alert">{aiError}</div>}

      {/* AI 모의면접(LangGraph) — 답변(자막)을 평가해 논리를 파고드는 꼬리질문을 이어간다 */}
      <div className="pr-qbar">
        {aiQuestion ? (
          <>
            <div className="pr-q-main">
              <span className={`pr-q-cat${aiQuestion.type === "followup" ? " pr-q-cat-follow" : ""}`}>
                {aiQuestion.type === "followup" ? "🔥 꼬리질문" : `질문 ${aiQuestion.index}`}
              </span>
              <p className="pr-q-text">{aiQuestion.question}</p>
              {aiQuestion.basis && <span className="pr-q-intent">근거 · {aiQuestion.basis}</span>}
              {/* 직전 답변 평가 요약(논리 공격 지점) */}
              {aiEval && (
                <span className="pr-q-evalline">
                  직전 답변 평가 · 종합 {aiEval.score} / 구체성 {aiEval.specificity} / 역할 {aiEval.roleClarity}
                  {aiQuestion.type === "followup" && " — 약한 지점을 더 파고듭니다"}
                </span>
              )}
            </div>
            <div className="pr-q-nav">
              <button
                type="button"
                className="pr-btn pr-btn-primary"
                onClick={submitCurrentAnswer}
                disabled={aiBusy || phase !== "recording"}
                title={phase !== "recording" ? "녹화 중에 답변할 수 있어요." : undefined}
              >
                {aiBusy ? "AI 분석 중…" : "답변 완료 → 다음 질문"}
              </button>
              <span className="pr-q-count">
                {phase === "recording"
                  ? "답변을 말한 뒤 버튼을 누르세요"
                  : "‘녹화 시작’을 누르면 답변할 수 있어요"}
              </span>
            </div>
          </>
        ) : (
          <div className={`pr-q-empty${aiReport ? "" : " pr-q-empty-start"}`}>
            <div className="pr-q-intro">
              <strong>AI 모의면접</strong>
              <span>
                {aiReport
                  ? "면접이 종료되었습니다. 아래 리포트를 확인하고, 녹화를 정지해 기록에 저장하세요."
                  : "고른 이력서와 직무를 바탕으로, 실제 압박면접처럼 답변을 깊게 파고듭니다."}
              </span>
              {!aiReport && (
                <div className="pr-q-steps">
                  <span className="pr-q-step">
                    <i>1</i> 이력서·직무 기반 질문
                  </span>
                  <span className="pr-q-step">
                    <i>2</i> 답변 자막 실시간 평가
                  </span>
                  <span className="pr-q-step">
                    <i>3</i> 약점 파고드는 꼬리질문
                  </span>
                </div>
              )}
              {!aiReport && resumes.length === 0 && (
                <span className="pr-q-resume-warn">
                  면접에 쓸 이력서가 없습니다. ‘이력서 피드백’에서 이력서 PDF 를 먼저 업로드해 주세요.
                </span>
              )}
            </div>
            {!aiReport && (
              <div className="pr-q-start">
                {resumes.length > 0 && (
                  <label className="pr-field">
                    <span className="pr-field-label">이력서</span>
                    <div className="pr-select">
                      <select
                        value={selectedResumeId ?? ""}
                        onChange={(e) => setSelectedResumeId(Number(e.target.value) || null)}
                        disabled={aiBusy}
                      >
                        {resumes.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.filename} · {fmtResumeDate(r.created_at)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </label>
                )}
                {user.jobs.length > 1 && (
                  <label className="pr-field">
                    <span className="pr-field-label">직무</span>
                    <div className="pr-select">
                      <select
                        value={selectedRole ?? ""}
                        onChange={(e) => setSelectedRole(e.target.value || null)}
                        disabled={aiBusy}
                      >
                        {user.jobs.map((j) => (
                          <option key={j} value={j}>
                            {j}
                          </option>
                        ))}
                      </select>
                    </div>
                  </label>
                )}
                <button
                  type="button"
                  className="pr-btn pr-btn-primary pr-q-start-btn"
                  onClick={startInterviewSession}
                  disabled={aiBusy}
                >
                  <SparkleIcon size={15} /> {aiBusy ? "면접 준비 중…" : "AI 모의면접 시작"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 최종 리포트(면접 종료 후) */}
      {aiReport && (
        <div className="pr-report">
          <div className="pr-report-head">
            <SparkleIcon size={16} /> AI 면접 리포트
          </div>
          <p className="pr-report-summary">{aiReport.summary}</p>
          <div className="pr-report-cols">
            {aiReport.strengths.length > 0 && (
              <div>
                <h4>강점</h4>
                <ul>{aiReport.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            )}
            {aiReport.improvements.length > 0 && (
              <div>
                <h4>보완점</h4>
                <ul>{aiReport.improvements.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            )}
          </div>
          {aiReport.perAnswerFeedback.length > 0 && (
            <div className="pr-report-perq">
              <h4>답변별 피드백</h4>
              {aiReport.perAnswerFeedback.map((p) => (
                <div key={p.index} className="pr-report-qrow">
                  <span className="pr-report-score">{p.score}점</span>
                  <div>
                    <p className="pr-report-q">Q{p.index}. {p.question}</p>
                    <p className="pr-report-fb">{p.feedback}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          {aiReport.expectedQuestions.length > 0 && (
            <div className="pr-report-perq">
              <h4>더 준비하면 좋은 예상 질문</h4>
              <ul>{aiReport.expectedQuestions.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          )}
          {aiReport.nextSteps.length > 0 && (
            <div className="pr-report-perq">
              <h4>다음 면접 준비 조언</h4>
              <ul>{aiReport.nextSteps.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      <div className="pr-grid">
        {/* 좌측: 카메라/녹화 영역 */}
        <div className="pr-stage">
          <div className="pr-video-wrap">
            {/* 리뷰 단계에서는 녹화본을, 그 외에는 라이브 미리보기를 보여준다 */}
            <video
              ref={liveVideoRef}
              className="pr-video"
              muted
              playsInline
              style={{ display: phase === "review" || phase === "saving" ? "none" : "block" }}
            />
            <video
              ref={reviewVideoRef}
              className="pr-video"
              controls
              playsInline
              src={reviewUrl ?? undefined}
              style={{ display: phase === "review" || phase === "saving" ? "block" : "none" }}
            />

            {phase === "idle" && (
              <div className="pr-overlay">
                <p>면접 연습을 시작하려면 카메라를 켜 주세요.</p>
                <button type="button" className="pr-btn pr-btn-primary" onClick={enableCamera}>
                  카메라 켜기
                </button>
              </div>
            )}

            {/* 카메라만 꺼진 상태: 화면은 가리되 녹화·자막은 계속된다 */}
            {!cameraOn && (phase === "ready" || phase === "recording") && (
              <div className="pr-overlay pr-cam-off">
                <CameraOffIcon size={34} />
                <p>카메라가 꺼져 있어요. 녹화와 자막은 계속됩니다.</p>
              </div>
            )}

            {phase === "recording" && (
              <div className="pr-rec-badge">
                <span className="pr-rec-dot" /> REC {fmt(elapsed)}
              </div>
            )}
          </div>

          {/* 컨트롤 바 */}
          <div className="pr-controls">
            {phase === "ready" && (
              <>
                <button type="button" className="pr-btn pr-btn-rec" onClick={startRecording}>
                  <span className="pr-rec-dot" /> 녹화 시작
                </button>
                <button type="button" className="pr-btn pr-btn-ghost" onClick={toggleCamera}>
                  {cameraOn ? <CameraOffIcon size={16} /> : <CameraIcon size={16} />}
                  {cameraOn ? "카메라 끄기" : "카메라 켜기"}
                </button>
              </>
            )}
            {phase === "recording" && (
              <>
                <button type="button" className="pr-btn pr-btn-stop" onClick={stopRecording}>
                  ■ 녹화 정지
                </button>
                <button type="button" className="pr-btn pr-btn-ghost" onClick={toggleCamera}>
                  {cameraOn ? <CameraOffIcon size={16} /> : <CameraIcon size={16} />}
                  {cameraOn ? "카메라 끄기" : "카메라 켜기"}
                </button>
              </>
            )}
            {(phase === "review" || phase === "saving") && (
              <>
                <input
                  className="pr-title-input"
                  placeholder="제목 (비우면 날짜로 자동 저장)"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={phase === "saving"}
                  maxLength={200}
                />
                <button
                  type="button"
                  className="pr-btn pr-btn-primary"
                  onClick={save}
                  disabled={phase === "saving"}
                >
                  {phase === "saving" ? "저장 중…" : "면접 기록에 저장"}
                </button>
                <button
                  type="button"
                  className="pr-btn pr-btn-ghost"
                  onClick={discard}
                  disabled={phase === "saving"}
                >
                  다시 녹화
                </button>
              </>
            )}
          </div>
        </div>

        {/* 우측: 실시간 자막 */}
        <div className="pr-transcript">
          <div className="pr-transcript-head">
            <span>실시간 자막</span>
            {phase === "recording" && <span className="pr-live-dot">● LIVE</span>}
          </div>
          {!sttSupported && (
            <div className="pr-stt-warn">
              이 브라우저는 실시간 음성인식을 지원하지 않습니다. 녹화는 정상 동작하며,
              자막은 Chrome 또는 Edge 에서 사용할 수 있습니다.
            </div>
          )}
          <div className="pr-transcript-body" ref={transcriptBoxRef}>
            {liveTranscript ? (
              <p className="pr-transcript-text">
                {finalText}
                {interimText && <span className="pr-interim"> {interimText}</span>}
              </p>
            ) : (
              <p className="pr-transcript-empty">
                {phase === "recording"
                  ? "말을 시작하면 여기에 자막이 표시됩니다…"
                  : "녹화를 시작하면 말한 내용이 실시간으로 변환됩니다."}
              </p>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
