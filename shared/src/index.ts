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
  is_admin: boolean; // 마스터(관리자) 계정 여부 — 일반 가입자는 항상 false
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

// ── 관리자: 사이트별 크롤링 설정 ───────────────────────────────────────────
// 마스터(is_admin) 계정만 조회·수정할 수 있다. 크롤러(파이썬 데몬)가 이 값을 읽어
// 사이트마다 정해진 주기로 자동 수집하거나(auto), 수동 실행만 받거나(manual),
// 비활성(enabled=false)이면 건너뛴다.
export type CrawlMode = "auto" | "manual";

export interface CrawlSetting {
  source: string; // 출처 키(saramin, wanted, …)
  label: string; // 사람이 읽는 이름(사람인 등)
  implemented: boolean; // 어댑터가 실제 구현돼 있는지(false면 켜도 수집 안 됨)
  interval_hours: number; // 자동 수집 주기(시간). auto 모드에서만 의미.
  mode: CrawlMode; // auto: 주기마다 자동 / manual: 수동 실행만
  enabled: boolean; // false면 자동·수동 모두 건너뜀(비활성화)
  last_run_at: string | null; // 마지막 수집 시각(ISO)
  next_run_at: string | null; // 다음 예정 시각(auto·enabled일 때만 계산)
  last_status: string | null; // 마지막 실행 결과 요약
  pending: boolean; // 수동 실행이 큐에 걸려 처리 대기/진행 중인지
}

export interface CrawlSettingsResponse {
  items: CrawlSetting[];
}

