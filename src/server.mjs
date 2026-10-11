import { readConfig } from "./config.mjs";
import { createTool } from "./tool.mjs";

let tool;
try {
  const config = readConfig();
  tool = createTool(config);
  await tool.start();
  console.log(`${config.appLabel}: ${config.publicUrl}`);
  console.log(
    `Moodle: ${config.configured ? "регистрация настроена" : "не настроен; заполните MOODLE_* после регистрации External tool"}`,
  );
} catch (error) {
  console.error(`Не удалось запустить: ${error.message}`);
  process.exitCode = 1;
}

let stopping = false;
async function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    await tool?.close();
  } catch {
    process.exitCode = 1;
  }
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
