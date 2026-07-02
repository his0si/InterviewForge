# 멀티스테이지: 빌드 단계에서 client(정적) + server 를 빌드하고,
# 런타임 단계에선 Fastify 하나가 API와 정적파일을 함께 서빙한다.
FROM node:22-slim AS build
WORKDIR /app

# 워크스페이스 매니페스트만 먼저 복사 → 의존성 캐시 최대화
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci

# 소스 복사 후 전체 빌드 (shared → server → client)
COPY . .

# 클라이언트(Vite) 빌드에 주입할 값. .env 는 .dockerignore 로 빌드 컨텍스트에서 제외되므로
# compose 의 build.args 로 전달받아 빌드 스테이지 환경변수로 노출한다.
# Vite 는 process.env 의 VITE_ 접두사 변수를 번들에 포함하며, 이 ENV 는 build 스테이지에만 남고
# 런타임 이미지로는 넘어가지 않는다(정적 번들 안에만 값이 박힘).
ARG VITE_AMPLITUDE_API_KEY
ENV VITE_AMPLITUDE_API_KEY=$VITE_AMPLITUDE_API_KEY

RUN npm run build

# 런타임에 필요 없는 devDependencies 제거
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/shared ./shared
COPY --from=build /app/client/dist ./client/dist

EXPOSE 8787
CMD ["node", "server/dist/index.js"]
