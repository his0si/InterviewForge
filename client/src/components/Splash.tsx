// 로딩 중 화면 전체를 덮는 스플래시(로고 + 스피너). index.html 초기 스플래시와 동일한 모양.
export default function Splash() {
  return (
    <div className="app-splash" role="status" aria-label="불러오는 중">
      <img className="app-splash-logo" src="/logo-mark.png" alt="InterviewForge" width={78} height={78} />
      <div className="app-splash-name">InterviewForge</div>
      <div className="app-splash-spin" />
    </div>
  );
}
