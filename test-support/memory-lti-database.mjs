import { randomUUID } from 'node:crypto';

// Implements ltijs 7's published DatabaseManager contract for synthetic tests only.
// src/server.mjs never imports this file: the normal server always uses MongoDB.
export class MemoryLtiDatabase {
  #platforms = new Map();
  #tokens = new Map();
  #launches = new Map();
  #nonces = new Map();

  async listen() {}
  async close() {}
  async getPlatforms(filter = {}) {
    return structuredClone([...this.#platforms.values()].filter((platform) =>
      (filter.url === undefined || platform.url === filter.url)
      && (filter.name === undefined || platform.name === filter.name)
      && (filter.clientId === undefined || (Array.isArray(filter.clientId)
        ? filter.clientId.includes(platform.clientId) : platform.clientId === filter.clientId))));
  }
  async getPlatformById(id) { return structuredClone(this.#platforms.get(id)); }
  async getPlatformByUrlAndClientId(url, clientId) {
    return (await this.getPlatforms({ url, clientId }))[0];
  }
  async savePlatform(attributes) {
    const id = randomUUID();
    this.#platforms.set(id, { ...structuredClone(attributes), id });
    return id;
  }
  async updatePlatformById(id, fields) {
    const platform = this.#platforms.get(id);
    if (!platform) throw new Error('Unexpected test platform ID');
    this.#platforms.set(id, { ...platform, ...structuredClone(fields) });
  }
  async deletePlatformById(id) { this.#platforms.delete(id); }
  async getAccessToken(url, clientId, scopes) {
    return structuredClone(this.#tokens.get(JSON.stringify([url, clientId, scopes])));
  }
  async saveAccessToken(url, clientId, scopes, token) {
    const key = JSON.stringify([url, clientId, scopes]);
    this.#tokens.set(key, structuredClone(token));
    return key;
  }
  async getIdToken(id) { return structuredClone(this.#launches.get(id)); }
  async saveIdToken(claims) {
    const id = randomUUID();
    this.#launches.set(id, { ...structuredClone(claims), id });
    return id;
  }
  async saveNonce(nonce) {
    if (this.#nonces.has(nonce)) throw new Error('Duplicate fixture nonce');
    this.#nonces.set(nonce, Date.now() + 10 * 60_000);
    return nonce;
  }
  async consumeNonce(nonce) {
    const expiresAt = this.#nonces.get(nonce);
    this.#nonces.delete(nonce);
    return typeof expiresAt === 'number' && Date.now() < expiresAt;
  }
}
