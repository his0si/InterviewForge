import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { PublicUser } from "@e-lifethon/shared";
import { me } from "./api";
import { Login } from "./pages/Login";
import { Signup } from "./pages/Signup";
import { Home } from "./pages/Home";
import { Jobs } from "./pages/Jobs";
import { JobDetail } from "./pages/JobDetail";
import { Practice } from "./pages/Practice";
import { History } from "./pages/History";
import { ResumeFeedback } from "./pages/ResumeFeedback";

// index.html 의 스플래시를 부드럽게 사라지게 한 뒤 DOM 에서 제거한다.
function hideSplash() {
  const el = document.getElementById("splash");
  if (!el) return;
  el.classList.add("splash-hide");
  window.setTimeout(() => el.remove(), 500);
}

export function App() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  // 새로고침해도 로그인 상태를 복원한다(쿠키 기반).
  useEffect(() => {
    me()
      .then((res) => setUser(res.user))
      .finally(() => {
        setLoading(false);
        hideSplash(); // 초기 로딩(번들+인증)이 끝나면 index.html 스플래시 제거
      });
  }, []);

  // 로딩 중에는 index.html 의 스플래시가 화면을 덮고 있으므로 아무것도 그리지 않는다.
  if (loading) return null;

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
        path="/jobs"
        element={authed((u) => (
          <Jobs user={u} onUser={setUser} onLogout={() => setUser(null)} />
        ))}
      />
      <Route
        path="/jobs/:id"
        element={authed((u) => (
          <JobDetail user={u} onUser={setUser} onLogout={() => setUser(null)} />
        ))}
      />
      <Route
        path="/resume"
        element={authed((u) => (
          <ResumeFeedback user={u} onUser={setUser} onLogout={() => setUser(null)} />
        ))}
      />
      <Route
        path="/practice"
        element={authed((u) => (
          <Practice user={u} onUser={setUser} onLogout={() => setUser(null)} />
        ))}
      />
      <Route
        path="/history"
        element={authed((u) => (
          <History user={u} onUser={setUser} onLogout={() => setUser(null)} />
        ))}
      />
      {/* 옛 경로 호환: /feedback → /resume */}
      <Route path="/feedback" element={<Navigate to="/resume" replace />} />
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
