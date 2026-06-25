// 마스터(is_admin) 계정에게만 채용 공고 화면 상단에 뜨는 "관리자 메뉴".
// 사이트별로 (1) 자동 수집 주기(시간) (2) 자동/수동 (3) 비활성화 를 제어하고,
// 수동 실행을 즉시 요청할 수 있다. 일반 사용자에겐 렌더링되지 않는다.
import { useEffect, useState } from "react";
import type { CrawlSetting } from "@e-lifethon/shared";
import { getCrawlSettings, runCrawl, updateCrawlSetting } from "../api";
import { sourceMeta } from "../pages/sourceMeta";
import "./adminCrawl.css";

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Row({
  s,
  onChange,
}: {
  s: CrawlSetting;
  onChange: (next: CrawlSetting) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [hours, setHours] = useState(String(s.interval_hours));
  const [note, setNote] = useState<string | null>(null);
  const m = sourceMeta(s.source);

  // 서버 값이 바뀌면 입력칸도 동기화.
  useEffect(() => setHours(String(s.interval_hours)), [s.interval_hours]);

  async function patch(p: { interval_hours?: number; mode?: "auto" | "manual"; enabled?: boolean }) {
    setBusy(true);
    setNote(null);
    try {
      const next = await updateCrawlSetting(s.source, p);
      onChange(next);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function commitHours() {
    const h = Math.round(Number(hours));
    if (!Number.isFinite(h) || h < 1 || h > 720) {
      setHours(String(s.interval_hours));
      setNote("주기는 1~720시간");
      return;
    }
    if (h !== s.interval_hours) void patch({ interval_hours: h });
  }

  async function run() {
    setBusy(true);
    setNote(null);
    try {
      const r = await runCrawl(s.source);
      setNote(r.message);
      onChange({ ...s, pending: true });
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const dim = !s.implemented;
  return (
    <div className={`acp-row${dim ? " acp-dim" : ""}`}>
      <div className="acp-name">
        <span className="acp-chip" style={{ color: m.color, borderColor: m.color }}>{s.label}</span>
        {!s.implemented && <span className="acp-tag">미구현</span>}
      </div>

      {/* 활성화 토글 */}
      <label className="acp-toggle" title="비활성화하면 자동·수동 모두 건너뜁니다">
        <input
          type="checkbox"
          checked={s.enabled}
          disabled={busy || dim}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        <span className="acp-track" aria-hidden><span className="acp-thumb" /></span>
        <span className="acp-toggle-label">{s.enabled ? "활성" : "비활성"}</span>
      </label>

      {/* 자동/수동 */}
      <div className="acp-mode">
        <button
          type="button"
          className={s.mode === "auto" ? "on" : ""}
          disabled={busy || dim || !s.enabled}
          onClick={() => s.mode !== "auto" && patch({ mode: "auto" })}
        >
          자동
        </button>
        <button
          type="button"
          className={s.mode === "manual" ? "on" : ""}
          disabled={busy || dim || !s.enabled}
          onClick={() => s.mode !== "manual" && patch({ mode: "manual" })}
        >
          수동
        </button>
      </div>

      {/* 주기(시간) — auto 일 때만 의미 */}
      <div className="acp-interval">
        <input
          type="number"
          min={1}
          max={720}
          value={hours}
          disabled={busy || dim || !s.enabled || s.mode !== "auto"}
          onChange={(e) => setHours(e.target.value)}
          onBlur={commitHours}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <span>시간마다</span>
      </div>

      {/* 마지막/다음 */}
      <div className="acp-times">
        <span>최근 {fmt(s.last_run_at)}</span>
        <span>{s.mode === "auto" && s.enabled ? `다음 ${fmt(s.next_run_at)}` : "—"}</span>
      </div>

      {/* 수동 실행 */}
      <button
        type="button"
        className="acp-run"
        disabled={busy || dim || !s.enabled || s.pending}
        onClick={run}
      >
        {s.pending ? "실행 대기중…" : "지금 실행"}
      </button>

      {note && <div className="acp-note">{note}</div>}
    </div>
  );
}

export default function AdminCrawlPanel() {
  const [items, setItems] = useState<CrawlSetting[] | null>(null);
  const [open, setOpen] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      setItems(await getCrawlSettings());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // 진행 중(pending)인 사이트가 있으면 주기적으로 새로고침해 상태/시각을 갱신.
  useEffect(() => {
    if (!items?.some((s) => s.pending)) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [items]);

  function replaceOne(next: CrawlSetting) {
    setItems((prev) => prev?.map((s) => (s.source === next.source ? next : s)) ?? prev);
  }

  return (
    <section className="acp">
      <button type="button" className="acp-head" onClick={() => setOpen((o) => !o)}>
        <span className="acp-title">관리자 메뉴 · 사이트별 크롤링</span>
        <span className="acp-sub">자동 수집 주기 · 자동/수동 · 비활성화</span>
        <span className="acp-caret">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="acp-body">
          {err && <div className="acp-error">{err}</div>}
          {!items && !err && <div className="acp-loading">불러오는 중…</div>}
          {items && (
            <>
              <div className="acp-row acp-colhead">
                <span>사이트</span>
                <span>상태</span>
                <span>모드</span>
                <span>주기</span>
                <span>최근 / 다음</span>
                <span>수동</span>
              </div>
              {items.map((s) => (
                <Row key={s.source} s={s} onChange={replaceOne} />
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}
