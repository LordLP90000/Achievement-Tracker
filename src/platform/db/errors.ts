/** PostgreSQL error classes the application reacts to (everything else is a 500). */

const UNIQUE_VIOLATION = '23505';

const codeOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

/** A unique constraint was violated, reported by postgres.js directly or wrapped by Drizzle (`cause`). */
export function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return codeOf(error) === UNIQUE_VIOLATION || codeOf(cause) === UNIQUE_VIOLATION;
}
