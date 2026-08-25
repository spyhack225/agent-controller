export class ApiError extends Error {
  status: number;
  details: unknown;
  /** Seconds the server asked us to wait, from the `retry-after` header on a 429. */
  retryAfterSeconds: number | null;

  constructor(status: number, message: string, details?: unknown, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ApiOptions {
  method?: string;
  token?: string;
  auth?: boolean;
  body?: unknown;
  signal?: AbortSignal;
  /**
   * Let the browser finish this request after the document goes away. Only used by the thread
   * watch release on `pagehide`, where the alternative is waiting out a 90s lease.
   */
  keepalive?: boolean;
}

export async function requestJson<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.auth !== false && options.token) {
    headers.set("authorization", `Bearer ${options.token}`);
  }

  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    ...(options.keepalive ? { keepalive: true } : {}),
  });

  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const body = typeof data === "object" && data ? data as Record<string, unknown> : {};
    const error = typeof body.error === "object" && body.error
      ? body.error as Record<string, unknown>
      : {};
    const message = typeof error.message === "string"
      ? error.message
      : `Request failed with HTTP ${response.status}.`;
    const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    throw new ApiError(
      response.status,
      message,
      error.details,
      Number.isFinite(retryAfter) ? retryAfter : null,
    );
  }

  return data as T;
}

export function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
