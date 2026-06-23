import { useState } from "react";
import type { HealthResponse } from "@e-lifethon/shared";

// API는 항상 같은 출처의 상대경로로 호출한다.
//  - 개발: Vite 프록시(vite.config.ts)가 /health 를 백엔드(:8787)로 넘긴다.
//  - 프로덕션: 같은 컨테이너의 Fastify가 정적파일과 API를 같이 서빙한다.
export function App() {
  const [status, setStatus] = useState<string>("");

  async function checkServer() {
    try {
      const res = await fetch("/health");
      const data: HealthResponse = await res.json();
      setStatus(data.ok ? "서버 연결 OK ✅" : "서버 응답 이상");
    } catch {
      setStatus("서버에 연결할 수 없습니다 ❌");
    }
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 40 }}>
      <h1>InterviewForge</h1>
      <p>Vite + React + TypeScript 기본 세팅.</p>
      <button onClick={checkServer}>서버 연결 확인</button>
      {status && <p>{status}</p>}
    </div>
  );
}
