// 이력서 피드백 라우트.
// - 사용자가 올린 이력서 PDF 를 DB(resumes.file BYTEA)에 저장한다.
// - 업로드 시 PDF 원문 텍스트를 추출해 resumes.extracted_text 에 함께 저장한다(분석/피드백 입력).
// - AI 피드백 생성은 추후 추가(현재는 업로드/보관/조회/삭제 + 원문 추출까지).
// - 모든 라우트는 로그인(쿠키 if_token)이 필요하며, 자기 소유 레코드만 접근할 수 있다.
import type { FastifyInstance } from "fastify";
import type { Resume, ResumeProfile, AnalysisStatus, ResumesResponse } from "@e-lifethon/shared";
import { extractText, getDocumentProxy } from "unpdf";
import { pool } from "./db.js";
import { currentUserId } from "./auth.js";
import { analyzeResume } from "./resumeAnalysis.js";
import { collapseLetterSpacing } from "./textUtil.js";

const MAX_PDF_BYTES = 20 * 1024 * 1024; // 이력서 PDF 는 20MB 까지 허용
// 목록/메타에는 원문 전체 대신 글자 수만 내려준다(원문은 별도 /text 로 조회).
const META_COLS = `id, filename, mime_type, size_bytes,
  COALESCE(char_length(extracted_text), 0) AS extracted_chars,
  analysis, analysis_status, analyzed_at, feedback, created_at`;

function toResume(row: Record<string, unknown>): Resume {
  return {
    id: row.id as number,
    filename: row.filename as string,
    mime_type: row.mime_type as string,
    size_bytes: row.size_bytes as number,
    extracted_chars: Number(row.extracted_chars ?? 0),
    analysis_status: ((row.analysis_status as string) ?? "pending") as AnalysisStatus,
    analysis: (row.analysis as ResumeProfile | null) ?? null,
    feedback: (row.feedback as string | null) ?? null,
    analyzed_at: row.analyzed_at ? (row.analyzed_at as Date).toISOString() : null,
    created_at: (row.created_at as Date).toISOString(),
  };
}

// PDF 바이트에서 원문 텍스트를 추출한다. 실패하면 빈 문자열(업로드 자체는 막지 않는다).
async function extractPdfText(file: Buffer): Promise<string> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(file));
    const { text } = await extractText(pdf, { mergePages: true });
    const merged = (Array.isArray(text) ? text.join("\n") : text).trim();
    return collapseLetterSpacing(merged);
  } catch {
    return "";
  }
}

export async function resumeRoutes(app: FastifyInstance): Promise<void> {
  // ── 업로드: multipart(file: PDF) ──────────────────────────────────────────
  app.post("/api/resumes", async (req, reply) => {
    const userId = currentUserId(req);
    if (!userId) return reply.code(401).send({ error: "로그인이 필요합니다." });
    if (!req.isMultipart()) {
      return reply.code(400).send({ error: "multipart/form-data 로 업로드하세요." });
    }

    let filename = "resume.pdf";
    let mimeType = "application/pdf";
    let file: Buffer | null = null;

    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "file") {
          part.file.resume();
          continue;
        }
        filename = (part.filename || filename).slice(0, 255);
        mimeType = part.mimetype || mimeType;
        file = await part.toBuffer();
      }
    }

    if (!file || file.length === 0) {
      return reply.code(400).send({ error: "PDF 파일이 필요합니다." });
    }
    // PDF 만 허용(확장자 또는 매직넘버 %PDF 로 가볍게 검사).
    const isPdf =
      mimeType === "application/pdf" ||
      filename.toLowerCase().endsWith(".pdf") ||
      file.subarray(0, 4).toString("latin1") === "%PDF";
    if (!isPdf) {
      return reply.code(415).send({ error: "PDF 파일만 업로드할 수 있습니다." });
    }
    if (file.length > MAX_PDF_BYTES) {
      return reply.code(413).send({ error: "파일이 너무 큽니다(최대 20MB)." });
    }

    // PDF 원문 추출(분석/피드백 입력용). 실패해도 업로드는 계속 진행한다.
    const extractedText = await extractPdfText(file);
    if (!extractedText) {
      req.log.warn({ filename }, "이력서 PDF 에서 텍스트를 추출하지 못했습니다(스캔본일 수 있음).");
    }

    try {
      const res = await pool.query(
        `INSERT INTO resumes (user_id, filename, mime_type, size_bytes, file, extracted_text, analysis_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${META_COLS}`,
        [
          userId,
          filename,
          "application/pdf",
          file.length,
          file,
          extractedText || null,
          extractedText ? "pending" : "error",
        ]
      );
      const row = res.rows[0];
      // 원문이 있으면 백그라운드로 로컬 LLM 분석을 시작한다(응답은 즉시 반환).
      if (extractedText) {
        analyzeResume(row.id as number).catch((e) => req.log.error(e, "이력서 분석 실패"));
      }
      return reply.code(201).send(toResume(row));
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "이력서 저장에 실패했습니다." });
    }
  });

  // ── 목록: 내 이력서(파일 바이트 제외, 최신순) ──────────────────────────────
  app.get("/api/resumes", async (req, reply) => {
    const userId = currentUserId(req);
    if (!userId) return reply.code(401).send({ error: "로그인이 필요합니다." });
    const res = await pool.query(
      `SELECT ${META_COLS} FROM resumes WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    const body: ResumesResponse = { items: res.rows.map(toResume) };
    return body;
  });

  // ── 보기/다운로드: PDF 바이트 스트리밍(자기 소유만) ───────────────────────
  app.get<{ Params: { id: string } }>("/api/resumes/:id/file", async (req, reply) => {
    const userId = currentUserId(req);
    if (!userId) return reply.code(401).send({ error: "로그인이 필요합니다." });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "잘못된 id 입니다." });

    const res = await pool.query(
      `SELECT file, mime_type, filename FROM resumes WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (res.rowCount === 0) return reply.code(404).send({ error: "이력서를 찾을 수 없습니다." });

    const { file, mime_type, filename } = res.rows[0];
    // inline 으로 브라우저에서 바로 미리보기. 파일명은 RFC5987 로 인코딩.
    const encoded = encodeURIComponent(filename || "resume.pdf");
    return reply
      .header("Content-Type", mime_type || "application/pdf")
      .header("Content-Disposition", `inline; filename*=UTF-8''${encoded}`)
      .header("Content-Length", (file as Buffer).length)
      .header("Cache-Control", "private, max-age=3600")
      .send(file);
  });

  // ── 단건 조회: 분석 상태 폴링용(메타 + analysis + feedback) ────────────────
  app.get<{ Params: { id: string } }>("/api/resumes/:id", async (req, reply) => {
    const userId = currentUserId(req);
    if (!userId) return reply.code(401).send({ error: "로그인이 필요합니다." });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "잘못된 id 입니다." });
    const res = await pool.query(
      `SELECT ${META_COLS} FROM resumes WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (res.rowCount === 0) return reply.code(404).send({ error: "이력서를 찾을 수 없습니다." });
    return toResume(res.rows[0]);
  });

  // ── 재분석: 분석 다시 실행(원문이 있을 때만) ───────────────────────────────
  app.post<{ Params: { id: string } }>("/api/resumes/:id/analyze", async (req, reply) => {
    const userId = currentUserId(req);
    if (!userId) return reply.code(401).send({ error: "로그인이 필요합니다." });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "잘못된 id 입니다." });
    const own = await pool.query(
      `SELECT char_length(extracted_text) AS chars FROM resumes WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (own.rowCount === 0) return reply.code(404).send({ error: "이력서를 찾을 수 없습니다." });
    if (!Number(own.rows[0].chars)) {
      return reply.code(422).send({ error: "분석할 원문 텍스트가 없습니다(스캔본 PDF 일 수 있음)." });
    }
    await pool.query(`UPDATE resumes SET analysis_status = 'pending' WHERE id = $1`, [id]);
    analyzeResume(id).catch((e) => req.log.error(e, "이력서 재분석 실패"));
    return { ok: true as const };
  });

  // ── 원문 텍스트: PDF 에서 추출한 텍스트(자기 소유만) ───────────────────────
  app.get<{ Params: { id: string } }>("/api/resumes/:id/text", async (req, reply) => {
    const userId = currentUserId(req);
    if (!userId) return reply.code(401).send({ error: "로그인이 필요합니다." });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "잘못된 id 입니다." });

    const res = await pool.query(
      `SELECT extracted_text FROM resumes WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (res.rowCount === 0) return reply.code(404).send({ error: "이력서를 찾을 수 없습니다." });
    const text = (res.rows[0].extracted_text as string | null) ?? "";
    return { id, text, chars: text.length };
  });

  // ── 삭제 ──────────────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/api/resumes/:id", async (req, reply) => {
    const userId = currentUserId(req);
    if (!userId) return reply.code(401).send({ error: "로그인이 필요합니다." });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "잘못된 id 입니다." });

    const res = await pool.query(
      `DELETE FROM resumes WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (res.rowCount === 0) return reply.code(404).send({ error: "이력서를 찾을 수 없습니다." });
    return { ok: true as const };
  });
}
