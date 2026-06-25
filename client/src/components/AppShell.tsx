import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { PublicUser } from "@e-lifethon/shared";
import { logout as apiLogout } from "../api";
import AccountModal from "./AccountModal";
import {
  BotIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  HomeIcon,
  LogoutIcon,
  MenuIcon,
  NoteIcon,
  SettingsIcon,
  TrendIcon,
  UserIcon,
} from "./icons";
import "./app.css";

// 모든 대시보드 화면이 공유하는 앱 셸. 좌측 사이드바 + 본문(children).
// 인증/사용자 상태는 상위(App)에서 내려준다(쿠키 기반).
export default function AppShell({
  user,
  onUser,
  onLogout,
  children,
}: {
  user: PublicUser;
  onUser: (u: PublicUser) => void;
  onLogout: () => void;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("sidebar_collapsed") === "1"
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountMenu, setAccountMenu] = useState(false);
  const [accountModal, setAccountModal] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  // 라우트 바뀌면 모바일 드로어 닫기
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // 계정 메뉴 바깥 클릭 / ESC 닫기
  useEffect(() => {
    if (!accountMenu) return;
    function onClick(e: MouseEvent) {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) {
        setAccountMenu(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setAccountMenu(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [accountMenu]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      localStorage.setItem("sidebar_collapsed", c ? "0" : "1");
      return !c;
    });
    setAccountMenu(false);
  }

  async function doLogout() {
    await apiLogout();
    onLogout();
  }

  const accountName = user.nickname || user.email.split("@")[0];
  const accountSub = user.jobs.length ? user.jobs.join(" · ") : "InterviewForge 계정";

  return (
    <div className={`app${collapsed ? " collapsed" : ""}${mobileOpen ? " mobile-open" : ""}`}>
      <div className="app-backdrop" onClick={() => setMobileOpen(false)} aria-hidden />
      <aside className="app-sidebar">
        <div className="app-brand">
          <div className="if-brand-mark">IF</div>
          <span className="if-brand-title">InterviewForge</span>
        </div>

        <nav className="app-nav">
          <NavLink to="/" end className="app-nav-item">
            <HomeIcon />
            <span>홈</span>
          </NavLink>
          <NavLink to="/practice" className="app-nav-item">
            <BotIcon />
            <span>면접 연습</span>
          </NavLink>
          <NavLink to="/history" className="app-nav-item">
            <NoteIcon />
            <span>면접 기록</span>
          </NavLink>
          <NavLink to="/feedback" className="app-nav-item">
            <TrendIcon />
            <span>AI 피드백</span>
          </NavLink>
        </nav>

        <div className="app-user">
          <div className="app-user-info">
            <span className="app-user-name">{accountName}</span>
            <span className="app-user-team">{accountSub}</span>
          </div>
          <div className="app-user-actions">
            <div className="app-account" ref={accountRef}>
              <button
                type="button"
                className="app-icon-btn"
                title="설정"
                aria-label="설정"
                aria-expanded={accountMenu}
                onClick={() => setAccountMenu((o) => !o)}
              >
                <SettingsIcon />
              </button>
              {accountMenu && (
                <div className="app-account-menu" role="menu">
                  <div className="app-account-head">
                    <span className="app-account-name">{accountName}</span>
                    <span className="app-account-email">{user.email}</span>
                  </div>
                  <button
                    type="button"
                    className="app-account-item"
                    role="menuitem"
                    onClick={() => {
                      setAccountMenu(false);
                      setMobileOpen(false);
                      setAccountModal(true);
                    }}
                  >
                    <UserIcon size={17} />내 계정
                  </button>
                  <button
                    type="button"
                    className="app-account-item danger"
                    role="menuitem"
                    onClick={doLogout}
                  >
                    <LogoutIcon size={17} />로그아웃
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="app-icon-btn app-collapse-btn"
              title={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
              aria-label={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
              onClick={toggleCollapsed}
            >
              {collapsed ? <ChevronRightIcon size={16} /> : <ChevronLeftIcon size={16} />}
            </button>
          </div>
        </div>
      </aside>

      <div className="app-main-col">
        <header className="app-topbar">
          <button
            type="button"
            className="app-burger"
            onClick={() => setMobileOpen(true)}
            aria-label="메뉴 열기"
          >
            <MenuIcon size={22} />
          </button>
          <div className="app-mobile-brand">
            <div className="if-brand-mark">IF</div>
            <span className="if-brand-title">InterviewForge</span>
          </div>
        </header>

        <main className="app-main">{children}</main>
      </div>

      {accountModal && (
        <AccountModal
          user={user}
          onClose={() => setAccountModal(false)}
          onSaved={onUser}
        />
      )}
    </div>
  );
}
