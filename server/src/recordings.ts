// 면접 연습 녹화(면접 기록) 라우트.
// - 면접 연습 화면에서 녹화한 영상(webm)과 실시간 변환 자막(transcript)을 받아 DB 에 저장한다.
// - 영상 바이트는 interview_recordings.video(BYTEA)에 그대로 보관한다.
// - 모든 라우트는 로그인(쿠키 if_token)이 필요하며, 자기 소유 레코드만 접근할 수 있다.
import type { FastifyInstance } from "fastify";
import type { InterviewRecording, InterviewReport, RecordingsResponse } from "@e-lifethon/shared";
import { pool } from "./db.js";
import { currentUserId } from "./auth.js";

// 영상은 사용자가 직접 보는 한 명 분량이라 넉넉히 200MB 까지 허용한다.
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

// 영상 바이트를 뺀 메타데이터 컬럼(목록/단건 공통).
const META_COLS = `id, title, transcript, duration_sec, mime_type, size_bytes, interview_report, created_at`;

function toRecording(row: Record<string, unknown>): InterviewRecording {
  return {
    id: row.id as number,
    title: row.title as string,
    transcript: row.transcript as string,
    duration_sec: row.duration_sec as number,
    mime_type: row.mime_type as string,
    size_bytes: row.size_bytes as number,
    // JSONB 컬럼은 pg 가 이미 객체로 파싱해 준다(없으면 null).
    interview_report: (row.interview_report as InterviewReport | null) ?? null,
    created_at: (row.created_at as Date).toISOString(),
  };
}

export async function recordingRoutes(app: FastifyInstance): Promise<void> {
  // ── 업로드: multipart(video 파일 + title/transcript/duration_sec 필드) ──────
  app.post("/api/recordings", async (req, reply) => {
    const userId = currentUserId(req);
    if (!userId) return reply.code(401).send({ error: "로그인이 필요합니다." });

    // @fastify/multipart 가 등록돼 있어야 한다(index.ts 에서 register).
    if (!req.isMultipart()) {
      return reply.code(400).send({ error: "multipart/form-data 로 업로드하세요." });
    }

    let title = "";
    let transcript = "";
    let durationSec = 0;
    let mimeType = "video/webm";
    let video: Buffer | null = null;
    let interviewReport: unknown = null; // AI 모의면접 결과(JSON 문자열로 전송됨)

    // 파트를 순서대로 읽는다. 파일 파트(video)는 버퍼로 모은다.
    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "video") {
          // 알 수 없는 파일 파트는 스트림을 비워 막힘을 방지한다.
          part.file.resume();
          continue;
        }
        mimeType = part.mimetype || mimeType;
        video = await part.toBuffer();
      } else {
        const value = typeof part.value === "string" ? part.value : String(part.value);
        if (part.fieldname === "title") title = value.slice(0, 200);
        else if (part.fieldname === "transcript") transcript = value;
        else if (part.fieldname === "duration_sec") durationSec = Math.max(0, Math.floor(Number(value) || 0));
        else if (part.fieldname === "interview_report") {
          // 모의면접 결과는 JSON 문자열로 온다. 깨졌으면 조용히 무시(녹화 저장은 계속).
          try {
            interviewReport = value ? JSON.parse(value) : null;
          } catch {
            interviewReport = null;
          }
        }
      }
    }

    if (!video || video.length === 0) {
      return reply.code(400).send({ error: "video 파일이 필요합니다." });
    }
    if (video.length > MAX_VIDEO_BYTES) {
      return reply.code(413).send({ error: "영상이 너무 큽니다(최대 200MB)." });
    }

    // 제목이 비면 날짜 기반 자동 제목을 붙인다.
    if (!title.trim()) {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      title = `면접 연습 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }

    try {
      const res = await pool.query(
        `INSERT INTO interview_recordings
           (user_id, title, transcript, duration_sec, mime_type, size_bytes, video, interview_report)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${META_COLS}`,
        [
          userId,
          title,
          transcript,
          durationSec,
          mimeType,
          video.length,
          video,
          interviewReport ? JSON.stringify(interviewReport) : null,
        ]
      );
      return reply.code(201).send(toRecording(res.rows[0]));
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "녹화 저장에 실패했습니다." });
    }
  });

  // ── 목록: 내 녹화 메타데이터(영상 바이트 제외, 최신순) ──────────────────────
  app.get("/api/recordings", async (req, reply) => {
    const userId = currentUserId(req);
    if (!userId) return reply.code(401).send({ error: "로그인이 필요합니다." });

    const res = await pool.query(
      `SELECT ${META_COLS} FROM interview_recordings
        WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    const body: RecordingsResponse = { items: res.rows.map(toRecording) };
    return body;
  });

  // ── 재생: 영상 바이트 스트리밍(자기 소유만) ────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/recordings/:id/video", async (req, reply) => {
    const userId = currentUserId(req);
    if (!userId) return reply.code(401).send({ error: "로그인이 필요합니다." });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "잘못된 id 입니다." });

    const res = await pool.query(
      `SELECT video, mime_type FROM interview_recordings WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (res.rowCount === 0) return reply.code(404).send({ error: "녹화를 찾을 수 없습니다." });

    const { video, mime_type } = res.rows[0];
    const buf = video as Buffer;
    const total = buf.length;
    const type = mime_type || "video/webm";

    reply
      .header("Content-Type", type)
      .header("Cache-Control", "private, max-age=3600")
      .header("Accept-Ranges", "bytes");

    // Range 요청 지원(썸네일 프레임 추출·탐색 시 부분만 내려받도록 206 응답).
    const range = req.headers.range;
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        return reply
          .code(416)
          .header("Content-Range", `bytes */${total}`)
          .send();
      }
      end = Math.min(end, total - 1);
      return reply
        .code(206)
        .header("Content-Range", `bytes ${start}-${end}/${total}`)
        .header("Content-Length", end - start + 1)
        .send(buf.subarray(start, end + 1));
    }

    return reply.header("Content-Length", total).send(buf);
  });

  // ── 삭제: 자기 소유 녹화 삭제 ─────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/api/recordings/:id", async (req, reply) => {
    const userId = currentUserId(req);
    if (!userId) return reply.code(401).send({ error: "로그인이 필요합니다." });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "잘못된 id 입니다." });

    const res = await pool.query(
      `DELETE FROM interview_recordings WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (res.rowCount === 0) return reply.code(404).send({ error: "녹화를 찾을 수 없습니다." });
    return { ok: true as const };
  });
}
