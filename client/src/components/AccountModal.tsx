import { useEffect, useState } from "react";
import type { PublicUser } from "@e-lifethon/shared";
import { changePassword, updateProfile } from "../api";
import { CloseIcon } from "./icons";

type Msg = { type: "ok" | "err"; text: string } | null;

// 사이드바 설정 → "내 계정" 모달. 이름(닉네임)/직무 변경 + 비밀번호 변경.
export default function AccountModal({
  user,
  onClose,
  onSaved,
}: {
  user: PublicUser;
  onClose: () => void;
  onSaved: (updated: PublicUser) => void;
}) {
  const [nickname, setNickname] = useState(user.nickname);
  const [jobs, setJobs] = useState<string[]>(user.jobs.length ? user.jobs : [""]);

  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwMsg, setPwMsg] = useState<Msg>(null);
  const [pwLoading, setPwLoading] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<Msg>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function updateJob(i: number, value: string) {
    setJobs((prev) => prev.map((j, idx) => (idx === i ? value : j)));
  }
  function addJob() {
    setJobs((prev) => [...prev, ""]);
  }
  function removeJob(i: number) {
    setJobs((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function onChangePassword() {
    setPwMsg(null);
    if (pw.length < 8) {
      setPwMsg({ type: "err", text: "새 비밀번호는 8자 이상이어야 합니다." });
      return;
    }
    if (pw !== pw2) {
      setPwMsg({ type: "err", text: "새 비밀번호가 일치하지 않습니다." });
      return;
    }
    setPwLoading(true);
    try {
      const res = await changePassword(cur, pw);
      setPwMsg({ type: "ok", text: res.message });
      setCur("");
      setPw("");
      setPw2("");
    } catch (e) {
      setPwMsg({ type: "err", text: e instanceof Error ? e.message : "변경에 실패했습니다." });
    } finally {
      setPwLoading(false);
    }
  }

  async function onSave() {
    setSaveMsg(null);
    if (!nickname.trim()) {
      setSaveMsg({ type: "err", text: "이름(닉네임)을 입력해 주세요." });
      return;
    }
    const cleanJobs = jobs.map((j) => j.trim()).filter(Boolean);
    if (cleanJobs.length === 0) {
      setSaveMsg({ type: "err", text: "직무를 최소 1개 입력해 주세요." });
      return;
    }
    setSaving(true);
    try {
      const updated = await updateProfile(nickname.trim(), cleanJobs);
      onSaved(updated);
      onClose();
    } catch (e) {
      setSaveMsg({ type: "err", text: e instanceof Error ? e.message : "저장에 실패했습니다." });
      setSaving(false);
    }
  }

  return (
    <div className="acct-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="acct-modal" onClick={(e) => e.stopPropagation()}>
        <div className="acct-head">
          <span className="acct-title">내 계정</span>
          <button type="button" className="acct-x" onClick={onClose} aria-label="닫기">
            <CloseIcon size={20} />
          </button>
        </div>

        <div className="acct-body">
          <div className="acct-field">
            <label htmlFor="acct-nickname">이름</label>
            <input
              id="acct-nickname"
              className="acct-input"
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="면접왕"
              maxLength={30}
            />
          </div>

          <div className="acct-section">
            <div className="acct-section-title">비밀번호 변경</div>
            <input
              className="acct-input"
              type="password"
              placeholder="현재 비밀번호"
              autoComplete="current-password"
              value={cur}
              onChange={(e) => setCur(e.target.value)}
            />
            <input
              className="acct-input"
              type="password"
              placeholder="새 비밀번호"
              autoComplete="new-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
            <input
              className="acct-input"
              type="password"
              placeholder="새 비밀번호 확인"
              autoComplete="new-password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
            />
            {pwMsg && <div className={`acct-msg ${pwMsg.type}`}>{pwMsg.text}</div>}
            <button
              type="button"
              className="acct-btn-sm"
              onClick={onChangePassword}
              disabled={pwLoading || !cur || !pw || !pw2}
            >
              {pwLoading ? "변경 중…" : "변경"}
            </button>
          </div>

          <div className="acct-section">
            <div className="acct-section-title">직무 변경 (최소 1개)</div>
            {jobs.map((job, i) => (
              <div className="acct-jobs-row" key={i}>
                <input
                  className="acct-input"
                  type="text"
                  value={job}
                  onChange={(e) => updateJob(i, e.target.value)}
                  placeholder="예: 백엔드 개발자"
                />
                {jobs.length > 1 && (
                  <button
                    type="button"
                    className="acct-job-remove"
                    onClick={() => removeJob(i)}
                    aria-label="직무 삭제"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button type="button" className="acct-add-btn" onClick={addJob}>
              + 직무 추가
            </button>
          </div>
        </div>

        <div className="acct-foot">
          {saveMsg && <div className={`acct-msg ${saveMsg.type}`}>{saveMsg.text}</div>}
          <button type="button" className="acct-btn-outline" onClick={onClose}>
            닫기
          </button>
          <button type="button" className="acct-btn-primary" onClick={onSave} disabled={saving}>
            {saving ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}
