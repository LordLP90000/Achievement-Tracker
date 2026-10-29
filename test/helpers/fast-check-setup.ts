import fc from 'fast-check';

/**
 * Property tests are deterministic (test strategy §1): every run explores the same cases, and a failure prints the
 * seed and the shrunk counterexample, so it can be replayed.
 */
fc.configureGlobal({ seed: 20_261_029 });
