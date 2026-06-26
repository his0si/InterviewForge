import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { InterviewRecording, PublicUser } from "@e-lifethon/shared";
import { deleteRecording, getRecordings, recordingVideoUrl } from "../api";
import AppShell from "../components/AppShell";
import PageHeader from "../components/PageHeader";
import { CopyIcon, FilmIcon, PlayIcon, TrashIcon } from "../components/icons";
import "./practice.css";

// 면접 기록: 저장된 녹화 목록 → 선택하면 영상 재생 + 변환된 자막 전체를 본다.

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}분 ${s}초` : `${s}초`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function History({
  user,
  onUser,
  onLogout,
}: {
  user: PublicUser;
  onUser: (u: PublicUser) => void;
  onLogout: () => void;
}) {
  const [items, setItems] = useState<InterviewRecording[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      const list = await getRecordings();
      setItems(list);
      setSelectedId((cur) => cur ?? list[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "불러오기에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onDelete(id: number) {
    if (!window.confirm("이 면접 기록을 삭제할까요? 영상과 자막이 모두 삭제됩니다.")) return;
    try {
      await deleteRecording(id);
      setItems((prev) => {
        const next = prev.filter((r) => r.id !== id);
        setSelectedId((cur) => (cur === id ? next[0]?.id ?? null : cur));
        return next;
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : "삭제에 실패했습니다.");
    }
  }

  const [copied, setCopied] = useState(false);
  async function onCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 클립보드 접근 불가 시 무시 */
    }
  }

  const selected = items.find((r) => r.id === selectedId) ?? null;

  return (
    <AppShell user={user} onUser={onUser} onLogout={onLogout}>
      <PageHeader title="면접 기록">
        면접 연습에서 녹화한 영상과 실시간 자막을 다시 확인할 수 있습니다.
      </PageHeader>

      {error && <div className="pr-alert">{error}</div>}

      {loading ? (
        <div className="pr-empty">불러오는 중…</div>
      ) : items.length === 0 ? (
        <div className="pr-empty">
          아직 저장된 면접 기록이 없습니다.{" "}
          <Link to="/practice" className="pr-link">
            면접 연습
          </Link>{" "}
          에서 녹화를 시작해 보세요.
        </div>
      ) : (
        <div className="pr-hist-grid">
          {/* 좌측: 목록 */}
          <aside className="dash-card pr-hist-aside">
            <div className="dash-card-head">
              <h2>녹화 목록</h2>
              <span className="dash-link">{items.length}개</span>
            </div>
            <div className="pr-hist-list">
              {items.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`pr-hist-item${r.id === selectedId ? " active" : ""}`}
                  onClick={() => setSelectedId(r.id)}
                >
                  <span className="pr-hist-thumb" aria-hidden>
                    {r.id === selectedId ? <PlayIcon size={16} /> : <FilmIcon size={16} />}
                  </span>
                  <span className="pr-hist-body">
                    <span className="pr-hist-title">{r.title}</span>
                    <span className="pr-hist-meta">
                      {fmtDate(r.created_at)} · {fmtDuration(r.duration_sec)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          {/* 우측: 재생 + 자막 */}
          <section className="dash-card pr-hist-detail">
            {selected ? (
              <>
                <div className="pr-hist-detail-head">
                  <div className="pr-hist-detail-title">
                    <h2>{selected.title}</h2>
                    <div className="pr-hist-chips">
                      <span className="pr-chip">{fmtDate(selected.created_at)}</span>
                      <span className="pr-chip">{fmtDuration(selected.duration_sec)}</span>
                      <span className="pr-chip">{fmtSize(selected.size_bytes)}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="pr-btn pr-btn-danger"
                    onClick={() => onDelete(selected.id)}
                  >
                    <TrashIcon size={14} /> 삭제
                  </button>
                </div>

                <div className="pr-hist-stage">
                  <video
                    key={selected.id}
                    className="pr-video"
                    controls
                    playsInline
                    src={recordingVideoUrl(selected.id)}
                  />
                </div>

                <div className="pr-hist-transcript-card">
                  <div className="pr-transcript-head">
                    <span>답변</span>
                    {selected.transcript.trim() && (
                      <button
                        type="button"
                        className="pr-copy-btn"
                        onClick={() => onCopy(selected.transcript)}
                      >
                        <CopyIcon size={14} /> {copied ? "복사됨" : "복사"}
                      </button>
                    )}
                  </div>
                  <div className="pr-hist-transcript">
                    {selected.transcript.trim() ? (
                      selected.transcript
                    ) : (
                      <span className="pr-transcript-empty">자막이 없습니다.</span>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="pr-empty">기록을 선택하세요.</div>
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}
