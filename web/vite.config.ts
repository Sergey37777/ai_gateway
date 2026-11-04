/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const GATEWAY = "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    // в разработке API шлюза — через прокси, чтобы origin был один, как в проде
    proxy: { "/v1": GATEWAY, "/health": GATEWAY, "/ui": GATEWAY },
  },
  // ~1 МБ (openai SDK + highlight.js) — UI в LAN, assets кэшируются как immutable
  build: { chunkSizeWarningLimit: 1200 },
  // воркер и ядро ffmpeg.wasm Vite не должен пре-бандлить
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
