// 로그인/회원가입 좌측 비주얼 카드 (워드마크 + 태그라인). 두 화면이 공유한다.
// 원본(hansolax)의 사진+로고 자리를 InterviewForge 그라데이션+워드마크로 대체.
export default function AuthVisual() {
  return (
    <div className="auth-visual">
      <p className="auth-logo">
        InterviewForge<span className="dot">.</span>
      </p>
      <div className="auth-tagline">
        <h2>
          We simulate the pressure.
          <br />
          You master the room.
        </h2>
        <div className="auth-tagline-sub">
          <span className="rule" aria-hidden />
          <span>AI Interview Simulator</span>
        </div>
      </div>
    </div>
  );
}
