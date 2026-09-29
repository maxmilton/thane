/**
 * Hot swapping (hot.ts), over fake hosts: a selector's first registration returns a handle that mounts
 * its newest code; a later one mounts every live instance again with the new code, into the same host
 * with the same props, after running the old code's cleanups. The instance object a parent holds stays,
 * and destroying it runs the newest cleanups and forgets it.
 */
import { describe, expect, test } from 'bun:test';
import { hotRegister, type HotRuntime } from './hot.js';

let log: string[] = [];

/** A host element: its content, and whether it is in the page */
const host = (connected = true) => ({ innerHTML: '', isConnected: connected }) as unknown as HTMLElement;

/** A factory whose instances log their mount and cleanups under `version` */
const factory = (version: string) => ({
  __f: (target: HTMLElement, props?: { n: number }) => {
    target.innerHTML = `${version}:${props?.n}`;
    log.push(`mount ${version} ${props?.n}`);
    return {
      root: target,
      __bindingsCleanup: () => log.push(`bindings ${version} ${props?.n}`),
      __onDestroy: () => log.push(`destroy ${version} ${props?.n}`),
    };
  },
});

/** What a parent does to destroy a child it holds (`__dc`) */
const destroy = (instance: {
  __bindingsCleanup?: (() => void) | undefined;
  __onDestroy?: (() => void) | undefined;
}) => {
  instance.__bindingsCleanup?.();
  instance.__onDestroy?.();
};

describe('hot swapping', () => {
  test('a registration again mounts every live instance with the new code, in place', () => {
    log = [];
    const hot: HotRuntime = {};
    const handle = hotRegister(hot, 'x-card', factory('v1'));
    const [a, b] = [host(), host()];
    const first = handle.__f(a, { n: 1 });
    handle.__f(b, { n: 2 });
    expect(log).toEqual(['mount v1 1', 'mount v1 2']);

    log = [];
    expect(hotRegister(hot, 'x-card', factory('v2'))).toBe(handle);
    expect(log).toEqual(['bindings v1 1', 'destroy v1 1', 'mount v2 1', 'bindings v1 2', 'destroy v1 2', 'mount v2 2']);
    expect(a.innerHTML).toBe('v2:1');

    // The parent's instance runs the new code's cleanups, and is forgotten
    log = [];
    destroy(first);
    expect(log).toEqual(['bindings v2 1', 'destroy v2 1']);
    hotRegister(hot, 'x-card', factory('v3'));
    expect(log).toEqual(['bindings v2 1', 'destroy v2 1', 'bindings v2 2', 'destroy v2 2', 'mount v3 2']);
  });

  test('a new mount after a swap runs the newest code; other selectors are untouched', () => {
    log = [];
    const hot: HotRuntime = {};
    const card = hotRegister(hot, 'x-card', factory('card'));
    hotRegister(hot, 'x-other', factory('other')).__f(host(), { n: 9 });
    hotRegister(hot, 'x-card', factory('card2'));
    card.__f(host(), { n: 3 });
    expect(log).toEqual(['mount other 9', 'mount card2 3']);
  });

  test('an instance whose host left the page without being destroyed is forgotten', () => {
    log = [];
    const hot: HotRuntime = {};
    const target = host();
    hotRegister(hot, 'x-card', factory('v1')).__f(target, { n: 1 });
    (target as unknown as { isConnected: boolean }).isConnected = false;
    log = [];
    hotRegister(hot, 'x-card', factory('v2'));
    expect(log).toEqual([]);
    expect(hot.components!.get('x-card')!.live.size).toBe(0);
  });
});
