import path from "node:path";
import { readConfig } from "../src/config.mjs";
import { createTool } from "../src/tool.mjs";
import { MemoryLtiDatabase } from "../test-support/memory-lti-database.mjs";
import { CLIENT_ID, DEPLOYMENT_ID, startMockPlatform } from "../test-support/mock-platform.mjs";

// Deliberately ignore .env / real Moodle credentials in this isolated demo.
let platform;
let tool;
try {
  const toolPort = Number(process.env.DEMO_TOOL_PORT || 3000);
  platform = await startMockPlatform({ port: Number(process.env.DEMO_PLATFORM_PORT || 3001) });
  const config = readConfig({
    PORT: String(toolPort),
    PUBLIC_URL: `http://127.0.0.1:${toolPort}`,
    LISTEN_HOST: "127.0.0.1",
    DATA_DIR: path.resolve("data/demo"),
    APP_LABEL: "Локальный стенд · RAG LAB",
    MOODLE_ISSUER: platform.origin,
    MOODLE_CLIENT_ID: CLIENT_ID,
    MOODLE_DEPLOYMENT_ID: DEPLOYMENT_ID,
    MOODLE_AUTH_URL: `${platform.origin}/auth`,
    MOODLE_TOKEN_URL: `${platform.origin}/token`,
    MOODLE_JWKS_URL: `${platform.origin}/jwks`,
  });
  config.demo = true;
  platform.setToolUrl(config.publicUrl);
  tool = createTool(config, { databaseManager: new MemoryLtiDatabase() });
  await tool.start();
  console.log(`Локальная имитация Moodle: ${platform.origin}`);
  console.log("Откройте этот адрес и выберите Студента A, Студента B или Преподавателя.");
  console.log("Это НЕ реальная запись оценок в Moodle/Gnomio. Остановка: Ctrl+C.");
} catch (error) {
  await Promise.allSettled([tool?.close(), platform?.close()]);
  console.error(`Демо не запущено: ${error.message}`);
  process.exitCode = 1;
}
let stopping = false;
async function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  await Promise.allSettled([tool?.close(), platform?.close()]);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
