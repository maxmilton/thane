/**
 * Characterisation of signal notification order (F0-2 item 10, before RT-2 and A2-2).
 *
 * Each test logs subscriber calls and pins the exact order observed on e4a17f1. The runtime's
 * rules, as they show up here:
 * - A setter at rest notifies synchronously. A setter inside a notification (or a batch) only
 *   records the signal in a pending set; the outermost notification drains that set after its
 *   own subscribers have run.
 * - Each signal the drain notifies starts at depth 0 again, so it drains its own cascades
 *   recursively before the drain moves on. A signal that is re-set by an earlier entry of the
 *   same drain is therefore notified twice.
 * - `batch` drains once when the outermost batch ends. A batch that ends inside a subscriber
 *   drains in that moment, at depth > 0, so the cascades it causes wait for the outer drain.
 * - A computed is dirty-marked when a source notifies, and notifies its own subscribers from a
 *   queue that runs when the outermost notification ends. Read before its source has notified
 *   (inside a cascade or a batch), it returns its previous value.
 *
 * Throwing subscribers are re-thrown through queueMicrotask; the tests capture those.
 */
import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { batch, computed, signal } from './signal.js';

/** Run `fn` with queueMicrotask captured, and return the errors it would have re-thrown. */
const captureRethrown = (fn: () => void): string[] => {
  const original = globalThis.queueMicrotask;
  const queued: Array<() => void> = [];
  globalThis.queueMicrotask = (cb: () => void) => void queued.push(cb);
  try {
    fn();
  } finally {
    globalThis.queueMicrotask = original;
  }
  const errors: string[] = [];
  for (const cb of queued) {
    try {
      cb();
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return errors;
};

describe('cascades', () => {
  test("a subscriber's write is notified after every subscriber of the outer signal", () => {
    const log: string[] = [];
    const a = signal(0);
    const b = signal(0);
    const c = signal(0);
    a.subscribe((v) => {
      log.push(`a1:${v}`);
      b(v * 10);
      log.push(`a1 set b, b()=${b()}`);
    }, true);
    a.subscribe((v) => {
      log.push(`a2:${v} b()=${b()}`);
      c(v * 100);
    }, true);
    a.subscribe((v) => log.push(`a3:${v}`), true);
    b.subscribe((v) => {
      log.push(`b1:${v}`);
      c(v + 1);
    }, true);
    b.subscribe((v) => log.push(`b2:${v}`), true);
    c.subscribe((v) => log.push(`c1:${v}`), true);

    a(1);
    log.push('done');

    expect(log).toEqual([
      'a1:1',
      // the value is written at once; only the notification waits
      'a1 set b, b()=10',
      'a2:1 b()=10',
      'a3:1',
      // drain, in the order the signals were first set: b, then c
      'b1:10',
      'b2:10',
      // b's own cascade (c = 11) is drained before the outer drain reaches c
      'c1:11',
      // c was also in the outer drain's snapshot, so it is notified again; it never sees 100
      'c1:11',
      'done',
    ]);
  });

  test('a diamond of plain signals: the join is notified per changed input value', () => {
    const log: string[] = [];
    const a = signal(0);
    const b = signal(0);
    const c = signal(0);
    const d = signal(0);
    a.subscribe((v) => b(v + 1), true);
    a.subscribe((v) => c(v * 2), true);
    b.subscribe((v) => {
      log.push(`b:${v} c()=${c()}`);
      d(v + c());
    }, true);
    c.subscribe((v) => {
      log.push(`c:${v} b()=${b()}`);
      d(b() + v);
    }, true);
    d.subscribe((v) => log.push(`d:${v}`), true);

    a(1);

    // b's subscriber already sees c's new value; c's write to d is the same value, so d is quiet
    expect(log).toEqual(['b:2 c()=2', 'd:4', 'c:2 b()=2']);
  });

  test('a signal set twice in one cascade is notified once, with the last value', () => {
    const log: string[] = [];
    const a = signal(0);
    const b = signal(0);
    a.subscribe((v) => {
      b(v + 1);
      b(v + 2);
      log.push(`a1 b()=${b()}`);
    }, true);
    a.subscribe((v) => {
      b(v + 3);
      log.push(`a2 b()=${b()}`);
    }, true);
    b.subscribe((v) => log.push(`b:${v}`), true);

    a(1);

    expect(log).toEqual(['a1 b()=3', 'a2 b()=4', 'b:4']);
  });

  test('a signal re-set by an earlier entry of the drain is notified twice with the same value', () => {
    const log: string[] = [];
    const a = signal(0);
    const b = signal(0);
    const c = signal(0);
    a.subscribe((v) => {
      b(v);
      c(v);
    }, true);
    b.subscribe((v) => {
      log.push(`b:${v}`);
      c(v + 100);
    }, true);
    c.subscribe((v) => log.push(`c:${v}`), true);

    a(1);

    expect(log).toEqual(['b:1', 'c:101', 'c:101']);
  });
});

describe('circular dependencies', () => {
  test('a pair that settles after 200 rounds runs to the end: the 100-pass cap is not reached', () => {
    const a = signal(0);
    const b = signal(0);
    const seen: string[] = [];
    a.subscribe((v) => {
      seen.push(`a${v}`);
      if (v < 200) b(v + 1);
    }, true);
    b.subscribe((v) => {
      seen.push(`b${v}`);
      if (v < 200) a(v + 1);
    }, true);

    // Each drained signal drains its own cascade recursively, so the pending set is empty after
    // every pass of the capped loop; "Circular signal dependency" is not thrown
    expect(() => a(1)).not.toThrow();
    expect(seen.length).toBe(200);
    expect(seen.slice(0, 4)).toEqual(['a1', 'b2', 'a3', 'b4']);
    expect(seen.at(-1)).toBe('b200');
    expect([a(), b()]).toEqual([199, 200]);
  });

  test('a computed over a settling pair is notified once, with the final value', () => {
    const log: string[] = [];
    const a = signal(0);
    const b = signal(0);
    const ca = computed(() => a() * 10);
    ca.subscribe((v) => log.push(`ca:${v}`), true);
    a.subscribe((v) => {
      if (v < 7) b(v + 1);
      if (v === 3) log.push(`a=3 ca()=${ca()}`);
    }, true);
    b.subscribe((v) => {
      log.push(`b:${v}`);
      if (v < 7) a(v + 1);
    }, true);

    a(1);
    log.push('done');

    // ca was dirty-marked by a's notification before a's second subscriber read it
    expect(log).toEqual(['b:2', 'a=3 ca()=30', 'b:4', 'b:6', 'ca:70', 'done']);
  });

  // Runs in a child process: the overflow unwinds through the runtime's module state, which bun
  // shares between test files, and where the stack runs out decides what is left behind.
  test('a pair that never settles overflows the stack; "Circular signal dependency" is never thrown', () => {
    const signalUrl = pathToFileURL(join(dirname(import.meta.path), 'signal.ts')).href;
    const script = `
      const { signal } = await import(${JSON.stringify(signalUrl)});
      const a = signal(0), b = signal(0);
      let calls = 0;
      a.subscribe((v) => { calls++; b(v + 1); }, true);
      b.subscribe((v) => { calls++; a(v + 1); }, true);
      const queued = [];
      globalThis.queueMicrotask = (cb) => void queued.push(cb);
      const errors = [];
      try { a(1); } catch (e) { errors.push({ name: e.name, message: e.message, sync: true }); }
      for (const cb of queued) { try { cb(); } catch (e) { errors.push({ name: e.name, message: e.message, sync: false }); } }
      console.log(JSON.stringify({ calls, errors: errors.slice(0, 5) }));
    `;
    const run = Bun.spawnSync([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const out = run.stdout.toString().trim().split('\n').at(-1) ?? '';
    const { calls, errors } = JSON.parse(out) as {
      calls: number;
      errors: Array<{ name: string; message: string; sync: boolean }>;
    };

    expect(calls).toBeGreaterThan(1000);
    expect(errors.some((e) => e.name === 'RangeError')).toBe(true);
    expect(errors.some((e) => e.message === 'Circular signal dependency')).toBe(false);
  });
});

describe('batch', () => {
  test('top level: one notification per changed signal, in the order they were first set, with final values', () => {
    const log: string[] = [];
    const a = signal(0);
    const b = signal(0);
    a.subscribe((v) => log.push(`a:${v}`), true);
    b.subscribe((v) => log.push(`b:${v}`), true);

    batch(() => {
      b(1);
      a(1);
      log.push(`in batch a()=${a()}`);
      a(2);
      b(1);
    });
    log.push('after batch');

    expect(log).toEqual(['in batch a()=1', 'b:1', 'a:2', 'after batch']);
  });

  test('nested: nothing is notified until the outermost batch ends', () => {
    const log: string[] = [];
    const a = signal(0);
    const b = signal(0);
    a.subscribe((v) => log.push(`a:${v}`), true);
    b.subscribe((v) => log.push(`b:${v}`), true);

    batch(() => {
      a(1);
      batch(() => {
        b(1);
        a(2);
      });
      log.push('inner done');
    });
    log.push('outer done');

    expect(log).toEqual(['inner done', 'a:2', 'b:1', 'outer done']);
  });

  test("the first batched signal's cascades run before the second batched signal is notified", () => {
    const log: string[] = [];
    const a = signal(0);
    const b = signal(0);
    const c = signal(0);
    a.subscribe((v) => {
      log.push(`a:${v}`);
      c(v);
    }, true);
    b.subscribe((v) => log.push(`b:${v}`), true);
    c.subscribe((v) => log.push(`c:${v}`), true);

    batch(() => {
      a(1);
      b(1);
    });

    expect(log).toEqual(['a:1', 'c:1', 'b:1']);
  });

  test('a batched signal re-set by an earlier batched signal is notified twice', () => {
    const log: string[] = [];
    const a = signal(0);
    const b = signal(0);
    a.subscribe((v) => {
      log.push(`a:${v}`);
      b(v + 1);
    }, true);
    b.subscribe((v) => log.push(`b:${v}`), true);

    batch(() => {
      a(1);
      b(1);
    });

    expect(log).toEqual(['a:1', 'b:2', 'b:2']);
  });

  test('batch inside a subscriber flushes before it returns, including signals the cascade set before it', () => {
    const log: string[] = [];
    const a = signal(0);
    const x = signal(0);
    const b = signal(0);
    const c = signal(0);
    const d = signal(0);
    a.subscribe((v) => {
      log.push('a1');
      x(v);
    }, true);
    a.subscribe((v) => {
      log.push('a2 start');
      batch(() => {
        b(v);
        c(v);
        log.push('a2 batch fn end');
      });
      log.push(`a2 end d()=${d()}`);
    }, true);
    a.subscribe(() => log.push('a3'), true);
    x.subscribe((v) => log.push(`x:${v}`), true);
    b.subscribe((v) => {
      log.push(`b:${v}`);
      d(v);
    }, true);
    c.subscribe((v) => log.push(`c:${v}`), true);
    d.subscribe((v) => log.push(`d:${v}`), true);

    a(1);
    log.push('done');

    expect(log).toEqual([
      'a1',
      'a2 start',
      'a2 batch fn end',
      // the batch drains everything pending, x included, while a's notification is still running
      'x:1',
      'b:1',
      'c:1',
      // the batch drained at depth > 0, so b's cascade (d) waits for a's notification to end
      'a2 end d()=1',
      'a3',
      'd:1',
      'done',
    ]);
  });

  test('batch inside a subscriber that runs from a batch flush', () => {
    const log: string[] = [];
    const a = signal(0);
    const b = signal(0);
    const c = signal(0);
    a.subscribe((v) => {
      log.push('a1');
      batch(() => b(v));
      log.push('a1 end');
    }, true);
    a.subscribe(() => log.push('a2'), true);
    b.subscribe((v) => {
      log.push(`b:${v}`);
      c(v);
    }, true);
    c.subscribe((v) => log.push(`c:${v}`), true);

    batch(() => a(1));
    log.push('done');

    expect(log).toEqual(['a1', 'b:1', 'a1 end', 'a2', 'c:1', 'done']);
  });

  test('a throwing subscriber inside a batch does not stop the others; the error is re-thrown later', () => {
    const log: string[] = [];
    const a = signal(0);
    const b = signal(0);
    a.subscribe(() => {
      log.push('a1 throws');
      throw new Error('boom');
    }, true);
    a.subscribe((v) => log.push(`a2:${v}`), true);
    b.subscribe((v) => log.push(`b:${v}`), true);

    const errors = captureRethrown(() => {
      batch(() => {
        a(1);
        b(1);
      });
      log.push('after');
    });

    expect(log).toEqual(['a1 throws', 'a2:1', 'b:1', 'after']);
    expect(errors).toEqual(['boom']);
  });

  test('a batch whose function throws still notifies, then re-throws to the caller', () => {
    const log: string[] = [];
    const a = signal(0);
    a.subscribe((v) => log.push(`a:${v}`), true);
    try {
      batch(() => {
        a(1);
        throw new Error('fn');
      });
    } catch (e) {
      log.push(`caught ${(e as Error).message}`);
    }
    expect(log).toEqual(['a:1', 'caught fn']);
  });
});

describe('computed in each situation', () => {
  test('cascade: read before its source has notified it returns the previous value', () => {
    const log: string[] = [];
    const a = signal(1);
    const b = signal(1);
    const cb = computed(() => b() * 10);
    cb.subscribe((v) => log.push(`cb notified:${v}`), true);
    const unobserved = computed(() => b() * 100);
    unobserved();
    a.subscribe((v) => {
      b(v + 1);
      log.push(`a1 b()=${b()} cb()=${cb()} unobserved()=${unobserved()}`);
    }, true);
    a.subscribe(() => log.push(`a2 cb()=${cb()}`), true);
    b.subscribe((v) => log.push(`b:${v} cb()=${cb()}`), true);

    a(5);
    log.push(`after cb()=${cb()} unobserved()=${unobserved()}`);

    expect(log).toEqual([
      'a1 b()=6 cb()=10 unobserved()=100',
      'a2 cb()=10',
      // b's notification dirty-marks both computeds first (they subscribed first), so this read is fresh
      'b:6 cb()=60',
      // the computed's own subscribers run when the outermost notification ends
      'cb notified:60',
      'after cb()=60 unobserved()=600',
    ]);
  });

  test('diamond of computeds: the join notifies once, glitch-free; a downstream read inside the source notification is stale', () => {
    const log: string[] = [];
    const a = signal(1);
    const b = computed(() => {
      log.push('eval b');
      return a() * 2;
    });
    const c = computed(() => {
      log.push('eval c');
      return a() + 1;
    });
    const d = computed(() => {
      log.push('eval d');
      return b() + c();
    });
    d.subscribe((v) => log.push(`d:${v}`), true);
    b.subscribe((v) => log.push(`b:${v}`), true);
    a.subscribe((v) => log.push(`a:${v} d()=${d()}`), true);
    log.push('--set');

    a(2);

    expect(log).toEqual([
      'eval b',
      'eval c',
      'eval d',
      '--set',
      // b and c are dirty, d is not yet: reading d here returns the old 4, not 7
      'a:2 d()=4',
      // queued computed notifications, in the order their sources marked them: b first
      'eval b',
      'eval d',
      'eval c',
      'd:7',
      'b:4',
      // c's queued notification re-evaluates c and d; d is unchanged, so nothing is notified
      'eval c',
      'eval d',
    ]);
  });

  test('set twice in a cascade: the computed is notified once with the final value', () => {
    const log: string[] = [];
    const a = signal(0);
    const b = signal(0);
    const cb = computed(() => {
      log.push('eval cb');
      return b() * 10;
    });
    cb.subscribe((v) => log.push(`cb:${v}`), true);
    a.subscribe((v) => {
      b(v + 1);
      b(v + 2);
      log.push(`a1 cb()=${cb()}`);
    }, true);
    b.subscribe((v) => log.push(`b:${v} cb()=${cb()}`), true);
    log.push('--');

    a(1);

    expect(log).toEqual(['eval cb', '--', 'a1 cb()=0', 'eval cb', 'b:3 cb()=30', 'eval cb', 'cb:30']);
  });

  test('top-level batch: a read inside the batch is stale; the computed notifies between two batched sources', () => {
    const log: string[] = [];
    const a = signal(0);
    const b = signal(0);
    const sum = computed(() => {
      log.push('eval sum');
      return a() + b();
    });
    sum.subscribe((v) => log.push(`sum:${v}`), true);
    a.subscribe((v) => log.push(`a:${v}`), true);
    b.subscribe((v) => log.push(`b:${v}`), true);
    log.push('--');

    batch(() => {
      a(1);
      b(2);
      log.push(`in batch a()=${a()} sum()=${sum()}`);
    });
    log.push('done');

    expect(log).toEqual([
      'eval sum',
      '--',
      'in batch a()=1 sum()=0',
      'a:1',
      // the computed queue runs at the end of a's notification, before b is notified;
      // the value is already final because b was written during the batch
      'eval sum',
      'sum:3',
      'b:2',
      'eval sum',
      'done',
    ]);
  });

  test('nested batch: reads inside either batch are stale; one notification after the outer one', () => {
    const log: string[] = [];
    const a = signal(0);
    const ca = computed(() => a() + 1);
    ca.subscribe((v) => log.push(`ca:${v}`), true);

    batch(() => {
      batch(() => {
        a(5);
        log.push(`inner ca()=${ca()}`);
      });
      log.push(`outer ca()=${ca()}`);
    });
    log.push(`after ca()=${ca()}`);

    expect(log).toEqual(['inner ca()=1', 'outer ca()=1', 'ca:6', 'after ca()=6']);
  });

  test('batch inside a subscriber: the read after the batch is fresh; notification waits for the outer end', () => {
    const log: string[] = [];
    const a = signal(0);
    const b = signal(0);
    const cb = computed(() => b() * 10);
    cb.subscribe((v) => log.push(`cb:${v}`), true);
    a.subscribe((v) => {
      batch(() => b(v));
      log.push(`a1 after batch cb()=${cb()}`);
    }, true);
    a.subscribe(() => log.push('a2'), true);

    a(3);
    log.push('done');

    expect(log).toEqual(['a1 after batch cb()=30', 'a2', 'cb:30', 'done']);
  });

  test("a computed subscriber's write is notified synchronously (the computed queue runs at depth 0)", () => {
    const log: string[] = [];
    const a = signal(1);
    const z = signal(0);
    const ca = computed(() => a() * 10);
    ca.subscribe((v) => {
      log.push(`ca:${v}`);
      z(v);
      log.push('ca after set z');
    }, true);
    z.subscribe((v) => log.push(`z:${v}`), true);
    a.subscribe((v) => log.push(`a:${v}`), true);

    a(2);
    log.push('done');

    expect(log).toEqual(['a:2', 'ca:20', 'z:20', 'ca after set z', 'done']);
  });

  test('a throwing computed subscriber inside a batch does not stop the others', () => {
    const log: string[] = [];
    const a = signal(0);
    const ca = computed(() => a() + 1);
    ca.subscribe(() => {
      log.push('ca1 throws');
      throw new Error('cboom');
    }, true);
    ca.subscribe((v) => log.push(`ca2:${v}`), true);

    const errors = captureRethrown(() => {
      batch(() => a(1));
      log.push('after');
    });

    expect(log).toEqual(['ca1 throws', 'ca2:2', 'after']);
    expect(errors).toEqual(['cboom']);
  });
});
