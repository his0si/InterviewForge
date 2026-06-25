import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 개발 서버(:5210)에서 API 경로를 백엔드(:8787)로 프록시한다.
// 덕분에 client 코드는 개발/프로덕션 모두 같은 출처의 상대경로(/health, /api/...)만 쓰면 되고,
// 별도의 client용 환경변수 파일이 필요 없다.
// 공유 머신이라 포트 자동 증가로 남의 영역에 끼지 않도록 strictPort 로 고정한다.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5210,
    strictPort: true,
    proxy: {
      "/health": "http://localhost:8787",
      "/api": "http://localhost:8787",
    },
  },
});
