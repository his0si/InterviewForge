// 로그인/회원가입 좌측 비주얼. 홈 화면 목업 사진(login-hero.png)을 패널 전체 배경으로 깔고,
// 그 위에 어두운 오버레이 + 로고 + 태그라인을 올린다(CSS .auth-visual). 두 화면이 공유한다.
export default function AuthVisual() {
  return (
    <div className="auth-visual">
      <div className="auth-brand">
        <img className="auth-brand-mark" src="/logo-mark.png" alt="" width={30} height={30} />
        <span>InterviewForge</span>
      </div>

      <div className="auth-tagline">
        <h2>
          We simulate the <span className="accent">pressure.</span>
          <br />
          You master the <span className="accent">room.</span>
        </h2>
        <div className="auth-tagline-sub">
          <span className="rule" aria-hidden />
          <span>AI Interview Simulator</span>
        </div>
      </div>
    </div>
  );
}
