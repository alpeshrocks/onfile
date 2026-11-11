import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One clock for all business logic. In production it is the wall clock. Tests and the demo
 * seeder run code "at" another moment with withClock(), so time-dependent behaviour
 * (reminder schedules, expiry, the audit chain's timestamps) is exercised through the real
 * code path with no sleeping and no rewriting of stored rows.
 */
const store = new AsyncLocalStorage<{ at: number }>();

export function now(): Date {
  const frozen = store.getStore();
  return new Date(frozen ? frozen.at : Date.now());
}

export function withClock<T>(at: Date, fn: () => Promise<T>): Promise<T> {
  return store.run({ at: at.getTime() }, fn);
}
