/**
 * Node's `cloneNode` and `insertBefore`, read once for every compiled list of an app: a compiled row calls
 * them on its template and its container. A module of its own (`thane/runtime/dom`), which only a compiled
 * file with a list imports, so an app without a list reads nothing, and `thane/runtime` loads where there
 * is no DOM (the unit tests run under Bun).
 * @internal
 */
export const { cloneNode: _cloneNode, insertBefore: _insertBefore } = Node.prototype;
