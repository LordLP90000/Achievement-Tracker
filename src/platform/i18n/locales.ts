/** Locales of emails and server-generated texts (contract `Locale`, A-02). */

export const LOCALES = ['de-CH', 'fr-CH', 'it-CH', 'en', 'de', 'fr', 'it'] as const;

export type Locale = (typeof LOCALES)[number];

/** Used when the client sends none: the service starts in German-speaking Switzerland. */
export const DEFAULT_LOCALE: Locale = 'de-CH';

const KNOWN: ReadonlySet<string> = new Set(LOCALES);

export function isLocale(value: string): value is Locale {
  return KNOWN.has(value);
}
