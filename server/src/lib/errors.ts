/** 带 HTTP 状态与业务码的错误，统一由 app.ts 的错误中间件转成 JSON 响应 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }
}

export function badRequest(message: string, details?: unknown): ApiError {
  return new ApiError(400, 'BAD_REQUEST', message, details);
}

export function notFound(message: string): ApiError {
  return new ApiError(404, 'NOT_FOUND', message);
}

export function conflict(code: string, message: string, details?: unknown): ApiError {
  return new ApiError(409, code, message, details);
}
