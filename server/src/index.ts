import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type { HealthResponse } from "@e-lifethon/shared";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

app.get("/health", async (): Promise<HealthResponse> => ({ ok: true }));

// 프로덕션: 빌드된 client(client/dist)를 같은 서버에서 정적 서빙 + SPA fallback.
// 개발 중에는 client/dist 가 없으므로 건너뛰고, Vite 개발 서버(:5173)가 화면을 담당한다.
const clientDist = join(dirname(fileURLToPath(import.meta.url)), "../../client/dist");
if (existsSync(clientDist)) {
  await app.register(fastifyStatic, { root: clientDist });
  app.setNotFoundHandler((req, reply) => {
    // /health 등 API 경로는 그대로 404, 나머지는 SPA 라우팅을 위해 index.html 반환
    if (req.raw.url?.startsWith("/health")) {
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
