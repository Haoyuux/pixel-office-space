/** Errors the REST layer maps to status codes (app.ts error handler). */
export class ValidationError extends Error {}  // 400
export class NotFoundError extends Error {}    // 404
export class ConflictError extends Error {}    // 409
