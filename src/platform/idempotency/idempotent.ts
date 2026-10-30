import { randomUUID } from 'node:crypto';
import { decryptText, encryptText } from '../crypto/field-cipher.ts';
import type { Transaction } from '../db/database.ts';
import { findLiveIdempotencyRecord, lockIdempotencyKey, saveIdempotencyRecord } from './idempotency-repository.ts';

export const IDEMPOTENCY_KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;

const FIELD = 'response_body_enc';

/** Create operations that take an `Idempotency-Key` (contract parameter `IdempotencyKey`). */
export type IdempotentRoute = 'createAchievement' | 'createQuest' | 'placeGamble' | 'createCheckIn';

/** A create request as its `Idempotency-Key` names it: the key and a digest of everything the request asks for. */
export interface IdempotentRequest {
  readonly route: IdempotentRoute;
  readonly key: string;
  readonly requestHash: Buffer;
}

/** A successful response as it was sent; failures are never stored (Q-39). */
export interface StoredResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export type IdempotentOutcome =
  { readonly outcome: 'executed' | 'replayed'; readonly response: StoredResponse } | { readonly outcome: 'key_reused' };

/**
 * Runs a create request at most once per user, route and key for 24 hours (ADR-0008, Q-39). It runs inside the
 * request's own transaction, so the record commits together with the effect or not at all: a duplicate waits for
 * the first request and then replays its response, the same key for another request is refused, and a request that
 * failed left nothing behind, so its retry runs again. The response is encrypted with the user's data key.
 */
export async function runIdempotent(
  tx: Transaction,
  dataKey: Uint8Array,
  userId: string,
  request: IdempotentRequest,
  now: Date,
  work: () => Promise<StoredResponse>,
): Promise<IdempotentOutcome> {
  await lockIdempotencyKey(tx, userId, request.route, request.key);
  const stored = await findLiveIdempotencyRecord(tx, userId, request.route, request.key, now);
  if (stored !== undefined) {
    if (!stored.requestHash.equals(request.requestHash)) return { outcome: 'key_reused' };
    const content = decryptText(dataKey, { userId, recordId: stored.id, field: FIELD }, stored.responseBodyEnc);
    const { headers, body } = JSON.parse(content) as Pick<StoredResponse, 'headers' | 'body'>;
    return { outcome: 'replayed', response: { status: stored.responseStatus, headers, body } };
  }
  const response = await work();
  const id = randomUUID();
  await saveIdempotencyRecord(tx, {
    id,
    userId,
    route: request.route,
    key: request.key,
    requestHash: request.requestHash,
    responseStatus: response.status,
    responseBodyEnc: encryptText(
      dataKey,
      { userId, recordId: id, field: FIELD },
      JSON.stringify({ headers: response.headers, body: response.body }),
    ),
    createdAt: now,
    expiresAt: new Date(now.getTime() + IDEMPOTENCY_KEY_LIFETIME_MS),
  });
  return { outcome: 'executed', response };
}
