// 영상 기반 신호 — MediaPipe FaceLandmarker(블렌드셰이프)로 브라우저에서 실시간 계산.
//  - 서버/GPU 불필요. 라이브 카메라 스트림의 <video> 프레임을 ~12fps 로 샘플링한다.
//  - 블렌드셰이프에서: 눈 깜빡임(eyeBlink), 시선(eyeLook*), 표정 긴장(browDown/mouthPress/eyeSquint),
//    변환행렬에서: 고개 각도(yaw/pitch) → 흔들림.
//  - 모델/워즘은 CDN 에서 로드(런타임 네트워크 필요). 실패하면 tracker=null 로 우아하게 비활성(타이밍/말 신호만 사용).

import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const SAMPLE_INTERVAL_MS = 80; // ~12.5fps
const BLINK_THRESHOLD = 0.5; // eyeBlink 블렌드셰이프가 이 값을 넘으면 감은 것으로 본다.
const GAZE_AWAY_THRESHOLD = 0.45; // eyeLook* 최대값이 이 값을 넘으면 시선이 정면을 벗어난 것.

interface Sample {
  t: number; // performance.now() 기준 ms
  face: boolean;
  blink: number; // (좌+우)/2 eyeBlink
  gaze: number; // 시선 이탈 정도(0~1)
  tension: number; // 표정 긴장(0~1)
  yaw: number; // 고개 좌우(rad)
  pitch: number; // 고개 상하(rad)
}

export interface FaceWindowMetrics {
  faceMeasured: boolean;
  facePresencePct: number | null;
  blinkPerMin: number | null;
  eyeJitter: number | null; // 눈 떨림(eyeBlink 고주파 변동, 0~1)
  gazeAwayPct: number | null;
  headJitter: number | null; // 고개 각도 변동(0~1 정규화)
  tension: number | null;
  samples: number;
}

function bs(map: Map<string, number>, name: string): number {
  return map.get(name) ?? 0;
}

// 열우선(column-major) 4x4 변환행렬에서 yaw/pitch 추출.
function eulerFromMatrix(m: number[]): { yaw: number; pitch: number } {
  const r20 = m[2];
  const r21 = m[6];
  const r22 = m[10];
  const pitch = Math.atan2(r21, r22);
  const yaw = Math.atan2(-r20, Math.hypot(r21, r22));
  return { yaw, pitch };
}

export interface FaceTracker {
  stop(): void;
  window(startT: number, endT: number): FaceWindowMetrics;
  summary(): FaceWindowMetrics;
  nowT(): number;
}

/** 얼굴 트래커 생성. 실패(미지원/네트워크)하면 null. */
export async function createFaceTracker(video: HTMLVideoElement): Promise<FaceTracker | null> {
  const makeOptions = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO" as const,
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });

  let landmarker: FaceLandmarker;
  try {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, makeOptions("GPU"));
    } catch {
      landmarker = await FaceLandmarker.createFromOptions(fileset, makeOptions("CPU"));
    }
  } catch {
    return null; // 모델/워즘 로드 실패(오프라인 등) → 영상 신호 없이 진행.
  }

  const samples: Sample[] = [];
  let running = true;
  let lastSampleT = 0;
  let lastVideoTime = -1;

  const loop = () => {
    if (!running) return;
    const t = performance.now();
    // 같은 프레임 재검출 방지 + 샘플 간격 유지.
    if (
      video.readyState >= 2 &&
      video.currentTime !== lastVideoTime &&
      t - lastSampleT >= SAMPLE_INTERVAL_MS
    ) {
      lastSampleT = t;
      lastVideoTime = video.currentTime;
      try {
        const res = landmarker.detectForVideo(video, t);
        const cats = res.faceBlendshapes?.[0]?.categories;
        if (cats && cats.length) {
          const map = new Map<string, number>();
          for (const c of cats) map.set(c.categoryName, c.score);
          const blink = (bs(map, "eyeBlinkLeft") + bs(map, "eyeBlinkRight")) / 2;
          const gaze =
            Math.max(
              bs(map, "eyeLookOutLeft"),
              bs(map, "eyeLookInLeft"),
              bs(map, "eyeLookOutRight"),
              bs(map, "eyeLookInRight")
            ) *
              0.7 +
            Math.max(
              bs(map, "eyeLookUpLeft"),
              bs(map, "eyeLookDownLeft"),
              bs(map, "eyeLookUpRight"),
              bs(map, "eyeLookDownRight")
            ) *
              0.3;
          const tension =
            ((bs(map, "browDownLeft") + bs(map, "browDownRight")) / 2) * 0.5 +
            ((bs(map, "mouthPressLeft") + bs(map, "mouthPressRight")) / 2) * 0.3 +
            ((bs(map, "eyeSquintLeft") + bs(map, "eyeSquintRight")) / 2) * 0.2;
          const mtx = res.facialTransformationMatrixes?.[0]?.data as number[] | undefined;
          const { yaw, pitch } = mtx ? eulerFromMatrix(mtx) : { yaw: 0, pitch: 0 };
          samples.push({ t, face: true, blink, gaze, tension, yaw, pitch });
        } else {
          samples.push({ t, face: false, blink: 0, gaze: 0, tension: 0, yaw: 0, pitch: 0 });
        }
      } catch {
        /* 개별 프레임 검출 실패는 무시 */
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

  const compute = (from: number, to: number): FaceWindowMetrics => {
    const win = samples.filter((s) => s.t >= from && s.t <= to);
    const empty: FaceWindowMetrics = {
      faceMeasured: false,
      facePresencePct: null,
      blinkPerMin: null,
      eyeJitter: null,
      gazeAwayPct: null,
      headJitter: null,
      tension: null,
      samples: win.length,
    };
    if (win.length < 5) return empty;
    const withFace = win.filter((s) => s.face);
    const presence = withFace.length / win.length;
    if (withFace.length < 5) return { ...empty, facePresencePct: presence };

    // 깜빡임: eyeBlink 가 임계값을 상향 돌파한 횟수.
    let blinks = 0;
    for (let i = 1; i < withFace.length; i++) {
      if (withFace[i - 1].blink < BLINK_THRESHOLD && withFace[i].blink >= BLINK_THRESHOLD) blinks++;
    }
    const durMin = Math.max(1e-3, (withFace[withFace.length - 1].t - withFace[0].t) / 60000);
    const blinkPerMin = blinks / durMin;

    // 눈 떨림: eyeBlink 의 프레임 간 변동(고주파) 평균. 미세하게 계속 떨리면 커진다.
    let dsum = 0;
    for (let i = 1; i < withFace.length; i++) dsum += Math.abs(withFace[i].blink - withFace[i - 1].blink);
    const eyeJitter = clamp01((dsum / (withFace.length - 1)) * 3.5);

    // 시선 이탈 비율.
    const gazeAwayPct = withFace.filter((s) => s.gaze >= GAZE_AWAY_THRESHOLD).length / withFace.length;

    // 고개 흔들림: yaw/pitch 프레임 간 변화량 평균(rad) → 0~1 정규화.
    let hsum = 0;
    for (let i = 1; i < withFace.length; i++) {
      hsum += Math.abs(withFace[i].yaw - withFace[i - 1].yaw) + Math.abs(withFace[i].pitch - withFace[i - 1].pitch);
    }
    const headJitter = clamp01((hsum / (withFace.length - 1)) * 8);

    const tension = clamp01(withFace.reduce((a, s) => a + s.tension, 0) / withFace.length);

    return {
      faceMeasured: true,
      facePresencePct: presence,
      blinkPerMin,
      eyeJitter,
      gazeAwayPct,
      headJitter,
      tension,
      samples: win.length,
    };
  };

  return {
    stop() {
      running = false;
      try {
        landmarker.close();
      } catch {
        /* 무시 */
      }
    },
    window: (from, to) => compute(from, to),
    summary: () => compute(0, Number.MAX_SAFE_INTEGER),
    nowT: () => performance.now(),
  };
}
