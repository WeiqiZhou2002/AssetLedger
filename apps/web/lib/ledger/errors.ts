export class LedgerError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
export function invariant(
  condition: unknown,
  message: string,
  status: 400 | 403 | 404 | 409 = 400,
): asserts condition {
  if (!condition) {
    throw new LedgerError(message, status);
  }
}
