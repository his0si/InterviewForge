// 채용 공고 조회 라우트. 크롤러가 채운 job_postings 테이블을 읽어 화면에 제공한다.
import type { FastifyInstance } from "fastify";
import type { JobsResponse } from "@e-lifethon/shared";
import { pool } from "./db.js";

const COLS = `id, source, source_url, title, company, location, employment_type,
  experience_level, education, salary, job_categories, skills,
  posted_at, deadline, deadline_text, qualifications, preferred,
  hiring_process, documents, benefits, description, detail_fetched, ai_summary`;

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { source?: string; q?: string; limit?: string; offset?: string } }>(
    "/api/jobs",
    async (req, reply) => {
      const limit = Math.min(Number(req.query.limit ?? 30) || 30, 100);
      const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
      const source = req.query.source?.trim();
      const q = req.query.q?.trim();

      // 노출 게이트: AI 요약 + 카드 한 줄(회사)이 모두 완료된 공고만 보여준다.
      // (파이프라인이 끝나야 프론트에 뜸 — 처리중/미완성 공고는 숨김)
      const where: string[] = [
        "is_active = TRUE",
        "ai_summary IS NOT NULL",
        "company IS NOT NULL",
      ];
      const params: unknown[] = [];
      if (source) {
        params.push(source);
        where.push(`source = $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        where.push(`(title ILIKE $${params.length} OR company ILIKE $${params.length})`);
      }
      const whereSql = where.join(" AND ");

      try {
        const totalRes = await pool.query(
          `SELECT count(*)::int AS n FROM job_postings WHERE ${whereSql}`,
          params
        );
        const itemsRes = await pool.query(
          `SELECT ${COLS} FROM job_postings WHERE ${whereSql}
           ORDER BY COALESCE(posted_at, first_seen_at::date) DESC, id DESC
           LIMIT ${limit} OFFSET ${offset}`,
          params
        );
        const sourcesRes = await pool.query(
          `SELECT DISTINCT source FROM job_postings
           WHERE is_active = TRUE AND ai_summary IS NOT NULL AND company IS NOT NULL
           ORDER BY source`
        );
        return reply.send({
          items: itemsRes.rows,
          total: totalRes.rows[0].n,
          sources: sourcesRes.rows.map((r) => r.source),
        } as JobsResponse);
      } catch (err) {
        // 크롤러가 아직 한 번도 안 돌아 테이블이 없을 수 있다 → 빈 목록으로 응답
        if ((err as { code?: string }).code === "42P01") {
          return reply.send({ items: [], total: 0, sources: [] } as JobsResponse);
        }
        throw err;
      }
    }
  );

  // 단일 공고 상세
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req, reply) => {
    try {
      const r = await pool.query(
        `SELECT ${COLS} FROM job_postings WHERE id = $1`,
        [Number(req.params.id)]
      );
      if (!r.rowCount) return reply.code(404).send({ error: "not found" });
      return reply.send(r.rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === "42P01") {
        return reply.code(404).send({ error: "not found" });
      }
      throw err;
    }
  });
}
