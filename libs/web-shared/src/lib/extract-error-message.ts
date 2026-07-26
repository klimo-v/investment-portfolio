/** Достаём сообщение об ошибке из HttpErrorResponse (Nest BadRequestException) */
export function extractErrorMessage(err: unknown, fallback: string): string {
  if (
    err &&
    typeof err === 'object' &&
    'error' in err &&
    err.error &&
    typeof err.error === 'object' &&
    'message' in err.error &&
    typeof err.error.message === 'string'
  ) {
    return err.error.message;
  }
  return fallback;
}
