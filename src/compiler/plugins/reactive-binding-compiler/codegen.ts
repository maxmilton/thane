/**
 * Code generation for reactive binding compiler
 *
 * Generates JavaScript code for bindings, subscriptions, static templates,
 * imports, and the body of the component's binding function.
 */

import type {
  ConditionalBlock,
  WhenElseBlock,
  RepeatBlock,
  BindingInfo,
  SimpleBinding,
  ExpressionBinding,
  EventBinding,
  ItemEventBinding,
  EmitOptions,
  StaticTemplateInfo,
} from './types.js';
import { isExpressionBinding, isSimpleBinding } from './types.js';
import { generateStaticRepeatTemplate } from './repeat-analysis.js';
import { walkDirectives } from './directive-tree.js';
import {
  toCamelCase,
  BIND_FN,
  renameIdentifierInExpression,
  parseArrowFunction,
  expressionReferencesIdentifier,
} from '../../utils/index.js';
import { escapeTemplateLiteral } from '../../utils/html-parser/index.js';
import { buildDomModel, cookTemplateText, type DomModel, type DomNode } from './dom-model.js';
import { anchorMark, BOUND_MARK, stripMarks } from './template-utils.js';
import { ErrorCode } from '../../errors.js';
import type { ImportInfo } from '../../types.js';
import type { ChildMountInfo } from '../component-precompiler/component-precompiler.js';
import type { GeneratedInitBindingsArtifact, RuntimeHelperName } from '../../../contracts/index.js';
import { INTERNAL_RUNTIME_SPECIFIER, PUBLIC_RUNTIME_SPECIFIER } from '../../../contracts/index.js';

/**
 * Rows per batch clone for repeat() rows without cleanups: the reconciler clones a fragment of
 * this many rows at once and binds each, instead of one cloneNode and insertBefore per row.
 */
const ROW_BATCH_SIZE = 16;

// ============================================================================
// Key Function Inlining
// ============================================================================

/**
 * Detect simple `(param) => param.prop` trackBy patterns and extract the
 * property name. When matched, the codegen emits just the property name
 * string instead of the full arrow function, letting the runtime use a
 * direct property access (avoiding per-call function invocation overhead).
 */
const _simpleKeyFnRe = /^\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\.(\w+)\s*$/;
const extractKeyProperty = (trackByFn: string): string | null => {
  const m = _simpleKeyFnRe.exec(trackByFn);
  return m ? m[2]! : null;
};

/** The reconciler's key argument: the key property as a string, the trackBy function, or the index. */
const keyArg = (rep: RepeatBlock): string => {
  const keyProp = rep.trackByFn ? extractKeyProperty(rep.trackByFn) : null;
  return keyProp ? `'${keyProp}'` : rep.trackByFn || '(_, i) => i';
};

const _repeatSourceRe = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(\)\s*$/;

const extractRepeatSourceExpression = (itemsExpression: string): string | null => {
  const match = _repeatSourceRe.exec(itemsExpression.trim());
  return match?.[1] ?? null;
};

const buildRepeatSubscriptionSources = (rep: RepeatBlock): string[] => {
  const directSource = extractRepeatSourceExpression(rep.itemsExpression);
  if (directSource) {
    return [directSource];
  }

  const sources: string[] = [];
  for (const signalName of rep.signalNames) {
    if (!sources.includes(signalName)) {
      sources.push(signalName);
    }
  }

  return sources;
};

// ============================================================================
// Navigation Helper
// ============================================================================

/**
 * Convert a child-index path to firstElementChild/nextElementSibling navigation.
 * Avoids HTMLCollection creation from .children[N] access.
 * @example pathToSiblingNav('_el', [1, 0]) → '_el.firstElementChild.nextElementSibling.firstElementChild'
 */
const pathToSiblingNav = (root: string, path: number[]): string => {
  let expr = root;
  for (const idx of path) {
    expr += '.firstElementChild';
    for (let s = 0; s < idx; s++) expr += '.nextElementSibling';
  }
  return expr;
};

// ============================================================================
// Scopes: where compiled code finds the nodes it binds (A1)
// ============================================================================

/**
 * How the code of one template reaches the nodes it binds (bound elements and child hosts, text
 * nodes, directive, list and child anchors), without ids and without searching. `at(id, name)` is
 * the expression for the node marked `id`: an element's BOUND_MARK, or an anchor comment's data
 * (`b3(`, `b3.`); `text(id, name)` is the text node after the text marker `id` (`<!--b3-->`). `name`
 * is the variable the caller wants it in. `head` holds the declarations they needed, which the
 * caller emits before any statement that changes the DOM: a path is only valid on the template as
 * it was cloned.
 */
interface NavScope {
  at: (id: string, name: string) => string;
  text: (id: string, name: string) => string;
  head: string[];
}

/** The tree the browser builds of a template as it is emitted (A1, see dom-model.ts). */
const modelOf = (html: string, emit: EmitOptions): DomModel => buildDomModel(cookTemplateText(emit.html(html)));

function* nodesOf(nodes: DomNode[]): Generator<DomNode> {
  for (const n of nodes) {
    yield n;
    yield* nodesOf(n.children);
  }
}

const structureError = (model: DomModel): Error =>
  new Error(
    `${ErrorCode.TEMPLATE_STRUCTURE}: the browser rebuilds this template's markup, so the compiler cannot tell where its bound nodes end up: ${model.problems[0]}.`,
  );

const lostNode = (): Error =>
  new Error(
    `${ErrorCode.PLUGIN_ERROR}: internal compiler error — a bound node's position in its template could not be found. Please report this with the template.`,
  );

/**
 * The node marked `id` in a template's model; its absence is a compiler bug. Ids count from 0 in
 * every file (A1-5), so a comment the developer wrote in the marker's form (`<!--b0-->`) could be
 * taken for the marker: that is reported instead.
 */
const markedNode = (model: DomModel, id: string): DomNode => {
  if (model.problems.length > 0) throw structureError(model);
  const found = [...nodesOf(model.roots)].filter((n) =>
    n.kind === 'comment' ? n.data === id : n.attrs.get(BOUND_MARK) === id,
  );
  if (found.length > 1) {
    throw new Error(
      `${ErrorCode.TEMPLATE_STRUCTURE}: a comment in this template has the form of the compiler's own markers (<!--${id}-->), so the compiler cannot tell which node it binds: change or remove the comment.`,
    );
  }
  if (!found[0]) throw lostNode();
  return found[0];
};

/** The text node a text binding writes: the one after its marker comment. */
const textAfter = (model: DomModel, marker: DomNode): DomNode => {
  const siblings = marker.parent ? marker.parent.children : model.roots;
  const text = siblings[siblings.indexOf(marker) + 1];
  if (text?.kind !== 'text') throw lostNode();
  return text;
};

/** Where a search starts: a node the code already holds (`node` null: the component root, `r`). */
interface NavSource {
  node: DomNode | null;
  expr: string;
  cost: number;
}

/**
 * The moves from `n` (null: the component root, whose last children are the template's top-level
 * nodes): the node each property reaches. A template's top-level nodes have no siblings or parent
 * outside it. An element target is reached with element steps only, which do not depend on the
 * text nodes around it.
 */
const movesFrom = (model: DomModel, n: DomNode | null, elementsOnly: boolean): [DomNode, string][] => {
  const moves: [DomNode, string][] = [];
  const isElement = (c: DomNode) => c.kind === 'element';
  const kids = n ? n.children : model.roots;
  if (kids.length > 0) {
    const els = kids.filter(isElement);
    if (!elementsOnly) {
      if (n) moves.push([kids[0]!, 'firstChild']);
      moves.push([kids[kids.length - 1]!, 'lastChild']);
    }
    if (els.length > 0) {
      if (n) moves.push([els[0]!, 'firstElementChild']);
      moves.push([els[els.length - 1]!, 'lastElementChild']);
    }
  }
  if (n) {
    const siblings = n.parent ? n.parent.children : model.roots;
    const i = siblings.indexOf(n);
    if (!elementsOnly) {
      if (i + 1 < siblings.length) moves.push([siblings[i + 1]!, 'nextSibling']);
      if (i > 0) moves.push([siblings[i - 1]!, 'previousSibling']);
    }
    const next = siblings.slice(i + 1).find(isElement);
    if (next) moves.push([next, 'nextElementSibling']);
    const previous = siblings.slice(0, i).reverse().find(isElement);
    if (previous) moves.push([previous, 'previousElementSibling']);
    if (n.parent) moves.push([n.parent, 'parentNode']);
  }
  return moves;
};

/** The shortest expression (in characters) that reaches `target` from one of `sources`. */
const shortestPath = (model: DomModel, sources: NavSource[], target: DomNode): string => {
  const elementsOnly = target.kind === 'element';
  const open = [...sources];
  const done = new Set<DomNode | null>();
  while (open.length > 0) {
    let best = 0;
    for (let i = 1; i < open.length; i++) if (open[i]!.cost < open[best]!.cost) best = i;
    const cur = open.splice(best, 1)[0]!;
    if (cur.node === target) return cur.expr;
    if (done.has(cur.node)) continue;
    done.add(cur.node);
    for (const [next, prop] of movesFrom(model, cur.node, elementsOnly)) {
      if (!done.has(next)) open.push({ node: next, expr: `${cur.expr}.${prop}`, cost: cur.cost + prop.length + 1 });
    }
  }
  throw new Error(
    `${ErrorCode.PLUGIN_ERROR}: internal compiler error — no path to a bound node. Please report this with the template.`,
  );
};

/**
 * A scope over one template. Each target is declared once as `name` (in `head`), from the shortest
 * path out of the scope's sources and the targets declared before it; `direct` can answer without a
 * declaration (the component scope's `_ns[i]` elements).
 */
const createScope = (
  model: DomModel,
  indent: string,
  sources: NavSource[],
  direct?: (node: DomNode) => string | undefined,
): NavScope => {
  const head: string[] = [];
  const known = [...sources];
  const declared = new Set<string>();
  const declare = (node: DomNode, name: string): string => {
    head.push(`${indent}const ${name} = ${shortestPath(model, known, node)};`);
    declared.add(name);
    known.push({ node, expr: name, cost: 2 });
    return name;
  };
  return {
    head,
    at: (id, name) => {
      if (declared.has(name)) return name;
      const node = markedNode(model, id);
      return direct?.(node) ?? declare(node, name);
    },
    text: (id, name) => (declared.has(name) ? name : declare(textAfter(model, markedNode(model, id)), name)),
  };
};

/**
 * The component template's scope. The registration factory hands `__b` the template's elements in
 * document order (`_ns`, listed from the clone before it is inserted), so an element is `_ns[i]`; any
 * other node is reached from one of them, or from the component root's last children (`r`).
 */
const componentScope = (model: DomModel): NavScope & { used: () => boolean; usesRoot: () => boolean } => {
  let used = false;
  const scope = createScope(
    model,
    '    ',
    [
      ...model.elements.map((el) => ({ node: el, expr: `_ns[${el.order}]`, cost: 5 + String(el.order).length })),
      { node: null, expr: 'r', cost: 2 },
    ],
    (node) => {
      if (node.kind !== 'element') return undefined;
      used = true;
      return `_ns[${node.order}]`;
    },
  );
  return {
    ...scope,
    used: () => used || scope.head.some((line) => line.includes('_ns[')),
    usesRoot: () => scope.head.some((line) => line.includes(' = r.')),
  };
};

/** A directive branch's scope, reached from the branch's first node (`_c`), which the runtime passes. */
const branchScope = (model: DomModel, indent: string): NavScope =>
  model.roots.length > 0
    ? createScope(model, indent, [{ node: model.roots[0]!, expr: '_c', cost: 2 }])
    : createScope(model, indent, []);

/**
 * The write for a dynamic attribute: through a DOM property when the analysis found one with
 * identical semantics (`class` → `className` on HTML elements), otherwise `setAttribute`.
 */
const attributeWrite = (
  target: string,
  binding: { property?: string | undefined; domProperty?: string | undefined },
  value: string,
): string =>
  binding.domProperty
    ? `${target}.${binding.domProperty} = ${value}`
    : `${target}.setAttribute('${binding.property}', ${value})`;

// ============================================================================
// Redundancy-guarded writes
// ============================================================================

/** A binding's first write and its guarded re-write, sharing one guard variable. */
interface GuardedWrite {
  fill: string;
  update: string;
}

/**
 * Wrap a DOM write in a redundancy guard. The guard variable keeps the last value written
 * for this binding, so a re-evaluation that produces the same value skips the DOM write —
 * a skipped `setAttribute`/`textContent` write is several times cheaper than the write.
 *
 * `fill` is the first write after cloning. When the static template already ships the
 * attribute as the empty string, the first write is skipped for an empty result too.
 *
 * @example guardedWrite('_p0', (v) => `_e0.textContent = ${v}`, 'item.label')
 *   fill:   _e0.textContent = _p0 = item.label
 *   update: if (_p0 !== (_p0 = item.label)) _e0.textContent = _p0
 */
const guardedWrite = (
  guardVar: string,
  write: (value: string) => string,
  expr: string,
  staticValue?: string | undefined,
  updateGuardVar: string = guardVar,
): GuardedWrite => ({
  fill: staticValue === '' ? `if ((${guardVar} = ${expr}) !== '') ${write(guardVar)}` : write(`${guardVar} = ${expr}`),
  update: `if (${updateGuardVar} !== (${updateGuardVar} = ${expr})) ${write(updateGuardVar)}`,
});

/**
 * Where a row-local variable lives once it is kept on the managed record instead of in a
 * per-row closure: `_p0` → `_m.p0`. Used by the shared update function of lean rows.
 */
const recordField = (local: string): string => `_m.${local.slice(1)}`;

/** Allocates guard variable names for one row factory. */
const createGuardAllocator = (prefix: string) => {
  const vars: string[] = [];
  return {
    vars,
    next: (): string => {
      const name = `${prefix}${vars.length}`;
      vars.push(name);
      return name;
    },
    /** `let` declaration for every guard allocated so far, or '' when none. */
    declaration: (): string => (vars.length > 0 ? `let ${vars.join(', ')};` : ''),
  };
};

// ============================================================================
// Selection bindings: one subscription per list instead of one per row
// ============================================================================

/** A row attribute of the form `signal() === item.<key> ? on : off`, resolved to its two values. */
interface SelectionBinding {
  signalName: string;
  onValue: string;
  offValue: string;
}

const _selectionRe =
  /^\s*(?:(\w+)\(\)\s*(===|!==)\s*item\.(\w+)|item\.(\w+)\s*(===|!==)\s*(\w+)\(\))\s*\?\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*$/;

/**
 * Recognise a selection binding: `signal() === item.<key> ? 'on' : 'off'` (or `!==`, or the
 * operands swapped) where `<key>` is the repeat's trackBy property. Such a value depends only
 * on the row's key and the signal, so the compiler can replace N per-row subscriptions with
 * one subscription on the list that rewrites the two rows whose value changed, found through
 * the reconciler's key map. Anything else keeps the general per-row path.
 */
const matchSelectionBinding = (
  expr: string,
  outerSignalNames: string[],
  keyProp: string | null,
): SelectionBinding | null => {
  if (!keyProp || outerSignalNames.length !== 1) return null;
  const m = _selectionRe.exec(expr);
  if (!m) return null;
  const signalName = m[1] ?? m[6]!;
  const op = m[2] ?? m[5]!;
  const prop = m[3] ?? m[4]!;
  if (signalName !== outerSignalNames[0] || prop !== keyProp) return null;
  const first = m[7]!;
  const second = m[8]!;
  return op === '==='
    ? { signalName, onValue: first, offValue: second }
    : { signalName, onValue: second, offValue: first };
};

/**
 * Emit the list-level subscription for a selection binding. It remembers the previously
 * selected key, and on change clears the old row and marks the new one; rows that no longer
 * exist (or keys with no row) are skipped. Rows still compute the value on creation, so a row
 * created while selected starts in the right state.
 */
const buildSelectionSubscription = (
  repId: string,
  index: number,
  sel: SelectionBinding,
  path: number[],
  write: (target: string, value: string) => string,
): string => {
  const nav = (managed: string) => (path.length === 0 ? `${managed}.el` : pathToSiblingNav(`${managed}.el`, path));
  const prev = `_sel_${repId}_${index}`;
  const rc = `_rc_${repId}`;
  return (
    `let ${prev} = ${sel.signalName}(); ` +
    `_subs.push(${sel.signalName}.subscribe((_v) => { ` +
    `const _o = ${rc}.get(${prev}); if (_o) ${write(nav('_o'), sel.offValue)}; ` +
    `const _n = ${rc}.get(_v); if (_n) ${write(nav('_n'), sel.onValue)}; ` +
    `${prev} = _v; }, true));`
  );
};

// ============================================================================
// Event Delegation Types & Helpers
// ============================================================================

/** A single event binding that can be dispatched via container-level delegation */
interface DelegatedEvent {
  path: number[];
  handlerExpr: string;
  modifiers: string[];
}

/** Result of partitioning item events into delegatable vs non-delegatable */
interface PartitionedEvents {
  delegatedByType: Map<string, DelegatedEvent[]>;
  nonDelegatable: ItemEventBinding[];
}

/**
 * Turn a row event attribute's expression into statements for the row listener body, where
 * the event is `e`. An arrow function is inlined (its parameter aliased to `e` when it has
 * another name); a plain reference is called with the event; a call expression such as
 * `select(item.id)` runs as written.
 */
const inlineRowHandler = (handlerExpr: string): string => {
  const arrow = parseArrowFunction(handlerExpr);
  if (arrow) {
    const body = arrow.isBlockBody ? arrow.body.slice(1, -1).trim() : arrow.body;
    const param = arrow.params.replace(/^\(|\)$/g, '').trim();
    if (param === '' || param === 'e') return body;
    if (/^[A-Za-z_$][\w$]*$/.test(param)) return `{ const ${param} = e; ${body}; }`;
    return `(${handlerExpr})(e)`;
  }
  const trimmed = handlerExpr.trim();
  if (/^[A-Za-z_$][\w$.]*$/.test(trimmed)) return `${trimmed}(e)`;
  return handlerExpr;
};

/**
 * Partition item events into delegatable (container-level listener) and
 * non-delegatable (.self modifier or missing path) groups.
 */
const partitionItemEvents = (
  itemEvents: ItemEventBinding[],
  eventElementPaths: Map<string, number[]> | undefined,
  rep: RepeatBlock,
  indexVar: string,
): PartitionedEvents => {
  const delegatedByType = new Map<string, DelegatedEvent[]>();
  const nonDelegatable: ItemEventBinding[] = [];

  if (!eventElementPaths) return { delegatedByType, nonDelegatable };

  for (const evt of itemEvents) {
    const evtPath = eventElementPaths.get(evt.elementId);
    if (!evtPath) {
      nonDelegatable.push(evt);
      continue;
    }

    let handlerExpr = evt.handlerExpression;
    handlerExpr = renameIdentifierInExpression(handlerExpr, rep.itemVar, 'item');
    if (rep.indexVar) {
      handlerExpr = renameIdentifierInExpression(handlerExpr, rep.indexVar, indexVar);
    }
    handlerExpr = inlineRowHandler(handlerExpr);

    // .self requires currentTarget === target — cannot delegate
    if (evt.modifiers.includes('self')) {
      nonDelegatable.push(evt);
      continue;
    }

    if (!delegatedByType.has(evt.eventName)) {
      delegatedByType.set(evt.eventName, []);
    }
    delegatedByType.get(evt.eventName)!.push({
      path: evtPath,
      handlerExpr,
      modifiers: evt.modifiers,
    });
  }

  return { delegatedByType, nonDelegatable };
};

/**
 * Build delegated listener statements — one addEventListener per event type on the container.
 * Each listener walks from e.target up to the item root, reads __d, and dispatches. `captured`
 * names, per event, the row property that holds its element (see emitRepeat): in a row whose
 * when()/whenElse() content comes and goes, an element's position is only known at creation.
 */
const buildDelegatedListenerStatements = (
  delegatedByType: Map<string, DelegatedEvent[]>,
  containerVar: string,
  captured?: Map<DelegatedEvent, string>,
): string[] => {
  const statements: string[] = [];

  for (const [eventName, events] of delegatedByType) {
    // Walk up to the row once, remembering the row child the target came through (`_cell`).
    // Each handler first compares that child with its own compiled position, so only the
    // one handler whose subtree the target is in runs a containment check, and only for
    // the part of its path below the cell.
    const finalBody = [
      `let _row = e.target, _cell = null;`,
      `while (_row && _row.parentNode !== ${containerVar}) { _cell = _row; _row = _row.parentNode; }`,
      `if (!_row || !_row.__d) return;`,
      `const item = _row.__d;`,
    ];

    for (const evt of events) {
      const modParts: string[] = [];
      if (evt.modifiers.includes('prevent')) modParts.push('e.preventDefault()');
      if (evt.modifiers.includes('stop')) modParts.push('e.stopPropagation()');
      const keyMods = evt.modifiers.filter((m) => m !== 'prevent' && m !== 'stop' && m !== 'self');
      if (keyMods.length > 0) {
        const guard = compileKeyGuard(keyMods);
        if (guard) modParts.push(`if (${guard}) return`);
      }
      const handlerBody = [...modParts, evt.handlerExpr].join('; ');

      const capturedAs = captured?.get(evt);
      if (evt.path.length === 0) {
        finalBody.push(`${handlerBody};`);
      } else if (capturedAs) {
        finalBody.push(`if (_row.${capturedAs}.contains(e.target)) { ${handlerBody}; return; }`);
      } else {
        const [cellIndex, ...rest] = evt.path;
        const cellExpr = pathToSiblingNav('_row', [cellIndex!]);
        const guard =
          rest.length === 0
            ? `_cell !== null && _cell === ${cellExpr}`
            : `_cell !== null && _cell === ${cellExpr} && ${pathToSiblingNav('_cell', rest)}?.contains(e.target)`;
        finalBody.push(`if (${guard}) { ${handlerBody}; return; }`);
      }
    }

    statements.push(`${containerVar}.addEventListener('${eventName}', (e) => { ${finalBody.join(' ')} });`);
  }

  return statements;
};

/**
 * Build per-item addEventListener statements for non-delegatable events.
 * Returns { navStatements, addStatements } for insertion into createItem.
 */
const buildNonDelegatableEventStatements = (
  nonDelegatableEvents: ItemEventBinding[],
  eventElementPaths: Map<string, number[]> | undefined,
  elementBindings: { path: number[] }[],
  navVarNames: string[],
  rep: RepeatBlock,
  indexVar: string,
): { navStatements: string[]; addStatements: string[] } => {
  const navStatements: string[] = [];
  const addStatements: string[] = [];

  if (nonDelegatableEvents.length === 0 || !eventElementPaths) {
    return { navStatements, addStatements };
  }

  const pathToBindingVar = new Map<string, string>();
  for (let i = 0; i < elementBindings.length; i++) {
    const eb = elementBindings[i]!;
    pathToBindingVar.set(JSON.stringify(eb.path), navVarNames[i]!);
  }

  const eventElVarMap = new Map<string, string>();
  let eventElIdx = 0;

  for (const evt of nonDelegatableEvents) {
    if (!eventElVarMap.has(evt.elementId)) {
      const evtPath = eventElementPaths.get(evt.elementId);
      if (evtPath) {
        const existingVar = pathToBindingVar.get(JSON.stringify(evtPath));
        if (existingVar) {
          eventElVarMap.set(evt.elementId, existingVar);
        } else {
          const varName = `_ev${eventElIdx++}`;
          eventElVarMap.set(evt.elementId, varName);
          if (evtPath.length === 0) {
            navStatements.push(`const ${varName} = _el`);
          } else {
            navStatements.push(`const ${varName} = ${pathToSiblingNav('_el', evtPath)}`);
          }
        }
      }
    }
  }

  for (const evt of nonDelegatableEvents) {
    const elVar = eventElVarMap.get(evt.elementId);
    if (!elVar) continue;
    let handlerExpr = evt.handlerExpression;
    handlerExpr = renameIdentifierInExpression(handlerExpr, rep.itemVar, 'item');
    if (rep.indexVar) {
      handlerExpr = renameIdentifierInExpression(handlerExpr, rep.indexVar, indexVar);
    }
    handlerExpr = inlineRowHandler(handlerExpr);
    const bodyParts: string[] = [];
    if (evt.modifiers.includes('prevent')) bodyParts.push('e.preventDefault()');
    if (evt.modifiers.includes('stop')) bodyParts.push('e.stopPropagation()');
    if (evt.modifiers.includes('self')) bodyParts.push('if (e.target !== e.currentTarget) return');
    const keyMods = evt.modifiers.filter((m) => m !== 'prevent' && m !== 'stop' && m !== 'self');
    if (keyMods.length > 0) {
      const guard = compileKeyGuard(keyMods);
      if (guard) bodyParts.push(`if (${guard}) return`);
    }
    bodyParts.push(handlerExpr);
    addStatements.push(`${elVar}.addEventListener('${evt.eventName}', (e) => { ${bodyParts.join('; ')}; })`);
  }

  return { navStatements, addStatements };
};

// ============================================================================
// Key Map & Code Generation
// ============================================================================

/** Map of event modifier names to their corresponding KeyboardEvent.key values */
const KEY_MAP: Record<string, string[]> = {
  enter: ['Enter'],
  tab: ['Tab'],
  delete: ['Backspace', 'Delete'],
  esc: ['Escape'],
  escape: ['Escape'],
  space: [' '],
  up: ['ArrowUp'],
  down: ['ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
};

/**
 * Compile key modifier names into a JS guard expression.
 * Returns `null` if no valid key modifiers are present.
 *
 * The guard uses `&&` so that the early-return fires only when the pressed
 * key matches **none** of the listed keys.  With `||` the condition was a
 * tautology (always true) whenever more than one key was listed.
 *
 * @example compileKeyGuard(['enter', 'tab']) => "e.key !== 'Enter' && e.key !== 'Tab'"
 */
const compileKeyGuard = (modifiers: string[]): string | null => {
  const checks = modifiers
    .map((mod) => {
      const keys = KEY_MAP[mod];
      if (!keys) return null;
      return keys.length === 1 ? `e.key !== '${keys[0]}'` : `!${JSON.stringify(keys)}.includes(e.key)`;
    })
    .filter(Boolean);
  return checks.length > 0 ? checks.join(' && ') : null;
};

/**
 * The DOM write of a simple binding, writing `value`: a camel-cased style property (a custom
 * property, which has no camel-cased name, through setProperty), an attribute, or, for text
 * bindings, the binding's text node (the one after its marker comment).
 */
const simpleWrite = (binding: SimpleBinding, value: string): string => {
  const elRef = binding.id;
  if (binding.type === 'style' && binding.property!.startsWith('--'))
    return `${elRef}.style.setProperty('${binding.property}', ${value})`;
  if (binding.type === 'style') return `${elRef}.style.${toCamelCase(binding.property!)} = ${value}`;
  if (binding.type === 'attr') return attributeWrite(elRef, binding, value);
  return `${elRef}.data = ${value} ?? ''`;
};

/** Generate binding update code for a single simple binding. */
const generateBindingUpdateCode = (binding: SimpleBinding): string => simpleWrite(binding, 'v');

/**
 * The DOM write for an expression binding, as a function of the value expression, keyed on
 * the binding's element/marker variable. Returns undefined for binding kinds with no write.
 */
const expressionWrite = (binding: {
  id: string;
  type: SimpleBinding['type'];
  property?: string | undefined;
  domProperty?: string | undefined;
}): ((value: string) => string) | undefined => {
  if (binding.type === 'text') return (v) => `${binding.id}.data = (${v}) ?? ''`;
  if (binding.type === 'attr' && binding.property) return (v) => attributeWrite(binding.id, binding, v);
  if (binding.type === 'style' && binding.property)
    return (v) => `${binding.id}.style.setProperty('${binding.property}', ${v})`;
  return undefined;
};

/**
 * Generate initial value assignment code for a simple binding
 */
const generateInitialValueCode = (binding: SimpleBinding): string => simpleWrite(binding, `${binding.signalName}()`);

/**
 * Group simple bindings by their signal name for consolidated subscriptions
 */
const groupBindingsBySignal = (bindings: SimpleBinding[]): Map<string, SimpleBinding[]> => {
  const groups = new Map<string, SimpleBinding[]>();
  for (const binding of bindings) {
    const existing = groups.get(binding.signalName) || [];
    existing.push(binding);
    groups.set(binding.signalName, existing);
  }
  return groups;
};

/**
 * Generate a consolidated subscription for multiple bindings of the same signal
 */
const generateConsolidatedSubscription = (signalName: string, bindings: SimpleBinding[]): string => {
  if (bindings.length === 1) {
    const update = generateBindingUpdateCode(bindings[0]!);
    return `${signalName}.subscribe(v => { ${update}; }, true)`;
  }
  const updates = bindings.map((b) => `      ${generateBindingUpdateCode(b)};`).join('\n');
  return `${signalName}.subscribe(v => {\n${updates}\n    }, true)`;
};

/**
 * Turn an event attribute's expression into the listener to register. Arrow functions and
 * plain references are passed through (they receive the event); a call expression such as
 * `navigate('/x')` is wrapped so it runs on the event, not at bind time; modifiers add
 * their guards around the call.
 */
const compileEventHandler = (evt: EventBinding): string => {
  const handlerCode = evt.handlerExpression;
  const hasModifiers = evt.modifiers.length > 0;
  const hasPrevent = evt.modifiers.includes('prevent');
  const hasStop = evt.modifiers.includes('stop');
  const hasSelf = evt.modifiers.includes('self');
  const keyModifiers = evt.modifiers.filter((m) => m !== 'prevent' && m !== 'stop' && m !== 'self');
  const isArrow = parseArrowFunction(handlerCode) !== null;
  const isSimpleRef = /^[a-zA-Z_$][a-zA-Z0-9_$.]*$/.test(handlerCode.trim());
  const isFnCall = !isArrow && !isSimpleRef;

  if (hasModifiers && (hasPrevent || hasStop || hasSelf || keyModifiers.length > 0)) {
    const bodyParts: string[] = [];
    if (hasSelf) bodyParts.push('if (e.target !== e.currentTarget) return;');
    if (keyModifiers.length > 0) {
      const guard = compileKeyGuard(keyModifiers);
      if (guard) bodyParts.push(`if (${guard}) return;`);
    }
    if (hasPrevent) bodyParts.push('e.preventDefault();');
    if (hasStop) bodyParts.push('e.stopPropagation();');
    bodyParts.push(isFnCall ? `${handlerCode};` : `(${handlerCode})(e);`);
    return `(e) => { ${bodyParts.join(' ')} }`;
  }
  return isFnCall ? `() => { ${handlerCode}; }` : handlerCode;
};

/**
 * Generate an initNested function for a conditional/whenElse inside a repeat item.
 * The initNested receives `_c` (the first node of the conditional content), which
 * is already in the DOM by the time initNested is called; bound nodes are reached
 * from it by path (`model` is the content's template).
 */
const generateRepeatNestedCondInitFn = (
  nestedBindings: BindingInfo[],
  nestedEventBindings: EventBinding[],
  outerItemVar: string,
  model: DomModel,
): string => {
  const hasSignalBindings = nestedBindings.length > 0;
  const hasEvents = nestedEventBindings.length > 0;
  if (!hasSignalBindings && !hasEvents) return '() => []';

  const parts: string[] = [];
  parts.push('(_c) => {');
  // Bound elements and text nodes are reached inside the conditional's own content, by path from
  // its first node (A1-2, A1-4)
  const scope = branchScope(model, '  ');
  const simpleNested = nestedBindings.filter(isSimpleBinding);
  const exprNested = nestedBindings.filter(isExpressionBinding);
  const target = (b: BindingInfo): string =>
    b.type === 'text' ? scope.text(b.id, `_n_${b.id}`) : scope.at(b.id, `_n_${b.id}`);
  // Elements first: a text node's path can then start from one of them
  for (const b of nestedBindings) if (b.type !== 'text') target(b);
  const eventTargets = nestedEventBindings.map((evt) => scope.at(evt.elementId, `_n_${evt.elementId}`));
  for (const b of nestedBindings) if (b.type === 'text') target(b);
  parts.push(...scope.head);
  // A signal binding's write, of `value`
  const write = (sb: SimpleBinding, value: string): string => {
    const el = `_n_${sb.id}`;
    if (sb.type === 'text') return `${el}.data = ${value} ?? ''`;
    if (sb.type === 'attr' && sb.property) return attributeWrite(el, sb, value);
    if (sb.type === 'style' && sb.property) return `${el}.style.setProperty('${sb.property}', ${value})`;
    return '';
  };
  // Initial values for signal bindings
  for (const sb of simpleNested) {
    const w = write(sb, `${sb.signalName === outerItemVar ? 'item' : sb.signalName}()`);
    if (w) parts.push(`  ${w};`);
  }
  // Expression bindings: first write here, guarded re-writes in the subscriptions below
  const exprNestedWrites = new Map<ExpressionBinding, GuardedWrite>();
  for (const eb of exprNested) {
    const renamedExpr = renameIdentifierInExpression(eb.expression, outerItemVar, 'item');
    const w = expressionWrite({ ...eb, id: `_n_${eb.id}` });
    if (!w) continue;
    const gw = guardedWrite(`_pv_${eb.id}`, w, renamedExpr);
    exprNestedWrites.set(eb, gw);
    parts.push(`  let _pv_${eb.id}; ${gw.fill};`);
  }
  parts.push('  const _nsubs = [];');
  // Subscriptions for signal bindings
  const renamedSimpleNested = simpleNested.map((sb) => ({
    ...sb,
    signalName: sb.signalName === outerItemVar ? 'item' : sb.signalName,
  }));
  for (const [signalName, sbs] of groupBindingsBySignal(renamedSimpleNested)) {
    const updates = sbs.map((sb) => write(sb, 'v')).filter(Boolean);
    if (updates.length > 0) {
      parts.push(`  _nsubs.push(${signalName}.subscribe(v => { ${updates.join('; ')}; }, true));`);
    }
  }
  for (const eb of exprNested) {
    const gw = exprNestedWrites.get(eb);
    if (!gw) continue;
    const updFn = `() => { ${gw.update}; }`;
    for (const sig of eb.signalNames) {
      const renamedSig = sig === outerItemVar ? 'item' : sig;
      parts.push(`  _nsubs.push(${renamedSig}.subscribe(${updFn}, true));`);
    }
  }
  // Listeners inside the content: reached inside the content and discarded with it
  nestedEventBindings.forEach((evt, i) => {
    parts.push(`  ${eventTargets[i]}.addEventListener('${evt.eventName}', ${compileEventHandler(evt)});`);
  });
  parts.push('  return _nsubs;');
  parts.push('}');
  return parts.join('\n');
};

/** A when() condition that is a bare signal read (`show()`): bound by `__bindIf` on the signal itself. */
const isSimpleConditional = (cond: ConditionalBlock): boolean =>
  cond.signalNames.length === 1 && cond.jsExpression === `${cond.signalName}()`;

/**
 * Generate the body of the component's binding function (`__b`) and the static templates.
 * Child components are mounted where their anchor is: the top-level ones by the body itself,
 * the others by the directive that contains them. `helpers` holds every runtime helper the
 * generated code calls, so that the component imports exactly those.
 */
export const generateInitBindingsFunction = (
  bindings: BindingInfo[],
  conditionals: ConditionalBlock[],
  whenElseBlocks: WhenElseBlock[] = [],
  repeatBlocks: RepeatBlock[] = [],
  eventBindings: EventBinding[] = [],
  emit: EmitOptions,
  childMountsByDirective?: Map<string, { cm: ChildMountInfo; globalIndex: number }[]>,
  topLevelChildMounts: { cm: ChildMountInfo; globalIndex: number }[] = [],
  componentTemplate = '',
  childHosts: ReadonlySet<string> = new Set(),
): GeneratedInitBindingsArtifact => {
  const lines: string[] = [];
  // The component template's elements, by position (A1-2)
  const top = componentScope(modelOf(componentTemplate, emit));
  const staticTemplates: string[] = []; // Collect static templates for repeat optimizations
  const helpers = new Set<RuntimeHelperName>();
  /** A runtime helper's name, recorded as used where the call to it is emitted. */
  const use = (helper: RuntimeHelperName): RuntimeHelperName => {
    helpers.add(helper);
    return helper;
  };

  // A child component, mounted where its placeholder was (A1-4): into its host element when the host
  // is in the template (see child-hosts.ts), otherwise into a new host that replaces its anchor
  // comment. `setup` holds the statements, `cleanup` the expression that mounts it and returns its
  // destroy function; the host and the anchor are reached through `scope`.
  const mountChild = (
    { cm, globalIndex }: { cm: ChildMountInfo; globalIndex: number },
    indent: string,
    scope: NavScope,
    itemVar?: string,
  ): { setup: string[]; cleanup: string } => {
    const varName = `_cm${globalIndex}`;
    // Step 10: the row's item is `item` in the row factory; its index keeps the developer's name
    const props = itemVar ? renameIdentifierInExpression(cm.propsExpression, itemVar, 'item') : cm.propsExpression;
    const mount = (host: string) => `${use(BIND_FN.DESTROY_CHILD)}(${cm.componentName}.__f(${host}, ${props}))`;
    if (childHosts.has(cm.anchorId)) return { setup: [], cleanup: mount(scope.at(cm.anchorId, varName)) };
    const anchor = scope.at(`${cm.anchorId}.`, `_cma${globalIndex}`);
    return {
      setup: [
        `${indent}const ${varName} = document.createElement('${emit.selector(cm.selector)}');`,
        `${indent}${anchor}.replaceWith(${varName});`,
      ],
      cleanup: mount(varName),
    };
  };
  // The children inside one directive's template (a branch or a row), mounted by its code
  const generateMountInfo = (
    directiveId: string,
    indent: string,
    scope: NavScope,
    itemVar?: string,
  ): { setupLines: string[]; cleanupExprs: string[] } => {
    const setupLines: string[] = [];
    const cleanupExprs: string[] = [];
    for (const mount of childMountsByDirective?.get(directiveId) ?? []) {
      const { setup, cleanup } = mountChild(mount, indent, scope, itemVar);
      setupLines.push(...setup);
      cleanupExprs.push(cleanup);
    }
    return { setupLines, cleanupExprs };
  };

  const buildEventListenerStatements = (events: EventBinding[], scope: NavScope): string[] =>
    events.map(
      (evt) =>
        `${scope.at(evt.elementId, evt.elementId)}.addEventListener('${evt.eventName}', ${compileEventHandler(evt)});`,
    );
  // Events inside when() content (and whenElse branches nested in it) are bound by the branch
  // initializer, not at the top level. Row events belong to the row generator.
  const conditionalEventIds = new Set<string>();
  const addEventIds = (events: EventBinding[]) => events.forEach((evt) => conditionalEventIds.add(evt.id));
  walkDirectives(
    { conditionals },
    {
      cond: (cond) => addEventIds(cond.nestedEventBindings),
      whenElse: (we) => addEventIds([...we.thenEventBindings, ...we.elseEventBindings]),
      repeat: () => false,
    },
  );
  // Collect top-level subscription unsubscribe handles for cleanup on destroy
  lines.push(`    const _subs = [];`);
  const topLevelBindings = bindings.filter((b) => !b.isInsideConditional);
  // Separate expression bindings (multi-signal) from simple bindings
  const simpleBindings = topLevelBindings.filter(isSimpleBinding);
  const expressionBindings = topLevelBindings.filter(isExpressionBinding);
  // Each bound node by path (A1-2, A1-4): a text binding's text node is declared in the head, an
  // element is `_ns[i]`
  for (const id of new Set(topLevelBindings.map((b) => b.id))) {
    if (topLevelBindings.some((b) => b.id === id && b.type === 'text')) top.text(id, id);
    else lines.push(`    const ${id} = ${top.at(id, id)};`);
  }
  // Simple bindings: initial value assignment + consolidated subscription
  for (const binding of simpleBindings) {
    lines.push(`    ${generateInitialValueCode(binding)};`);
  }
  const signalGroups = groupBindingsBySignal(simpleBindings);
  for (const [signalName, signalBindings] of signalGroups) {
    lines.push(`    _subs.push(${generateConsolidatedSubscription(signalName, signalBindings)});`);
  }
  // Expression bindings: multi-subscribe pattern
  // e.g. const _upd_b2 = () => { b2.data = count() + 1; };
  //      count.subscribe(_upd_b2, true);
  expressionBindings.forEach((binding, idx) => {
    const updFn = `_upd_${binding.id}_${idx}`;
    const expr = binding.expression;
    const signals = binding.signalNames;
    // The expression re-runs whenever any of its signals change; the guard skips the DOM
    // write when the result is unchanged.
    const write = expressionWrite({ ...binding, id: binding.id });
    if (!write) return;
    const guard = `_pv_${binding.id}_${idx}`;
    lines.push(`    let ${guard}; const ${updFn} = () => { ${guardedWrite(guard, write, expr).update}; };`);
    lines.push(`    ${updFn}();`);
    for (const sig of signals) {
      lines.push(`    _subs.push(${sig}.subscribe(${updFn}, true));`);
    }
  });

  // The call that binds a when() block between its two anchors (reached through `scope`):
  // `__bindIf` for a bare signal read, otherwise `__bindIfExpr` over every signal the condition
  // reads. Callers add their wrapper.
  const whenCall = (cond: ConditionalBlock, initCode: string, scope: NavScope): string => {
    const template = escapeTemplateLiteral(stripMarks(emit.html(cond.templateContent)));
    const range = `${scope.at(`${cond.id}(`, `_ws_${cond.id}`)}, ${scope.at(`${cond.id})`, `_we_${cond.id}`)}`;
    if (isSimpleConditional(cond)) {
      return `${use(BIND_FN.IF)}(${range}, ${cond.signalName}, \`${template}\`, ${initCode})`;
    }
    const signals = cond.signalNames.join(', ');
    return `${use(BIND_FN.IF_EXPR)}(${range}, [${signals}], () => ${cond.jsExpression}, \`${template}\`, ${initCode})`;
  };

  // The two `__bindIfExpr` calls that bind a whenElse() block over its three anchors: the then
  // branch between the first two on the condition, the else branch between the last two on its
  // negation. Callers add their wrapper.
  const whenElseCalls = (we: WhenElseBlock, thenInit: string, elseInit: string, scope: NavScope): [string, string] => {
    const signals = we.signalNames.join(', ');
    const [start, middle, end] = (['(', '|', ')'] as const).map((kind, i) =>
      scope.at(`${we.thenId}${kind}`, `_w${'sme'[i]}_${we.thenId}`),
    );
    const call = (range: string, condition: string, template: string, init: string) =>
      `${use(BIND_FN.IF_EXPR)}(${range}, [${signals}], () => ${condition}, \`${escapeTemplateLiteral(stripMarks(emit.html(template)))}\`, ${init})`;
    return [
      call(`${start}, ${middle}`, we.jsExpression, we.thenTemplate, thenInit),
      call(`${middle}, ${end}`, `!(${we.jsExpression})`, we.elseTemplate, elseInit),
    ];
  };

  // A list's source, after its reconciler: the `_items_` thunk, the optional empty-template
  // sync, the initial reconcile, one subscription per source signal into `_subs`, and the
  // reconciler's clearAll.
  const emitListSource = (
    rep: RepeatBlock,
    reconcilerVar: string,
    containerVar: string,
    anchorVar: string,
    lines: string[],
  ): void => {
    const itemsVar = `_items_${rep.id}`;
    const emptyVar = `_empty_${rep.id}`;
    const syncVar = `_syncEmpty_${rep.id}`;
    lines.push(`    const ${itemsVar} = () => ${rep.itemsExpression};`);
    if (rep.emptyTemplate) {
      const escapedEmptyTemplate = escapeTemplateLiteral(emit.html(rep.emptyTemplate));
      lines.push(`    let ${emptyVar};`);
      lines.push(
        `    const ${syncVar} = (items) => { items.length ? ${emptyVar}?.remove() : ${containerVar}.insertBefore(${emptyVar} ??= _T(\`${escapedEmptyTemplate}\`).content.firstElementChild, ${anchorVar}); };`,
      );
    }
    lines.push(`    ${reconcilerVar}.reconcile(${itemsVar}());`);
    if (rep.emptyTemplate) lines.push(`    ${syncVar}(${itemsVar}());`);
    const onChange = rep.emptyTemplate
      ? `const items = ${itemsVar}(); ${reconcilerVar}.reconcile(items); ${syncVar}(items);`
      : `${reconcilerVar}.reconcile(${itemsVar}());`;
    buildRepeatSubscriptionSources(rep).forEach((source, sourceIdx) => {
      const sourceVar = `_rsrc_${rep.id}_${sourceIdx}`;
      lines.push(`    const ${sourceVar} = ${source};`);
      lines.push(
        `    _subs.push(typeof ${sourceVar}?.subscribe === 'function' ? ${sourceVar}.subscribe(() => { ${onChange} }, true) : () => {});`,
      );
    });
    // When the scope ends (destroy, or a branch hiding), the rows' own cleanups run too (H-28)
    lines.push(`    _subs.push(() => ${reconcilerVar}.clearAll());`);
  };

  // A row's bindings to component signals: navigation to each bound element (`<prefix>N`), the
  // first writes, and one subscription per signal into the row's cleanups. Attribute and style
  // bindings are reached by element path; a text binding's text node (`<prefix>tN`) through the
  // row's scope, which declares it in its head. The options name the scope's variables (outer rows
  // and nested rows use different names).
  const emitRowSignalBindings = (
    staticInfo: StaticTemplateInfo,
    scope: { row: string; prefix: string; cleanups: string; nodes: NavScope },
  ): { nav: string[]; fill: string[]; subscriptions: string[] } => {
    const nav: string[] = [];
    const fill: string[] = [];
    const subscriptions: string[] = [];
    const bind = (write: string, signalNames: string[] | undefined, signalName: string) => {
      fill.push(write);
      for (const s of signalNames ?? [signalName]) {
        subscriptions.push(`${scope.cleanups}.push(${s}.subscribe(() => { ${write}; }, true))`);
      }
    };
    (staticInfo.signalElementBindings ?? []).forEach((sb, i) => {
      const varName = `${scope.prefix}${i}`;
      nav.push(`const ${varName} = ${sb.path.length === 0 ? scope.row : pathToSiblingNav(scope.row, sb.path)}`);
      const signalCall = sb.expression ?? `${sb.signalName}()`;
      // Only attr/style — text bindings use signalCommentBindings
      if (sb.type === 'attr' && sb.property) {
        bind(attributeWrite(varName, sb, signalCall), sb.signalNames, sb.signalName);
      } else if (sb.type === 'style' && sb.property) {
        bind(`${varName}.style.setProperty('${sb.property}', ${signalCall})`, sb.signalNames, sb.signalName);
      }
    });
    (staticInfo.signalCommentBindings ?? []).forEach((scb, i) => {
      const text = scope.nodes.text(scb.commentId, `${scope.prefix}t${i}`);
      const signalCall = scb.expression ?? `${scb.signalName}()`;
      bind(`${text}.data = ${signalCall} ?? ''`, scb.signalNames, scb.signalName);
    });
    return { nav, fill, subscriptions };
  };

  // One repeat() list: the anchor lookup, the row template, the row factory and the
  // subscriptions, written as statements into `lines`. Component-level lists write straight
  // into the binding function; a list inside a when()/whenElse() branch writes into that
  // branch's initializer, where a block-scoped `_subs` collects its unsubscribes.
  const emitRepeat = (rep: RepeatBlock, lines: string[], scope: NavScope): void => {
    // The list's anchor comment, reached through the scope, which declares it in its head (A1-4)
    const anchorLine = (anchorVar: string): void => void scope.at(`${rep.id}.`, anchorVar);
    const indexVar = rep.indexVar || '_idx';
    const hasNestedRepeats = rep.nestedRepeats.length > 0;
    const hasNestedConditionals = rep.nestedConditionals.length > 0;
    const hasItemEvents = rep.itemEvents.length > 0;

    // A row that is a child component call (`(item) => Card({ item })`) has no markup of its
    // own: each row mounts the component into a host element.
    const directRepeatComponent = childMountsByDirective?.get(rep.id) ? null : rep.componentRow;
    if (directRepeatComponent) {
      const anchorVar = `_a_${rep.id}`;
      const containerVar = `_ct_${rep.id}`;
      const reconcilerVar = `_rc_${rep.id}`;
      let propsExpr = directRepeatComponent.propsExpression;
      propsExpr = renameIdentifierInExpression(propsExpr, rep.itemVar, 'item');

      anchorLine(anchorVar);
      lines.push(`    const ${containerVar} = ${anchorVar}.parentNode;`);
      lines.push(`    const ${reconcilerVar} = ${use(BIND_FN.KEYED_RECONCILER)}(${containerVar}, ${anchorVar},`);
      lines.push(`      (item, ${indexVar}, _ref) => {`);
      lines.push(`        const _el = document.createElement('div');`);
      lines.push(`        _insertBefore.call(${containerVar}, _el, _ref);`);
      lines.push(
        `        return { el: _el, cleanups: [${use(BIND_FN.DESTROY_CHILD)}(${directRepeatComponent.componentName}.__f(_el, ${propsExpr}))], value: item, update: () => {} };`,
      );
      lines.push(`      },`);
      lines.push(`    ${keyArg(rep)});`);
      emitListSource(rep, reconcilerVar, containerVar, anchorVar, lines);
      return;
    }

    {
      // Use optimized template-based approach
      const staticInfo = generateStaticRepeatTemplate(
        rep.itemTemplate,
        rep.itemBindings,
        rep.itemEvents,
        rep.signalBindings,
      );
      // The row's text nodes, directive and list anchors and child hosts, reached from `_el` by
      // path in the row template as emitted (A1-3, A1-4). Every one is declared (the scope's head)
      // before the row's first write.
      const rowModel = modelOf(staticInfo.staticHtml, emit);
      const rowScope = createScope(rowModel, '        ', [{ node: rowModel.roots[0]!, expr: '_el', cost: 2 }]);

      const hasCommentBindings = rep.itemBindings.some(
        (b) => b.type === 'text' && b.textBindingMode === 'commentMarker',
      );
      const hasSignalCommentBindings = (staticInfo.signalCommentBindings?.length ?? 0) > 0;
      const hasAnyBindings =
        staticInfo.elementBindings.length > 0 ||
        hasCommentBindings ||
        hasSignalCommentBindings ||
        (staticInfo.signalElementBindings?.length ?? 0) > 0 ||
        (staticInfo.mixedSignalItemBindings?.length ?? 0) > 0 ||
        hasItemEvents ||
        hasNestedConditionals ||
        hasNestedRepeats ||
        rep.nestedWhenElse.length > 0;

      if (hasAnyBindings) {
        // Generate static template identifier
        const templateId = `__tpl_${rep.id}`;

        // Generate static template IIFE
        staticTemplates.push(
          `  const ${templateId} = _T(\`${escapeTemplateLiteral(stripMarks(emit.html(staticInfo.staticHtml)))}\`);`,
        );

        // Fully inlined repeat — inline navigation code, no runtime navigatePath
        // Generate inlined navigation code for each bound element
        const navVarNames: string[] = [];
        const navStatements: string[] = [];
        const navExprs: string[] = [];
        for (let i = 0; i < staticInfo.elementBindings.length; i++) {
          const eb = staticInfo.elementBindings[i]!;
          const varName = `_e${i}`;
          navVarNames.push(varName);
          const expr = eb.path.length === 0 ? '_el' : pathToSiblingNav('_el', eb.path);
          navExprs.push(expr);
          navStatements.push(`const ${varName} = ${expr}`);
        }
        // Optimize: reuse earlier navigation variables for shared path prefixes
        // e.g., _e0 = _el.firstElementChild, _e1 = _el.firstElementChild.nextElementSibling.firstElementChild
        // becomes _e1 = _e0.nextElementSibling.firstElementChild (saves one DOM property access per row)
        for (let j = 1; j < navExprs.length; j++) {
          for (let i = j - 1; i >= 0; i--) {
            const prefix = navExprs[i]!;
            if (navExprs[j]!.startsWith(prefix + '.')) {
              const suffix = navExprs[j]!.substring(prefix.length);
              navStatements[j] = `const ${navVarNames[j]} = ${navVarNames[i]}${suffix}`;
              break;
            }
          }
        }

        // Generate fill statements using inlined var names. Every write is redundancy-guarded:
        // the row keeps the last value written per binding and skips writes that would not
        // change the DOM (see guardedWrite).
        const guards = createGuardAllocator('_p');
        const fillStatements: string[] = [];
        const updateStatements: string[] = [];
        // Lean rows keep guard state on the managed record and share one update function;
        // these are the same updates written against the record, plus the record's fields.
        const leanUpdateStatements: string[] = [];
        const leanCommentUpdateStatements: string[] = [];
        const textVars: string[] = [];
        const commentVars: string[] = [];
        let textNodeCount = 0;
        for (let i = 0; i < staticInfo.elementBindings.length; i++) {
          const eb = staticInfo.elementBindings[i]!;
          const varName = navVarNames[i]!;
          for (const binding of eb.bindings) {
            const expr = renameIdentifierInExpression(binding.expression, rep.itemVar, 'item');
            let gw: GuardedWrite | undefined;
            if (binding.type === 'text') {
              // Sole-content text bindings: the element is empty in the static template and the
              // fill writes textContent, the cheapest way to create the Text node. The first
              // guarded update resolves that node lazily (`??=`) and every update writes its
              // nodeValue: a string store on an existing node instead of textContent discarding
              // the child and allocating a new one per write. Rows that never update never pay
              // the read; an empty value leaves no node, so the update falls back to textContent
              // and resolves again next time.
              const textVar = `_t${textNodeCount++}`;
              textVars.push(textVar);
              const guard = guards.next();
              const textUpdate = (g: string, t: string, target: string): string =>
                `if (${g} !== (${g} = ${expr})) (${t} ??= ${target}.firstChild) ? (${t}.nodeValue = ${g} ?? '') : (${target}.textContent = ${g} ?? '')`;
              gw = {
                fill: `${varName}.textContent = (${guard} = ${expr}) ?? ''; let ${textVar}`,
                update: textUpdate(guard, textVar, varName),
              };
              // The shared update navigates only when a binding actually changes, and the text
              // node cache on the record makes that a one-time cost per row
              leanUpdateStatements.push(textUpdate(recordField(guard), recordField(textVar), navExprs[i]!));
            } else if (binding.type === 'attr' && binding.property) {
              const guard = guards.next();
              const write = (v: string) => attributeWrite(varName, binding, v);
              gw = guardedWrite(guard, write, expr, binding.staticValue);
              const leanWrite = (v: string) => attributeWrite(navExprs[i]!, binding, v);
              leanUpdateStatements.push(
                guardedWrite(guard, leanWrite, expr, binding.staticValue, recordField(guard)).update,
              );
            }
            if (gw) {
              fillStatements.push(gw.fill);
              updateStatements.push(gw.update);
            }
          }
        }

        // Comment-marker item bindings (mixed-content text bindings)
        const commentBindings = rep.itemBindings.filter(
          (b) => b.type === 'text' && b.textBindingMode === 'commentMarker',
        );
        const commentFillStatements: string[] = [];
        const commentUpdateStatements: string[] = [];
        commentBindings.forEach((cb, i) => {
          const expr = renameIdentifierInExpression(cb.expression, rep.itemVar, 'item');
          // The text node after the marker, reached by path once per row; fill and update write to it
          const textVar = rowScope.text(cb.elementId, `_c${i}`);
          commentVars.push(textVar);
          const guard = guards.next();
          const gw = guardedWrite(guard, (v) => `${textVar}.data = (${v}) ?? ''`, expr);
          commentFillStatements.push(gw.fill);
          commentUpdateStatements.push(gw.update);
          const rec = recordField(textVar);
          leanCommentUpdateStatements.push(
            guardedWrite(guard, (v) => `${rec}.data = (${v}) ?? ''`, expr, undefined, recordField(guard)).update,
          );
        });

        // Signal binding navigation and fill (Step 13), and signal text bindings (Step 13b)
        const {
          nav: signalNavStatements,
          fill: signalFillStatements,
          subscriptions: signalSubscriptions,
        } = emitRowSignalBindings(staticInfo, { row: '_el', prefix: '_s', cleanups: '_cleanups', nodes: rowScope });

        // Mixed signal+item binding navigation, fill, subscription & update (Step 13c)
        const mixedNavStatements: string[] = [];
        const mixedFillStatements: string[] = [];
        const mixedUpdateStatements: string[] = [];
        // Selection bindings are lifted out of the row: one subscription per list (emitted after
        // the reconciler exists) instead of one per row
        const selectionSubscriptions: string[] = [];
        // In a row whose when()/whenElse() content comes and goes, positions are only known when the
        // row is created: selection bindings, which a list-level subscription reaches later by
        // position, stay per row there (A1-3)
        const rowHasRanges = hasNestedConditionals || rep.nestedWhenElse.length > 0;
        const mixedKeyProp = rep.trackByFn && !rowHasRanges ? extractKeyProperty(rep.trackByFn) : null;
        if (staticInfo.mixedSignalItemBindings && staticInfo.mixedSignalItemBindings.length > 0) {
          for (let i = 0; i < staticInfo.mixedSignalItemBindings.length; i++) {
            const mb = staticInfo.mixedSignalItemBindings[i]!;
            const varName = `_m${i}`;
            // Navigation — check if an existing nav var points to the same path
            const pathKey = JSON.stringify(mb.path);
            let reuseVar: string | undefined;
            for (let j = 0; j < staticInfo.elementBindings.length; j++) {
              if (JSON.stringify(staticInfo.elementBindings[j]!.path) === pathKey) {
                reuseVar = navVarNames[j];
                break;
              }
            }
            if (reuseVar) {
              mixedNavStatements.push(`const ${varName} = ${reuseVar}`);
            } else if (mb.path.length === 0) {
              mixedNavStatements.push(`const ${varName} = _el`);
            } else {
              mixedNavStatements.push(`const ${varName} = ${pathToSiblingNav('_el', mb.path)}`);
            }
            const expr = renameIdentifierInExpression(mb.expression, rep.itemVar, 'item');
            const selection =
              mb.type === 'attr' && mb.property ? matchSelectionBinding(expr, mb.outerSignalNames, mixedKeyProp) : null;
            if (selection) {
              // Fill on creation only (guarded, so an empty class skips the write); the list-level
              // subscription owns every later change, and a data update cannot change the value
              // because the row's key is constant
              mixedFillStatements.push(
                guardedWrite(guards.next(), (v) => attributeWrite(varName, mb, v), expr, mb.staticValue).fill,
              );
              selectionSubscriptions.push(
                buildSelectionSubscription(rep.id, i, selection, mb.path, (target, value) =>
                  attributeWrite(target, mb, value),
                ),
              );
              continue;
            }
            let gw: GuardedWrite | undefined;
            if (mb.type === 'attr' && mb.property) {
              gw = guardedWrite(guards.next(), (v) => attributeWrite(varName, mb, v), expr, mb.staticValue);
            } else if (mb.type === 'text') {
              gw = guardedWrite(guards.next(), (v) => `${varName}.textContent = (${v}) ?? ''`, expr);
            } else if (mb.type === 'style' && mb.property) {
              gw = guardedWrite(guards.next(), (v) => `${varName}.style.setProperty('${mb.property}', ${v})`, expr);
            }
            if (gw) {
              mixedFillStatements.push(gw.fill);
              mixedUpdateStatements.push(gw.update);
              // Per-item subscription: re-evaluate the expression when an outer signal changes.
              // 'item' is captured in the createItem closure — correct per-row value. The guard
              // means a signal change that leaves this row's value alone costs no DOM write.
              for (const sigName of mb.outerSignalNames) {
                signalSubscriptions.push(`_cleanups.push(${sigName}.subscribe(() => { ${gw.update}; }, true))`);
              }
            }
          }
        }

        // Key function and empty template are handled inline below

        // Generate the inlined repeat setup
        const tplContentVar = `_tc_${rep.id}`;
        const anchorVar = `_a_${rep.id}`;
        const containerVar = `_ct_${rep.id}`;
        const reconcilerVar = `_rc_${rep.id}`;

        lines.push(`    const ${tplContentVar} = ${templateId}.content.firstElementChild;`);
        anchorLine(anchorVar);
        lines.push(`    const ${containerVar} = ${anchorVar}.parentNode;`);
        // Partition item events into delegated (container listener) vs non-delegatable (per-item)
        const { delegatedByType: delegatedEventsByType, nonDelegatable: nonDelegatableEvents } = hasItemEvents
          ? partitionItemEvents(rep.itemEvents, staticInfo.eventElementPaths, rep, indexVar)
          : { delegatedByType: new Map<string, DelegatedEvent[]>(), nonDelegatable: [] as ItemEventBinding[] };

        // A row with ranges keeps each delegated element on the row (`_el.__eN`, set at creation),
        // because the delegated listener cannot find it by position later (A1-3)
        const capturedEvents = new Map<DelegatedEvent, string>();
        if (rowHasRanges) {
          for (const events of delegatedEventsByType.values()) {
            for (const evt of events) if (evt.path.length > 0) capturedEvents.set(evt, `__e${capturedEvents.size}`);
          }
        }
        // Build delegated listener code (emitted AFTER reconciler creation)
        const delegatedListenerStatements = buildDelegatedListenerStatements(
          delegatedEventsByType,
          containerVar,
          capturedEvents,
        );

        // Handle non-delegatable events (e.g., .self modifier) with per-item listeners
        const { navStatements: eventNavStatements, addStatements: eventAddStatements } =
          buildNonDelegatableEventStatements(
            nonDelegatableEvents,
            staticInfo.eventElementPaths,
            staticInfo.elementBindings,
            navVarNames,
            rep,
            indexVar,
          );

        // Determine if we need to store item data on the element for delegation
        const useDelegation = delegatedEventsByType.size > 0;

        // Always use createKeyedReconciler — when no trackBy, inject (_, i) => i
        const keyFnExpr = keyArg(rep);

        const repMountInfo = generateMountInfo(rep.id, '        ', rowScope, rep.itemVar);
        const hasRepMounts = repMountInfo.cleanupExprs.length > 0;
        const hasSignalSubs = signalSubscriptions.length > 0;
        const needsCleanups =
          hasSignalSubs || hasNestedConditionals || hasNestedRepeats || rep.nestedWhenElse.length > 0 || hasRepMounts;

        const updateParts = [...updateStatements, ...commentUpdateStatements, ...mixedUpdateStatements];
        if (useDelegation) {
          updateParts.push('_el.__d = item');
        }
        // Row-scoped signals for nested directives (see createRowRefRewriter in repeat-analysis)
        const rowSignalVars = rep.rowSignalVars ?? [];
        const hasIndexSignal = rowSignalVars.includes(`${indexVar}$`);
        // A list whose bindings read the index asks the reconciler to refresh rows that move
        const usesIndex =
          hasIndexSignal ||
          (!!rep.indexVar && rep.itemBindings.some((b) => expressionReferencesIdentifier(b.expression, rep.indexVar!)));
        for (const v of rowSignalVars) {
          updateParts.push(`${v}(${v === `${rep.itemVar}$` ? 'item' : indexVar})`);
        }

        // Rows that need no cleanups (no per-row subscriptions, nested directives or child mounts)
        // are bound by a standalone function, so the reconciler can clone them in batches of
        // ROW_BATCH_SIZE and bind each cloned row; the single-row factory clones, binds and inserts.
        const batchRows = !needsCleanups;
        if (batchRows) {
          lines.push(`    const _bind_${rep.id} = (_el, item, ${indexVar}) => {`);
        } else {
          lines.push(`    const ${reconcilerVar} = ${use(BIND_FN.KEYED_RECONCILER)}(${containerVar}, ${anchorVar},`);
          lines.push(`      (item, ${indexVar}, _ref) => {`);
          lines.push(`        const _el = _cloneNode.call(${tplContentVar}, true);`);
        }
        if (useDelegation) {
          lines.push(`        _el.__d = item;`);
        }
        for (const [evt, prop] of capturedEvents)
          lines.push(`        _el.${prop} = ${pathToSiblingNav('_el', evt.path)};`);
        for (const v of rowSignalVars) {
          lines.push(`        const ${v} = ${use(BIND_FN.SIGNAL)}(${v === `${rep.itemVar}$` ? 'item' : indexVar});`);
        }
        for (const navStmt of navStatements) {
          lines.push(`        ${navStmt};`);
        }
        // Nested conditionals (Step 14) and lists (Step 15): the row reaches each one's anchors from
        // `_el`. A directive that shows changes the row, so they are declared with the rest.
        // A whenElse() or list inside a row's when() is collected as the row's too, but its anchors
        // are in the when()'s content, not in the row: it is skipped, as before A1 (H-18, P20: RW's).
        const inRow = (id: string, kind: '(' | '.') => staticInfo.staticHtml.includes(anchorMark(id, kind));
        const directiveCalls: string[] = [];
        for (const cond of rep.nestedConditionals) {
          const condInitNested = generateRepeatNestedCondInitFn(
            cond.nestedBindings,
            cond.nestedEventBindings,
            rep.itemVar,
            modelOf(cond.templateContent, emit),
          );
          directiveCalls.push(`        _cleanups.push(${whenCall(cond, condInitNested, rowScope)});`);
        }
        // Nested whenElse codegen (Step 14)
        for (const we of rep.nestedWhenElse.filter((w) => inRow(w.thenId, '('))) {
          const thenInitFn = generateRepeatNestedCondInitFn(
            we.thenBindings,
            [],
            rep.itemVar,
            modelOf(we.thenTemplate, emit),
          );
          const elseInitFn = generateRepeatNestedCondInitFn(
            we.elseBindings,
            [],
            rep.itemVar,
            modelOf(we.elseTemplate, emit),
          );
          for (const call of whenElseCalls(we, thenInitFn, elseInitFn, rowScope)) {
            directiveCalls.push(`        _cleanups.push(${call});`);
          }
        }
        const rowLists = rep.nestedRepeats.filter((nr) => inRow(nr.id, '.'));
        for (const nr of rowLists) rowScope.at(`${nr.id}.`, `_nrA_${nr.id}`);
        lines.push(...rowScope.head);
        for (const navStmt of signalNavStatements) {
          lines.push(`        ${navStmt};`);
        }
        for (const navStmt of eventNavStatements) {
          lines.push(`        ${navStmt};`);
        }
        for (const navStmt of mixedNavStatements) {
          lines.push(`        ${navStmt};`);
        }
        if (guards.vars.length > 0) {
          lines.push(`        ${guards.declaration()}`);
        }
        lines.push(`        ${fillStatements.join('; ')};`);
        if (commentFillStatements.length > 0) {
          lines.push(`        ${commentFillStatements.join('; ')};`);
        }
        if (signalFillStatements.length > 0) {
          lines.push(`        ${signalFillStatements.join('; ')};`);
        }
        if (mixedFillStatements.length > 0) {
          lines.push(`        ${mixedFillStatements.join('; ')};`);
        }
        if (eventAddStatements.length > 0) {
          lines.push(`        ${eventAddStatements.join('; ')};`);
        }
        if (!batchRows) {
          lines.push(`        _insertBefore.call(${containerVar}, _el, _ref);`);
        }
        for (const sl of repMountInfo.setupLines) {
          lines.push(sl);
        }
        if (needsCleanups) {
          lines.push(`        const _cleanups = [];`);
          for (const ce of repMountInfo.cleanupExprs) {
            lines.push(`        _cleanups.push(${ce});`);
          }
          for (const sub of signalSubscriptions) {
            lines.push(`        ${sub};`);
          }
        }
        lines.push(...directiveCalls);
        // Nested repeat codegen (Step 15)
        for (const nr of rowLists) {
          lines.push(`        const _nrC_${nr.id} = _nrA_${nr.id}.parentNode;`);
          // Generate inner static template
          const innerStaticInfo = generateStaticRepeatTemplate(
            nr.itemTemplate,
            nr.itemBindings,
            nr.itemEvents,
            nr.signalBindings,
          );
          const innerTplId = `__tpl_${nr.id}`;
          staticTemplates.push(
            `  const ${innerTplId} = _T(\`${escapeTemplateLiteral(stripMarks(emit.html(innerStaticInfo.staticHtml)))}\`);`,
          );
          const innerIndexVar = nr.indexVar || '_idx';
          // The inner row's text nodes, by path from `_nrEl` (A1-4)
          const innerModel = modelOf(innerStaticInfo.staticHtml, emit);
          const innerScope = createScope(innerModel, '            ', [
            { node: innerModel.roots[0]!, expr: '_nrEl', cost: 2 },
          ]);
          lines.push(`        const _nrTc_${nr.id} = ${innerTplId}.content.firstElementChild;`);
          lines.push(`        const _nrRc_${nr.id} = ${use(BIND_FN.KEYED_RECONCILER)}(_nrC_${nr.id}, _nrA_${nr.id},`);
          lines.push(`          (_nrItem, ${innerIndexVar}, _nrRef) => {`);
          lines.push(`            const _nrEl = _cloneNode.call(_nrTc_${nr.id}, true);`);
          // Inner comment-marker item bindings (mixed-content text bindings), and inner signal
          // bindings (Step 13 for nested repeats)
          const innerCommentFillStatements: string[] = [];
          const innerCommentUpdateStatements: string[] = [];
          nr.itemBindings
            .filter((b) => b.type === 'text' && b.textBindingMode === 'commentMarker')
            .forEach((cb, i) => {
              const expr = renameIdentifierInExpression(cb.expression, nr.itemVar, '_nrItem');
              const text = innerScope.text(cb.elementId, `_nrc${i}`);
              innerCommentFillStatements.push(`${text}.data = (${expr}) ?? ''`);
              innerCommentUpdateStatements.push(`${text}.data = (${expr}) ?? ''`);
            });
          const {
            nav: innerSignalNavStatements,
            fill: innerSignalFillStatements,
            subscriptions: innerSignalSubscriptions,
          } = emitRowSignalBindings(innerStaticInfo, {
            row: '_nrEl',
            prefix: '_nrs',
            cleanups: '_nrCleanups',
            nodes: innerScope,
          });
          lines.push(...innerScope.head);
          // Inner item bindings fill & navigation (element-based), redundancy-guarded like the
          // outer rows. Guards are allocated here in binding order and reused by the update path.
          const innerGuards = createGuardAllocator('_nrp');
          const innerWrites: GuardedWrite[] = [];
          if (innerStaticInfo.elementBindings.length > 0) {
            const innerNavLines: string[] = [];
            const innerFillLines: string[] = [];
            for (let bi = 0; bi < innerStaticInfo.elementBindings.length; bi++) {
              const eb = innerStaticInfo.elementBindings[bi]!;
              const nv = `_nre${bi}`;
              if (eb.path.length === 0) {
                innerNavLines.push(`            const ${nv} = _nrEl;`);
              } else {
                innerNavLines.push(`            const ${nv} = ${pathToSiblingNav('_nrEl', eb.path)};`);
              }
              eb.bindings.forEach((binding) => {
                const expr = renameIdentifierInExpression(binding.expression, nr.itemVar, '_nrItem');
                let gw: GuardedWrite | undefined;
                if (binding.type === 'text') {
                  const textVar = `_nrt${innerWrites.length}`;
                  const guard = innerGuards.next();
                  gw = {
                    fill: `${nv}.textContent = (${guard} = ${expr}) ?? ''; let ${textVar}`,
                    update: `if (${guard} !== (${guard} = ${expr})) (${textVar} ??= ${nv}.firstChild) ? (${textVar}.nodeValue = ${guard} ?? '') : (${nv}.textContent = ${guard} ?? '')`,
                  };
                } else if (binding.type === 'attr' && binding.property) {
                  gw = guardedWrite(
                    innerGuards.next(),
                    (v) => attributeWrite(nv, binding, v),
                    expr,
                    binding.staticValue,
                  );
                }
                if (gw) {
                  innerWrites.push(gw);
                  innerFillLines.push(`            ${gw.fill};`);
                }
              });
            }
            lines.push(...innerNavLines);
            if (innerGuards.vars.length > 0) lines.push(`            ${innerGuards.declaration()}`);
            lines.push(...innerFillLines);
          }
          if (innerCommentFillStatements.length > 0) {
            lines.push(`            ${innerCommentFillStatements.join('; ')};`);
          }
          lines.push(`            _insertBefore.call(_nrC_${nr.id}, _nrEl, _nrRef);`);
          const hasInnerSignalSubs = innerSignalSubscriptions.length > 0;
          for (const navStmt of innerSignalNavStatements) {
            lines.push(`            ${navStmt};`);
          }
          if (innerSignalFillStatements.length > 0) {
            lines.push(`            ${innerSignalFillStatements.join('; ')};`);
          }
          // Inner update statements
          const innerUpdateParts: string[] = innerWrites.map((gw) => gw.update);
          // Add comment-marker update statements
          innerUpdateParts.push(...innerCommentUpdateStatements);
          if (hasInnerSignalSubs) {
            lines.push(`            const _nrCleanups = [];`);
            for (const sub of innerSignalSubscriptions) {
              lines.push(`            ${sub};`);
            }
          }
          lines.push(
            `            return { el: _nrEl, cleanups: ${hasInnerSignalSubs ? '_nrCleanups' : '[]'}, value: _nrItem,`,
          );
          lines.push(
            `              update: (_nrItem) => { ${innerUpdateParts.join('; ')}${innerUpdateParts.length ? ';' : ''} } };`,
          );
          lines.push(`          },`);
          lines.push(`        ${keyArg(nr)});`);
          // Check if the items expression references the outer item variable
          const nrItemsExpr = renameIdentifierInExpression(nr.itemsExpression, rep.itemVar, 'item');
          lines.push(`        _nrRc_${nr.id}.reconcile(${nrItemsExpr});`);
          // If the nested repeat is driven by a signal, subscribe
          if (nr.signalName) {
            lines.push(
              `        _cleanups.push(${nr.signalName}.subscribe(() => { _nrRc_${nr.id}.reconcile(${nrItemsExpr}); }, true));`,
            );
          }
          lines.push(`        _cleanups.push(() => { _nrRc_${nr.id}.clearAll(); });`);
        }
        // Lean rows: no per-row update closure. Guard state and lazily resolved text nodes live
        // on the managed record, and one update function per list re-navigates from the row
        // element. Rows with a mixed signal+item binding that is not lifted keep their closure.
        const leanRows = batchRows && mixedUpdateStatements.length === 0;
        if (leanRows) {
          const leanParts = [...leanUpdateStatements, ...leanCommentUpdateStatements];
          const usedByUpdate = (v: string): boolean => leanParts.some((s) => s.includes(recordField(v)));
          const fields = [
            ...guards.vars.filter(usedByUpdate).map((v) => `${v.slice(1)}: ${v}`),
            ...textVars.map((v) => `${v.slice(1)}: undefined`),
            ...commentVars.map((v) => `${v.slice(1)}: ${v}`),
          ];
          lines.push(
            `        return { el: _el, cleanups: _nc, value: item, key: undefined${fields.length > 0 ? ', ' + fields.join(', ') : ''} };`,
          );
          lines.push(`    };`);
          if (useDelegation) leanParts.push('_el.__d = item');
          lines.push(`    const _update_${rep.id} = (_m, item, ${indexVar}) => {`);
          lines.push(`      const _el = _m.el;`);
          lines.push(`      ${leanParts.join('; ')};`);
          lines.push(`    };`);
        } else {
          lines.push(`        return { el: _el, cleanups: ${needsCleanups ? '_cleanups' : '_nc'}, value: item,`);
          lines.push(
            `          update: (item${usesIndex ? `, ${indexVar}` : ''}) => { ${updateParts.join('; ')}; } };`,
          );
        }
        if (batchRows) {
          if (!leanRows) lines.push(`    };`);
          lines.push(`    const ${reconcilerVar} = ${use(BIND_FN.KEYED_RECONCILER)}(${containerVar}, ${anchorVar},`);
          lines.push(
            `      (item, ${indexVar}, _ref) => { const _el = _cloneNode.call(${tplContentVar}, true); const _m = _bind_${rep.id}(_el, item, ${indexVar}); _insertBefore.call(${containerVar}, _el, _ref); return _m; },`,
          );
          lines.push(
            `    ${keyFnExpr}, { size: ${ROW_BATCH_SIZE}, row: ${tplContentVar}, bind: _bind_${rep.id}${leanRows ? `, update: _update_${rep.id}` : ''} }${usesIndex ? ', true' : ''});`,
          );
        } else {
          lines.push(`      },`);
          lines.push(`    ${keyFnExpr}${usesIndex ? ', undefined, true' : ''});`);
        }
        for (const sub of selectionSubscriptions) {
          lines.push(`    ${sub}`);
        }

        // Empty template handling (inlined by compiler — not in reconciler)
        emitListSource(rep, reconcilerVar, containerVar, anchorVar, lines);
        // Emit delegated event listeners on the container (after reconciler is ready)
        for (const stmt of delegatedListenerStatements) {
          lines.push(`    ${stmt}`);
        }

        return;
      } else {
        // No-bindings path: template clone with no fill/update

        const templateId = `__tpl_${rep.id}`;
        staticTemplates.push(
          `  const ${templateId} = _T(\`${escapeTemplateLiteral(stripMarks(emit.html(staticInfo.staticHtml)))}\`);`,
        );

        const tplContentVar = `_tc_${rep.id}`;
        const anchorVar = `_a_${rep.id}`;
        const containerVar = `_ct_${rep.id}`;
        const reconcilerVar = `_rc_${rep.id}`;

        lines.push(`    const ${tplContentVar} = ${templateId}.content.firstElementChild;`);
        anchorLine(anchorVar);
        lines.push(`    const ${containerVar} = ${anchorVar}.parentNode;`);

        lines.push(`    const ${reconcilerVar} = ${use(BIND_FN.KEYED_RECONCILER)}(${containerVar}, ${anchorVar},`);
        lines.push(`      (item, ${indexVar}, _ref) => {`);
        lines.push(`        const _el = _cloneNode.call(${tplContentVar}, true);`);
        // Child component mounts inside repeat items (Step 7 + Step 10)
        const fbRepMountInfo = generateMountInfo(rep.id, '        ', rowScope, rep.itemVar);
        lines.push(...rowScope.head);
        lines.push(`        _insertBefore.call(${containerVar}, _el, _ref);`);
        for (const sl of fbRepMountInfo.setupLines) {
          lines.push(sl);
        }
        if (fbRepMountInfo.cleanupExprs.length > 0) {
          lines.push(
            `        return { el: _el, cleanups: [${fbRepMountInfo.cleanupExprs.join(', ')}], value: item, update: () => {} };`,
          );
        } else {
          lines.push(`        return { el: _el, cleanups: [], value: item, update: () => {} };`);
        }
        lines.push(`      },`);
        lines.push(`    ${keyArg(rep)});`);

        // Empty template handling (inlined)
        emitListSource(rep, reconcilerVar, containerVar, anchorVar, lines);
        return;
      }
    }
  };

  // Nested initializer shared by when() content and whenElse branches
  const generateNestedInitializer = (
    bindings: BindingInfo[],
    nestedConds: ConditionalBlock[],
    nestedWE: WhenElseBlock[],
    nestedReps: RepeatBlock[],
    directiveId: string | undefined,
    nestedEvents: EventBinding[],
    template: string,
  ): string => {
    // Every element the branch binds is reached from the branch's first element, before any of
    // the branch's code changes the DOM
    const scope = branchScope(modelOf(template, emit), '      ');
    const weMountInfo = directiveId
      ? generateMountInfo(directiveId, '      ', scope)
      : { setupLines: [], cleanupExprs: [] };
    const hasWeMounts = weMountInfo.cleanupExprs.length > 0;
    if (
      bindings.length === 0 &&
      nestedConds.length === 0 &&
      nestedWE.length === 0 &&
      nestedReps.length === 0 &&
      nestedEvents.length === 0 &&
      !hasWeMounts
    ) {
      return '() => []';
    }

    const initLines: string[] = [];
    // Each bound element and text node, by path from the branch's first node (A1-2, A1-4)
    // Elements first: a text node's path can then start from one of them
    for (const b of bindings) if (b.type !== 'text') scope.at(b.id, b.id);
    for (const evt of nestedEvents) scope.at(evt.elementId, evt.elementId);
    for (const b of bindings) if (b.type === 'text') scope.text(b.id, b.id);
    const simpleNestedBindings = bindings.filter(isSimpleBinding);
    const exprNestedBindings = bindings.filter(isExpressionBinding);
    for (const binding of simpleNestedBindings) {
      initLines.push(`      ${generateInitialValueCode(binding)};`);
    }
    exprNestedBindings.forEach((binding, idx) => {
      const updFn = `_upd_${binding.id}_${idx}`;
      const expr = binding.expression;
      const write = expressionWrite({ ...binding, id: binding.id });
      if (write) {
        const guard = `_pv_${binding.id}_${idx}`;
        initLines.push(`      let ${guard}; const ${updFn} = () => { ${guardedWrite(guard, write, expr).update}; };`);
      }
      // Expression bindings always need an explicit initial call because
      // subscribe(..., true) skips the initial notification.
      initLines.push(`      ${updFn}();`);
    });
    for (const sl of weMountInfo.setupLines) {
      initLines.push(sl);
    }

    // Generate addEventListener calls for event bindings inside whenElse branches
    if (nestedEvents.length > 0) {
      const nestedEventLines = buildEventListenerStatements(nestedEvents, scope);
      for (const line of nestedEventLines) {
        initLines.push(`      ${line}`);
      }
    }

    const nestedRepeatCleanupVars: string[] = [];
    for (const rep of nestedReps) {
      const repLines: string[] = [];
      emitRepeat(rep, repLines, scope);
      initLines.push(`      const _rsubs_${rep.id} = [];`);
      initLines.push(`      { const _subs = _rsubs_${rep.id};`);
      for (const line of repLines) initLines.push(`  ${line}`);
      initLines.push('      }');
      nestedRepeatCleanupVars.push(
        `() => { for (let i = 0; i < _rsubs_${rep.id}.length; i++) _rsubs_${rep.id}[i](); }`,
      );
    }

    initLines.push('      return [');
    const signalGroups = groupBindingsBySignal(simpleNestedBindings);
    for (const [signalName, signalBindings] of signalGroups) {
      initLines.push(`        ${generateConsolidatedSubscription(signalName, signalBindings)},`);
    }
    for (const ce of weMountInfo.cleanupExprs) {
      initLines.push(`        ${ce},`);
    }
    exprNestedBindings.forEach((binding, idx) => {
      const updFn = `_upd_${binding.id}_${idx}`;
      const signals = binding.signalNames;
      for (const sig of signals) {
        initLines.push(`        ${sig}.subscribe(${updFn}, true),`);
      }
    });
    for (const cond of nestedConds) {
      const nestedBindingsCode = generateNestedInitializer(
        cond.nestedBindings,
        cond.nestedConditionals,
        cond.nestedWhenElse,
        cond.nestedRepeats,
        cond.id,
        cond.nestedEventBindings,
        cond.templateContent,
      );
      initLines.push(`        ${whenCall(cond, nestedBindingsCode, scope)},`);
    }
    for (const nestedWe of nestedWE) {
      const thenInitCode = generateNestedInitializer(
        nestedWe.thenBindings,
        nestedWe.thenConditionals,
        nestedWe.thenWhenElse,
        nestedWe.thenRepeats,
        nestedWe.thenId,
        nestedWe.thenEventBindings ?? [],
        nestedWe.thenTemplate,
      );
      const elseInitCode = generateNestedInitializer(
        nestedWe.elseBindings,
        nestedWe.elseConditionals,
        nestedWe.elseWhenElse,
        nestedWe.elseRepeats,
        nestedWe.elseId,
        nestedWe.elseEventBindings ?? [],
        nestedWe.elseTemplate,
      );
      for (const call of whenElseCalls(nestedWe, thenInitCode, elseInitCode, scope)) initLines.push(`        ${call},`);
    }

    for (const cleanupVar of nestedRepeatCleanupVars) {
      initLines.push(`        ${cleanupVar},`);
    }

    initLines.push('      ];');
    initLines.push('    }');
    return ['(_c) => {', ...scope.head, ...initLines].join('\n');
  };
  // Cached prototype methods for repeat block hot paths (avoids prototype chain lookup per call).
  // Lists inside when()/whenElse() branches use them too, so any list at any depth counts.
  let hasAnyRepeat = false;
  walkDirectives(
    { conditionals, whenElse: whenElseBlocks, repeats: repeatBlocks },
    {
      repeat: () => {
        hasAnyRepeat = true;
        return false;
      },
    },
  );
  if (hasAnyRepeat) {
    staticTemplates.push(`  const _cloneNode = Node.prototype.cloneNode;`);
    staticTemplates.push(`  const _insertBefore = Node.prototype.insertBefore;`);
    // Rows without cleanups share one empty array instead of allocating one each
    staticTemplates.push(`  const _nc = [];`);
  }

  // when() element content is a full sub-template — same initializer as a whenElse branch
  for (const cond of conditionals) {
    const nestedCode = generateNestedInitializer(
      cond.nestedBindings,
      cond.nestedConditionals,
      cond.nestedWhenElse,
      cond.nestedRepeats,
      cond.id,
      cond.nestedEventBindings,
      cond.templateContent,
    );
    lines.push(`    _subs.push(${whenCall(cond, nestedCode, top)});`);
  }
  for (const we of whenElseBlocks) {
    const thenCode = generateNestedInitializer(
      we.thenBindings,
      we.thenConditionals,
      we.thenWhenElse,
      we.thenRepeats,
      we.thenId,
      we.thenEventBindings ?? [],
      we.thenTemplate,
    );
    const elseCode = generateNestedInitializer(
      we.elseBindings,
      we.elseConditionals,
      we.elseWhenElse,
      we.elseRepeats,
      we.elseId,
      we.elseEventBindings ?? [],
      we.elseTemplate,
    );
    for (const call of whenElseCalls(we, thenCode, elseCode, top)) lines.push(`    _subs.push(${call});`);
  }
  for (const rep of repeatBlocks) emitRepeat(rep, lines, top);

  if (eventBindings.length > 0) {
    // Generate direct addEventListener calls (skip conditional-bound events here)
    const topLevelEvents = eventBindings.filter((evt) => !conditionalEventIds.has(evt.id));
    const eventLines = buildEventListenerStatements(topLevelEvents, top);
    for (const line of eventLines) {
      lines.push(`    ${line}`);
    }
  }

  // Child components outside every directive: mounted once, destroyed with the component
  for (const mount of topLevelChildMounts) {
    const { setup, cleanup } = mountChild(mount, '    ', top);
    lines.push(...setup, `    _subs.push(${cleanup});`);
  }

  // Return cleanup function that unsubscribes all top-level subscriptions
  lines.push(`    return () => { for (let i = 0; i < _subs.length; i++) _subs[i](); };`);
  // The component's anchors are reached before any of its code changes the DOM
  lines.splice(1, 0, ...top.head);
  if (top.usesRoot()) lines.unshift(`    const r = ctx.root;`);

  return { code: lines.join('\n'), staticTemplates, helpers, elementList: top.used() };
};

/**
 * Generate a static template property for pre-compiled HTML
 */
export const generateStaticTemplate = (content: string, emit: EmitOptions): string => {
  const escapedContent = escapeTemplateLiteral(stripMarks(emit.html(content)));
  return `
  const _T = (h) => { const t = document.createElement('template'); t.innerHTML = h; return t; };
  const __tpl = _T(\`${escapedContent}\`);`;
};

/**
 * Generate updated import statements — splits user-facing imports (from 'thane')
 * and compiler-internal imports (from 'thane/runtime') into two separate lines.
 *
 * This keeps the public API surface clean: `import { signal } from 'thane'`
 * never shows __registerComponent or __bindIf in IDE autocomplete.
 */
export const generateUpdatedImport = (importInfo: ImportInfo, requiredBindFunctions: string[]): string => {
  const q = importInfo.quoteChar;
  const userImports = importInfo.namedImports;
  const internalImports = requiredBindFunctions;

  // Resolve the internal specifier from the user's module specifier.
  // 'thane' or 'thane/…' → 'thane/runtime', relative paths stay unchanged (dev/test).
  const spec = importInfo.moduleSpecifier;
  const internalSpec =
    spec === PUBLIC_RUNTIME_SPECIFIER || spec.startsWith(`${PUBLIC_RUNTIME_SPECIFIER}/`)
      ? INTERNAL_RUNTIME_SPECIFIER
      : spec;

  const lines: string[] = [];
  if (userImports.length > 0) {
    lines.push(`import { ${userImports.join(', ')} } from ${q}${spec}${q}`);
  }
  if (internalImports.length > 0) {
    lines.push(`import { ${internalImports.join(', ')} } from ${q}${internalSpec}${q}`);
  }
  return lines.join('\n');
};
