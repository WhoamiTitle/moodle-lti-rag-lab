import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readConfig } from "../src/config.mjs";
import { MemoryLtiDatabase } from "../test-support/memory-lti-database.mjs";

test("Приватный скрытый каталог не блокирует явно разрешённые HTML/CSS/JS и не публикует src", async (t) => {
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const temporary = await mkdtemp(path.join(os.tmpdir(), "rag-private-assets-"));
  const application = path.join(temporary, ".private/app");
  await mkdir(application, { recursive: true });
  await cp(path.join(repository, "src"), path.join(application, "src"), { recursive: true });
  await cp(path.join(repository, "public"), path.join(application, "public"), { recursive: true });
  await symlink(path.join(repository, "node_modules"), path.join(application, "node_modules"));
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const url = `http://127.0.0.1:${port}/~s507353/moodle-lti-rag`;
  const config = readConfig({ PORT: String(port), PUBLIC_URL: url, DATA_DIR: path.join(temporary, "attempts") });
  const { createTool } = await import(pathToFileURL(path.join(application, "src/tool.mjs")).href);
  const tool = createTool(config, { databaseManager: new MemoryLtiDatabase(), logger: { error() {}, warn() {} } });
  t.after(async () => {
    await tool.close();
    await rm(temporary, { recursive: true, force: true });
  });
  await tool.start();
  const welcome = await fetch(`${url}/`);
  assert.equal(welcome.status, 200);
  assert.match(await welcome.text(), /Тренажёр запускается из Moodle/);
  for (const asset of ["app.css", "app.js", "api.js"]) {
    const response = await fetch(`${url}/assets/${asset}`);
    assert.equal(response.status, 200, asset);
    assert.ok((await response.text()).length > 100);
  }
  const unauthenticated = await fetch(`${url}/app`);
  assert.equal(unauthenticated.status, 401);
  assert.match(await unauthenticated.text(), /Тренажёр запускается из Moodle/);
  assert.equal((await fetch(`${url}/src/config.mjs`)).status, 404);
  assert.equal((await fetch(`${url}/assets/.env`)).status, 404);
});
