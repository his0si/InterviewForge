import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { register } from "../api";
import AuthVisual from "./AuthVisual";
import "../auth.css";

export function Signup() {
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [nickname, setNickname] = useState("");
  const [jobs, setJobs] = useState<string[]>([""]); // 최소 1개
  const [remember, setRemember] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  function updateJob(i: number, value: string) {
    setJobs((prev) => prev.map((j, idx) => (idx === i ? value : j)));
  }
  function addJob() {
    setJobs((prev) => [...prev, ""]);
  }
  function removeJob(i: number) {
    setJobs((prev) => prev.filter((_, idx) => idx !== i));
  }

  // 회원가입 = 인증 메일 전송. (이메일 링크 방식이라 "인증 요청"도 같은 동작)
  async function sendVerification() {
    setError("");
    setDone("");
    if (password.length < 8) {
      setError("비밀번호는 8자 이상이어야 합니다.");
      return;
    }
    if (password !== passwordConfirm) {
      setError("비밀번호가 일치하지 않습니다.");
      return;
    }
    if (!nickname.trim()) {
      setError("닉네임을 입력해 주세요.");
      return;
    }
    const cleanJobs = jobs.map((j) => j.trim()).filter(Boolean);
    if (cleanJobs.length === 0) {
      setError("직무를 최소 1개 입력해 주세요.");
      return;
    }
    setLoading(true);
    try {
      const res = await register(email, password, nickname.trim(), cleanJobs);
      if (remember) localStorage.setItem("saved_email", email);
      setDone(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "가입에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void sendVerification();
  }

  return (
    <div className="auth">
      <AuthVisual />

      <div className="auth-form-card">
        <form className="auth-form" onSubmit={onSubmit}>
          <h1>회원가입</h1>

          {error && <div className="auth-msg error">{error}</div>}
          {done && (
            <div className="auth-msg ok">
              {done}
              <br />
              메일이 안 보이면 스팸함을 확인해 주세요.
            </div>
          )}

          <div className="auth-fields">
            <div className="auth-field">
              <label htmlFor="email">이메일</label>
              <div className="auth-row">
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
                <button
                  className="auth-inline-btn"
                  type="button"
                  onClick={() => void sendVerification()}
                  disabled={loading || !email}
                >
                  {loading ? "전송 중…" : "인증 요청"}
                </button>
              </div>
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
                autoComplete="new-password"
                minLength={8}
                required
              />
            </div>

            <div className="auth-field">
              <label htmlFor="password-confirm">비밀번호 확인</label>
              <input
                id="password-confirm"
                className="auth-input"
                type="password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                required
              />
            </div>

            <div className="auth-field">
              <label htmlFor="nickname">닉네임</label>
              <input
                id="nickname"
                className="auth-input"
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="면접왕"
                maxLength={30}
                required
              />
            </div>

            <div className="auth-field">
              <label>직무 (최소 1개)</label>
              {jobs.map((job, i) => (
                <div className="auth-row" key={i}>
                  <input
                    className="auth-input"
                    type="text"
                    value={job}
                    onChange={(e) => updateJob(i, e.target.value)}
                    placeholder="예: 백엔드 개발자"
                  />
                  {jobs.length > 1 && (
                    <button
                      type="button"
                      className="auth-inline-btn auth-job-remove"
                      onClick={() => removeJob(i)}
                      aria-label="직무 삭제"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <button type="button" className="auth-add-btn" onClick={addJob}>
                + 직무 추가
              </button>
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
              {loading ? "보내는 중…" : done ? "인증 메일 다시 보내기" : "회원가입"}
            </button>
            <button
              className="auth-btn auth-btn-outline"
              type="button"
              onClick={() => navigate("/login")}
            >
              로그인
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
