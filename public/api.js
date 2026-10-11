// A saved pending attempt is a recoverable outcome, not a confirmed AGS delivery.
export async function requestApi(url, { body, csrf, basePath = "", fetchRequest = fetch } = {}) {
  const response = await fetchRequest(`${basePath}${url}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers:
      body === undefined
        ? { Accept: "application/json" }
        : { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  const value = await response.json();
  const savedPending =
    url === "/api/submit" && response.status === 502 && value.ok === false && value.current?.status === "pending";
  if (!response.ok && !savedPending) {
    const error = new Error(value.error || "Не удалось выполнить запрос.");
    error.status = response.status;
    error.code = value.code;
    throw error;
  }
  return value;
}
