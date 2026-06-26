// 면접 예상 질문 생성. 로컬 LLM(exaone3.5)으로 사용자 직무 + (있으면) 이력서 프로필 +
// (있으면) 겨냥한 채용 공고를 근거로 카테고리별 질문을 만든다.
import type { FastifyInstance } from "fastify";
import type {
  InterviewQuestion,
  InterviewQuestionsRequest,
  InterviewQuestionsResponse,
  ResumeProfile,
} from "@e-lifethon/shared";
import { pool } from "./db.js";
import { currentUserId } from "./auth.js";
import { generateJson } from "./ollama.js";

const CATEGORIES = ["지원동기", "직무역량", "기술", "경험기반", "인성"];

function buildPrompt(opts: {
  roles: string[];
  profile: ResumeProfile | null;
  job: { title: string; company: string | null; summary: string | null } | null;
  count: number;
}): string {
  const { roles, profile, job, count } = opts;
  const parts: string[] = [];
  parts.push(`너는 한국 기업 면접관이다. 아래 지원자 정보를 근거로 실제 면접에서 나올 법한 한국어 면접 질문 ${count}개를 만들어라.`);
  parts.push(
    `규칙:
- 카테고리는 ${CATEGORIES.join(", ")} 중에서 고른다. 가능하면 여러 카테고리를 고루 섞는다.
- 이력서 정보가 있으면 그 경험/기술을 파고드는 "경험기반" 꼬리질문을 반드시 포함한다.
- 추측으로 없는 사실을 만들지 말 것. 질문은 구체적이고 자연스럽게.
- intent 에는 이 질문으로 무엇을 평가하는지 한 줄로 적는다.`
  );
  parts.push(`지원 직무: ${roles.length ? roles.join(", ") : "(미지정)"}`);
  if (profile) {
    parts.push(
      `이력서 요약: ${profile.summary || "(없음)"}
보유 기술: ${profile.skills.join(", ") || "(없음)"}
경력: ${profile.years != null ? profile.years + "년" : "(미상)"}
강점: ${profile.strengths.join(", ") || "(없음)"}`
    );
  }
  if (job) {
    parts.push(
      `겨냥한 공고: ${job.title}${job.company ? " / " + job.company : ""}
공고 요약: ${(job.summary || "").slice(0, 1200)}`
    );
  }
  parts.push(
    `JSON 으로만 답하라. 형식: {"questions":[{"category":"...","question":"...","intent":"..."}]}`
  );
  return parts.join("\n\n");
}

function normalizeQuestions(raw: any, count: number): InterviewQuestion[] {
  const arr = Array.isArray(raw?.questions) ? raw.questions : Array.isArray(raw) ? raw : [];
  return arr
    .map((q: any) => ({
      category: String(q?.category ?? "").trim() || "기타",
      question: String(q?.question ?? "").trim(),
      intent: String(q?.intent ?? "").trim(),
    }))
    .filter((q: InterviewQuestion) => q.question.length > 0)
    .slice(0, count);
}

export async function interviewRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: InterviewQuestionsRequest }>("/api/interview/questions", async (req, reply) => {
    const userId = currentUserId(req);
    if (!userId) return reply.code(401).send({ error: "로그인이 필요합니다." });

    const body = req.body ?? {};
    const count = Math.min(15, Math.max(3, Number(body.count) || 8));

    // 1) 사용자 직무
    const u = await pool.query(`SELECT jobs FROM users WHERE id = $1`, [userId]);
    const roles: string[] = (u.rows[0]?.jobs as string[] | undefined) ?? [];

    // 2) 이력서 프로필 (지정 id 또는 가장 최근 분석 완료본)
    let profile: ResumeProfile | null = null;
    const resumeQ = body.resumeId
      ? await pool.query(
          `SELECT analysis FROM resumes WHERE id = $1 AND user_id = $2 AND analysis_status = 'done'`,
          [body.resumeId, userId]
        )
      : await pool.query(
          `SELECT analysis FROM resumes
             WHERE user_id = $1 AND analysis_status = 'done' AND analysis IS NOT NULL
           ORDER BY analyzed_at DESC NULLS LAST LIMIT 1`,
          [userId]
        );
    if (resumeQ.rows[0]?.analysis) profile = resumeQ.rows[0].analysis as ResumeProfile;

    // 3) 겨냥한 공고(선택)
    let job: { title: string; company: string | null; summary: string | null } | null = null;
    if (body.jobId) {
      const j = await pool.query(
        `SELECT title, company, COALESCE(ai_summary, qualifications, description) AS summary
           FROM job_postings WHERE id = $1`,
        [body.jobId]
      );
      if (j.rows[0]) job = j.rows[0];
    }

    if (roles.length === 0 && !profile && !job) {
      return reply
        .code(422)
        .send({ error: "질문을 만들 정보가 부족합니다. 직무를 설정하거나 이력서를 분석해 주세요." });
    }

    try {
      const raw = await generateJson<any>(buildPrompt({ roles, profile, job, count }), {
        temperature: 0.5, // 질문은 약간의 다양성 허용
      });
      const questions = normalizeQuestions(raw, count);
      if (questions.length === 0) {
        return reply.code(502).send({ error: "질문 생성에 실패했습니다. 잠시 후 다시 시도해 주세요." });
      }
      const res: InterviewQuestionsResponse = {
        questions,
        basedOn: { roles, resumeUsed: !!profile, jobTitle: job?.title ?? null },
      };
      return res;
    } catch (err) {
      req.log.error(err, "면접 질문 생성 실패");
      return reply.code(503).send({ error: "로컬 AI 응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요." });
    }
  });
}
