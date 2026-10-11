import assert from "node:assert/strict";
import test from "node:test";
import { requestApi } from "../public/api.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("API остаётся в подпапке приложения; HTTP 502 сохраняет семантику pending", async () => {
  const payload = { ok: false, current: { status: "pending" } };
  const result = await requestApi("/api/submit", {
    basePath: "/~s507353/moodle-lti-rag",
    body: {},
    fetchRequest: async (url) => {
      assert.equal(url, "/~s507353/moodle-lti-rag/api/submit");
      return jsonResponse(payload, 502);
    },
  });
  assert.deepEqual(result, payload);
});

test("Браузерный клиент принимает обёртку ok/current и отправляет только answers/requestId с CSRF", async () => {
  const body = { requestId: "96f32308-dce4-445b-9efa-c9cd66070a31", answers: { q1: "rag", q2: "", q3: "api" } };
  const payload = { ok: true, current: { requestId: body.requestId, scoreGiven: 7, status: "sent" } };
  const result = await requestApi("/api/submit", {
    body,
    csrf: "synthetic-csrf",
    fetchRequest: async (url, options) => {
      assert.equal(url, "/api/submit");
      assert.equal(options.method, "POST");
      assert.equal(options.credentials, "same-origin");
      assert.deepEqual(options.headers, {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": "synthetic-csrf",
      });
      assert.deepEqual(JSON.parse(options.body), body);
      assert.ok(options.signal instanceof AbortSignal);
      return jsonResponse(payload);
    },
  });
  assert.deepEqual(result, payload);
});

test("Браузерный клиент сохраняет current при HTTP 502, но не считает pending подтверждённой доставкой", async () => {
  const payload = {
    ok: false,
    error: "Оценка сохранена. Повторите отправку.",
    current: { requestId: "96f32308-dce4-445b-9efa-c9cd66070a31", scoreGiven: 7, status: "pending", sentAt: null },
  };
  const result = await requestApi("/api/submit", { body: {}, fetchRequest: async () => jsonResponse(payload, 502) });
  assert.deepEqual(result, payload);
  assert.equal(result.ok, false);
  assert.equal(result.current.status, "pending");
  assert.equal(result.current.sentAt, null);
});

test("Браузерный клиент не скрывает произвольный 502 или ошибку другого маршрута за наличием current", async () => {
  for (const [url, payload] of [
    ["/api/submit", { error: "Нет сохранённой попытки" }],
    ["/api/submit", { ok: false, current: { status: "sent" }, error: "Некорректный ответ" }],
    ["/api/submit", { current: { status: "pending" }, error: "Нет ok:false" }],
    ["/api/session", { ok: false, current: { status: "pending" }, error: "Сбой чтения сессии" }],
    ["/api/new-attempt", { ok: false, current: { status: "pending" }, error: "Сбой новой попытки" }],
  ]) {
    await assert.rejects(requestApi(url, { fetchRequest: async () => jsonResponse(payload, 502) }), {
      status: 502,
      message: payload.error,
    });
  }
});

test("Браузерный клиент передаёт читаемую error, HTTP-статус и дополнительный код в обработчик ошибок", async () => {
  for (const status of [400, 401, 403]) {
    const payload = { error: "Откройте тренажёр из Moodle", code: "synthetic_error", current: { status: "pending" } };
    await assert.rejects(requestApi("/api/submit", { fetchRequest: async () => jsonResponse(payload, status) }), {
      status,
      message: payload.error,
      code: payload.code,
    });
  }
});

test("Браузерный GET читает сессию без POST-тела и CSRF-заголовка", async () => {
  const payload = { label: "RAG", userId: "student-a", learner: true, agsReady: true, current: null };
  const result = await requestApi("/api/session", {
    fetchRequest: async (_url, options) => {
      assert.equal(options.method, "GET");
      assert.equal(options.body, undefined);
      assert.deepEqual(options.headers, { Accept: "application/json" });
      return jsonResponse(payload);
    },
  });
  assert.deepEqual(result, payload);
});

test("Браузерный клиент не делает автоматический повтор при неоднозначном сетевом сбое", async () => {
  let calls = 0;
  const failure = new TypeError("Сеть недоступна");
  await assert.rejects(
    requestApi("/api/submit", {
      body: {},
      fetchRequest: async () => {
        calls += 1;
        throw failure;
      },
    }),
    (error) => error === failure && error.status === undefined,
  );
  assert.equal(calls, 1);
});
