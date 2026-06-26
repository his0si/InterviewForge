import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { JobPosting, PublicUser } from "@e-lifethon/shared";
import { getJobs, getRecommendedJobs } from "../api";
import AppShell from "../components/AppShell";
import AdminCrawlPanel from "../components/AdminCrawlPanel";
import PageHeader from "../components/PageHeader";
import { ExternalLinkIcon, RotateIcon, SearchIcon } from "../components/icons";
import { jobRole, sourceMeta } from "./sourceMeta";
import { formatDeadline } from "../format";
import "../trends.css";

function JobCard({ job }: { job: JobPosting }) {
  const m = sourceMeta(job.source);
  const role = jobRole(job.job_categories);
  return (
    <Link to={`/jobs/${job.id}`} className="tr-post">
      <span className="job-src-pill" style={{ color: m.color }}>
        {m.label}
      </span>
      <div className="tr-post-body">
        <div className="tr-post-head">
          <span className="tr-post-title">{job.title}</span>
          <span className="tr-post-meta">
            <span className="tr-date">
              {job.deadline ? `~${formatDeadline(job.deadline)}` : job.deadline_text ?? ""}
            </span>
          </span>
        </div>
        <div className="job-meta-row">
          {job.company && <b>{job.company}</b>}
          {role && <span>{role}</span>}
          {job.location && <span>{job.location}</span>}
          {job.experience_level && <span>{job.experience_level}</span>}
          {job.employment_type && <span>{job.employment_type}</span>}
        </div>
        {job.skills.length > 0 && (
          <div className="job-tag-row">
            {job.skills.slice(0, 10).map((s) => (
              <span className="job-tag" key={s}>{s}</span>
            ))}
          </div>
        )}
      </div>
      <span className="tr-post-ext" aria-hidden>
        <ExternalLinkIcon size={16} />
      </span>
    </Link>
  );
}

export function Jobs({
  user,
  onUser,
  onLogout,
}: {
  user: PublicUser;
  onUser: (u: PublicUser) => void;
  onLogout: () => void;
}) {
  const [items, setItems] = useState<JobPosting[]>([]);
  const [total, setTotal] = useState(0);
  const [sources, setSources] = useState<string[]>([]);
  const [source, setSource] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"latest" | "recommended">("latest");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);

    if (sort === "recommended") {
      // 추천순: 직무 + 이력서 기반 의미검색 결과를 받아온 뒤,
      // 현재 선택된 출처·검색어로 클라이언트에서 한 번 더 거른다.
      getRecommendedJobs(50)
        .then((res) => {
          const needle = q.trim().toLowerCase();
          const filtered = res.items.filter((j) => {
            if (source && j.source !== source) return false;
            if (needle) {
              const hay = `${j.title} ${j.company ?? ""}`.toLowerCase();
              if (!hay.includes(needle)) return false;
            }
            return true;
          });
          setItems(filtered);
          setTotal(filtered.length);
        })
        .catch(() => {
          setItems([]);
          setTotal(0);
        })
        .finally(() => setLoading(false));
      return;
    }

    getJobs({ source: source || undefined, q: q || undefined, limit: 50 })
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
        if (res.sources.length) setSources(res.sources);
      })
      .finally(() => setLoading(false));
  }, [source, q, sort]);

  return (
    <AppShell user={user} onUser={onUser} onLogout={onLogout}>
      <nav className="tr-crumbs" aria-label="경로">
        <span className="tr-crumb">
          <span className="current">채용 공고</span>
        </span>
      </nav>

      <PageHeader title="채용 공고">여러 사이트의 공고를 한곳에서 — 카드를 누르면 상세, 상세에서 원본으로 이동합니다.</PageHeader>

      {user.is_admin && <AdminCrawlPanel />}

      <div className="tr-filterbar">
        <button
          type="button"
          className={`tr-filter-pill${source === "" ? " active" : ""}`}
          onClick={() => setSource("")}
        >
          전체
        </button>
        {sources.map((s) => (
          <button
            key={s}
            type="button"
            className={`tr-filter-pill${source === s ? " active" : ""}`}
            onClick={() => setSource(s)}
          >
            {sourceMeta(s).label}
          </button>
        ))}
        <div className="tr-filter-right">
          <div className="tr-filter-search">
            <SearchIcon />
            <input
              type="search"
              placeholder="제목·회사 검색"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button type="button" className="tr-reset" onClick={() => { setQ(""); setSource(""); }}>
            <RotateIcon /> 초기화
          </button>
        </div>
      </div>

      <div className="tr-listbar">
        <span className="tr-count">{loading ? "불러오는 중…" : `${total}건`}</span>
        <button
          type="button"
          className="tr-sort"
          onClick={() => setSort((s) => (s === "latest" ? "recommended" : "latest"))}
          title="정렬 순서 바꾸기"
        >
          {sort === "latest" ? "최신순" : "추천순"}
        </button>
      </div>

      {!loading && items.length === 0 ? (
        <div className="tr-post-list">
          <div style={{ padding: 40, textAlign: "center", color: "#888" }}>
            아직 수집된 공고가 없습니다. 크롤러를 실행하면 채워집니다.
          </div>
        </div>
      ) : (
        <div className="tr-post-list">
          {items.map((j) => (
            <JobCard job={j} key={j.id} />
          ))}
        </div>
      )}
    </AppShell>
  );
}
