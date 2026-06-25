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
