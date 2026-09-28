/**
 * `batch()` defers the writes inside its function by raising the notification depth, the
 * same way a write inside a subscriber is deferred. Beyond the order
 * (notification-order.test.ts), this is what that must keep: the depth comes back however a
 * batch ends, and a subscriber that runs inside the batch's function (its first call on
 * `subscribe`) has its writes deferred to the batch's flush. Each test also passes on the
 * setter that tested a separate batch counter.
 */
import { describe, expect, test } from 'bun:test';
import { batch, signal } from './signal.js';

describe('batch and the notification depth', () => {
  test('after a batch, a write notifies at once', () => {
    const log: string[] = [];
    const a = signal(0);
    a.subscribe((v) => log.push(`a:${v}`), true);
    batch(() => a(1));
    a(2);
    log.push('after the write');
    expect(log).toEqual(['a:1', 'a:2', 'after the write']);
  });

  test('after a batch whose function throws, a write notifies at once', () => {
    const log: string[] = [];
    const a = signal(0);
    a.subscribe((v) => log.push(`a:${v}`), true);
    expect(() =>
      batch(() => {
        a(1);
        throw new Error('fn');
      }),
    ).toThrow('fn');
    a(2);
    log.push('after the write');
    expect(log).toEqual(['a:1', 'a:2', 'after the write']);
  });

  test('after nested batches whose inner function throws, a write notifies at once', () => {
    const log: string[] = [];
    const a = signal(0);
    const b = signal(0);
    a.subscribe((v) => log.push(`a:${v}`), true);
    b.subscribe((v) => log.push(`b:${v}`), true);
    batch(() => {
      a(1);
      try {
        batch(() => {
          b(1);
          throw new Error('inner');
        });
      } catch {
        log.push('caught inner');
      }
    });
    b(2);
    log.push('after the write');
    expect(log).toEqual(['caught inner', 'a:1', 'b:1', 'b:2', 'after the write']);
  });

  test("a subscriber's first call inside a batch: its writes wait for the batch to end", () => {
    const log: string[] = [];
    const a = signal(0);
    const b = signal(0);
    b.subscribe((v) => log.push(`b:${v}`), true);
    batch(() => {
      a.subscribe((v) => {
        log.push(`a first call:${v}`);
        b(v + 1);
      });
      log.push('fn end');
    });
    log.push('after the batch');
    expect(log).toEqual(['a first call:0', 'fn end', 'b:1', 'after the batch']);
  });

  test("a batch that throws inside a subscriber: the subscriber's later writes still wait for its notification", () => {
    const log: string[] = [];
    const a = signal(0);
    const b = signal(0);
    const c = signal(0);
    a.subscribe((v) => {
      try {
        batch(() => {
          b(v);
          throw new Error('fn');
        });
      } catch {
        log.push('caught');
      }
      c(v);
      log.push('a1 end');
    }, true);
    a.subscribe(() => log.push('a2'), true);
    b.subscribe((v) => log.push(`b:${v}`), true);
    c.subscribe((v) => log.push(`c:${v}`), true);
    a(1);
    log.push('done');
    // the batch flushes b before it re-throws; c waits for a's notification to end
    expect(log).toEqual(['b:1', 'caught', 'a1 end', 'a2', 'c:1', 'done']);
  });
});
