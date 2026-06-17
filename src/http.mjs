export class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

export function sendBuffer(res, status, buffer, headers = {}) {
  res.writeHead(status, {
    "cache-control": "private, no-store",
    "content-length": buffer.length,
    ...headers,
  });
  res.end(buffer);
}

export function sendError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  sendJson(res, status, {
    error: {
      message: status === 500 ? "Internal server error." : error.message,
      ...(error?.details ? { details: error.details } : {}),
    },
  });
}

export function requireString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, `${field} is required.`);
  }
  return value.trim();
}

export function optionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
