import { describe, expect, it } from 'vitest';
import { sharedAnswer } from './shared-answer.ts';

/** A check whose answers the test hands out one by one, and a clock the test moves. */
function harness<T>(reuseMs: number) {
  let time = 1000;
  const pending: { resolve: (answer: T) => void; reject: (error: Error) => void }[] = [];
  const check = (): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  let started = 0;
  const ask = sharedAnswer(
    () => {
      started += 1;
      return check();
    },
    reuseMs,
    () => time,
  );
  return {
    ask,
    started: () => started,
    advance: (ms: number) => {
      time += ms;
    },
    answer: (value: T) => {
      pending.shift()?.resolve(value);
    },
    fail: (error: Error) => {
      pending.shift()?.reject(error);
    },
  };
}

describe('sharedAnswer [D-10]', () => {
  it('runs one check for everyone who asks while it runs', async () => {
    const probe = harness<boolean>(1000);
    const callers = [probe.ask(), probe.ask(), probe.ask()];
    expect(probe.started()).toBe(1);

    probe.answer(true);

    await expect(Promise.all(callers)).resolves.toEqual([true, true, true]);
    expect(probe.started()).toBe(1);
  });

  it('gives the last answer until it is `reuseMs` old, then checks again', async () => {
    const probe = harness<string>(1000);
    const first = probe.ask();
    probe.answer('first');
    await expect(first).resolves.toBe('first');

    probe.advance(999);
    await expect(probe.ask()).resolves.toBe('first');
    expect(probe.started()).toBe(1);

    probe.advance(1);
    const second = probe.ask();
    expect(probe.started()).toBe(2);
    probe.answer('second');
    await expect(second).resolves.toBe('second');
  });

  it('counts the age of an answer from the end of its check, so a slow check is not repeated at once', async () => {
    const probe = harness<boolean>(1000);
    const first = probe.ask();
    probe.advance(5000);
    probe.answer(false);
    await expect(first).resolves.toBe(false);

    probe.advance(999);
    await expect(probe.ask()).resolves.toBe(false);
    expect(probe.started()).toBe(1);
  });

  it('never runs two checks at once, however long the first one takes', async () => {
    const probe = harness<boolean>(1000);
    const first = probe.ask();
    probe.advance(60_000);
    const second = probe.ask();
    expect(probe.started()).toBe(1);

    probe.answer(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it('keeps no answer when the check fails: every waiting caller gets the error, the next caller a new check', async () => {
    const probe = harness<boolean>(1000);
    const callers = [probe.ask(), probe.ask()];
    probe.fail(new Error('down'));
    for (const caller of callers) await expect(caller).rejects.toThrow('down');

    const next = probe.ask();
    expect(probe.started()).toBe(2);
    probe.answer(true);
    await expect(next).resolves.toBe(true);
  });

  it('recovers from a check that throws before it returns a promise', async () => {
    let started = 0;
    const ask = sharedAnswer(
      () => {
        started += 1;
        if (started === 1) throw new Error('broken');
        return Promise.resolve('fine');
      },
      1000,
      () => 0,
    );

    await expect(ask()).rejects.toThrow('broken');
    await expect(ask()).resolves.toBe('fine');
    expect(started).toBe(2);
  });

  it('with no reuse still shares a running check and then checks again', async () => {
    const probe = harness<number>(0);
    const callers = [probe.ask(), probe.ask()];
    probe.answer(1);
    await expect(Promise.all(callers)).resolves.toEqual([1, 1]);

    const next = probe.ask();
    expect(probe.started()).toBe(2);
    probe.answer(2);
    await expect(next).resolves.toBe(2);
  });
});
