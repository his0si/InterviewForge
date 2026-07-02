import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { JobPosting, PublicUser } from "@e-lifethon/shared";
import { getJob } from "../api";
import AppShell from "../components/AppShell";
import Splash from "../components/Splash";
import { Events, track } from "../analytics";
import { CopyIcon, ExternalLinkIcon } from "../components/icons";
import { jobRole, sourceMeta } from "./sourceMeta";
import { formatDeadline } from "../format";
import "../trends.css";

// 원문/섹션을 마크다운으로 예쁘게 렌더(일반 텍스트도 줄바꿈 유지).
function Md({ children }: { children: string }) {
  return (
    <div className="job-md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{children}</ReactMarkdown>
    </div>
  );
}

export function JobDetail({
  user,
  onUser,
  onLogout,
}: {
  user: PublicUser;
  onUser: (u: PublicUser) => void;
  onLogout: () => void;
}) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState<JobPosting | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getJob(id)
      .then((j) => {
        setJob(j);
        if (j) {
          track(Events.JOB_DETAIL_VIEW, {
            source: j.source,
            company: j.company ?? null,
            jobTitle: j.title,
          });
        }
      })
      .finally(() => setLoading(false));
  }, [id]);

  const crumbs = (
    <nav className="tr-crumbs" aria-label="경로">
      <span className="tr-crumb">
        <Link to="/jobs">채용 공고</Link>
        <span className="sep">›</span>
      </span>
      <span className="tr-crumb">
        <span className="current">공고 상세</span>
      </span>
    </nav>
  );

  if (loading) return <Splash />;

  if (!job) {
    return (
      <AppShell user={user} onUser={onUser} onLogout={onLogout}>
        {crumbs}
        <div className="tr-detail-card">
          <p style={{ color: "#888" }}>공고를 찾을 수 없습니다.</p>
        </div>
      </AppShell>
    );
  }

  const m = sourceMeta(job.source);

  return (
    <AppShell user={user} onUser={onUser} onLogout={onLogout}>
      {crumbs}

      <div className="tr-detail-card">
        <div className="tr-detail-head">
          <span className="job-src-pill" style={{ color: m.color }}>{m.label}</span>
          <span className="tr-date">
            {job.deadline ? `마감 ~${formatDeadline(job.deadline)}` : job.deadline_text ?? ""}
          </span>
        </div>

        <h1 className="tr-detail-title">{job.title}</h1>

        <div className="job-meta-row" style={{ marginBottom: 4 }}>
          {job.company && <b>{job.company}</b>}
          {jobRole(job.job_categories) && <span>{jobRole(job.job_categories)}</span>}
          {job.location && <span>{job.location}</span>}
          {job.experience_level && <span>{job.experience_level}</span>}
          {job.employment_type && <span>{job.employment_type}</span>}
          {job.education && <span>{job.education}</span>}
        </div>

        {job.skills.length > 0 && (
          <div className="job-tag-row">
            {job.skills.map((s) => (
              <span className="job-tag" key={s}>{s}</span>
            ))}
          </div>
        )}

        <div className="tr-detail-actions">
          <button
            type="button"
            className="tr-btn-primary"
            onClick={() =>
              navigate("/practice", {
                state: { jobId: job.id, jobTitle: job.title, company: job.company ?? null },
              })
            }
          >
            이 공고로 모의면접
          </button>
          <a
            href={job.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="tr-btn-outline"
            onClick={() =>
              track(Events.JOB_SOURCE_CLICK, {
                source: job.source,
                company: job.company ?? null,
                jobTitle: job.title,
              })
            }
          >
            <ExternalLinkIcon size={16} /> 원문 바로가기
          </a>
          <button
            type="button"
            className="tr-btn-outline"
            onClick={() => navigator.clipboard?.writeText(job.source_url)}
          >
            <CopyIcon size={16} /> 링크 복사
          </button>
        </div>

        {job.ai_summary && (
          <>
            <hr className="tr-divider" />
            <div className="job-ai-card">
              <div className="job-ai-badge">AI 요약</div>
              <Md>{job.ai_summary}</Md>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
