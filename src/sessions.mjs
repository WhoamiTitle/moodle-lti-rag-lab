import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.mjs';

const randomToken = () => randomBytes(32).toString('base64url');

export class Sessions {
  #tickets = new Map();
  #sessions = new Map();

  constructor({ ttlMs = 45 * 60 * 1000, clock = Date.now, limit = 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.limit = limit;
  }

  issueTicket(launch) {
    this.#prune();
    if (this.#tickets.size + this.#sessions.size >= this.limit) {
      throw new AppError(503, 'session_limit', 'Достигнут лимит учебных сессий. Попробуйте позже.');
    }
    const ticket = randomToken();
    this.#tickets.set(ticket, { launch, expiresAt: this.clock() + 60_000 });
    return ticket;
  }

  activate(ticket) {
    this.#prune();
    const record = this.#tickets.get(ticket);
    if (!record) throw new AppError(401, 'invalid_ticket', 'Ссылка запуска истекла или уже использована. Откройте элемент из Moodle заново.');
    this.#tickets.delete(ticket);
    const id = randomToken();
    const session = { ...record.launch, csrf: randomToken(), expiresAt: this.clock() + this.ttlMs };
    this.#sessions.set(id, session);
    return { id, session };
  }

  get(id) {
    this.#prune();
    const session = this.#sessions.get(id);
    if (!session) throw new AppError(401, 'session_required', 'Откройте тренажёр из Moodle. Сессия действует 45 минут; после перезапуска сервера нужен новый запуск.');
    return session;
  }

  verifyCsrf(session, value) {
    const supplied = typeof value === 'string' ? Buffer.from(value) : Buffer.alloc(0);
    const expected = Buffer.from(session.csrf);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new AppError(403, 'invalid_csrf', 'Неверный CSRF-токен. Обновите страницу тренажёра.');
    }
  }

  #prune() {
    const now = this.clock();
    for (const collection of [this.#tickets, this.#sessions]) {
      for (const [key, value] of collection) if (value.expiresAt <= now) collection.delete(key);
    }
  }
}
