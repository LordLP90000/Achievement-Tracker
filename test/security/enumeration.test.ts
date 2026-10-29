import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';

const json = { 'content-type': 'application/json' };

/** Everything a client can observe except the clock: status, headers without `date`, body. */
function observable(response: LightMyRequestResponse) {
  const headers = Object.fromEntries(Object.entries(response.headers).filter(([name]) => name !== 'date'));
  return { status: response.statusCode, headers, body: response.body };
}

describe('no account enumeration [R-AUTH-07, S-02]', () => {
  let ctx: AccountsApp;

  const email = () => `enum-${randomUUID().slice(0, 8)}@example.test`;
  const post = (url: string, body: unknown) =>
    contractInject(ctx.app, { method: 'POST', url, headers: json, payload: JSON.stringify(body) });
  const register = (address: string, password = 'correct horse battery staple') =>
    post('/v1/auth/register', { email: address, password, privacy_policy_version: '2026-10-01', age_confirmed: true });
  const verifiedAccount = async () => {
    const address = email();
    await register(address);
    const token = (await ctx.emails()).find((queued) => queued.payload.to === address)?.payload.token ?? '';
    expect((await post('/v1/auth/verify-email', { token })).statusCode).toBe(204);
    return address;
  };
  const deactivatedAccount = async () => {
    const address = await verifiedAccount();
    await ctx.admin.sql`update users set deactivated_at = ${ctx.clock.now()}
      where email_blind_index = ${ctx.blindIndex(address)}`;
    return address;
  };
  const emailsTo = async (address: string) =>
    (await ctx.emails()).filter((queued) => queued.payload.to === address).length;

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('answers a registration identically for a new, an existing and a deactivated address, hashing once each', async () => {
    const existing = await verifiedAccount();
    const deactivated = await deactivatedAccount();
    const fresh = email();
    const answers = [];
    const hashes = [];

    for (const address of [fresh, existing, deactivated]) {
      const before = ctx.hashCount();
      answers.push(observable(await register(address)));
      hashes.push(ctx.hashCount() - before);
    }

    expect(answers[0]).toMatchObject({ status: 202 });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect(hashes).toEqual([1, 1, 1]);
  });

  it('answers a breached password identically for a new and an existing address, without hashing', async () => {
    const existing = await verifiedAccount();
    const before = ctx.hashCount();

    const answers = [
      observable(await register(email(), 'password1234')),
      observable(await register(existing, 'password1234')),
    ];

    expect(answers[0]).toMatchObject({ status: 422 });
    expect({ ...answers[1], body: undefined }).toEqual({ ...answers[0], body: undefined });
    expect(JSON.parse(answers[1]?.body ?? '')).toEqual({
      ...JSON.parse(answers[0]?.body ?? '{}'),
      request_id: expect.any(String) as unknown,
    });
    expect(ctx.hashCount()).toBe(before);
  });

  it('gives a registered address exactly one email per registration, like a new one', async () => {
    const existing = await verifiedAccount();
    const fresh = email();
    const before = await emailsTo(existing);

    await register(fresh);
    await register(existing);

    expect(await emailsTo(fresh)).toBe(1);
    expect((await emailsTo(existing)) - before).toBe(1);
  });

  it('answers a resend identically for an unknown, an unverified, a verified and a deactivated address', async () => {
    const unverified = email();
    await register(unverified);
    const addresses = [email(), unverified, await verifiedAccount(), await deactivatedAccount()];

    const answers = [];
    for (const address of addresses)
      answers.push(observable(await post('/v1/auth/resend-verification', { email: address })));

    expect(answers[0]).toMatchObject({ status: 202 });
    for (const answer of answers.slice(1)) expect(answer).toEqual(answers[0]);
  });

  it('answers a password-reset request identically for an unknown, an unverified, a verified and a deactivated address', async () => {
    const unverified = email();
    await register(unverified);
    const addresses = [email(), unverified, await verifiedAccount(), await deactivatedAccount()];

    const answers = [];
    for (const address of addresses)
      answers.push(observable(await post('/v1/auth/password/forgot', { email: address })));

    expect(answers[0]).toMatchObject({ status: 202 });
    for (const answer of answers.slice(1)) expect(answer).toEqual(answers[0]);
  });

  it('answers a failed login identically for an unknown address, a wrong password and an unverified account, verifying once each [I-05]', async () => {
    const verified = await verifiedAccount();
    const unverified = email();
    await register(unverified);
    const attempts = [email(), verified, unverified];

    const answers = [];
    const verifications = [];
    for (const address of attempts) {
      const before = ctx.verifyCount();
      const response = await post('/v1/auth/login', {
        email: address,
        password: 'wrong but long enough',
        client: 'ios',
      });
      verifications.push(ctx.verifyCount() - before);
      const body = { ...response.json<Record<string, unknown>>(), request_id: undefined };
      answers.push({ ...observable(response), body });
    }

    expect(answers[0]).toMatchObject({ status: 401, body: { type: 'urn:questline:problem:invalid-credentials' } });
    for (const answer of answers.slice(1)) expect(answer).toEqual(answers[0]);
    expect(verifications).toEqual([1, 1, 1]);
  });
});
