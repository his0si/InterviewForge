import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { PublicUser } from "@e-lifethon/shared";
import { me } from "./api";
import { Login } from "./pages/Login";
import { Signup } from "./pages/Signup";
import { Home } from "./pages/Home";
import { ComingSoon } from "./pages/ComingSoon";

export function App() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  // 새로고침해도 로그인 상태를 복원한다(쿠키 기반).
  useEffect(() => {
    me()
      .then((res) => setUser(res.user))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100svh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "rgba(10,10,10,0.5)",
          fontFamily: "'Pretendard Variable', Pretendard, system-ui, sans-serif",
        }}
      >
        불러오는 중…
      </div>
    );
  }

  // 로그인이 필요한 화면 공통 래퍼
  const authed = (node: (u: PublicUser) => React.ReactNode) =>
    user ? node(user) : <Navigate to="/login" replace />;

  return (
    <Routes>
      <Route
        path="/"
        element={authed((u) => (
          <Home user={u} onUser={setUser} onLogout={() => setUser(null)} />
        ))}
      />
      <Route
        path="/practice"
        element={authed((u) => (
          <ComingSoon title="면접 연습" user={u} onUser={setUser} onLogout={() => setUser(null)} />
        ))}
      />
      <Route
        path="/history"
        element={authed((u) => (
          <ComingSoon title="면접 기록" user={u} onUser={setUser} onLogout={() => setUser(null)} />
        ))}
      />
      <Route
        path="/feedback"
        element={authed((u) => (
          <ComingSoon title="AI 피드백" user={u} onUser={setUser} onLogout={() => setUser(null)} />
        ))}
      />
      <Route
        path="/login"
        element={user ? <Navigate to="/" replace /> : <Login onLogin={setUser} />}
      />
      <Route
        path="/signup"
        element={user ? <Navigate to="/" replace /> : <Signup />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
