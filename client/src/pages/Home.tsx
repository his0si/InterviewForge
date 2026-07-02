import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  InterviewRecording,
  PublicUser,
  RecommendedJob,
  Resume,
} from "@e-lifethon/shared";
import { getRecommendedJobs, getRecordings, getResumes } from "../api";
import AppShell from "../components/AppShell";
import Splash from "../components/Splash";
import { sourceMeta } from "./sourceMeta";
import { formatDeadline } from "../format";
import {
  CameraIcon,
  ExternalLinkIcon,
  SparkleIcon,
} from "../components/icons";
import "./home.css";

// 홈 대시보드: 채용 공고 · 이력서 피드백 · 면접 연습 · 면접 기록을 한 화면에서 본다.

function todayLabel(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}
function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}분 ${s}초` : `${s}초`;
}

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
  const [recommended, setRecommended] = useState<RecommendedJob[]>([]);
  const [recRoles, setRecRoles] = useState<string[]>([]);
  const [recordings, setRecordings] = useState<InterviewRecording[]>([]);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 각 영역을 독립적으로 로드(하나가 실패해도 나머지는 표시). 모두 끝나면 스플래시 해제.
    Promise.allSettled([
      getRecommendedJobs(10).then((r) => {
        setRecommended(r.items);
        setRecRoles(r.basedOn.roles);
      }),
      getRecordings().then(setRecordings),
      getResumes().then(setResumes),
    ]).finally(() => setLoading(false));
  }, []);

  if (loading) return <Splash />;

  return (
    <AppShell user={user} onUser={onUser} onLogout={onLogout}>
      <div className="home-dash">
      <div className="dash-greeting">
        <h1>안녕하세요, {name}님</h1>
        <p>오늘 · {todayLabel()} — 오늘도 면접 준비를 시작해 볼까요?</p>
      </div>

      {/* 맞춤 추천 공고 + 면접 기록 */}
      <div className="dash-bottom-grid home-grid-top">
        {/* 맞춤 추천 공고(직무 + 이력서 기반 로컬 AI 의미검색) */}
        <section className="dash-card dash-card-accent">
          <div className="dash-card-head">
            <h2>
              <SparkleIcon size={16} /> 맞춤 추천 공고
              {recRoles.length > 0 && (
                <span className="home-rec-roles">{recRoles.join(" · ")}</span>
              )}
            </h2>
            <Link to="/jobs" className="dash-link">
              전체 보기 →
            </Link>
          </div>
          {recommended.length === 0 ? (
            <div className="dash-placeholder">표시할 추천 공고가 없습니다.</div>
          ) : (
            <ul className="dash-list">
              {recommended.map((j) => {
                const m = sourceMeta(j.source);
                return (
                  <li key={j.id} className="dash-news-row">
                    <div className="dash-news-meta">
                      <span className="job-src-pill" style={{ color: m.color }}>
                        {m.label}
                      </span>
                      {j.company && <span className="home-sub">{j.company}</span>}
                      <span className="home-rec-side">
                        {j.score > 0 && (
                          <span className="home-rec-match">적합도 {Math.round(j.score * 100)}%</span>
                        )}
                        <span className="dash-date">
                          {j.deadline ? `~${formatDeadline(j.deadline)}` : j.deadline_text ?? ""}
                        </span>
                      </span>
                    </div>
                    <div className="dash-news-title">
                      <span>{j.title}</span>
                      <Link to={`/jobs/${j.id}`} className="dash-ext" aria-label="공고 보기">
                        <ExternalLinkIcon size={16} />
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 최근 면접 기록 */}
        <section className="dash-card">
          <div className="dash-card-head">
            <h2>최근 면접 기록</h2>
            <Link to="/history" className="dash-link">
              전체 보기 →
            </Link>
          </div>
          {recordings.length === 0 ? (
            <div className="dash-placeholder">
              아직 녹화가 없습니다.{" "}
              <Link to="/practice" className="dash-link" style={{ textDecoration: "underline" }}>
                면접 연습 시작 →
              </Link>
            </div>
          ) : (
            <ul className="dash-list">
              {recordings.slice(0, 5).map((r) => (
                <li key={r.id} className="dash-memo-row">
                  <Link to="/history" className="dash-memo-title home-link">
                    {r.title}
                  </Link>
                  <span className="dash-memo-author">
                    {fmtDate(r.created_at)} · {fmtDuration(r.duration_sec)}
                  </span>
                  {r.transcript && <span className="home-snippet">{r.transcript.slice(0, 70)}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* 이력서 피드백 + 면접 연습 */}
      <div className="dash-bottom-grid home-grid-bottom">
        {/* 이력서 피드백 */}
        <section className="dash-card">
          <div className="dash-card-head">
            <h2>이력서 피드백</h2>
            <Link to="/resume" className="dash-link">
              전체 보기 →
            </Link>
          </div>
          {resumes.length === 0 ? (
            <div className="dash-placeholder">
              이력서 PDF 를 올리면 안전하게 저장됩니다.{" "}
              <Link to="/resume" className="dash-link" style={{ textDecoration: "underline" }}>
                업로드 →
              </Link>
            </div>
          ) : (
            <div className="dash-list-scroll">
              <ul className="dash-list">
                {resumes.slice(0, 5).map((r) => (
                  <li key={r.id} className="dash-memo-row">
                    <Link to="/resume" className="dash-memo-title home-link">
                      {r.filename}
                    </Link>
                    <span className="dash-memo-author">
                      {fmtDate(r.created_at)} ·{" "}
                      {r.feedback ? "피드백 완료" : "피드백 대기 중"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* 면접 연습 CTA */}
        <section className="dash-card home-cta-card">
          <div className="dash-card-head">
            <h2>면접 연습</h2>
            <Link to="/practice" className="dash-link">
              연습실 →
            </Link>
          </div>
          <div className="home-cta">
            <p className="home-cta-text">
              카메라로 내 모습을 녹화하고, 말한 내용이 <b>실시간 자막</b>으로 변환됩니다.
              연습이 끝나면 면접 기록에 자동 저장돼 다시 볼 수 있어요.
            </p>
            <Link to="/practice" className="pr-btn pr-btn-primary">
              <CameraIcon size={17} /> 녹화 시작하기
            </Link>
          </div>
        </section>
      </div>
      </div>
    </AppShell>
  );
}
