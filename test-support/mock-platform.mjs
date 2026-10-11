import { createServer } from "node:http";
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import express from "express";
import { SCORE_SCOPE } from "../src/lti-launch.mjs";

export const CLAIM = "https://purl.imsglobal.org/spec/lti/claim/";
export const AGS_CLAIM = "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint";
export const LEARNER = "http://purl.imsglobal.org/vocab/lis/v2/membership#Learner";
export const INSTRUCTOR = "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor";
export const CLIENT_ID = "local-rag-tool";
export const DEPLOYMENT_ID = "local-deployment";

const users = {
  "student-a": { name: "Студент A (тест)", roles: [LEARNER] },
  "student-b": { name: "Студент B (тест)", roles: [LEARNER] },
  instructor: { name: "Преподаватель (тест)", roles: [INSTRUCTOR] },
};
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (symbol) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[symbol],
  );
}
function signJwt(payload, privateKey, kid = "local-platform-key") {
  const parts = [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
  ];
  const content = parts.join(".");
  return `${content}.${sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64url")}`;
}

// Explicitly selected local fixture. No production .env flag enables this platform.
export async function startMockPlatform({ port = 0 } = {}) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ type: ["application/json", "application/vnd.ims.lis.v1.score+json"] }));
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "local-platform-key", alg: "RS256", use: "sig" };
  const server = createServer(app);
  let toolUrl;
  let failures = 0;
  let loseResponses = 0;
  let gate = null;
  const tokens = new Map();
  const assertionIds = new Set();
  const scoreRequests = [];
  const acceptedEffects = [];
  const grades = new Map();

  function launchPayload(authenticationUrl, overrides = {}) {
    const url = new URL(authenticationUrl);
    const subject = url.searchParams.get("login_hint");
    const user = users[subject];
    if (
      !user ||
      url.searchParams.get("client_id") !== CLIENT_ID ||
      url.searchParams.get("redirect_uri") !== `${toolUrl}/lti/launch`
    ) {
      throw new Error("Unexpected mock authentication request");
    }
    const now = Math.floor(Date.now() / 1000);
    const resourceId = overrides[`${CLAIM}resource_link`]?.id || "rag-link";
    return {
      iss: origin,
      sub: subject,
      aud: CLIENT_ID,
      iat: now,
      exp: now + 300,
      nonce: url.searchParams.get("nonce"),
      name: user.name,
      [`${CLAIM}version`]: "1.3.0",
      [`${CLAIM}message_type`]: "LtiResourceLinkRequest",
      [`${CLAIM}deployment_id`]: DEPLOYMENT_ID,
      [`${CLAIM}target_link_uri`]: `${toolUrl}/lti/launch`,
      [`${CLAIM}roles`]: user.roles,
      [`${CLAIM}context`]: { id: "rag-course", title: "RAG-практикум (локальный стенд)" },
      [`${CLAIM}resource_link`]: { id: resourceId, title: "Три задания · 3/3/4" },
      [AGS_CLAIM]: {
        scope: [SCORE_SCOPE],
        lineitem: `${origin}/gradebook/lineitem?type_id=rag-lab&resource=${encodeURIComponent(resourceId)}`,
      },
      ...overrides,
    };
  }
  function createLaunch(authenticationUrl, overrides, signingKey = keys.privateKey) {
    const payload = launchPayload(authenticationUrl, overrides);
    return { id_token: signJwt(payload, signingKey), state: new URL(authenticationUrl).searchParams.get("state") };
  }
  app.get("/jwks", (_req, res) => res.json({ keys: [jwk] }));
  app.get("/auth", (req, res) => {
    const launch = createLaunch(`${origin}${req.originalUrl}`);
    res
      .set("Cache-Control", "no-store")
      .type("html")
      .send(
        `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Тестовый LTI-запуск</title><script defer src="/auto-submit.js"></script></head><body><p>Тестовая платформа передаёт подписанный LTI-токен…</p><form id="launch" action="${escapeHtml(toolUrl)}/lti/launch" method="post"><input type="hidden" name="id_token" value="${escapeHtml(launch.id_token)}"><input type="hidden" name="state" value="${escapeHtml(launch.state)}"><button>Продолжить</button></form></body></html>`,
      );
  });
  app.get("/auto-submit.js", (_req, res) =>
    res.type("application/javascript").send("document.getElementById('launch').submit();"),
  );
  app.post("/token", async (req, res) => {
    try {
      if (
        req.body.grant_type !== "client_credentials" ||
        req.body.client_assertion_type !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" ||
        req.body.scope !== SCORE_SCOPE
      ) {
        throw new Error("Unexpected OAuth contract");
      }
      const [head, body, signature] = req.body.client_assertion.split(".");
      const header = JSON.parse(Buffer.from(head, "base64url"));
      const payload = JSON.parse(Buffer.from(body, "base64url"));
      const keyset = await fetch(`${toolUrl}/lti/keys`).then((response) => response.json());
      const key = keyset.keys.find((candidate) => candidate.kid === header.kid);
      if (
        !key ||
        header.alg !== "RS256" ||
        !verify(
          "RSA-SHA256",
          Buffer.from(`${head}.${body}`),
          createPublicKey({ key, format: "jwk" }),
          Buffer.from(signature, "base64url"),
        ) ||
        payload.iss !== CLIENT_ID ||
        payload.sub !== CLIENT_ID ||
        payload.aud !== `${origin}/token` ||
        payload.exp <= Date.now() / 1000 ||
        !payload.jti ||
        assertionIds.has(payload.jti)
      ) {
        throw new Error("Invalid client assertion");
      }
      assertionIds.add(payload.jti);
      const accessToken = randomBytes(32).toString("base64url");
      tokens.set(accessToken, { expiresAt: Date.now() + 3600_000 });
      res.json({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, scope: SCORE_SCOPE });
    } catch {
      res.status(401).json({ error: "invalid_client" });
    }
  });
  app.post("/gradebook/lineitem/scores", async (req, res) => {
    const record = tokens.get((req.headers.authorization || "").replace(/^Bearer /, ""));
    if (!record || record.expiresAt <= Date.now()) {
      return res.status(401).json({ error: "invalid_token" });
    }
    const score = req.body;
    if (
      !req.is("application/vnd.ims.lis.v1.score+json") ||
      req.query.type_id !== "rag-lab" ||
      !["student-a", "student-b"].includes(score.userId) ||
      score.scoreMaximum !== 10 ||
      !Number.isInteger(score.scoreGiven) ||
      score.scoreGiven < 0 ||
      score.scoreGiven > 10 ||
      score.activityProgress !== "Completed" ||
      score.gradingProgress !== "FullyGraded" ||
      !Number.isFinite(Date.parse(score.timestamp))
    ) {
      return res.status(400).json({ error: "bad_score" });
    }
    scoreRequests.push({ url: req.originalUrl, score: structuredClone(score) });
    if (gate) {
      const currentGate = gate;
      gate = null;
      currentGate.enter();
      await currentGate.wait;
    }
    if (failures > 0) {
      failures -= 1;
      return res.status(503).json({ error: "simulated_ags_unavailable" });
    }
    const key = `${req.query.resource}:${score.userId}`;
    const previous = grades.get(key);
    if (!previous || Date.parse(score.timestamp) > Date.parse(previous.timestamp)) {
      grades.set(key, structuredClone(score));
    }
    acceptedEffects.push(structuredClone(score));
    if (loseResponses > 0) {
      loseResponses -= 1;
      req.socket.destroy();
      return;
    }
    res.status(204).end();
  });
  app.get("/demo/grades", (_req, res) =>
    res.json({
      demo: true,
      grades: Object.fromEntries(grades),
      calls: scoreRequests.length,
      accepted: acceptedEffects.length,
    }),
  );
  app.post("/demo/fail-next", (req, res) => {
    if (req.headers.origin && req.headers.origin !== origin) {
      return res.status(403).end();
    }
    failures += 1;
    res.redirect(303, "/");
  });
  app.get("/", (_req, res) => {
    const launchLinks = Object.entries(users)
      .map(([id, user]) => {
        const query = new URLSearchParams({
          iss: origin,
          client_id: CLIENT_ID,
          login_hint: id,
          target_link_uri: `${toolUrl}/lti/launch`,
          lti_deployment_id: DEPLOYMENT_ID,
        });
        return `<li><a href="${escapeHtml(`${toolUrl}/lti/login?${query}`)}">${escapeHtml(user.name)}</a></li>`;
      })
      .join("");
    res
      .type("html")
      .send(
        `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Локальная имитация Moodle</title></head><body><main><h1>Локальная имитация Moodle</h1><p>Это тестовый стенд, не Gnomio. Подпись LTI, OAuth-токен и AGS HTTP-запросы настоящие; участники и журнал вымышленные.</p><h2>Запустить тренажёр</h2><ul>${launchLinks}</ul><p><a href="/demo/grades">Посмотреть тестовый журнал (JSON)</a></p><form action="/demo/fail-next" method="post"><button>Имитировать сбой следующей доставки AGS</button></form><p>После этого запустите ученика, отправьте ответы и проверьте повтор доставки.</p></main></body></html>`,
      );
  });
  app.use((error, _req, res, _next) =>
    res.status(400).json({ error: "mock_request_rejected", message: error.message }),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    setToolUrl(url) {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
        throw new Error("Fixture tool must be on loopback");
      }
      toolUrl = url;
    },
    createLaunch,
    failNextScore(count = 1) {
      failures += count;
    },
    loseNextScoreResponse() {
      loseResponses += 1;
    },
    gateNextScore() {
      let release;
      let enter;
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      const entered = new Promise((resolve) => {
        enter = resolve;
      });
      gate = { wait, enter };
      return { entered, release };
    },
    get scoreRequests() {
      return structuredClone(scoreRequests);
    },
    get acceptedEffects() {
      return structuredClone(acceptedEffects);
    },
    get grades() {
      return structuredClone(grades);
    },
    close() {
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
