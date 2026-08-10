export class IdentityProjectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 503,
    public readonly retryable = true,
  ) {
    super(message);
  }
}
