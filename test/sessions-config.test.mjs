import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.mjs";
import { Sessions } from "../src/sessions.mjs";

test("Без регистрации сервер не включает фиктивную платформу; частичная конфигурация отклоняется", () => {
  const config = readConfig({});
  assert.equal(config.configured, false);
  assert.equal(config.moodle, null);
  assert.equal(config.publicUrl, "http://127.0.0.1:3000");
  assert.throws(() => readConfig({ MOODLE_CLIENT_ID: "client" }), /Заполните все реквизиты/);
});

test("Публичный URL требует HTTPS; безопасный вложенный путь поддерживается, HTTP только на loopback", () => {
  assert.equal(readConfig({ PUBLIC_URL: "https://tool.example/" }).publicUrl, "https://tool.example");
  for (const url of [
    "http://tool.example",
    "https://tool.example/path?x=1",
    "https://tool.example/a/../b",
    "https://tool.example/a/%2e%2e/b",
    "https://tool.example/a//b",
    "https://tool.example/a\\b",
    "HTTPS://tool.example/a/../b",
    "HTTPS://tool.example/a/%2f/b",
    "https://tool.example\\a",
    "https://user:pass@tool.example",
    "https://tool.example#x",
  ]) {
    assert.throws(() => readConfig({ PUBLIC_URL: url }));
  }
  assert.throws(() => readConfig({ LISTEN_HOST: "0.0.0.0" }), /loopback/);
  const prefixed = readConfig({ PUBLIC_URL: "https://se.ifmo.ru/~s507353/moodle-lti-rag/" });
  assert.equal(prefixed.publicUrl, "https://se.ifmo.ru/~s507353/moodle-lti-rag");
  assert.equal(prefixed.publicOrigin, "https://se.ifmo.ru");
  assert.equal(prefixed.basePath, "/~s507353/moodle-lti-rag");
});

test("Билет одноразовый, сессия ограничена временем; CSRF сравнивается с серверным значением", () => {
  let now = 0;
  const sessions = new Sessions({ ttlMs: 1000, clock: () => now });
  const ticket = sessions.issueTicket({ scope: { userId: "A" } });
  const { id, session } = sessions.activate(ticket);
  assert.equal(sessions.get(id).scope.userId, "A");
  assert.throws(() => sessions.activate(ticket), { status: 401 });
  assert.throws(() => sessions.verifyCsrf(session), { status: 403 });
  assert.throws(() => sessions.verifyCsrf(session, "x".repeat(session.csrf.length)), { status: 403 });
  sessions.verifyCsrf(session, session.csrf);
  now = 1001;
  assert.throws(() => sessions.get(id), { status: 401 });
  const expiredTicket = sessions.issueTicket({});
  now += 60_001;
  assert.throws(() => sessions.activate(expiredTicket), { status: 401 });
});
