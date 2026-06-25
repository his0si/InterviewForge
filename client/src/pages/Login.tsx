import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { PublicUser } from "@e-lifethon/shared";
import { login } from "../api";
import AuthVisual from "./AuthVisual";
import "../auth.css";

// /api/auth/verify 가 리다이렉트하며 붙여주는 ?verify= 값에 대한 안내문구.
const VERIFY_MSG: Record<string, string> = {
  success: "이메일 인증이 완료되었습니다. 이제 로그인하세요.",
  expired: "인증 링크가 만료되었습니다. 다시 가입해 인증 메일을 받아주세요.",
  invalid: "유효하지 않은 인증 링크입니다.",
};

export function Login({ onLogin }: { onLogin: (u: PublicUser) => void }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const verify = params.get("verify");

  // "아이디 저장" — 저장해둔 이메일이 있으면 미리 채운다.
  const savedEmail = localStorage.getItem("saved_email") ?? "";
  const [email, setEmail] = useState(savedEmail);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(Boolean(savedEmail));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await login(email, password);
      if (remember) localStorage.setItem("saved_email", email);
      else localStorage.removeItem("saved_email");
      onLogin(res.user);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth">
      <AuthVisual />

      <div className="auth-form-card">
        <form className="auth-form" onSubmit={onSubmit}>
          <h1>로그인</h1>

          {verify && VERIFY_MSG[verify] && (
            <div className={`auth-msg ${verify === "success" ? "ok" : "error"}`}>
              {VERIFY_MSG[verify]}
            </div>
          )}
          {error && <div className="auth-msg error">{error}</div>}

          <div className="auth-fields">
            <div className="auth-field">
              <label htmlFor="email">이메일</label>
              <input
                id="email"
                className="auth-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                autoComplete="email"
                required
              />
            </div>

            <div className="auth-field">
              <label htmlFor="password">비밀번호</label>
              <input
                id="password"
                className="auth-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
              />
            </div>

            <label className="auth-remember">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>아이디 저장</span>
            </label>
          </div>

          <div className="auth-actions">
            <button className="auth-btn auth-btn-primary" type="submit" disabled={loading}>
              {loading ? "로그인 중…" : "로그인"}
            </button>
            <button
              className="auth-btn auth-btn-outline"
              type="button"
              onClick={() => navigate("/signup")}
            >
              회원가입
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
