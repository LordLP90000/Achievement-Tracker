import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { decodeCursor, encodeCursor, pageOf, pageParams, type PagePosition } from './pagination.ts';
import { parseRequest, ProblemError } from './validation.ts';

/** The contract's `Cursor` pattern `^[A-Za-z0-9_-]{1,200}$`. */
const CONTRACT_CURSOR = /^[\w-]{1,200}$/;
const T0 = new Date('2026-10-29T12:00:00.000Z');
const ID = '0b4c1f7e-2f57-4e7a-9c1d-3a5b6c7d8e9f';

const positions = fc.record({
  createdAt: fc.date({
    min: new Date('2000-01-01T00:00:00.000Z'),
    max: new Date('2199-12-31T23:59:59.999Z'),
    noInvalidDate: true,
  }),
  id: fc.uuid({ version: 4 }),
});

const base64url = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
const query = z.object(pageParams);

function problemOf(value: unknown) {
  try {
    parseRequest(query, value);
  } catch (error) {
    if (error instanceof ProblemError) return error.problem;
    throw error;
  }
  throw new Error('expected a validation problem');
}

describe('cursor pagination [R-IN-01, architecture §3]', () => {
  it('encodes a position as an opaque cursor within the contract pattern and decodes it back', () => {
    const cursor = encodeCursor({ createdAt: T0, id: ID });

    expect(cursor).toMatch(CONTRACT_CURSOR);
    expect(cursor).not.toContain(ID);
    expect(decodeCursor(cursor)).toEqual({ createdAt: T0, id: ID });
  });

  it('round-trips every position, always within the contract pattern', () => {
    fc.assert(
      fc.property(positions, (position: PagePosition) => {
        const cursor = encodeCursor(position);
        expect(cursor).toMatch(CONTRACT_CURSOR);
        expect(decodeCursor(cursor)).toEqual(position);
      }),
    );
  });

  it.each([
    ['not base64-encoded JSON', 'abc'],
    ['JSON that is not an object', base64url('[1,2]')],
    ['null', base64url('null')],
    ['a missing ID', base64url(JSON.stringify({ t: T0.toISOString() }))],
    ['a missing instant', base64url(JSON.stringify({ i: ID }))],
    ['an extra property', base64url(JSON.stringify({ t: T0.toISOString(), i: ID, u: 'other-user' }))],
    ['an instant without milliseconds', base64url(JSON.stringify({ t: '2026-10-29T12:00:00Z', i: ID }))],
    ['an instant with an offset', base64url(JSON.stringify({ t: '2026-10-29T13:00:00.000+01:00', i: ID }))],
    ['an impossible date', base64url(JSON.stringify({ t: '2026-02-30T00:00:00.000Z', i: ID }))],
    ['a number as instant', base64url(JSON.stringify({ t: T0.getTime(), i: ID }))],
    ['an upper-case ID', base64url(JSON.stringify({ t: T0.toISOString(), i: ID.toUpperCase() }))],
    ['a non-v4 ID', base64url(JSON.stringify({ t: T0.toISOString(), i: '0b4c1f7e-2f57-1e7a-9c1d-3a5b6c7d8e9f' }))],
    ['an ID with SQL in it', base64url(JSON.stringify({ t: T0.toISOString(), i: "' or 1=1 --" }))],
  ])('decodes nothing from a cursor with %s', (_case, cursor) => {
    expect(decodeCursor(cursor)).toBeNull();
  });

  it('never throws on arbitrary input, only answers null or a valid position', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json().map(base64url)), (cursor) => {
        const position = decodeCursor(cursor);
        if (position !== null) expect(encodeCursor(position)).toMatch(CONTRACT_CURSOR);
      }),
    );
  });

  it('reads the first page of 20 when neither cursor nor limit is given', () => {
    expect(parseRequest(query, {})).toEqual({ limit: 20 });
  });

  it.each([
    ['1', 1],
    ['20', 20],
    ['100', 100],
  ])('reads limit=%s as %i', (limit, expected) => {
    expect(parseRequest(query, { limit })).toEqual({ limit: expected });
  });

  it.each(['0', '101', '-1', '1.5', '1e1', ' 5', '', 'abc', '007', '1000'])(
    'refuses limit=%j with a 400 pointing at the parameter',
    (limit) => {
      expect(problemOf({ limit })).toMatchObject({ status: 400, errors: [{ pointer: '/limit' }] });
    },
  );

  it('refuses a repeated limit parameter', () => {
    expect(problemOf({ limit: ['1', '2'] })).toMatchObject({ status: 400, errors: [{ pointer: '/limit' }] });
  });

  it('turns a valid cursor into the position it names', () => {
    expect(parseRequest(query, { cursor: encodeCursor({ createdAt: T0, id: ID }), limit: '5' })).toEqual({
      cursor: { createdAt: T0, id: ID },
      limit: 5,
    });
  });

  it.each([
    ['padding', `${encodeCursor({ createdAt: T0, id: ID })}=`],
    ['standard base64 characters', 'ab+/cd'],
    ['more than 200 characters', 'a'.repeat(201)],
    ['nothing', ''],
    ['a forged position', base64url(JSON.stringify({ t: 'yesterday', i: ID }))],
  ])('refuses a cursor with %s with a 400 pointing at the parameter', (_case, cursor) => {
    expect(problemOf({ cursor })).toMatchObject({ status: 400, errors: [{ pointer: '/cursor' }] });
  });

  it('never echoes a refused cursor (static messages only)', () => {
    const forged = base64url(JSON.stringify({ t: 'yesterday', i: "<script>alert('x')</script>" }));

    expect(JSON.stringify(problemOf({ cursor: forged }))).not.toContain(forged.slice(0, 12));
  });

  describe('a page of rows fetched with one extra row', () => {
    const rows = Array.from({ length: 4 }, (_, index) => ({
      createdAt: new Date(T0.getTime() - index * 1000),
      id: `0b4c1f7e-2f57-4e7a-9c1d-3a5b6c7d8e9${String(index)}`,
    }));

    it('has no next page when the extra row is missing', () => {
      expect(pageOf(rows.slice(0, 2), 3, (row) => row)).toEqual({ items: rows.slice(0, 2), nextCursor: null });
      expect(pageOf(rows.slice(0, 3), 3, (row) => row)).toEqual({ items: rows.slice(0, 3), nextCursor: null });
      expect(pageOf([], 3, (row) => row)).toEqual({ items: [], nextCursor: null });
    });

    it('drops the extra row and continues after the last row it returns', () => {
      const page = pageOf(rows, 3, (row) => row);

      expect(page.items).toEqual(rows.slice(0, 3));
      expect(page.nextCursor === null ? null : decodeCursor(page.nextCursor)).toEqual(rows[2]);
    });
  });
});
