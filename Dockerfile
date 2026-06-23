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
