import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import type { HealthResponse } from "@e-lifethon/shared";
import { initDb } from "./db.js";
import { authRoutes } from "./auth.js";
import { jobRoutes } from "./jobs.js";
import { adminRoutes } from "./admin.js";
import { recordingRoutes } from "./recordings.js";
import { resumeRoutes } from "./resumes.js";
import { interviewRoutes } from "./interview.js";
import { setupInterviewCheckpointer } from "./aiInterview/interviewGraph.js";
import { startJobEmbeddingWorker } from "./jobEmbeddings.js";
import { analyzePendingResumes } from "./resumeAnalysis.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true, credentials: true });
await app.register(cookie);
// 면접 녹화 영상 업로드(multipart). 한 파일당 200MB 까지 허용.
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 1 } });

app.get("/health", async (): Promise<HealthResponse> => ({ ok: true }));

// DB 스키마 보장 + 인증 라우트 등록
await initDb();
// AI 모의면접 LangGraph 체크포인트 테이블 생성/마이그레이션(서버 재시작 후에도 면접 재개).
await setupInterviewCheckpointer();
await app.register(authRoutes);
await app.register(jobRoutes);
await app.register(adminRoutes);
await app.register(recordingRoutes);
await app.register(resumeRoutes);
await app.register(interviewRoutes);

// 채용 공고 임베딩 백필 워커 시작(추천 의미검색 색인). 백그라운드로 동작.
startJobEmbeddingWorker();
// 분석 안 된 이력서 보정(배포 전 업로드되어 'pending' 으로 남은 건). 백그라운드.
void analyzePendingResumes();

// 프로덕션: 빌드된 client(client/dist)를 같은 서버에서 정적 서빙 + SPA fallback.
// 개발 중에는 client/dist 가 없으므로 건너뛰고, Vite 개발 서버(:5173)가 화면을 담당한다.
const clientDist = join(dirname(fileURLToPath(import.meta.url)), "../../client/dist");
if (existsSync(clientDist)) {
  await app.register(fastifyStatic, { root: clientDist });
  app.setNotFoundHandler((req, reply) => {
    // /health, /api 등 API 경로는 그대로 404(JSON), 나머지는 SPA 라우팅을 위해 index.html 반환
    const url = req.raw.url ?? "";
    if (url.startsWith("/health") || url.startsWith("/api")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });
}

const port = Number(process.env.PORT ?? 8787);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`E-LIFETHON server on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
