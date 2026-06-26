import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { InterviewQuestion, PublicUser } from "@e-lifethon/shared";
import { getInterviewQuestions, saveRecording } from "../api";
import AppShell from "../components/AppShell";
import PageHeader from "../components/PageHeader";
import {
  CameraIcon,
  CameraOffIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  RotateIcon,
  SparkleIcon,
} from "../components/icons";
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

  // 면접 예상 질문(로컬 AI 생성)
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [qIndex, setQIndex] = useState(0);
  const [qLoading, setQLoading] = useState(false);
  const [qError, setQError] = useState<string | null>(null);

  const loadQuestions = useCallback(async () => {
    setQLoading(true);
    setQError(null);
    try {
      const res = await getInterviewQuestions({ count: 8 });
      setQuestions(res.questions);
      setQIndex(0);
    } catch (err) {
      setQError(err instanceof Error ? err.message : "질문을 불러오지 못했습니다.");
    } finally {
      setQLoading(false);
    }
  }, []);

  const currentQuestion = questions[qIndex] ?? null;

  const transcriptBoxRef = useRef<HTMLDivElement>(null);

  // 자막이 길어지면 항상 맨 아래로 스크롤.
  useEffect(() => {
    const el = transcriptBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [finalText, interimText]);

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
      });
      navigate("/history");
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장에 실패했습니다.");
      setPhase("review");
    }
  }, [recordedBlob, elapsed, title, navigate]);

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

      {/* 면접 예상 질문(로컬 AI) — 질문을 보며 답변을 녹화한다 */}
      <div className="pr-qbar">
        {currentQuestion ? (
          <>
            <div className="pr-q-main">
              <span className="pr-q-cat">{currentQuestion.category}</span>
              <p className="pr-q-text">{currentQuestion.question}</p>
              {currentQuestion.intent && (
                <span className="pr-q-intent">평가 포인트 · {currentQuestion.intent}</span>
              )}
            </div>
            <div className="pr-q-nav">
              <button
                type="button"
                className="pr-q-btn"
                onClick={() => setQIndex((i) => Math.max(0, i - 1))}
                disabled={qIndex === 0}
                aria-label="이전 질문"
              >
                <ChevronLeftIcon size={16} />
              </button>
              <span className="pr-q-count">
                {qIndex + 1} / {questions.length}
              </span>
              <button
                type="button"
                className="pr-q-btn"
                onClick={() => setQIndex((i) => Math.min(questions.length - 1, i + 1))}
                disabled={qIndex >= questions.length - 1}
                aria-label="다음 질문"
              >
                <ChevronRightIcon size={16} />
              </button>
              <button
                type="button"
                className="pr-btn pr-btn-ghost rs-btn-sm"
                onClick={loadQuestions}
                disabled={qLoading}
              >
                <RotateIcon size={14} /> {qLoading ? "생성 중…" : "새 질문"}
              </button>
            </div>
          </>
        ) : (
          <div className="pr-q-empty">
            <div>
              <strong>면접 예상 질문</strong>
              <span>
                {qError ??
                  "내 직무와 분석된 이력서를 바탕으로 로컬 AI 가 예상 질문을 만들어 줍니다."}
              </span>
            </div>
            <button
              type="button"
              className="pr-btn pr-btn-primary"
              onClick={loadQuestions}
              disabled={qLoading}
            >
              <SparkleIcon size={15} /> {qLoading ? "질문 생성 중…" : "예상 질문 받기"}
            </button>
          </div>
        )}
      </div>

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
