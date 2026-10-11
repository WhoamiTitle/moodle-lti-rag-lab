import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { ExpressHttpHandler, IdTokenValidationMethod, Provider } from "ltijs";
import { AttemptStore } from "./attempt-store.mjs";
import { Attempts } from "./attempts.mjs";
import { AppError, requireObject } from "./errors.mjs";
import { MAX_ANSWER_LENGTH, getPublicTasks } from "./grading.mjs";
import { launchSession } from "./lti-launch.mjs";
import { LtiRequestHandler } from "./lti-request-handler.mjs";
import { Sessions } from "./sessions.mjs";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

function cookieValue(req, name) {
  const cookies = (req.headers.cookie || "").split(";").map((part) => part.trim());
  const matching = cookies.filter((part) => part.startsWith(`${name}=`));
  return matching.length === 1 ? matching[0].slice(name.length + 1) : undefined;
}

function ltiLogger(logger) {
  return {
    debug() {},
    warn(component) {
      logger.warn(`LTI warning (${component})`);
    },
    // Never log tokens, POST bodies, private keys or platform error responses.
    error(component) {
      logger.error(`LTI request rejected (${component})`);
    },
  };
}

export function createTool(config, { databaseManager, logger = console } = {}) {
  const route = (suffix) => `${config.basePath}${suffix}`;
  const secureCookies = new URL(config.publicUrl).protocol === "https:";
  const cookieName = secureCookies ? "__Host-rag_session" : "rag_session";
  const sessions = new Sessions({ ttlMs: config.sessionTtlMs });
  const store = new AttemptStore(config.dataDir);
  const attempts = new Attempts(store, { logger });
  const httpHandler = new ExpressHttpHandler(ltiLogger(logger), { port: config.port, cors: false });
  const app = httpHandler.app;
  let server;
  let registeredPlatform;
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
    // ltijs OIDC pages use inline scripts for localStorage / form_post state recovery.
    // The actual training interface never enables inline JS or third-party assets.
    const ltiPage = [route("/lti/login"), route("/lti/launch")].includes(req.path);
    res.set(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        `script-src 'self'${ltiPage ? " 'unsafe-inline'" : ""}`,
        `style-src 'self'${ltiPage ? " 'unsafe-inline'" : ""}`,
        "connect-src 'self'",
        "img-src 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ].join("; "),
    );
    next();
  });

  // Limit OIDC redirect targets before handing the login to the library.
  app.all(route("/lti/login"), (req, res, next) => {
    if (!config.configured) {
      return res.status(503).json({ error: "not_configured", message: "Платформа Moodle ещё не зарегистрирована." });
    }
    const parameters = { ...req.query, ...req.body };
    if (
      parameters.iss !== config.moodle.issuer ||
      (parameters.client_id !== undefined && parameters.client_id !== config.moodle.clientId) ||
      (parameters.lti_deployment_id !== undefined && parameters.lti_deployment_id !== config.moodle.deploymentId) ||
      parameters.target_link_uri !== `${config.publicUrl}/lti/launch`
    ) {
      return res
        .status(400)
        .json({ error: "invalid_login", message: "Проверьте issuer, client ID, deployment ID и URL запуска." });
    }
    // Some Moodle launches omit client_id. Bind them to this configured client,
    // not the first historical registration for the same issuer in MongoDB.
    if (parameters.client_id === undefined) {
      req.body = { ...req.body, client_id: config.moodle.clientId };
    }
    next();
  });

  const provider = new Provider({
    ...(databaseManager
      ? { databaseManager }
      : {
          database: { url: config.mongoUrl, connection: { serverSelectionTimeoutMS: 5000 } },
        }),
    httpHandler,
    requestHandler: new LtiRequestHandler(config.requestTimeoutMs),
    logger: ltiLogger(logger),
    tokenMaxAge: 60,
    routes: {
      loginRoute: route("/lti/login"),
      launchRoute: route("/lti/launch"),
      keysetRoute: route("/lti/keys"),
    },
  });

  provider.onResourceLink(async (context, _request, response) => {
    const ticket = sessions.issueTicket(launchSession(context, config));
    // Do not put ltik or id_token in an application URL or browser storage.
    response.redirect(`${route("/session/start")}?ticket=${ticket}`);
  });
  const unsupported = async (_context, _request, response) => {
    response.status(400).json({
      error: "unsupported_launch",
      message:
        "Поддерживается только Resource Link launch. Deep Linking и Submission Review для этой лабораторной не включены.",
    });
  };
  provider.onDeepLinking(unsupported);
  provider.onSubmissionReview(unsupported);

  app.get(route("/healthz"), (_req, res) => res.json({ ok: true, configured: config.configured }));
  app.get(route("/tool-public-key"), (_req, res) => {
    if (!registeredPlatform) {
      return res.status(503).json({ error: "not_configured" });
    }
    res.type("text/plain").send(registeredPlatform.keys.public);
  });
  if (config.basePath) {
    app.get(config.basePath, (req, res, next) => {
      if (req.path === config.basePath) {
        return res.redirect(308, `${route("/")}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`);
      }
      next();
    });
  }
  // Fixed filenames relative to the public root: private parent dot-directories
  // must not trigger send's dotfile filter. Arbitrary paths are never accepted.
  app.get(route("/"), (_req, res) => res.type("html").sendFile("welcome.html", { root: PUBLIC_DIR }));
  app.get(route("/assets/app.css"), (_req, res) => res.sendFile("app.css", { root: PUBLIC_DIR }));
  app.get(route("/assets/app.js"), (_req, res) => res.sendFile("app.js", { root: PUBLIC_DIR }));
  app.get(route("/assets/api.js"), (_req, res) => res.sendFile("api.js", { root: PUBLIC_DIR }));
  app.get(route("/session/start"), (req, res) => {
    if (typeof req.query.ticket !== "string") {
      throw new AppError(401, "invalid_ticket", "Необходим одноразовый билет запуска.");
    }
    const { id } = sessions.activate(req.query.ticket);
    res.cookie(cookieName, id, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: "lax",
      path: "/",
      maxAge: config.sessionTtlMs,
    });
    res.redirect(303, route("/app"));
  });

  function requireSession(req, _res, next) {
    req.trainingSession = sessions.get(cookieValue(req, cookieName));
    next();
  }
  app.get(route("/app"), (req, res, next) => {
    if (req.path === route("/app/")) {
      return res.redirect(308, route("/app"));
    }
    next();
  });
  app.get(route("/app"), requireSession, (_req, res) => res.sendFile("app.html", { root: PUBLIC_DIR }));
  app.use(route("/api"), requireSession);
  app.get(route("/api/session"), async (req, res) => {
    const session = req.trainingSession;
    res.json({
      label: config.appLabel,
      userId: session.scope.userId,
      name: session.displayName,
      roles: session.roles,
      course: session.scope.contextId,
      resource: session.scope.resourceLinkId,
      learner: session.isLearner,
      agsReady: !session.gradeUnavailable,
      demo: Boolean(config.demo),
      courseTitle: session.contextTitle,
      resourceTitle: session.resourceTitle,
      platform: {
        issuer: session.scope.issuer,
        clientId: session.scope.clientId,
        deploymentId: session.scope.deploymentId,
      },
      gradeUnavailable: session.gradeUnavailable,
      csrf: session.csrf,
      expiresAt: new Date(session.expiresAt).toISOString(),
      tasks: getPublicTasks(),
      maxAnswerLength: MAX_ANSWER_LENGTH,
      scoreMaximum: 10,
      ...(await attempts.snapshot(session.scope)),
    });
  });

  app.use(route("/api"), (req, _res, next) => {
    if (req.method === "GET") {
      return next();
    }
    const session = req.trainingSession;
    sessions.verifyCsrf(session, req.headers["x-csrf-token"]);
    if (
      req.headers.origin !== config.publicOrigin ||
      (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")
    ) {
      throw new AppError(403, "cross_origin", "Запрос должен приходить из страницы тренажёра.");
    }
    if (!session.isLearner) {
      throw new AppError(
        403,
        "read_only",
        "Этот запуск доступен только для просмотра. Оценки отправляются только для роли Learner.",
      );
    }
    if (session.gradeUnavailable) {
      throw new AppError(409, "ags_unavailable", session.gradeUnavailable);
    }
    if (!req.is("application/json")) {
      throw new AppError(415, "json_required", "Нужен Content-Type: application/json.");
    }
    next();
  });
  app.post(route("/api/submit"), async (req, res) => {
    const session = req.trainingSession;
    const { duplicate, ...current } = await attempts.submit(session.scope, req.body, session.lineItemId, (score) =>
      session.context.grading.submitScore(session.lineItemId, score),
    );
    const confirmed = current.status === "sent";
    res.status(confirmed ? 200 : 502).json({
      ok: confirmed,
      ...(duplicate ? { duplicate: true } : {}),
      current,
      ...(!confirmed ? { error: "Оценка сохранена в тренажере. Moodle не подтвердил прием. Повторите отправку." } : {}),
    });
  });
  app.post(route("/api/new-attempt"), async (req, res) => {
    requireObject(req.body, []);
    await attempts.newAttempt(req.trainingSession.scope);
    res.json({ ok: true });
  });
  app.use((_req, res) => res.status(404).json({ error: "not_found", message: "Страница не найдена." }));
  app.use((error, req, res, _next) => {
    const known =
      error instanceof AppError || (Number.isInteger(error.status) && error.status >= 400 && error.status < 500);
    if (!known) {
      logger.error(`Application error: ${error.name || "Error"}`);
    }
    const status = known ? error.status : 500;
    if (req.path === route("/app") && status === 401) {
      return res.status(401).type("html").sendFile("welcome.html", { root: PUBLIC_DIR });
    }
    res.status(status).json({
      code: known ? error.code || error.name : "internal_error",
      error: known
        ? error.message
        : "Внутренняя ошибка. Сохранённые попытки не сброшены; проверьте сервер и откройте элемент из Moodle.",
    });
  });

  async function registerPlatform() {
    if (!config.configured) {
      return;
    }
    const moodle = config.moodle;
    const registration = {
      url: moodle.issuer,
      clientId: moodle.clientId,
      name: "Moodle",
      authenticationEndpoint: moodle.authUrl,
      accessTokenEndpoint: moodle.tokenUrl,
      authorizationServer: moodle.tokenUrl,
      idTokenValidation: { method: IdTokenValidationMethod.JwkSet, key: moodle.jwksUrl },
    };
    const manager = provider.platformManager;
    const existing = await manager.getPlatformByUrlAndClientId(moodle.issuer, moodle.clientId);
    // Updating endpoints retains the original signing keys across restarts.
    registeredPlatform = existing
      ? await manager.updatePlatform(existing, registration)
      : await manager.registerPlatform(registration);
  }

  return {
    app,
    provider,
    async start() {
      try {
        await store.init();
        await provider.databaseManager.listen();
        await provider.cacheManager.listen();
        await registerPlatform();
        server = createServer(app);
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(config.port, config.host, resolve);
        });
      } catch (error) {
        await this.close();
        throw error;
      }
      return server.address();
    },
    async close() {
      if (server?.listening) {
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
      await Promise.all([provider.databaseManager.close(), provider.cacheManager.close(), store.close()]);
    },
  };
}
