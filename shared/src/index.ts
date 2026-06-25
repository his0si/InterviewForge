// client 와 server 가 함께 쓰는 타입을 여기에 둔다.
// 예: API 응답 형태를 한 번만 정의해서 양쪽에서 import → 타입 불일치 방지.

export interface HealthResponse {
  ok: boolean;
}

// ── 인증(Auth) ─────────────────────────────────────────────────────────────
// 클라이언트에 노출해도 되는 사용자 정보(비밀번호 제외).
export interface PublicUser {
  id: number;
  email: string;
  nickname: string;
  jobs: string[];
  is_verified: boolean;
  created_at: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  nickname: string;
  jobs: string[]; // 최소 1개
}

// 회원가입 직후 응답: 인증 메일을 보냈다는 안내.
export interface RegisterResponse {
  ok: true;
  message: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  ok: true;
  user: PublicUser;
}

export interface MeResponse {
  user: PublicUser | null;
}

// 모든 인증 API 의 공통 에러 형태.
export interface AuthError {
  ok: false;
  error: string;
}

// ── 채용 공고(크롤러가 채우는 job_postings 를 화면에 노출) ─────────────────
export interface JobPosting {
  id: number;
  source: string; // 출처 키(칩 라벨용): saramin, wanted, …
  source_url: string; // 원본 링크
  title: string;
  company: string | null;
  location: string | null;
  employment_type: string | null;
  experience_level: string | null;
  education: string | null;
  salary: string | null;
  job_categories: string[];
  skills: string[];
  posted_at: string | null;
  deadline: string | null;
  deadline_text: string | null;
  qualifications: string | null;
  preferred: string | null;
  hiring_process: string | null;
  documents: string | null;
  benefits: string | null;
  description: string | null;
  detail_fetched: boolean; // true면 상세까지 수집(빈 항목=실제 없음), false면 미수집(unknown)
  ai_summary: string | null; // 로컬 LLM이 정리한 마크다운 요약
}

export interface JobsResponse {
  items: JobPosting[];
  total: number;
  sources: string[]; // 현재 DB에 존재하는 출처 목록(필터칩용)
}

