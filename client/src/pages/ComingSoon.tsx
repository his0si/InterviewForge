import type { PublicUser } from "@e-lifethon/shared";
import AppShell from "../components/AppShell";
import PageHeader from "../components/PageHeader";

// 아직 내용이 없는 메뉴(면접 연습/기록/피드백)용 자리표시 페이지.
export function ComingSoon({
  title,
  user,
  onUser,
  onLogout,
}: {
  title: string;
  user: PublicUser;
  onUser: (u: PublicUser) => void;
  onLogout: () => void;
}) {
  return (
    <AppShell user={user} onUser={onUser} onLogout={onLogout}>
      <PageHeader title={title}>준비 중입니다.</PageHeader>
    </AppShell>
  );
}
