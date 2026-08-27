/** Predictable, code-tagged errors (§39). Thrown anywhere, handled centrally. */
export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly errors: unknown[];
  public readonly isOperational: boolean;

  constructor(statusCode: number, message: string, code = 'ERROR', errors: unknown[] = []) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.errors = errors;
    this.isOperational = true;
    Error.captureStackTrace?.(this, this.constructor);
  }

  static badRequest(msg = 'Bad request', code = 'BAD_REQUEST', errors: unknown[] = []) {
    return new ApiError(400, msg, code, errors);
  }
  static unauthorized(msg = 'Unauthorized', code = 'UNAUTHORIZED') {
    return new ApiError(401, msg, code);
  }
  static forbidden(msg = 'Forbidden', code = 'FORBIDDEN') {
    return new ApiError(403, msg, code);
  }
  static notFound(msg = 'Not found', code = 'NOT_FOUND') {
    return new ApiError(404, msg, code);
  }
  static conflict(msg = 'Conflict', code = 'CONFLICT') {
    return new ApiError(409, msg, code);
  }
  static tooMany(msg = 'Too many requests', code = 'RATE_LIMITED') {
    return new ApiError(429, msg, code);
  }
  static internal(msg = 'Internal server error', code = 'INTERNAL_ERROR') {
    return new ApiError(500, msg, code);
  }
}
