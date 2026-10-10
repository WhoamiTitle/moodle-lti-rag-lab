import { HttpError } from 'ltijs';

// Published ltijs RequestHandler contract, with a deadline and no automatic POST retries.
export class LtiRequestHandler {
  #permanentHeaders = {};

  constructor(timeoutMs = 15_000) {
    this.timeoutMs = timeoutMs;
  }

  get(url, options) { return this.request('GET', url, undefined, options); }
  post(url, body, options) { return this.request('POST', url, body, options); }
  put(url, body, options) { return this.request('PUT', url, body, options); }
  delete(url, options) { return this.request('DELETE', url, undefined, options); }
  setPermanentHeader(name, value) { this.#permanentHeaders[name] = value; }

  async request(method, target, body, options) {
    const url = new URL(target);
    for (const [key, value] of options?.query || []) url.searchParams.append(key, value);
    const headers = new Headers(this.#permanentHeaders);
    if (options?.headers?.authorization) headers.set('Authorization', options.headers.authorization);
    if (options?.headers?.accept) headers.set('Accept', options.headers.accept);
    if (options?.headers?.contentType) headers.set('Content-Type', options.headers.contentType);
    if (body !== undefined && !(body instanceof URLSearchParams) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(url, {
      method, headers,
      body: body === undefined ? undefined : body instanceof URLSearchParams ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
    const text = await response.text();
    let data;
    try { data = text === '' ? undefined : JSON.parse(text); } catch { data = text; }
    if (!response.ok) {
      throw new HttpError({ message: `AGS/LTI HTTP ${response.status}`, status: response.status,
        statusText: response.statusText, url: response.url, response: data });
    }
    return { data, headers: Object.fromEntries(response.headers) };
  }
}
