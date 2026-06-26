// 채용 공고 조회 라우트. 크롤러가 채운 job_postings 테이블을 읽어 화면에 제공한다.
import type { FastifyInstance } from "fastify";
import type {
  JobsResponse,
  RecommendedJobsResponse,
  ResumeProfile,
} from "@e-lifethon/shared";
import { pool } from "./db.js";
import { currentUserId } from "./auth.js";
import { embed } from "./ollama.js";
import { toVectorLiteral } from "./jobEmbeddings.js";

const COLS = `id, source, source_url, title, company, location, employment_type,
  experience_level, education, salary, job_categories, skills,
  posted_at, deadline, deadline_text, qualifications, preferred,
  hiring_process, documents, benefits, description, detail_fetched, ai_summary`;

// 추천 공통 필터: 노출 가능한 활성 공고 + 마감 안 지난 것
const REC_GATE = `is_active = TRUE AND ai_summary IS NOT NULL AND company IS NOT NULL
  AND (deadline IS NULL OR deadline >= current_date)`;

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

  // ── 맞춤 추천: 사용자 직무 + 이력서 프로필 기반 의미검색(임베딩) ───────────
  // 폴백: 임베딩이 아직 없거나 Ollama 불가 시 직무 키워드 매칭.
  app.get<{ Querystring: { limit?: string } }>("/api/jobs/recommended", async (req, reply) => {
    const userId = currentUserId(req);
    if (!userId) return reply.code(401).send({ error: "로그인이 필요합니다." });
    const limit = Math.min(Number(req.query.limit ?? 8) || 8, 30);

    try {
      // 1) 직무 + 최근 분석된 이력서 프로필 수집
      const u = await pool.query(`SELECT jobs FROM users WHERE id = $1`, [userId]);
      const roles: string[] = (u.rows[0]?.jobs as string[] | undefined) ?? [];
      const rp = await pool.query(
        `SELECT analysis FROM resumes
           WHERE user_id = $1 AND analysis_status = 'done' AND analysis IS NOT NULL
         ORDER BY analyzed_at DESC NULLS LAST LIMIT 1`,
        [userId]
      );
      const profile: ResumeProfile | null = rp.rows[0]?.analysis ?? null;

      if (roles.length === 0 && !profile) {
        return reply.send({
          items: [],
          basedOn: { roles, resumeUsed: false, method: "keyword" },
        } as RecommendedJobsResponse);
      }

      // 2) 의미검색용 쿼리 텍스트(직무 + 이력서 핵심)
      const queryText = [
        roles.join(", "),
        profile?.roles?.join(", "),
        profile?.skills?.join(", "),
        profile?.summary,
      ]
        .filter(Boolean)
        .join("\n");

      // 3) 임베딩 의미검색 시도
      try {
        const vec = await embed(queryText);
        const lit = toVectorLiteral(vec);
        const r = await pool.query(
          `SELECT ${COLS}, 1 - (embedding <=> $1::vector) AS score
             FROM job_postings
            WHERE ${REC_GATE} AND embedding IS NOT NULL
            ORDER BY embedding <=> $1::vector
            LIMIT $2`,
          [lit, limit]
        );
        if (r.rowCount && r.rowCount > 0) {
          return reply.send({
            items: r.rows,
            basedOn: { roles, resumeUsed: !!profile, method: "semantic" },
          } as RecommendedJobsResponse);
        }
        // 임베딩이 아직 하나도 없으면 키워드 폴백으로 진행
      } catch (e) {
        req.log.warn(e, "추천 임베딩 실패 — 키워드 폴백");
      }

      // 4) 폴백: 직무 키워드 매칭(제목 또는 직무 카테고리)
      const terms = (roles.length ? roles : profile?.roles ?? []).filter(Boolean);
      if (terms.length === 0) {
        return reply.send({
          items: [],
          basedOn: { roles, resumeUsed: !!profile, method: "keyword" },
        } as RecommendedJobsResponse);
      }
      const likeParams = terms.map((t) => `%${t}%`);
      const ors = terms
        .map((_, i) => `title ILIKE $${i + 1} OR array_to_string(job_categories, ' ') ILIKE $${i + 1}`)
        .join(" OR ");
      const r2 = await pool.query(
        `SELECT ${COLS}, 0 AS score
           FROM job_postings
          WHERE ${REC_GATE} AND (${ors})
          ORDER BY COALESCE(posted_at, first_seen_at::date) DESC, id DESC
          LIMIT ${limit}`,
        likeParams
      );
      return reply.send({
        items: r2.rows,
        basedOn: { roles, resumeUsed: !!profile, method: "keyword" },
      } as RecommendedJobsResponse);
    } catch (err) {
      if ((err as { code?: string }).code === "42P01") {
        return reply.send({
          items: [],
          basedOn: { roles: [], resumeUsed: false, method: "keyword" },
        } as RecommendedJobsResponse);
      }
      throw err;
    }
  });

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
