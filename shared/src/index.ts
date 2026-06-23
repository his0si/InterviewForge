// client 와 server 가 함께 쓰는 타입을 여기에 둔다.
// 예: API 응답 형태를 한 번만 정의해서 양쪽에서 import → 타입 불일치 방지.

export interface HealthResponse {
  ok: boolean;
}
