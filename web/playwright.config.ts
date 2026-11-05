import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const PORT = 8765;
// относительно корня репозитория (cwd шлюза)
const E2E_DATA = "web/test-results/e2e-data";
// речь для фейкового микрофона Chromium
const HELLO_WAV = fileURLToPath(new URL("../tests/fixtures/hello.wav", import.meta.url));

/** e2e на реальном шлюзе: whisper `tiny`/`base` на CPU, лимит загрузки 1 МиБ (видео → извлечение). */
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["microphone"],
        launchOptions: {
          args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            `--use-file-for-fake-audio-capture=${HELLO_WAV}`,
          ],
        },
      },
    },
  ],
  // БД aigw_e2e на dev-PostgreSQL (docker compose -f compose.dev.yaml up -d) пересоздаётся при
  // каждом запуске; каталог данных — тоже с нуля
  webServer: {
    command: [
      `docker compose -f compose.dev.yaml exec -T postgres psql -U aigw -d postgres -q`,
      `-c "DROP DATABASE IF EXISTS aigw_e2e WITH (FORCE)" -c "CREATE DATABASE aigw_e2e"`,
      `&& rm -rf ${E2E_DATA}`,
      `&& uv run uvicorn ai_gateway.main:app --port ${String(PORT)}`,
    ].join(" "),
    cwd: "..",
    url: `http://localhost:${String(PORT)}/health`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      AIGW_DEVICE: "cpu",
      AIGW_MODELS_FILE: "models.dev.yaml",
      AIGW_MAX_UPLOAD_MB: "1",
      AIGW_WEB_DIR: "web/dist",
      AIGW_API_KEY: "",
      AIGW_DATABASE_URL: "postgresql+psycopg://aigw:aigw@localhost:55432/aigw_e2e",
      AIGW_DATA_DIR: E2E_DATA,
    },
  },
});
