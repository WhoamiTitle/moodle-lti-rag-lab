import { grade } from "./grading.mjs";
import { AppError, requireObject } from "./errors.mjs";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalAnswers(answers) {
  return { q1: answers.q1, q2: answers.q2, q3: answers.q3 };
}

function publicAttempt(attempt) {
  if (!attempt) {
    return null;
  }
  const { requestId, items, scoreGiven, scoreMaximum, status, createdAt, sentAt, deliveries, lastError } = attempt;
  return {
    // Derive the starter DTO from the existing schema; do not migrate stored attempts.
    id: requestId,
    requestId,
    answerSignature: JSON.stringify(Object.values(canonicalAnswers(attempt.answers))),
    answers: attempt.answers,
    items,
    scoreGiven,
    scoreMaximum,
    status,
    createdAt,
    sentAt,
    deliveries,
    lastError,
    lastDeliveryAt: attempt.deliveryTimestamp,
  };
}

export class Attempts {
  constructor(store, { clock = Date.now, logger = console } = {}) {
    this.store = store;
    this.clock = clock;
    this.logger = logger;
  }

  async snapshot(scope) {
    const snapshot = await this.store.load(scope);
    return {
      current: publicAttempt(snapshot.current),
      history: snapshot.history.map((attempt) => publicAttempt(attempt)),
      historyTotal: snapshot.history.length,
    };
  }

  async submit(scope, body, lineItemId, deliver) {
    requireObject(body, ["requestId", "answers"]);
    if (typeof body.requestId !== "string" || !UUID_V4.test(body.requestId)) {
      throw new AppError(400, "invalid_request_id", "requestId должен быть UUID v4.");
    }
    const calculated = grade(body.answers);
    const answers = canonicalAnswers(body.answers);
    const requestId = body.requestId.toLowerCase();
    return this.store.run(scope, async () => {
      const snapshot = await this.store.load(scope);
      let attempt = [snapshot.current, ...snapshot.history].find((entry) => entry?.requestId === requestId);
      if (attempt) {
        if (JSON.stringify(attempt.answers) !== JSON.stringify(answers)) {
          throw new AppError(409, "request_id_reused", "Этот requestId уже закреплён за другими ответами.");
        }
        if (attempt.status === "sent") {
          return { ...publicAttempt(attempt), duplicate: true };
        }
        if (attempt.lineItemId !== lineItemId) {
          throw new AppError(
            409,
            "line_item_changed",
            "Колонка Moodle изменилась. Ожидающую попытку нельзя отправить в другую колонку.",
          );
        }
      } else {
        if (snapshot.current) {
          throw new AppError(
            409,
            "attempt_exists",
            snapshot.current.status === "pending"
              ? "Сначала повторите доставку текущей попытки."
              : "Сначала нажмите «Новая попытка».",
          );
        }
        attempt = {
          requestId,
          answers,
          ...calculated,
          lineItemId,
          status: "pending",
          createdAt: new Date(this.clock()).toISOString(),
          sentAt: null,
          deliveries: 0,
          lastError: null,
        };
        snapshot.current = attempt;
        // Persist the business result before requesting a token or making an AGS call.
        await this.store.save(scope, snapshot);
      }
      const timestampMs = Math.max(this.clock(), snapshot.lastTimestamp + 1);
      snapshot.lastTimestamp = timestampMs;
      attempt.deliveryTimestamp = new Date(timestampMs).toISOString();
      attempt.deliveries += 1;
      await this.store.save(scope, snapshot);

      try {
        await deliver({
          userId: scope.userId,
          scoreGiven: attempt.scoreGiven,
          scoreMaximum: attempt.scoreMaximum,
          activityProgress: "Completed",
          gradingProgress: "FullyGraded",
          timestamp: attempt.deliveryTimestamp,
        });
      } catch (error) {
        // A timeout is an unknown outcome, not proof that Moodle rejected the score.
        attempt.lastError = Number.isInteger(error.status) ? `ags_http_${error.status}` : "ags_network";
        this.logger.warn(`AGS: ${attempt.lastError}; attempt=${attempt.requestId}`);
        await this.store.save(scope, snapshot);
        return publicAttempt(attempt);
      }
      attempt.status = "sent";
      attempt.sentAt = new Date(this.clock()).toISOString();
      attempt.lastError = null;
      await this.store.save(scope, snapshot);
      return publicAttempt(attempt);
    });
  }

  async newAttempt(scope) {
    return this.store.run(scope, async () => {
      const snapshot = await this.store.load(scope);
      if (snapshot.current?.status === "pending") {
        throw new AppError(409, "delivery_pending", "Новая попытка доступна после доставки текущей оценки.");
      }
      if (snapshot.current) {
        snapshot.history.push(snapshot.current);
        snapshot.current = null;
        await this.store.save(scope, snapshot);
      }
      return { current: null };
    });
  }
}
