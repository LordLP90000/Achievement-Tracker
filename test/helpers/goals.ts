import { randomBytes, randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import type { AccountsApp } from './accounts-app.ts';

/** Shared steps of the goal-content suites (achievements, quests, check-ins, gambles). */

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export interface GoalUser {
  readonly userId: string;
  readonly token: string;
}

/** A verified, logged-in account; with the goal-content consent (R-PRIV-04) unless `consent: false`. */
export async function goalUser(ctx: AccountsApp, options: { readonly consent?: boolean } = {}): Promise<GoalUser> {
  const account = await ctx.account();
  const login = await ctx.post('/v1/auth/login', { email: account.email, password: account.password, client: 'ios' });
  if (login.statusCode !== 200) throw new Error(`login failed: ${String(login.statusCode)}`);
  const token = login.json<{ access_token: string }>().access_token;
  if (options.consent !== false) {
    const granted = await ctx.post('/v1/me/consents', { type: 'goal_content', version: '2026-10-01' }, bearer(token));
    if (granted.statusCode !== 201) throw new Error(`consent failed: ${String(granted.statusCode)}`);
  }
  return { userId: account.userId, token };
}

/** `POST /v1/achievements` with a fresh `Idempotency-Key` unless one is given. */
export function createAchievement(
  ctx: AccountsApp,
  token: string,
  body: unknown,
  key: string = randomUUID(),
): Promise<LightMyRequestResponse> {
  return ctx.post('/v1/achievements', body, { ...bearer(token), 'idempotency-key': key });
}

/**
 * Inserts `count` achievements directly, as earlier requests or later milestones would have left them; the title is
 * random bytes, so only tests that never read it may use these rows.
 */
export async function insertAchievements(
  ctx: AccountsApp,
  userId: string,
  count: number,
  status: 'active' | 'paused' | 'completed',
): Promise<void> {
  const now = ctx.clock.now();
  if (status === 'completed') {
    await ctx.admin.sql`
      insert into achievements
        (id, user_id, title_enc, status, dek_version, created_at, updated_at, completed_at, execution_score, rank)
      select gen_random_uuid(), ${userId}, ${randomBytes(48)}, 'completed', 1, ${now}, ${now}, ${now}, 80, 'gold'
      from generate_series(1, ${count})`;
    return;
  }
  await ctx.admin.sql`
    insert into achievements (id, user_id, title_enc, status, dek_version, created_at, updated_at)
    select gen_random_uuid(), ${userId}, ${randomBytes(48)}, ${status}, 1, ${now}, ${now}
    from generate_series(1, ${count})`;
}
