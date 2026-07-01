import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type {
  AiAnswerEvaluation,
  AiFinalReport,
  AiInterviewBasedOn,
  AiInterviewQuestion,
  ComposureReport,
  InterviewReport,
  PublicUser,
  Resume,
} from "@e-lifethon/shared";
import { getResumes, saveRecording, startAiInterview, submitAiInterviewAnswer } from "../api";
import AppShell from "../components/AppShell";
import PageHeader from "../components/PageHeader";
import { CameraIcon, CameraOffIcon, SparkleIcon } from "../components/icons";
import type { FaceTracker } from "../composure/faceTracker";
import { computeComposure, type PerAnswerSignal } from "../composure/score";
import { contentChars, countFillers, countHedges } from "../composure/fillers";
import ComposureCard from "../components/ComposureCard";
import "./practice.css";

// 면접 연습: 웹캠으로 내 모습을 녹화하고, 말한 내용을 Web Speech API 로 실시간 자막화한다.
// 정지하면 영상(webm) + 자막을 DB 에 저장 → 면접 기록에서 다시 볼 수 있다.

type Phase = "idle" | "ready" | "recording" | "review" | "saving";

// 녹화 중 화면에 겹쳐 보여주는 실시간 측정값.
type LiveStats = {
  wpm: number; // 말하기 속도(분당 어절 수)
  fillers: number; // 필러(어·음·그…) 누적 횟수
  wpmHistory: number[]; // wpm 추이(라인 그래프용)
  fillerHistory: number[]; // 구간별 필러 발생(막대 그래프용)
  face: { gaze: number; eye: number; posture: number } | null; // 카메라 켜졌을 때만
};

const clampScore = (x: number) => Math.max(0, Math.min(100, Math.round(x)));

// HUD 미니 라인 그래프(추이). 값 배열을 폭에 맞춰 폴리라인으로 그린다.
function Sparkline({ data }: { data: number[] }) {
  const W = 200;
  const H = 32;
  if (data.length < 2) {
    return <svg className="pr-hud-graph pr-hud-line" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" />;
  }
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = W / (data.length - 1);
  const pts = data
    .map((v, i) => `${(i * step).toFixed(1)},${(H - 2 - ((v - min) / range) * (H - 4)).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="pr-hud-graph pr-hud-line" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// HUD 미니 막대 그래프(구간별 값).
function BarGraph({ data }: { data: number[] }) {
  const W = 200;
  const H = 32;
  const n = Math.max(data.length, 1);
  const max = Math.max(...data, 1);
  const bw = W / n;
  return (
    <svg className="pr-hud-graph pr-hud-bars-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {data.map((v, i) => {
        const h = Math.max(1.5, (v / max) * (H - 2));
        return (
          <rect
            key={i}
            x={(i * bw + bw * 0.18).toFixed(1)}
            y={(H - h).toFixed(1)}
            width={(bw * 0.64).toFixed(1)}
            height={h.toFixed(1)}
            rx="0.6"
          />
        );
      })}
    </svg>
  );
}

// ── 녹화 영상에 HUD 를 합성(번인)하기 위한 캔버스 드로잉 ──────────────────────
// DOM 오버레이(.pr-hud)는 카메라 스트림에 포함되지 않으므로, 영상 프레임 + HUD 를
// 캔버스에 매 프레임 그려서 canvas.captureStream() 을 녹화한다(라이브 화면과 동일한 모양).
const HUD_PURPLE = "#a78bfa";
const HUD_FONT = "'Pretendard Variable', Pretendard, system-ui, sans-serif";

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hudLine(ctx: CanvasRenderingContext2D, data: number[], x: number, y: number, w: number, h: number) {
  if (data.length < 2) return;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = w / (data.length - 1);
  ctx.strokeStyle = HUD_PURPLE;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  data.forEach((v, i) => {
    const px = x + i * step;
    const py = y + h - 2 - ((v - min) / range) * (h - 4);
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  });
  ctx.stroke();
}

function hudBars(ctx: CanvasRenderingContext2D, data: number[], x: number, y: number, w: number, h: number) {
  const n = Math.max(data.length, 1);
  const max = Math.max(...data, 1);
  const bw = w / n;
  ctx.fillStyle = HUD_PURPLE;
  ctx.globalAlpha = 0.82;
  data.forEach((v, i) => {
    const bh = Math.max(2, (v / max) * (h - 2));
    ctx.fillRect(x + i * bw + bw * 0.18, y + h - bh, bw * 0.64, bh);
  });
  ctx.globalAlpha = 1;
}

function drawPanelBg(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  roundRectPath(ctx, x, y, w, h, 16);
  ctx.fillStyle = "rgba(18, 16, 30, 0.6)";
  ctx.fill();
  ctx.strokeStyle = "rgba(168, 139, 250, 0.35)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawPanelTitle(ctx: CanvasRenderingContext2D, title: string, x: number, y: number) {
  ctx.fillStyle = HUD_PURPLE;
  ctx.beginPath();
  ctx.arc(x + 4, y + 5, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#b9a7f5";
  ctx.font = `700 15px ${HUD_FONT}`;
  ctx.textBaseline = "middle";
  ctx.fillText(title, x + 16, y + 6);
  ctx.textBaseline = "alphabetic";
}

function drawMetric(ctx: CanvasRenderingContext2D, label: string, value: string, unit: string, x: number, y: number) {
  ctx.fillStyle = "#b7b5c8";
  ctx.font = `500 15px ${HUD_FONT}`;
  ctx.fillText(label, x, y + 13);
  ctx.fillStyle = "#fff";
  ctx.font = `800 34px ${HUD_FONT}`;
  ctx.fillText(value, x, y + 48);
  const vw = ctx.measureText(value).width;
  ctx.fillStyle = "#9a9ab0";
  ctx.font = `600 15px ${HUD_FONT}`;
  ctx.fillText(unit, x + vw + 7, y + 48);
}

// 카메라 영상 + SPEECH/COMPOSURE 패널을 캔버스에 한 프레임 그린다.
function renderHudFrame(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement | null,
  stats: LiveStats | null,
  cameraOn: boolean
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;

  if (cameraOn && video && video.readyState >= 2 && video.videoWidth > 0) {
    ctx.drawImage(video, 0, 0, W, H);
  } else {
    ctx.fillStyle = "#15151c";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#c8c8d2";
    ctx.font = `500 22px ${HUD_FONT}`;
    ctx.textAlign = "center";
    ctx.fillText("카메라가 꺼져 있어요 · 녹화·자막은 계속됩니다", W / 2, H / 2);
    ctx.textAlign = "left";
  }
  if (!stats) return;

  const M = 22;
  const pad = 20;
  const pw = 300;

  // SPEECH 패널(우상단)
  {
    const ph = 300;
    const x = W - pw - M;
    const y = M;
    drawPanelBg(ctx, x, y, pw, ph);
    let cy = y + pad;
    drawPanelTitle(ctx, "SPEECH", x + pad, cy);
    cy += 24;
    drawMetric(ctx, "말하기 속도", String(stats.wpm), "wpm", x + pad, cy);
    cy += 58;
    hudLine(ctx, stats.wpmHistory, x + pad, cy, pw - pad * 2, 34);
    cy += 34 + 14;
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + pad, cy);
    ctx.lineTo(x + pw - pad, cy);
    ctx.stroke();
    cy += 16;
    drawMetric(ctx, "필러(어.. 응..) 사용", String(stats.fillers), "회", x + pad, cy);
    cy += 58;
    hudBars(ctx, stats.fillerHistory, x + pad, cy, pw - pad * 2, 34);
  }

  // COMPOSURE 패널(좌하단)
  {
    const rows: [string, number | null][] = [
      ["시선 안정", stats.face?.gaze ?? null],
      ["눈 안정", stats.face?.eye ?? null],
      ["자세 안정", stats.face?.posture ?? null],
    ];
    const ph = stats.face ? 176 : 108;
    const x = M;
    const y = H - ph - M;
    drawPanelBg(ctx, x, y, pw, ph);
    let cy = y + pad;
    drawPanelTitle(ctx, "COMPOSURE", x + pad, cy);
    cy += 30;
    if (stats.face) {
      const labelW = 92;
      const scoreW = 34;
      const trackX = x + pad + labelW;
      const trackW = pw - pad * 2 - labelW - scoreW;
      for (const [label, score] of rows) {
        const s = score ?? 0;
        ctx.fillStyle = "#b6b6c6";
        ctx.font = `500 14px ${HUD_FONT}`;
        ctx.fillText(label, x + pad, cy + 6);
        // track
        roundRectPath(ctx, trackX, cy, trackW, 6, 3);
        ctx.fillStyle = "rgba(255,255,255,0.14)";
        ctx.fill();
        // fill
        roundRectPath(ctx, trackX, cy, Math.max(4, (trackW * s) / 100), 6, 3);
        ctx.fillStyle = HUD_PURPLE;
        ctx.fill();
        // score
        ctx.fillStyle = "#ececf2";
        ctx.font = `700 14px ${HUD_FONT}`;
        ctx.textAlign = "right";
        ctx.fillText(String(s), x + pw - pad, cy + 6);
        ctx.textAlign = "left";
        cy += 24;
      }
    } else {
      ctx.fillStyle = "#9a9ab0";
      ctx.font = `500 14px ${HUD_FONT}`;
      ctx.fillText(cameraOn ? "얼굴 인식 중…" : "카메라를 켜면 측정돼요", x + pad, cy + 6);
    }
  }
}

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
  const [isMobile, setIsMobile] = useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 720px)");
    const on = () => setIsMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

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
  // 겨냥한 공고(채용 공고 상세에서 "이 공고로 모의면접"으로 넘어오면 채워진다).
  //  - 이 공고의 회사로 기업 페르소나가 적용된다(데이터가 있으면).
  const navState = (useLocation().state ?? null) as
    | { jobId?: number; jobTitle?: string; company?: string | null }
    | null;
  const [targetJob, setTargetJob] = useState<{ id: number; title: string; company: string | null } | null>(
    navState?.jobId ? { id: navState.jobId, title: navState.jobTitle ?? "", company: navState.company ?? null } : null
  );
  // 면접 종료 후 녹화에 동봉할 결과 누적(questions[i] ↔ answers[i] ↔ evaluations[i] 정렬).
  const aiQuestionsRef = useRef<AiInterviewQuestion[]>([]);
  const aiAnswersRef = useRef<string[]>([]);
  const aiEvalsRef = useRef<AiAnswerEvaluation[]>([]);
  // 직전 제출 이후의 자막만 "이번 답변"으로 잘라내기 위한 커서(finalTranscript 의 길이).
  const answeredUpToRef = useRef<number>(0);

  // ── 평정심(압박 대응력) 분석 신호 ──
  const faceTrackerRef = useRef<FaceTracker | null>(null); // 영상 분석기(라이브 스트림)
  const questionShownAtRef = useRef<number>(0); // 현재 질문이 표시된 시각(Date.now)
  const firstSpeechAtRef = useRef<number | null>(null); // 그 질문에 대해 처음 말한 시각
  const answerFaceStartRef = useRef<number>(0); // 그 답변 구간의 영상 시작 타임(tracker.nowT)
  const composureSignalsRef = useRef<PerAnswerSignal[]>([]); // 답변별 신호 누적
  const composureRef = useRef<ComposureReport | null>(null); // 계산된 리포트(저장용)
  const [composure, setComposure] = useState<ComposureReport | null>(null); // 렌더용
  // 완성된 리포트(저장용). aiReport 와 같지만 저장 시점 최신값 보장을 위해 ref 로도 보관.
  const aiReportRef = useRef<AiFinalReport | null>(null);

  const transcriptBoxRef = useRef<HTMLDivElement>(null);

  // 자막이 길어지면 항상 맨 아래로 스크롤.
  useEffect(() => {
    const el = transcriptBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [finalText, interimText]);

  // 평정심: 새 질문이 표시되는 순간을 타이밍 기준점으로 잡는다(응답 지연 + 답변 구간 영상).
  useEffect(() => {
    if (aiQuestion) {
      questionShownAtRef.current = Date.now();
      firstSpeechAtRef.current = null;
      answerFaceStartRef.current = faceTrackerRef.current?.nowT() ?? performance.now();
    }
  }, [aiQuestion]);

  // ── 녹화 중 실시간 측정값(HUD) ──
  // 말하기 속도·채움말은 자막에서, 시선·눈·자세는 얼굴 트래커의 최근 구간에서 주기적으로 계산한다.
  const [liveStats, setLiveStats] = useState<LiveStats | null>(null);
  const wpmHistRef = useRef<number[]>([]);
  const fillerHistRef = useRef<number[]>([]);
  const prevFillersRef = useRef(0);
  // 녹화 영상에 HUD 를 합성하기 위한 캔버스·최신값 참조.
  const hudCanvasRef = useRef<HTMLCanvasElement>(null);
  const hudRafRef = useRef<number | null>(null);
  const liveStatsRef = useRef<LiveStats | null>(null);
  const cameraOnRef = useRef(true);
  useEffect(() => {
    cameraOnRef.current = cameraOn;
  }, [cameraOn]);
  useEffect(() => {
    if (phase !== "recording") {
      setLiveStats(null);
      wpmHistRef.current = [];
      fillerHistRef.current = [];
      prevFillersRef.current = 0;
      return;
    }
    const MAX_POINTS = 40; // 최근 ~28초(0.7초 간격) 추이 유지
    const tick = () => {
      const elapsedSec = Math.max(1, (Date.now() - startedAtRef.current) / 1000);
      const text = `${finalTranscriptRef.current} ${interimRef.current}`;
      // 말하기 속도: 분당 어절 수(wpm). 한국어는 공백으로 나눈 어절을 단어로 본다.
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      const wpm = Math.round(words / (elapsedSec / 60));
      const fillers = countFillers(text);
      const fillerDelta = Math.max(0, fillers - prevFillersRef.current);
      prevFillersRef.current = fillers;

      wpmHistRef.current = [...wpmHistRef.current, wpm].slice(-MAX_POINTS);
      fillerHistRef.current = [...fillerHistRef.current, fillerDelta].slice(-MAX_POINTS);

      let face: LiveStats["face"] = null;
      const tr = faceTrackerRef.current;
      if (tr && cameraOn) {
        const now = tr.nowT();
        const w = tr.window(now - 6000, now); // 최근 6초
        if (w.faceMeasured) {
          const blinkPenalty = w.blinkPerMin != null ? Math.max(0, w.blinkPerMin - 25) * 1.5 : 0;
          face = {
            gaze: clampScore(100 - (w.gazeAwayPct ?? 0) * 120),
            eye: clampScore(100 - (w.eyeJitter ?? 0) * 90 - blinkPenalty),
            posture: clampScore(100 - (w.headJitter ?? 0) * 110),
          };
        }
      }
      const next: LiveStats = {
        wpm,
        fillers,
        wpmHistory: [...wpmHistRef.current],
        fillerHistory: [...fillerHistRef.current],
        face,
      };
      liveStatsRef.current = next; // 캔버스 합성 루프가 읽는 최신값
      setLiveStats(next);
    };
    tick();
    const id = window.setInterval(tick, 700);
    return () => window.clearInterval(id);
  }, [phase, cameraOn]);

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
      // 평정심: 현재 질문에 대해 처음 말한 시각(응답 지연 계산용).
      if (firstSpeechAtRef.current == null && questionShownAtRef.current > 0) {
        firstSpeechAtRef.current = Date.now();
      }
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

    // HUD 를 영상에 합성해 녹화: 캔버스에 (카메라 + 패널)을 매 프레임 그리고 그 스트림을 녹화한다.
    // 캔버스 스트림 생성 실패 시엔 원본 카메라 스트림으로 폴백.
    let recordStream: MediaStream = stream;
    const canvas = hudCanvasRef.current;
    const liveVideo = liveVideoRef.current;
    if (canvas && liveVideo) {
      canvas.width = liveVideo.videoWidth || 1280;
      canvas.height = liveVideo.videoHeight || 720;
      renderHudFrame(canvas, liveVideo, liveStatsRef.current, cameraOnRef.current); // 첫 프레임
      const drawLoop = () => {
        renderHudFrame(canvas, liveVideoRef.current, liveStatsRef.current, cameraOnRef.current);
        hudRafRef.current = requestAnimationFrame(drawLoop);
      };
      hudRafRef.current = requestAnimationFrame(drawLoop);
      try {
        const canvasStream = canvas.captureStream(30);
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) canvasStream.addTrack(audioTrack);
        recordStream = canvasStream;
      } catch {
        if (hudRafRef.current) cancelAnimationFrame(hudRafRef.current);
        hudRafRef.current = null;
        recordStream = stream; // 폴백: HUD 없이 원본 녹화
      }
    }

    const recorder = new MediaRecorder(recordStream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      if (hudRafRef.current) {
        cancelAnimationFrame(hudRafRef.current); // HUD 합성 루프 종료
        hudRafRef.current = null;
      }
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

    // 평정심: 이번 녹화의 영상 분석 시작 + 답변 신호 초기화.
    composureSignalsRef.current = [];
    composureRef.current = null;
    setComposure(null);
    faceTrackerRef.current?.stop();
    faceTrackerRef.current = null;
    if (liveVideoRef.current) {
      const videoEl = liveVideoRef.current;
      // MediaPipe(약 130KB)는 녹화 시작 때만 지연 로드해 초기 앱 로딩을 가볍게 유지.
      import("../composure/faceTracker")
        .then(({ createFaceTracker }) => createFaceTracker(videoEl))
        .then((t) => {
          // 녹화가 이미 끝났으면 버린다.
          if (t && recorderRef.current && recorderRef.current.state === "recording") faceTrackerRef.current = t;
          else t?.stop();
        })
        .catch(() => {});
    }

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
    // 평정심: 면접을 끝까지 완료하지 않고 중단해도, 제출된 답변이 1개 이상이면 리포트를 만든다.
    if (!composureRef.current && composureSignalsRef.current.length > 0) {
      const tr = faceTrackerRef.current;
      const rep = computeComposure({
        perAnswer: composureSignalsRef.current,
        totalSpeakingSec: Math.max(1, Math.floor((Date.now() - startedAtRef.current) / 1000)),
        faceSummary: tr ? tr.summary() : null,
        sttMeasured: sttSupported,
      });
      if (rep.subs.some((s) => s.measured)) {
        composureRef.current = rep;
        setComposure(rep);
      }
    }
    faceTrackerRef.current?.stop(); // 영상 분석 종료
    faceTrackerRef.current = null;
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop(); // onstop 에서 review 로 전환
    }
  }, [stopRecognition, flushInterim, sttSupported]);

  // 현재까지의 모의면접 결과를 녹화 저장용 객체로 만든다(없으면 null).
  const buildInterviewReport = useCallback((): InterviewReport | null => {
    if (!interviewId || aiAnswersRef.current.length === 0) return null;
    // 사용한 이력서 파일명을 리포트에 함께 저장(리포트에 "이력서: 파일명" 표시).
    const resumeName = resumes.find((r) => r.id === selectedResumeId)?.filename ?? null;
    const basedOn = aiBasedOn ? { ...aiBasedOn, resumeName } : undefined;
    return {
      // 답변이 끝난 질문까지만 동봉(아직 답 안 한 마지막 질문은 제외).
      questions: aiQuestionsRef.current.slice(0, aiAnswersRef.current.length),
      answers: aiAnswersRef.current,
      evaluations: aiEvalsRef.current,
      finalReport: aiReportRef.current,
      basedOn,
      composure: composureRef.current ?? undefined,
    };
  }, [interviewId, aiBasedOn, resumes, selectedResumeId]);

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
        jobId: targetJob?.id ?? undefined,
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
  }, [selectedResumeId, selectedRole, targetJob]);

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

    // 평정심: 이번 답변의 신호(응답 지연 / 채움말·회피 / 답변 구간 영상) 기록.
    const tracker = faceTrackerRef.current;
    const faceWin = tracker ? tracker.window(answerFaceStartRef.current, tracker.nowT()) : null;
    const delayMs =
      firstSpeechAtRef.current != null && questionShownAtRef.current > 0
        ? Math.max(0, firstSpeechAtRef.current - questionShownAtRef.current)
        : null;
    composureSignalsRef.current = [
      ...composureSignalsRef.current,
      {
        index: answeredQuestion.index,
        responseDelayMs: delayMs,
        questionChars: (answeredQuestion.question ?? "").length, // 읽는 시간 추정용
        answerChars: contentChars(answer),
        fillerCount: countFillers(answer),
        hedgeCount: countHedges(answer),
        face: faceWin,
      },
    ];

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
        // 평정심 종합 계산(면접 종료 시점까지의 신호).
        const tr = faceTrackerRef.current;
        const rep = computeComposure({
          perAnswer: composureSignalsRef.current,
          totalSpeakingSec: Math.max(1, Math.floor((Date.now() - startedAtRef.current) / 1000)),
          faceSummary: tr ? tr.summary() : null,
          sttMeasured: sttSupported,
        });
        // 측정된 항목이 하나라도 있을 때만 리포트를 노출한다(전부 미측정이면 생략).
        if (rep.subs.some((s) => s.measured)) {
          composureRef.current = rep;
          setComposure(rep);
        }
        tr?.stop();
        faceTrackerRef.current = null;
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
  }, [interviewId, aiQuestion, flushInterim, sttSupported]);

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
      faceTrackerRef.current?.stop();
      if (hudRafRef.current) cancelAnimationFrame(hudRafRef.current);
      if (reviewUrl) URL.revokeObjectURL(reviewUrl);
    };
    // 언마운트 클린업만 — reviewUrl 최신값은 closure 로 충분.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const liveTranscript = (finalText + (interimText ? " " + interimText : "")).trim();

  // 모바일에서는 카메라 녹화·실시간 분석이 제한적이라 PC 이용을 안내한다.
  if (isMobile) {
    return (
      <AppShell user={user} onUser={onUser} onLogout={onLogout}>
        <PageHeader title="면접 연습">
          녹화 버튼을 누르면 내 모습이 녹화되고, 말한 내용이 실시간으로 자막에 표시됩니다.
        </PageHeader>
        <div className="pr-mobile-guard">
          <span className="pr-mobile-guard-icon">
            <CameraIcon size={30} />
          </span>
          <h3>PC에서 이용해 주세요</h3>
          <p>
            면접 연습은 카메라 녹화 · 실시간 자막 · 평정심 분석을 위해 데스크톱 브라우저에 맞춰져 있어요.
            PC로 접속하면 모든 기능을 사용할 수 있습니다.
          </p>
        </div>
      </AppShell>
    );
  }

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
            {aiBasedOn?.companyName && (
              <div className={`pr-persona-badge${aiBasedOn.personaApplied ? " on" : " off"}`}>
                {aiBasedOn.personaApplied
                  ? `${aiBasedOn.companyName} 기업 페르소나 적용 중 — 회사 공식 자료를 근거로 질문합니다`
                  : `${aiBasedOn.companyName} — 수집된 회사 자료가 없어 이력서 기반으로 진행합니다 (자료 준비되면 다음 면접부터 적용)`}
              </div>
            )}
            <div className="pr-q-main">
              <span className={`pr-q-cat${aiQuestion.type === "followup" ? " pr-q-cat-follow" : ""}`}>
                {aiQuestion.type === "followup" ? "꼬리질문" : `질문 ${aiQuestion.index}`}
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
                <div className="pr-field pr-field-target">
                  <span className="pr-field-label">겨냥 공고</span>
                  {targetJob ? (
                    <div className="pr-target-job">
                      <div className="pr-target-info">
                        <span className="pr-target-company">{targetJob.company ?? "회사 미상"}</span>
                        {targetJob.title && <span className="pr-target-title">{targetJob.title}</span>}
                      </div>
                      <button
                        type="button"
                        className="pr-target-clear"
                        onClick={() => setTargetJob(null)}
                        disabled={aiBusy}
                        title="공고 연결 해제(이력서 기반 일반 면접)"
                      >
                        해제
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="pr-target-pick"
                      onClick={() => navigate("/jobs")}
                      disabled={aiBusy}
                    >
                      채용 공고 선택 → 기업 페르소나
                    </button>
                  )}
                </div>
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

      {composure && <ComposureCard composure={composure} />}

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
            {/* HUD 를 영상에 합성하기 위한 숨은 캔버스(녹화 소스) */}
            <canvas ref={hudCanvasRef} style={{ display: "none" }} />
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
                <p className="pr-cam-off-note">
                  시선 안정 · 눈 안정(떨림·깜빡임) · 자세 안정은 카메라가 꺼져 있어 평정심 리포트에서 빠져요.
                  카메라를 켜면 영상 항목까지 함께 분석됩니다.
                </p>
              </div>
            )}

            {phase === "recording" && (
              <div className="pr-rec-badge">
                <span className="pr-rec-dot" /> REC {fmt(elapsed)}
              </div>
            )}

            {/* 녹화 중 실시간 측정값 HUD */}
            {phase === "recording" && liveStats && (
              <div className="pr-hud">
                <div className="pr-hud-title">
                  <span className="pr-hud-live-dot" /> SPEECH
                </div>

                {/* 말하기 속도(wpm) + 라인 그래프 */}
                <div className="pr-hud-block">
                  <span className="pr-hud-label">말하기 속도</span>
                  <span className="pr-hud-value">
                    {liveStats.wpm}
                    <em>wpm</em>
                  </span>
                  <Sparkline data={liveStats.wpmHistory} />
                </div>

                <div className="pr-hud-divider" />

                {/* 필러 사용 + 막대 그래프 */}
                <div className="pr-hud-block">
                  <span className="pr-hud-label">필러(어.. 응..) 사용</span>
                  <span className="pr-hud-value">
                    {liveStats.fillers}
                    <em>회</em>
                  </span>
                  <BarGraph data={liveStats.fillerHistory} />
                </div>
              </div>
            )}

            {/* 평정심(시선·눈·자세) — 왼쪽 아래 별도 패널 */}
            {phase === "recording" && liveStats && (
              <div className="pr-hud pr-hud-left">
                <div className="pr-hud-title">
                  <span className="pr-hud-live-dot" /> COMPOSURE
                </div>
                {liveStats.face ? (
                  <div className="pr-hud-bars">
                    {(
                      [
                        ["시선 안정", liveStats.face.gaze],
                        ["눈 안정", liveStats.face.eye],
                        ["자세 안정", liveStats.face.posture],
                      ] as const
                    ).map(([label, score]) => (
                      <div key={label} className="pr-hud-bar-row">
                        <span className="pr-hud-bar-label">{label}</span>
                        <span className="pr-hud-bar-track">
                          <span className="pr-hud-bar-fill" style={{ width: `${score}%` }} />
                        </span>
                        <span className="pr-hud-bar-score">{score}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="pr-hud-note">
                    {cameraOn ? "얼굴 인식 중…" : "카메라를 켜면 시선·눈·자세도 측정돼요"}
                  </div>
                )}
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
