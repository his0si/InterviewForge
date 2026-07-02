import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AnalysisStatus, PublicUser, Resume } from "@e-lifethon/shared";
import {
  deleteResume,
  getResumes,
  reanalyzeResume,
  resumeFileUrl,
  uploadResume,
} from "../api";
import AppShell from "../components/AppShell";
import PageHeader from "../components/PageHeader";
import Splash from "../components/Splash";
import { Events, track } from "../analytics";
import { ChevronDownIcon, ExternalLinkIcon, RotateIcon, SparkleIcon, TrashIcon } from "../components/icons";
import "./practice.css";

// 이력서 피드백: PDF 업로드 → 로컬 LLM(Ollama)이 원문을 분석해
// 구조화 프로필(직무·기술·강점/보완점) + 마크다운 피드백을 생성한다.

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const STATUS: Record<AnalysisStatus, { label: string; cls: string }> = {
  pending: { label: "분석 대기 중", cls: "outline" },
  processing: { label: "분석 중…", cls: "tag-yellow" },
  done: { label: "분석 완료", cls: "tag-green" },
  error: { label: "분석 실패", cls: "tag-red" },
};

function ChipList({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="rs-chips">
      {items.map((s, i) => (
        <span key={i} className="rs-skill-chip">
          {s}
        </span>
      ))}
    </div>
  );
}

// 분석 진행바: Ollama 가 실제 진척률을 주지 않으므로 경과 시간으로 추정한다.
// 95% 에 점근(완료되기 전 100% 로 차오르지 않게)하고, 경과 초를 함께 보여준다.
const EST_MS = 25000; // 일반적인 분석 소요(추정). 곡선이 초과를 부드럽게 흡수한다.
function AnalysisProgress() {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setElapsed(Date.now() - startRef.current), 200);
    return () => clearInterval(t);
  }, []);
  const sec = Math.floor(elapsed / 1000);
  const pct = Math.min(95, Math.round(95 * (1 - Math.exp(-elapsed / EST_MS))));
  return (
    <div className="rs-progress">
      <div className="rs-progress-top">
        <span>
          <span className="pr-live-dot">●</span> 로컬 AI 가 이력서를 분석하고 있어요…
        </span>
        <span className="rs-progress-time">
          {sec}초 · {pct}%
        </span>
      </div>
      <div className="rs-progress-track">
        <div className="rs-progress-bar" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function AnalysisPanel({ r, onReanalyze }: { r: Resume; onReanalyze: (id: number) => void }) {
  const p = r.analysis;
  if (r.analysis_status === "pending" || r.analysis_status === "processing") {
    return (
      <div className="rs-analysis">
        <AnalysisProgress />
      </div>
    );
  }
  if (r.analysis_status === "error") {
    return (
      <div className="rs-analysis">
        <p className="rs-analysis-empty">
          분석에 실패했습니다. 텍스트가 없는 스캔본 PDF 이거나 일시적인 오류일 수 있어요.
        </p>
        <div className="rs-analysis-foot">
          <button type="button" className="pr-btn pr-btn-ghost rs-btn-sm" onClick={() => onReanalyze(r.id)}>
            <RotateIcon size={14} /> 다시 분석
          </button>
        </div>
      </div>
    );
  }
  // done
  return (
    <div className="rs-analysis">
      {p && (
        <div className="rs-profile">
          {p.summary && <p className="rs-summary">{p.summary}</p>}
          <div className="rs-profile-grid">
            {p.roles.length > 0 && (
              <div className="rs-profile-item">
                <span className="rs-profile-label">직무</span>
                <ChipList items={p.roles} />
              </div>
            )}
            {p.years != null && (
              <div className="rs-profile-item">
                <span className="rs-profile-label">실무 경력</span>
                <span className="rs-profile-val">
                  {p.years}년{" "}
                  <span className="rs-profile-hint">· 정규직·계약직 기준(인턴·학력·프로젝트 제외)</span>
                </span>
              </div>
            )}
            {p.skills.length > 0 && (
              <div className="rs-profile-item">
                <span className="rs-profile-label">기술/역량</span>
                <ChipList items={p.skills} />
              </div>
            )}
            {p.domains.length > 0 && (
              <div className="rs-profile-item">
                <span className="rs-profile-label">도메인</span>
                <ChipList items={p.domains} />
              </div>
            )}
          </div>
        </div>
      )}

      {r.feedback && (
        <section className="rs-feedback-section">
          <div className="rs-section-label">
            <SparkleIcon size={15} /> AI 피드백
          </div>
          <div className="rs-feedback">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{r.feedback}</ReactMarkdown>
          </div>
        </section>
      )}

      <div className="rs-analysis-foot">
        <button type="button" className="pr-btn pr-btn-ghost rs-btn-sm" onClick={() => onReanalyze(r.id)}>
          <RotateIcon size={14} /> 다시 분석
        </button>
      </div>
    </div>
  );
}

export function ResumeFeedback({
  user,
  onUser,
  onLogout,
}: {
  user: PublicUser;
  onUser: (u: PublicUser) => void;
  onLogout: () => void;
}) {
  const [items, setItems] = useState<Resume[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function load() {
    setLoading(true);
    try {
      setItems(await getResumes());
    } catch (err) {
      setError(err instanceof Error ? err.message : "불러오기에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // 분석 진행 중인 이력서가 있으면 주기적으로 새로고침해 완료를 반영한다.
  const anyBusy = items.some(
    (r) => r.analysis_status === "pending" || r.analysis_status === "processing"
  );
  useEffect(() => {
    if (!anyBusy) return;
    const t = window.setInterval(async () => {
      try {
        setItems(await getResumes());
      } catch {
        /* 폴링 실패는 조용히 무시 */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [anyBusy]);

  async function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("PDF 파일만 업로드할 수 있습니다.");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const created = await uploadResume(file);
      track(Events.RESUME_UPLOAD, { sizeKb: Math.round(file.size / 1024) });
      setItems((prev) => [created, ...prev]);
      setOpenId(created.id); // 업로드 직후 분석 패널을 펼쳐 진행 상태를 보여준다
    } catch (err) {
      setError(err instanceof Error ? err.message : "업로드에 실패했습니다.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function onDelete(id: number) {
    if (!window.confirm("이 이력서를 삭제할까요?")) return;
    try {
      await deleteResume(id);
      setItems((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      alert(err instanceof Error ? err.message : "삭제에 실패했습니다.");
    }
  }

  async function onReanalyze(id: number) {
    try {
      await reanalyzeResume(id);
      track(Events.RESUME_REANALYZE);
      setItems((prev) =>
        prev.map((r) => (r.id === id ? { ...r, analysis_status: "pending" } : r))
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : "재분석 요청에 실패했습니다.");
    }
  }

  if (loading) return <Splash />;

  return (
    <AppShell user={user} onUser={onUser} onLogout={onLogout}>
      <PageHeader title="이력서 피드백">
        이력서 PDF 를 올리면 로컬 AI 가 직무·기술·강점을 피드백합니다.
        (모든 분석은 서버 내부에서만 처리되어 외부로 전송되지 않습니다.)
      </PageHeader>

      {error && <div className="pr-alert">{error}</div>}

      {/* 업로드 드롭존 */}
      <div
        className={`rs-drop${dragOver ? " over" : ""}${uploading ? " busy" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!uploading) handleFiles(e.dataTransfer.files);
        }}
        onClick={() => !uploading && inputRef.current?.click()}
        role="button"
        tabIndex={0}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => handleFiles(e.target.files)}
        />
        <div className="rs-drop-icon">PDF</div>
        <div className="rs-drop-text">
          <strong>{uploading ? "업로드 중…" : "이력서 PDF 를 여기에 끌어다 놓거나 클릭해서 선택"}</strong>
          <span>최대 20MB · PDF 형식만 지원</span>
        </div>
      </div>

      {/* 업로드한 이력서 목록 */}
      <div className="rs-list-section">
        <div className="rs-list-head">
          <h2>내 이력서</h2>
          <span className="dash-link">{items.length}개</span>
        </div>
        {items.length === 0 ? (
          <div className="dash-placeholder">아직 올린 이력서가 없습니다. 위에서 PDF 를 올려보세요.</div>
        ) : (
          <ul className="acc-list">
            {items.map((r) => {
              const st = STATUS[r.analysis_status];
              const open = openId === r.id;
              return (
                <li key={r.id} className={`acc-card${open ? " open" : ""}`}>
                  <div className="acc-head">
                    <button
                      type="button"
                      className="acc-head-btn"
                      onClick={() => setOpenId(open ? null : r.id)}
                    >
                      <span className="acc-thumb pdf" aria-hidden>
                        PDF
                      </span>
                      <span className="acc-head-text">
                        <span className="acc-title">{r.filename}</span>
                        <span className="acc-meta">
                          {fmtDate(r.created_at)} · {fmtSize(r.size_bytes)}
                        </span>
                      </span>
                      <span className={`dash-chip ${st.cls}`}>{st.label}</span>
                    </button>
                    <a
                      className="acc-act"
                      href={resumeFileUrl(r.id)}
                      target="_blank"
                      rel="noreferrer"
                      title="원본 PDF 열기"
                      aria-label="원본 PDF 열기"
                    >
                      <ExternalLinkIcon size={15} />
                    </a>
                    <button
                      type="button"
                      className="acc-act danger"
                      title="이 이력서 삭제"
                      aria-label="삭제"
                      onClick={() => onDelete(r.id)}
                    >
                      <TrashIcon size={16} />
                    </button>
                    <button
                      type="button"
                      className="acc-chev-btn"
                      onClick={() => setOpenId(open ? null : r.id)}
                      aria-label={open ? "접기" : "펼치기"}
                    >
                      <span className="acc-chev">
                        <ChevronDownIcon size={16} />
                      </span>
                    </button>
                  </div>
                  {open && (
                    <div className="acc-body">
                      <AnalysisPanel r={r} onReanalyze={onReanalyze} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
