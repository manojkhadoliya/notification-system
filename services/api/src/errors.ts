/** Carries the HTTP status + the `{error: {code, message}}` body shape
 * every endpoint uses (see api-spec.md#error-shape-all-endpoints).
 * `server.ts`'s global error handler is what actually catches these and
 * writes the response — route handlers just `throw`. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function unauthorized(message = "invalid or missing API key"): ApiError {
  return new ApiError(401, "unauthorized", message);
}

export function notFound(message = "not found"): ApiError {
  return new ApiError(404, "not_found", message);
}

export function conflict(message: string): ApiError {
  return new ApiError(409, "conflict", message);
}

export function tooManyRequests(message = "rate limit exceeded"): ApiError {
  return new ApiError(429, "rate_limited", message);
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, "bad_request", message);
}
