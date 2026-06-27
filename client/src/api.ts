// 인증 API 호출 모음. 모두 같은 출처의 상대경로(/api/...)를 쓴다.
// credentials: "include" 로 httpOnly 쿠키(if_token)를 주고받는다.
import type {
  AiAnswerResponse,
  CrawlSetting,
  CrawlSettingsResponse,
  InterviewRecording,
  InterviewReport,
  StartAiInterviewRequest,
  StartAiInterviewResponse,
  JobPosting,
  JobsResponse,
  LoginResponse,
  MeResponse,
  PublicUser,
  RecommendedJobsResponse,
  RecordingsResponse,
  RegisterResponse,
  Resume,
  ResumesResponse,
} from "@e-lifethon/shared";

async function send<T>(url: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? "요청에 실패했습니다.");
  return data as T;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return send<T>(url, "POST", body);
}

export function register(
  email: string,
  password: string,
  nickname: string,
  jobs: string[]
) {
  return post<RegisterResponse>("/api/auth/register", {
    email,
    password,
    nickname,
    jobs,
  });
}

export function login(email: string, password: string) {
  return post<LoginResponse>("/api/auth/login", { email, password });
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
}

export async function me(): Promise<MeResponse> {
  const res = await fetch("/api/auth/me", { credentials: "include" });
  return (await res.json()) as MeResponse;
}

// 내 계정: 이름(닉네임)·직무 수정 → 갱신된 사용자 반환
export async function updateProfile(
  nickname: string,
  jobs: string[]
): Promise<PublicUser> {
  const data = await send<{ ok: true; user: PublicUser }>(
    "/api/auth/profile",
    "PATCH",
    { nickname, jobs }
  );
  return data.user;
}

// 내 계정: 비밀번호 변경
export function changePassword(currentPassword: string, newPassword: string) {
  return post<{ ok: true; message: string }>("/api/auth/password", {
    currentPassword,
    newPassword,
  });
}

// 채용 공고 목록(출처/검색 필터)
export async function getJobs(opts: {
  source?: string;
  q?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<JobsResponse> {
  const p = new URLSearchParams();
  if (opts.source) p.set("source", opts.source);
  if (opts.q) p.set("q", opts.q);
  if (opts.limit != null) p.set("limit", String(opts.limit));
  if (opts.offset != null) p.set("offset", String(opts.offset));
  const res = await fetch(`/api/jobs?${p.toString()}`, { credentials: "include" });
  return (await res.json()) as JobsResponse;
}

// 맞춤 추천 공고(직무 + 이력서 기반 의미검색)
export async function getRecommendedJobs(limit = 8): Promise<RecommendedJobsResponse> {
  const res = await fetch(`/api/jobs/recommended?limit=${limit}`, { credentials: "include" });
  if (!res.ok) throw new Error("추천 공고를 불러오지 못했습니다.");
  return (await res.json()) as RecommendedJobsResponse;
}

export async function getJob(id: string | number): Promise<JobPosting | null> {
  const res = await fetch(`/api/jobs/${id}`, { credentials: "include" });
  if (!res.ok) return null;
  return (await res.json()) as JobPosting;
}

// ── 관리자(마스터) 전용: 사이트별 크롤링 설정 ──────────────────────────────
export async function getCrawlSettings(): Promise<CrawlSetting[]> {
  const res = await fetch("/api/admin/crawl-settings", { credentials: "include" });
  if (!res.ok) throw new Error("권한이 없거나 설정을 불러오지 못했습니다.");
  const data = (await res.json()) as CrawlSettingsResponse;
  return data.items;
}

// 한 사이트 설정 수정 → 갱신된 설정 반환
export function updateCrawlSetting(
  source: string,
  patch: { interval_hours?: number; mode?: "auto" | "manual"; enabled?: boolean }
): Promise<CrawlSetting> {
  return send<CrawlSetting>(`/api/admin/crawl-settings/${source}`, "PATCH", patch);
}

// 수동 실행 요청(큐잉)
export function runCrawl(source: string): Promise<{ ok: true; message: string }> {
  return post<{ ok: true; message: string }>(
    `/api/admin/crawl-settings/${source}/run`,
    {}
  );
}

// ── 면접 연습 녹화(면접 기록) ──────────────────────────────────────────────
// 녹화 영상(Blob) + 실시간 변환 자막을 multipart 로 업로드한다.
export async function saveRecording(input: {
  video: Blob;
  transcript: string;
  durationSec: number;
  title?: string;
  interviewReport?: InterviewReport | null;
}): Promise<InterviewRecording> {
  const fd = new FormData();
  fd.append("title", input.title ?? "");
  fd.append("transcript", input.transcript);
  fd.append("duration_sec", String(input.durationSec));
  // AI 모의면접으로 녹화했으면 결과(질문·평가·리포트)를 JSON 으로 동봉한다.
  if (input.interviewReport) fd.append("interview_report", JSON.stringify(input.interviewReport));
  // 파일 이름은 서버에서 쓰지 않지만 webm 으로 명시한다.
  fd.append("video", input.video, "interview.webm");
  const res = await fetch("/api/recordings", {
    method: "POST",
    credentials: "include",
    body: fd,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? "녹화 저장에 실패했습니다.");
  return data as InterviewRecording;
}

// 내 녹화 목록(영상 바이트 제외 메타데이터, 최신순)
export async function getRecordings(): Promise<InterviewRecording[]> {
  const res = await fetch("/api/recordings", { credentials: "include" });
  if (!res.ok) throw new Error("녹화 목록을 불러오지 못했습니다.");
  const data = (await res.json()) as RecordingsResponse;
  return data.items;
}

// 영상 재생용 URL(같은 출처, 쿠키 인증). <video src> 에 그대로 사용.
export function recordingVideoUrl(id: number): string {
  return `/api/recordings/${id}/video`;
}

// 녹화 삭제
export async function deleteRecording(id: number): Promise<void> {
  const res = await fetch(`/api/recordings/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? "삭제에 실패했습니다.");
  }
}

// ── 이력서 피드백 ──────────────────────────────────────────────────────────
// 이력서 PDF 업로드(multipart).
export async function uploadResume(file: File): Promise<Resume> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const res = await fetch("/api/resumes", {
    method: "POST",
    credentials: "include",
    body: fd,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? "이력서 업로드에 실패했습니다.");
  return data as Resume;
}

// 내 이력서 목록(파일 바이트 제외 메타데이터, 최신순)
export async function getResumes(): Promise<Resume[]> {
  const res = await fetch("/api/resumes", { credentials: "include" });
  if (!res.ok) throw new Error("이력서 목록을 불러오지 못했습니다.");
  const data = (await res.json()) as ResumesResponse;
  return data.items;
}

// 이력서 단건 조회(분석 상태 폴링용)
export async function getResume(id: number): Promise<Resume> {
  const res = await fetch(`/api/resumes/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error("이력서를 불러오지 못했습니다.");
  return (await res.json()) as Resume;
}

// 이력서 분석 다시 실행
export async function reanalyzeResume(id: number): Promise<void> {
  const res = await fetch(`/api/resumes/${id}/analyze`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? "재분석 요청에 실패했습니다.");
  }
}

// 이력서 PDF 미리보기/다운로드 URL(같은 출처, 쿠키 인증)
export function resumeFileUrl(id: number): string {
  return `/api/resumes/${id}/file`;
}

// 이력서 삭제
export async function deleteResume(id: number): Promise<void> {
  const res = await fetch(`/api/resumes/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? "삭제에 실패했습니다.");
  }
}

// ── AI 모의면접 (LangGraph 상호작용형) ──────────────────────────────────────
// 시작: 이력서/직무/공고로 첫 질문을 받는다.
export async function startAiInterview(
  body: StartAiInterviewRequest = {}
): Promise<StartAiInterviewResponse> {
  const res = await fetch("/api/interview/session", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? "모의면접을 시작하지 못했습니다.");
  return data as StartAiInterviewResponse;
}

// 답변 제출: 평가 + 다음 질문(꼬리/메인) 또는 최종 리포트를 받는다.
export async function submitAiInterviewAnswer(
  interviewId: string,
  answer: string
): Promise<AiAnswerResponse> {
  const res = await fetch(`/api/interview/session/${encodeURIComponent(interviewId)}/answer`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answer }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? "답변을 처리하지 못했습니다.");
  return data as AiAnswerResponse;
}
