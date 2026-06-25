// 인증 API 호출 모음. 모두 같은 출처의 상대경로(/api/...)를 쓴다.
// credentials: "include" 로 httpOnly 쿠키(if_token)를 주고받는다.
import type {
  CrawlSetting,
  CrawlSettingsResponse,
  JobPosting,
  JobsResponse,
  LoginResponse,
  MeResponse,
  PublicUser,
  RegisterResponse,
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
