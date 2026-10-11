import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

export function scopeKey(scope) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.issuer,
        scope.clientId,
        scope.deploymentId,
        scope.userId,
        scope.contextId,
        scope.resourceLinkId,
      ]),
    )
    .digest("hex");
}

// Atomic replacement on a local filesystem. One Node process per directory.
export class AttemptStore {
  #directory;
  #queues = new Map();
  #lock;

  constructor(directory) {
    this.#directory = directory;
  }

  async init() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    try {
      this.#lock = await open(path.join(this.#directory, ".instance.lock"), "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error(
          `Каталог ${this.#directory} уже заблокирован. Разрешён один процесс; после аварийного завершения проверьте PID в .instance.lock перед удалением только этого файла.`,
          { cause: error },
        );
      }
      throw error;
    }
    await this.#lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await this.#lock.sync();
  }

  async close() {
    await Promise.allSettled([...this.#queues.values()]);
    if (this.#lock) {
      await this.#lock.close();
      this.#lock = null;
      await unlink(path.join(this.#directory, ".instance.lock"));
    }
  }

  async run(scope, operation) {
    const key = scopeKey(scope);
    const preceding = this.#queues.get(key) || Promise.resolve();
    const running = preceding.catch(() => {}).then(operation);
    this.#queues.set(key, running);
    try {
      return await running;
    } finally {
      if (this.#queues.get(key) === running) {
        this.#queues.delete(key);
      }
    }
  }

  async load(scope) {
    let source;
    try {
      source = await readFile(this.#filename(scope), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return { version: 1, scope, current: null, history: [], lastTimestamp: 0 };
      }
      throw error;
    }
    const snapshot = JSON.parse(source);
    if (
      snapshot.version !== 1 ||
      !snapshot.scope ||
      scopeKey(snapshot.scope) !== scopeKey(scope) ||
      !Array.isArray(snapshot.history) ||
      !Number.isSafeInteger(snapshot.lastTimestamp) ||
      !(snapshot.current === null || ["pending", "sent"].includes(snapshot.current?.status))
    ) {
      throw new Error("Некорректное хранилище попыток: данные не будут сброшены автоматически.");
    }
    return snapshot;
  }

  async save(scope, snapshot) {
    const target = this.#filename(scope);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(snapshot, null, 2));
      await handle.sync();
      await handle.close();
      await rename(temporary, target);
      const directory = await open(this.#directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  #filename(scope) {
    return path.join(this.#directory, `${scopeKey(scope)}.json`);
  }
}
