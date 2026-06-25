import type { PublicUser } from "@e-lifethon/shared";
import AppShell from "../components/AppShell";
import PageHeader from "../components/PageHeader";

// 로그인 후 홈. 내용은 아직 비어 있고, 사이드바 셸만 갖춘다.
export function Home({
  user,
  onUser,
  onLogout,
}: {
  user: PublicUser;
  onUser: (u: PublicUser) => void;
  onLogout: () => void;
}) {
  const name = user.nickname || user.email.split("@")[0];
  return (
    <AppShell user={user} onUser={onUser} onLogout={onLogout}>
      <PageHeader title={`안녕하세요, ${name}님`}>
        InterviewForge 에 오신 걸 환영합니다.
      </PageHeader>
      {/* 본문 내용은 추후 추가 예정 */}
    </AppShell>
  );
}
