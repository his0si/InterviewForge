// AI 모의면접(LangGraph 상호작용형) 라우트.
//
//  - 기존의 one-shot "예상 질문 생성"을 대체한다. 이력서 원문(resumes.extracted_text) +
//    사용자 직무(users.jobs) + (선택) 겨냥한 공고를 근거로 첫 질문을 만들고,
//    사용자의 답변(면접 연습 화면의 실시간 자막)을 평가해 논리를 파고드는 꼬리질문 또는
//    다음 질문을 이어가며, 끝나면 최종 리포트를 낸다.
//  - 실제 상태/순서 관리는 server/src/aiInterview 의 LangGraph 엔진이 맡는다.
//  - 모든 추론은 로컬 Ollama(EXAONE 3.5)에서 처리한다(외부 API 키 불필요).
import type { FastifyInstance } from "fastify";
import type {
  AiAnswerRequest,
  AiAnswerResponse,
  AiInterviewBasedOn,
  ResumeProfile,
  StartAiInterviewRequest,
  StartAiInterviewResponse,
} from "@e-lifethon/shared";
import { pool } from "./db.js";
import { currentUserId } from "./auth.js";
import { stripContactInfo } from "./textUtil.js";
import { OllamaError } from "./ollama.js";
import { startInterview, submitAnswer, getInterviewState } from "./aiInterview/interviewGraph.js";
import { buildCompanyContext, enqueueCompanyIngest } from "./aiInterview/companyContextAdapter.js";

// interviewId 의 소유자(user_id)를 interview_sessions 에서 확인한다.
// 진행 중 세션의 그래프 상태는 PostgresSaver(checkpoints)에, 소유권/상태는 이 테이블에 있다.
// 둘 다 DB 라서 서버 재시작·다중 인스턴스에도 면접을 이어갈 수 있다.
async function sessionOwnerId(interviewId: string): Promise<string | null> {
  const r = await pool.query(`SELECT user_id FROM interview_sessions WHERE id = $1`, [interviewId]);
  return r.rows[0] ? String(r.rows[0].user_id) : null;
}

/** 직무 + 공고를 LangGraph 엔진의 grounding 근거(context)로 쓸 자연어로 직렬화한다. */
function buildContext(opts: {
  roles: string[];
  profile: ResumeProfile | null;
  job: { title: string; company: string | null; summary: string | null } | null;
}): string {
  const { roles, profile, job } = opts;
  const lines: string[] = [];
  if (roles.length) lines.push(`지원 직무: ${roles.join(", ")}`);
  if (profile) {
    if (profile.skills?.length) lines.push(`이력서 분석 보유 기술: ${profile.skills.join(", ")}`);
    if (profile.years != null) lines.push(`이력서 분석 경력: ${profile.years}년`);
  }
  if (job) {
    lines.push(`겨냥한 공고: ${job.title}${job.company ? " / " + job.company : ""}`);
    if (job.summary) lines.push(`공고 요약/요건: ${job.summary.slice(0, 1200)}`);
  }
  return lines.join("\n");
}

export async function interviewRoutes(app: FastifyInstance): Promise<void> {
  // ── 모의면접 시작: 이력서/직무/공고로 첫 질문 생성 ──────────────────────────
  app.post<{ Body: StartAiInterviewRequest }>("/api/interview/session", async (req, reply) => {
    const userId = currentUserId(req);
    if (!userId) return reply.code(401).send({ error: "로그인이 필요합니다." });

    const body = req.body ?? {};

    // 1) 사용자 직무. body.role 로 등록된 직무 중 하나를 고르면 그 직무만,
    //    아니면 등록된 직무 전체를 면접 근거로 쓴다.
    const u = await pool.query(`SELECT jobs FROM users WHERE id = $1`, [userId]);
    const allRoles: string[] = (u.rows[0]?.jobs as string[] | undefined) ?? [];
    const roles: string[] =
      body.role && allRoles.includes(body.role) ? [body.role] : allRoles;

    // 2) 이력서 원문(extracted_text) + 구조화 프로필(있으면). 지정 id 또는 가장 최근본.
    const resumeQ = body.resumeId
      ? await pool.query(
          `SELECT extracted_text, analysis FROM resumes WHERE id = $1 AND user_id = $2`,
          [body.resumeId, userId]
        )
      : await pool.query(
          `SELECT extracted_text, analysis FROM resumes
             WHERE user_id = $1 AND extracted_text IS NOT NULL AND char_length(extracted_text) > 0
           ORDER BY created_at DESC LIMIT 1`,
          [userId]
        );
    // 연락처/개인정보(이메일·전화 등)를 제거해 질문 근거로 쓰이지 않게 한다.
    const resumeText = stripContactInfo(String(resumeQ.rows[0]?.extracted_text ?? "").trim());
    const profile = (resumeQ.rows[0]?.analysis as ResumeProfile | null) ?? null;

    if (!resumeText) {
      return reply
        .code(422)
        .send({ error: "이력서 원문이 필요합니다. 이력서 피드백 메뉴에서 이력서 PDF 를 먼저 업로드해 주세요." });
    }

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

    let context = buildContext({ roles, profile, job });
    const basedOn: AiInterviewBasedOn = {
      roles,
      resumeUsed: true,
      jobTitle: job?.title ?? null,
    };

    // 4) 회사 페르소나(선택). 겨냥한 공고의 회사명으로 company_contexts 를 읽어
    //    첫 질문 앵커 + 회사 참고 context 를 만든다. 데이터 없으면 resume-only 로 안전 fallback.
    let companyAnchor;
    try {
      const persona = await buildCompanyContext(
        job?.company ?? "",
        body.role ?? roles[0] ?? "",
        resumeText
      );
      companyAnchor = persona.companyAnchor;
      // 프론트 배지용: 겨냥 회사명 + 페르소나 실제 적용 여부.
      basedOn.companyName = persona.displayName ?? job?.company ?? null;
      basedOn.personaApplied = !!persona.companyAnchor;
      if (persona.context) {
        // 회사 참고자료를 기존 직무/공고 context 뒤에 덧붙인다(둘 다 grounding 근거).
        context = context ? `${context}\n\n${persona.context}` : persona.context;
      }
      // 회사는 맞는데 수집 데이터가 없으면 JIT 수집 큐에 적재(디바운스). 이번 면접은 이력서 기반으로 진행되고,
      // 다음 번 면접부터 페르소나가 적용된다. 적재는 면접 응답을 막지 않는다.
      if (persona.dataMissing && persona.companyKey) {
        void enqueueCompanyIngest(persona.companyKey, job?.company ?? "");
      }
    } catch {
      // 페르소나 생성 실패는 면접을 막지 않는다(기존 흐름 유지).
      companyAnchor = undefined;
    }

    try {
      const started = await startInterview({ resumeText, context, companyAnchor, maxQuestions: body.maxQuestions });
      // 소유권/상태를 DB 에 기록(그래프 상태는 PostgresSaver 가 별도로 보존).
      await pool.query(
        `INSERT INTO interview_sessions (id, user_id, status, based_on)
         VALUES ($1, $2, 'in_progress', $3)`,
        [started.interviewId, userId, JSON.stringify(basedOn)]
      );
      const res: StartAiInterviewResponse = {
        interviewId: started.interviewId,
        status: started.status,
        question: started.question,
        basedOn,
      };
      return res;
    } catch (err) {
      req.log.error(err, "AI 모의면접 시작 실패");
      const msg =
        err instanceof OllamaError
          ? "로컬 AI 응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요."
          : "모의면접을 시작하지 못했습니다.";
      return reply.code(503).send({ error: msg });
    }
  });

  // ── 답변 제출: 평가 → 꼬리질문/다음질문/리포트 ────────────────────────────
  app.post<{ Params: { id: string }; Body: AiAnswerRequest }>(
    "/api/interview/session/:id/answer",
    async (req, reply) => {
      const userId = currentUserId(req);
      if (!userId) return reply.code(401).send({ error: "로그인이 필요합니다." });

      const interviewId = req.params.id;
      if ((await sessionOwnerId(interviewId)) !== String(userId)) {
        return reply.code(404).send({ error: "면접 세션을 찾을 수 없습니다." });
      }

      const answer = String(req.body?.answer ?? "").trim();
      if (!answer) return reply.code(400).send({ error: "답변(자막)이 비어 있습니다. 말한 내용이 인식되었는지 확인해 주세요." });

      try {
        const result = await submitAnswer({ interviewId, answer });
        // 세션 상태 갱신(완료면 completed 로 표시 — 그래프 상태는 PostgresSaver 가 보존).
        await pool.query(
          `UPDATE interview_sessions SET status = $2, updated_at = now() WHERE id = $1`,
          [interviewId, result.status]
        );
        const res: AiAnswerResponse = {
          interviewId: result.interviewId,
          status: result.status,
          evaluation: result.evaluation,
          nextQuestion: result.nextQuestion,
          finalReport: result.finalReport,
        };
        return res;
      } catch (err) {
        req.log.error(err, "AI 모의면접 답변 처리 실패");
        const msg =
          err instanceof OllamaError
            ? "로컬 AI 응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요."
            : "답변 처리에 실패했습니다.";
        return reply.code(503).send({ error: msg });
      }
    }
  );

  // ── 상태 조회(디버깅/복구용): 현재 질문·진행 정보 ─────────────────────────
  app.get<{ Params: { id: string } }>("/api/interview/session/:id", async (req, reply) => {
    const userId = currentUserId(req);
    if (!userId) return reply.code(401).send({ error: "로그인이 필요합니다." });

    const interviewId = req.params.id;
    if ((await sessionOwnerId(interviewId)) !== String(userId)) {
      return reply.code(404).send({ error: "면접 세션을 찾을 수 없습니다." });
    }
    const state = await getInterviewState(interviewId);
    if (!state) return reply.code(404).send({ error: "면접 세션을 찾을 수 없습니다." });
    return {
      interviewId,
      status: state.status,
      currentQuestion: state.currentQuestion,
      questionCount: state.questionCount,
      maxQuestions: state.maxQuestions,
    };
  });
}
