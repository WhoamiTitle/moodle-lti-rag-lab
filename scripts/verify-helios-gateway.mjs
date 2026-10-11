// Explicit local transport fixture, not a platform or a production server.
// Requires local PHP CLI and an unused loopback port 30353; no Docker/LMS/data is touched.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const prefix = "/~s507353/moodle-lti-rag";
let backendCalls = 0;
const backend = createServer(async (req, res) => {
  backendCalls += 1;
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  if (req.url === `${prefix}/redirect`) {
    res.writeHead(303, {
      Location: `${prefix}/app`,
      "Set-Cookie": ["probe_a=one; HttpOnly; Secure; Path=/", "probe_b=two; SameSite=Lax; Path=/"],
      "Content-Security-Policy": "default-src 'none'",
    });
    return res.end("not-followed");
  }
  if (req.url === `${prefix}/oversized-response`) {
    return res.end("x".repeat(2097153));
  }
  res.writeHead(req.url === `${prefix}/error` ? 403 : 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ method: req.method, url: req.url, body, headers: req.headers }));
});
let php;
try {
  await new Promise((resolve, reject) => {
    backend.once("error", reject);
    backend.listen(30353, "127.0.0.1", resolve);
  });
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  php = spawn(
    "php",
    ["-S", `127.0.0.1:${port}`, fileURLToPath(new URL("../deploy/helios/public/index.php", import.meta.url))],
    {
      stdio: "ignore",
    },
  );
  let phpError;
  php.on("error", (error) => {
    phpError = error;
  });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (phpError) {
      throw phpError;
    }
    try {
      const response = await fetch(`${origin}${prefix}/echo`, { signal: AbortSignal.timeout(300) });
      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* Wait only for this newly spawned PHP fixture. */
    }
    await setTimeout(50);
  }
  assert.ok(ready, "PHP fixture did not become ready");
  const request = (path, options) => fetch(`${origin}${path}`, { redirect: "manual", ...options });
  const response = await request(`${prefix}/echo?upstream=https://example.invalid`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: "probe_session=synthetic",
      Origin: "https://se.ifmo.ru",
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": "synthetic-csrf",
      "X-Forwarded-Host": "untrusted.invalid",
    },
    body: "state=synthetic&answer=RAG%20test",
  });
  assert.equal(response.status, 200);
  const echoed = await response.json();
  assert.equal(echoed.method, "POST");
  assert.equal(echoed.url, `${prefix}/echo?upstream=https://example.invalid`);
  assert.equal(echoed.body, "state=synthetic&answer=RAG%20test");
  assert.equal(echoed.headers.cookie, "probe_session=synthetic");
  assert.equal(echoed.headers.origin, "https://se.ifmo.ru");
  assert.equal(echoed.headers["x-csrf-token"], "synthetic-csrf");
  assert.equal(echoed.headers["sec-fetch-site"], "same-origin");
  assert.equal(echoed.headers.host, "se.ifmo.ru");
  assert.equal(echoed.headers["x-forwarded-host"], undefined);
  const redirected = await request(`${prefix}/redirect`);
  assert.equal(redirected.status, 303);
  assert.equal(redirected.headers.get("location"), `${prefix}/app`);
  assert.equal(redirected.headers.getSetCookie().length, 2);
  assert.match(redirected.headers.getSetCookie()[0], /HttpOnly; Secure; Path=\//);
  assert.equal(redirected.headers.get("content-security-policy"), "default-src 'none'");
  assert.equal(await redirected.text(), "not-followed");
  assert.equal((await request(`${prefix}/error`)).status, 403);
  const head = await request(`${prefix}/echo`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const beforeRejected = backendCalls;
  assert.equal((await request("/outside")).status, 400);
  assert.equal((await request(`${prefix}-other/echo`)).status, 400);
  assert.equal((await request(`${prefix}/echo`, { method: "DELETE" })).status, 405);
  assert.equal((await request(`${prefix}/echo`, { method: "POST", body: "x".repeat(131073) })).status, 413);
  assert.equal(backendCalls, beforeRejected);
  assert.equal((await request(`${prefix}/oversized-response`)).status, 502);
  await new Promise((resolve) => backend.close(resolve));
  assert.equal((await request(`${prefix}/echo`)).status, 502);
  console.log("Gateway transport verified: POST/body/headers, 303, two cookies, HEAD, 400/403/405/413/502.");
} finally {
  if (php && php.exitCode === null && php.pid) {
    const exited = once(php, "exit");
    php.kill("SIGTERM");
    await exited;
  }
  if (backend.listening) {
    await new Promise((resolve) => backend.close(resolve));
  }
}
