/**
 * Signal defects confirmed on e4a17f1 (framework analysis/simplification.md §1.8, R1 and R2).
 *
 * Each test asserts the correct behaviour and stays `test.todo` until RT-3 fixes it and turns it into
 * `test`. `bun test --todo src/runtime/hardening.test.ts` runs them: a todo that passes is reported as a
 * failure ("Remove `.todo`"), which means it has been fixed. The compile-time defects are in
 * src/compiler/hardening.test.ts, the runtime ones in e2e/tests/hardening.spec.ts.
 */
import { describe, expect, test } from 'bun:test';
import { computed, effect, signal } from './signal.js';

/** Live subscribers of a signal: its subscriber slots minus the unsubscribed (null) ones. */
const liveSubscribers = (sig: unknown): number => (sig as { _s: unknown[] })._s.filter((cb) => cb != null).length;

describe('F0-3 signal defects (turned on by RT-3)', () => {
  test('RT-3 R1 an effect that disposes itself during a run keeps no subscription', () => {
    const source = signal(0);
    let runs = 0;
    let stop: () => void = () => {};
    stop = effect(() => {
      runs++;
      if (source() > 0) stop();
    });
    expect(liveSubscribers(source)).toBe(1);

    source(1); // this run disposes the effect
    expect(liveSubscribers(source)).toBe(0);
    source(2);
    expect(runs).toBe(2);
    expect(liveSubscribers(source)).toBe(0);
  });

  test('RT-3 R2 a computed disposed inside its own derivation keeps no subscription on its dependency', () => {
    const source = signal(0);
    let derived: ReturnType<typeof computed<number>> | undefined;
    derived = computed(() => {
      const value = source();
      if (value > 0) derived?.dispose();
      return value;
    });
    derived.subscribe(() => {}, true);
    expect(liveSubscribers(source)).toBe(1);

    source(1); // this evaluation disposes the computed
    expect(liveSubscribers(source)).toBe(0);
  });
});
