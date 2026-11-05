/* global __ENV, __VU, open, crypto */
// Load and limit test (M6, Q-58; A-31, R-AUTH-08, D-01), run with k6 by `npm run test:load` (test/perf/run.ts)
// inside the Compose network against the local stack. The accounts come from the runner: verified, signed in.
import { check, sleep } from 'k6';
import http from 'k6/http';
import { Counter, Gauge } from 'k6/metrics';

const BASE = `${__ENV.BASE_URL}/v1`;
/** `{ load: [{ token }], burst: { token }, backoff: { email }, targetDate }` */
const accounts = JSON.parse(open('/data/accounts.json'));

const serverErrors = new Counter('server_errors');
const missingRetryAfter = new Counter('missing_retry_after');
const limitExceeded = new Counter('limit_exceeded');
const limitNotEnforced = new Counter('limit_not_enforced');
const backoffWrong = new Counter('backoff_wrong');
// What the bursts and the backoff saw, for the summary.
const perUser = { answered: new Gauge('per_user_answered'), bound: new Gauge('per_user_bound') };
const perClient = { answered: new Gauge('per_client_answered'), bound: new Gauge('per_client_bound') };
const backoffRetryAfter = new Gauge('backoff_retry_after_seconds');

// A-31, as in src/modules/rate-limit/limiter.ts.
const AUTH_PER_CLIENT = { capacity: 20, perSecond: 20 / 60 };
const PER_USER = { capacity: 120, perSecond: 120 / 60 };
const FREE_FAILURES = 5;
const FIRST_BLOCK_SECONDS = 60;

export const options = {
  batch: 200,
  batchPerHost: 200,
  scenarios: {
    load: { executor: 'constant-vus', exec: 'load', vus: accounts.load.length, duration: '60s' },
    userBurst: { executor: 'shared-iterations', exec: 'userBurst', vus: 1, iterations: 1, startTime: '10s' },
    clientBurst: { executor: 'shared-iterations', exec: 'clientBurst', vus: 1, iterations: 1, startTime: '10s' },
    // After the client burst's bucket has filled again (20 per minute): the backoff needs 8 of its requests.
    backoff: { executor: 'shared-iterations', exec: 'backoff', vus: 1, iterations: 1, startTime: '80s' },
  },
  thresholds: {
    'http_req_duration{scenario:load}': ['p(95)<500', 'p(99)<1500'],
    'http_req_failed{scenario:load}': ['rate==0'],
    server_errors: ['count==0'],
    missing_retry_after: ['count==0'],
    limit_exceeded: ['count==0'],
    limit_not_enforced: ['count==0'],
    backoff_wrong: ['count==0'],
  },
};

const headers = (token) => ({
  'content-type': 'application/json',
  ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
});

/** Every answer: no server error, and every 429 says when to come back. */
function track(responses) {
  for (const response of responses) {
    if (response.status === 0 || response.status >= 500) serverErrors.add(1);
    if (response.status === 429 && !(Number(response.headers['Retry-After']) > 0)) missingRetryAfter.add(1);
  }
}

/** A burst against one token bucket: at most its capacity plus what refilled meanwhile is answered, the rest is 429. */
function burst(name, requests, bucket, seen) {
  const started = Date.now();
  const responses = http.batch(requests);
  const seconds = (Date.now() - started) / 1000;
  track(responses);
  const answered = responses.filter((response) => response.status !== 429).length;
  const bound = bucket.capacity + Math.ceil(seconds * bucket.perSecond);
  if (answered > bound) limitExceeded.add(1, { burst: name });
  if (answered === responses.length) limitNotEnforced.add(1, { burst: name });
  seen.answered.add(answered);
  seen.bound.add(bound);
}

/** Ordinary use by signed-in users, each well within 120 requests a minute. */
export function load() {
  const { token } = accounts.load[(__VU - 1) % accounts.load.length];
  const create = { headers: { ...headers(token), 'idempotency-key': crypto.randomUUID() } };
  const achievement = JSON.stringify({ title: 'Load test', target_date: accounts.targetDate });
  const responses = [
    http.get(`${BASE}/me`, { headers: headers(token) }),
    http.get(`${BASE}/me/stats`, { headers: headers(token) }),
    http.get(`${BASE}/achievements`, { headers: headers(token) }),
    http.post(`${BASE}/achievements`, achievement, create),
  ];
  track(responses);
  check(responses, {
    'load: every request answered as asked': (all) => all.every((r) => r.status === 200 || r.status === 201),
  });
  sleep(3);
}

/** One user: 150 requests at once against 120 a minute. */
export function userBurst() {
  const params = { headers: headers(accounts.burst.token) };
  burst(
    'per user',
    Array.from({ length: 150 }, () => ['GET', `${BASE}/me`, null, params]),
    PER_USER,
    perUser,
  );
}

/** One client: 40 sign-ins at once, each for another unknown address, against 20 a minute. */
export function clientBurst() {
  const params = { headers: headers() };
  const signIn = () => {
    const email = `nobody-${crypto.randomUUID()}@example.test`;
    const body = JSON.stringify({ email, password: 'not the password at all', client: 'ios' });
    return ['POST', `${BASE}/auth/login`, body, params];
  };
  burst('per client', Array.from({ length: 40 }, signIn), AUTH_PER_CLIENT, perClient);
}

/** One address: the five free wrong passwords, and the sixth that starts the block, are answered; then 429. */
export function backoff() {
  const body = JSON.stringify({ email: accounts.backoff.email, password: 'a wrong password, again', client: 'ios' });
  const responses = Array.from({ length: FREE_FAILURES + 3 }, () =>
    http.post(`${BASE}/auth/login`, body, { headers: headers() }),
  );
  track(responses);
  const statuses = responses.map((response) => response.status);
  const wait = Number(responses[FREE_FAILURES + 1].headers['Retry-After']);
  const expected = [...Array(FREE_FAILURES + 1).fill(401), 429, 429];
  const ok = check(statuses, {
    'backoff: six wrong passwords answered, then blocked': (all) => all.join() === expected.join(),
    'backoff: blocked for at most the first block': () => wait > 0 && wait <= FIRST_BLOCK_SECONDS,
  });
  if (!ok) backoffWrong.add(1);
  backoffRetryAfter.add(wait);
}
