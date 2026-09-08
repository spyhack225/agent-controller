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

export interface BinaryUploadOptions {
  token: string;
  contentType: string;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
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

/** Raw HTTP upload with byte progress. Media never enters JSON or the event/WebSocket channels. */
export function uploadBinary<T>(
  path: string,
  body: Blob,
  options: BinaryUploadOptions,
): Promise<T> {
  return new Promise((resolve, reject) => {
    // AbortSignal does not replay an abort event to listeners added after it fired. Refuse before
    // constructing an XHR so a cancelled capture can never put bytes on the wire during teardown.
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new DOMException("Media upload cancelled.", "AbortError"));
      return;
    }
    const request = new XMLHttpRequest();
    let settled = false;
    const abort = () => request.abort();
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    request.open("PUT", path);
    request.responseType = "json";
    request.setRequestHeader("authorization", `Bearer ${options.token}`);
    request.setRequestHeader("content-type", options.contentType);
    request.upload.addEventListener("progress", (event) => {
      if (settled) return;
      options.onProgress?.(event.loaded, event.lengthComputable ? event.total : body.size);
    });
    request.addEventListener("load", () => {
      const data = request.response ?? parseXhrJson(request.responseText);
      if (request.status >= 200 && request.status < 300) {
        settle(() => resolve(data as T));
        return;
      }
      const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
      const envelope = record.error && typeof record.error === "object"
        ? record.error as Record<string, unknown>
        : {};
      settle(() => reject(new ApiError(
        request.status,
        typeof envelope.message === "string" ? envelope.message : `Request failed with HTTP ${request.status}.`,
        envelope.details,
      )));
    });
    request.addEventListener("error", () => settle(() => reject(new ApiError(0, "Media upload connection failed."))));
    request.addEventListener("abort", () => settle(() => reject(new DOMException("Media upload cancelled.", "AbortError"))));
    options.signal?.addEventListener("abort", abort, { once: true });
    request.addEventListener("loadend", cleanup);
    request.send(body);
  });
}

function parseXhrJson(value: string): unknown {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
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
