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
import { injectIdIntoFirstElement, escapeTemplateLiteral } from '../../utils/html-parser/index.js';
import type { ImportInfo } from '../../types.js';
import type { ChildMountInfo } from '../component-precompiler/component-precompiler.js';
import type { GeneratedInitBindingsArtifact, RuntimeHelperName } from '../../../contracts/index.js';
import { INTERNAL_RUNTIME_SPECIFIER, PUBLIC_RUNTIME_SPECIFIER } from '../../../contracts/index.js';

/**
 * Rows per batch clone for repeat() rows without cleanups: the reconciler clones a fragment of
 * this many rows at once and binds each, instead of one cloneNode and insertBefore per row.
 */
const ROW_BATCH_SIZE = 16;

/**
 * The variable that holds a bound element or marker. Compiler ids (`b12`) are used as they
 * are; a developer's own id is mapped to a name that cannot collide with the component's
 * variables or contain characters an identifier cannot (`my-box` → `_u_my$2dbox`).
 */
const elVar = (id: string): string =>
  /^b\d+$/.test(id) ? id : '_u_' + id.replace(/[^A-Za-z0-9_]/g, (c) => '$' + c.charCodeAt(0).toString(16));

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

/**
 * A row statement that maps every comment marker under `rootVar` by its text (`<!--b3-->` →
 * `mapVar['b3']`), with one TreeWalker over comments (NodeFilter.SHOW_COMMENT = 128).
 */
const commentMapStatement = (mapVar: string, rootVar: string): string =>
  `const ${mapVar} = {}; { const _tw = document.createTreeWalker(${rootVar}, 128); let _cn; while (_cn = _tw.nextNode()) ${mapVar}[_cn.data] = _cn; }`;

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
 * Each listener walks from e.target up to the item root, reads __d, and dispatches.
 */
const buildDelegatedListenerStatements = (
  delegatedByType: Map<string, DelegatedEvent[]>,
  containerVar: string,
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

      if (evt.path.length === 0) {
        finalBody.push(`${handlerBody};`);
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
 * bindings, the text node after the comment marker.
 */
const simpleWrite = (binding: SimpleBinding, value: string): string => {
  const elRef = elVar(binding.id);
  if (binding.type === 'style' && binding.property!.startsWith('--'))
    return `${elRef}.style.setProperty('${binding.property}', ${value})`;
  if (binding.type === 'style') return `${elRef}.style.${toCamelCase(binding.property!)} = ${value}`;
  if (binding.type === 'attr') return attributeWrite(elRef, binding, value);
  return `${elRef}.nextSibling.data = ${value} ?? ''`;
};

/**
 * Generate binding update code for a single simple binding.
 * For text bindings, navigates from comment marker to adjacent text node.
 */
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
  if (binding.type === 'text') return (v) => `${binding.id}.nextSibling.data = (${v}) ?? ''`;
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
 * The initNested receives `_c` (the root element of the conditional content), which
 * is already in the DOM by the time initNested is called; bound elements are looked
 * up inside it.
 */
const generateRepeatNestedCondInitFn = (
  nestedBindings: BindingInfo[],
  nestedEventBindings: EventBinding[],
  outerItemVar: string,
): string => {
  const hasSignalBindings = nestedBindings.length > 0;
  const hasEvents = nestedEventBindings.length > 0;
  if (!hasSignalBindings && !hasEvents) return '() => []';

  const parts: string[] = [];
  parts.push('(_c) => {');
  // Bound elements are looked up inside the conditional's own content, not the component root:
  // inside a repeat() every row has a copy of the same ids.
  parts.push(`  const _q = (id) => _c ? (_c.id === id ? _c : _c.querySelector('#' + id)) : _gid(id);`);
  // Build comment marker map for text bindings in this conditional
  const signalTextIds = new Set([
    ...nestedBindings.filter((b) => b.type === 'text' && isSimpleBinding(b)).map((b) => (b as SimpleBinding).id),
    ...nestedBindings.filter((b) => b.type === 'text' && isExpressionBinding(b)).map((b) => (b as SimpleBinding).id),
  ]);
  const hasTextMarkers = signalTextIds.size > 0;
  if (hasTextMarkers) {
    parts.push(
      `  const _rcm = {}; { const _w = document.createTreeWalker(_c || document, 128); let _n; while (_n = _w.nextNode()) _rcm[_n.data] = _n; }`,
    );
  }
  // Signal bindings
  const simpleNested = nestedBindings.filter(isSimpleBinding);
  const exprNested = nestedBindings.filter(isExpressionBinding);
  const signalElIds = [...new Set([...simpleNested.map((b) => b.id), ...exprNested.map((b) => b.id)])];
  for (const elId of signalElIds) {
    parts.push(`  const _n_${elVar(elId)} = ${signalTextIds.has(elId) ? `_rcm['${elId}']` : `_q('${elId}')`};`);
  }
  // Initial values for signal bindings
  for (const sb of simpleNested) {
    const renamedSignalName = sb.signalName === outerItemVar ? 'item' : sb.signalName;
    const signalCall = `${renamedSignalName}()`;
    if (sb.type === 'text') {
      parts.push(`  if (_n_${elVar(sb.id)}) _n_${elVar(sb.id)}.nextSibling.data = ${signalCall} ?? '';`);
    } else if (sb.type === 'attr' && sb.property) {
      parts.push(`  if (_n_${elVar(sb.id)}) ${attributeWrite(`_n_${elVar(sb.id)}`, sb, signalCall)};`);
    } else if (sb.type === 'style' && sb.property) {
      parts.push(`  if (_n_${elVar(sb.id)}) _n_${elVar(sb.id)}.style.setProperty('${sb.property}', ${signalCall});`);
    }
  }
  // Expression bindings: first write here, guarded re-writes in the subscriptions below
  const exprNestedWrites = new Map<ExpressionBinding, GuardedWrite>();
  for (const eb of exprNested) {
    const renamedExpr = renameIdentifierInExpression(eb.expression, outerItemVar, 'item');
    const write = expressionWrite({ ...eb, id: `_n_${elVar(eb.id)}` });
    if (!write) continue;
    const gw = guardedWrite(`_pv_${elVar(eb.id)}`, write, renamedExpr);
    exprNestedWrites.set(eb, gw);
    parts.push(`  let _pv_${elVar(eb.id)}; if (_n_${elVar(eb.id)}) ${gw.fill};`);
  }
  parts.push('  const _nsubs = [];');
  // Subscriptions for signal bindings
  const renamedSimpleNested = simpleNested.map((sb) => ({
    ...sb,
    signalName: sb.signalName === outerItemVar ? 'item' : sb.signalName,
  }));
  const signalGroups = groupBindingsBySignal(renamedSimpleNested);
  for (const [signalName, sbs] of signalGroups) {
    const updates = sbs
      .map((sb) => {
        if (sb.type === 'text') return `if (_n_${elVar(sb.id)}) _n_${elVar(sb.id)}.nextSibling.data = v ?? ''`;
        if (sb.type === 'attr' && sb.property)
          return `if (_n_${elVar(sb.id)}) ${attributeWrite(`_n_${elVar(sb.id)}`, sb, 'v')}`;
        if (sb.type === 'style' && sb.property)
          return `if (_n_${elVar(sb.id)}) _n_${elVar(sb.id)}.style.setProperty('${sb.property}', v)`;
        return '';
      })
      .filter(Boolean);
    if (updates.length === 1) {
      parts.push(`  _nsubs.push(${signalName}.subscribe(v => { ${updates[0]}; }, true));`);
    } else if (updates.length > 1) {
      parts.push(`  _nsubs.push(${signalName}.subscribe(v => { ${updates.join('; ')}; }, true));`);
    }
  }
  for (const eb of exprNested) {
    const gw = exprNestedWrites.get(eb);
    if (!gw) continue;
    const updFn = `() => { if (_n_${elVar(eb.id)}) ${gw.update}; }`;
    for (const sig of eb.signalNames) {
      const renamedSig = sig === outerItemVar ? 'item' : sig;
      parts.push(`  _nsubs.push(${renamedSig}.subscribe(${updFn}, true));`);
    }
  }
  // Listeners inside the content: resolved inside the content and discarded with it
  for (const evt of nestedEventBindings) {
    parts.push(`  _q('${evt.elementId}')?.addEventListener('${evt.eventName}', ${compileEventHandler(evt)});`);
  }
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
): GeneratedInitBindingsArtifact => {
  const lines: string[] = [];
  const staticTemplates: string[] = []; // Collect static templates for repeat optimizations
  const helpers = new Set<RuntimeHelperName>();
  /** A runtime helper's name, recorded as used where the call to it is emitted. */
  const use = (helper: RuntimeHelperName): RuntimeHelperName => {
    helpers.add(helper);
    return helper;
  };

  // ── Helper: generate child component mount lines for directive-nested mounts ──
  // Returns { setupLines, cleanupExprs } — consumers add setupLines as statements
  // and route cleanupExprs into the appropriate cleanup array/return value.
  const generateMountInfo = (
    directiveId: string,
    indent: string,
    repeatCtx?: { itemVar: string },
  ): { setupLines: string[]; cleanupExprs: string[] } => {
    const mounts = childMountsByDirective?.get(directiveId);
    if (!mounts || mounts.length === 0) return { setupLines: [], cleanupExprs: [] };
    const setupLines: string[] = [];
    const cleanupExprs: string[] = [];
    for (const { cm, globalIndex } of mounts) {
      const varName = `_cm${globalIndex}`;
      const anchorVar = `_cma${globalIndex}`;
      let propsExpr = cm.propsExpression;
      // Step 10: the row's item is `item` in the row factory; its index keeps the developer's name
      if (repeatCtx) {
        propsExpr = renameIdentifierInExpression(propsExpr, repeatCtx.itemVar, 'item');
      }
      setupLines.push(`${indent}const ${varName} = document.createElement('${emit.selector(cm.selector)}');`);
      if (repeatCtx) {
        setupLines.push(
          `${indent}const ${anchorVar} = (_el.id === '${cm.anchorId}' ? _el : _el.querySelector('#${cm.anchorId}'));`,
        );
      } else {
        setupLines.push(`${indent}const ${anchorVar} = _gid('${cm.anchorId}');`);
      }
      setupLines.push(`${indent}if (${anchorVar}) ${anchorVar}.replaceWith(${varName});`);
      cleanupExprs.push(`${use(BIND_FN.DESTROY_CHILD)}(${cm.componentName}.__f(${varName}, ${propsExpr}))`);
    }
    return { setupLines, cleanupExprs };
  };

  const buildEventListenerStatements = (events: EventBinding[]): string[] =>
    events.map((evt) => `_gid('${evt.elementId}')?.addEventListener('${evt.eventName}', ${compileEventHandler(evt)});`);
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
  lines.push(`    const r = ctx.root;`);
  lines.push(`    const _gid = (id) => r.querySelector('#' + id);`);
  // Collect top-level subscription unsubscribe handles for cleanup on destroy
  lines.push(`    const _subs = [];`);
  // Compute top-level binding info early so we can decide whether to emit the comment walker
  const topLevelBindings = bindings.filter((b) => !b.isInsideConditional);
  // Separate expression bindings (multi-signal) from simple bindings
  const simpleBindings = topLevelBindings.filter(isSimpleBinding);
  const expressionBindings = topLevelBindings.filter(isExpressionBinding);
  // IDs that target comment markers (text bindings) vs element IDs (attr/style/event)
  const textBindingIds = new Set<string>();
  for (const b of topLevelBindings) {
    if (b.type === 'text') textBindingIds.add(b.id);
  }
  // Check if _fcm (comment marker factory) is needed at any level — conditionals and
  // whenElse branches may reference it even when top-level text bindings don't exist.
  // Rows find their own markers.
  let hasConditionalTextBindings = false;
  const isText = (b: BindingInfo) => b.type === 'text';
  walkDirectives(
    { conditionals, whenElse: whenElseBlocks },
    {
      cond: (cond) => {
        if (cond.nestedBindings.some(isText)) hasConditionalTextBindings = true;
      },
      whenElse: (we) => {
        if (we.thenBindings.some(isText) || we.elseBindings.some(isText)) hasConditionalTextBindings = true;
      },
      repeat: () => false,
    },
  );
  const needsFcm = textBindingIds.size > 0 || hasConditionalTextBindings;
  // Collect all comment markers (<!--bN-->) into a map for O(1) lookup.
  // NodeFilter.SHOW_COMMENT = 128 — only emit when text bindings exist somewhere.
  if (needsFcm) {
    lines.push(
      `    const _fcm = (root) => { const m = {}; const w = document.createTreeWalker(root, 128); let n; while (n = w.nextNode()) m[n.data] = n; return m; };`,
    );
    if (textBindingIds.size > 0) {
      lines.push(`    const _cm = _fcm(r);`);
    }
  }
  const topLevelIds = [...new Set(topLevelBindings.map((b) => b.id))];
  if (topLevelIds.length > 0) {
    for (const id of topLevelIds) {
      // Text bindings use comment markers found via TreeWalker; others use getElementById
      lines.push(`    const ${elVar(id)} = ${textBindingIds.has(id) ? `_cm['${id}']` : `_gid('${id}')`};`);
    }
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
  // e.g. const _upd_b2 = () => { b2.nextSibling.data = count() + 1; };
  //      count.subscribe(_upd_b2, true);
  expressionBindings.forEach((binding, idx) => {
    const updFn = `_upd_${elVar(binding.id)}_${idx}`;
    const expr = binding.expression;
    const signals = binding.signalNames;
    // The expression re-runs whenever any of its signals change; the guard skips the DOM
    // write when the result is unchanged.
    const write = expressionWrite({ ...binding, id: elVar(binding.id) });
    if (!write) return;
    const guard = `_pv_${elVar(binding.id)}_${idx}`;
    lines.push(`    let ${guard}; const ${updFn} = () => { ${guardedWrite(guard, write, expr).update}; };`);
    lines.push(`    ${updFn}();`);
    for (const sig of signals) {
      lines.push(`    _subs.push(${sig}.subscribe(${updFn}, true));`);
    }
  });

  // The call that binds a when() block: `__bindIf` for a bare signal read, otherwise
  // `__bindIfExpr` over every signal the condition reads. Callers add their wrapper.
  const whenCall = (cond: ConditionalBlock, initCode: string, anchorVar?: string): string => {
    const template = escapeTemplateLiteral(emit.html(cond.templateContent));
    const anchor = anchorVar ? `, ${anchorVar}` : '';
    if (isSimpleConditional(cond)) {
      return `${use(BIND_FN.IF)}(r, ${cond.signalName}, '${cond.id}', \`${template}\`, ${initCode}${anchor})`;
    }
    const signals = cond.signalNames.join(', ');
    return `${use(BIND_FN.IF_EXPR)}(r, [${signals}], () => ${cond.jsExpression}, '${cond.id}', \`${template}\`, ${initCode}${anchor})`;
  };

  // The two `__bindIfExpr` calls that bind a whenElse() block: the then branch on the condition,
  // the else branch on its negation, each template carrying its branch id. Callers add their wrapper.
  const whenElseCalls = (
    we: WhenElseBlock,
    thenInit: string,
    elseInit: string,
    anchors?: [thenAnchor: string, elseAnchor: string],
  ): [string, string] => {
    const signals = we.signalNames.join(', ');
    const call = (condition: string, id: string, template: string, init: string, anchor: string | undefined) =>
      `${use(BIND_FN.IF_EXPR)}(r, [${signals}], () => ${condition}, '${id}', \`${escapeTemplateLiteral(emit.html(injectIdIntoFirstElement(template, id)))}\`, ${init}${anchor ? `, ${anchor}` : ''})`;
    return [
      call(we.jsExpression, we.thenId, we.thenTemplate, thenInit, anchors?.[0]),
      call(`!(${we.jsExpression})`, we.elseId, we.elseTemplate, elseInit, anchors?.[1]),
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
  // bindings are reached by path; text bindings through the row's comment map, which the caller
  // emits when `needsCommentMap` says the scope has none yet. The options name the scope's
  // variables (outer rows and nested rows use different names).
  const emitRowSignalBindings = (
    staticInfo: StaticTemplateInfo,
    scope: { row: string; prefix: string; cleanups: string; commentMap: string; hasCommentMap: boolean },
  ): { nav: string[]; fill: string[]; subscriptions: string[]; needsCommentMap: boolean } => {
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
    const commentBindings = staticInfo.signalCommentBindings ?? [];
    for (const scb of commentBindings) {
      const cmVar = `${scope.commentMap}['${scb.commentId}']`;
      const signalCall = scb.expression ?? `${scb.signalName}()`;
      bind(`if (${cmVar}) ${cmVar}.nextSibling.data = ${signalCall} ?? ''`, scb.signalNames, scb.signalName);
    }
    return { nav, fill, subscriptions, needsCommentMap: commentBindings.length > 0 && !scope.hasCommentMap };
  };

  // One repeat() list: the anchor lookup, the row template, the row factory and the
  // subscriptions, written as statements into `lines`. Component-level lists write straight
  // into the binding function; a list inside a when()/whenElse() branch writes into that
  // branch's initializer, where a block-scoped `_subs` collects its unsubscribes.
  const emitRepeat = (rep: RepeatBlock, lines: string[]): void => {
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

      lines.push(`    const ${anchorVar} = _gid('${rep.id}');`);
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
      // Collect directive anchor IDs for path computation (Step 14/15)
      const directiveAnchorIds: string[] = [
        ...rep.nestedConditionals.map((c) => c.id),
        ...rep.nestedWhenElse.flatMap((we) => [we.thenId, we.elseId]),
        ...rep.nestedRepeats.map((nr) => nr.id),
      ];
      const staticInfo = generateStaticRepeatTemplate(
        rep.itemTemplate,
        rep.itemBindings,
        rep.itemEvents,
        rep.signalBindings,
        directiveAnchorIds.length > 0 ? directiveAnchorIds : undefined,
      );

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
        // Restore child mount anchor IDs stripped by static template generation (Step 7)
        const repMounts = childMountsByDirective?.get(rep.id);
        if (repMounts) {
          for (const { cm } of repMounts) {
            staticInfo.staticHtml = staticInfo.staticHtml.replace(
              '<template></template>',
              `<template id="${cm.anchorId}"></template>`,
            );
          }
        }
        // Generate static template identifier
        const templateId = `__tpl_${rep.id}`;

        // Generate static template IIFE
        staticTemplates.push(
          `  const ${templateId} = _T(\`${escapeTemplateLiteral(emit.html(staticInfo.staticHtml))}\`);`,
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
        const commentNavStatements: string[] = [];
        const commentFillStatements: string[] = [];
        const commentUpdateStatements: string[] = [];
        if (commentBindings.length > 0) {
          // Scan cloned element for comment markers
          commentNavStatements.push(commentMapStatement('_icm', '_el'));
          commentBindings.forEach((cb, i) => {
            const expr = renameIdentifierInExpression(cb.expression, rep.itemVar, 'item');
            // Resolve the text node after the marker once per row; fill and update write to it
            const textVar = `_c${i}`;
            commentVars.push(textVar);
            commentNavStatements.push(`const ${textVar} = _icm['${cb.elementId}']?.nextSibling`);
            const guard = guards.next();
            const gw = guardedWrite(guard, (v) => `${textVar}.data = (${v}) ?? ''`, expr);
            commentFillStatements.push(`if (${textVar}) ${gw.fill}`);
            commentUpdateStatements.push(`if (${textVar}) ${gw.update}`);
            const rec = recordField(textVar);
            leanCommentUpdateStatements.push(
              `if (${rec}) ${guardedWrite(guard, (v) => `${rec}.data = (${v}) ?? ''`, expr, undefined, recordField(guard)).update}`,
            );
          });
        }

        // Signal binding navigation and fill (Step 13), and signal text bindings via comment
        // markers (Step 13b), which share _icm with the item comment bindings
        const {
          nav: signalNavStatements,
          fill: signalFillStatements,
          subscriptions: signalSubscriptions,
          needsCommentMap,
        } = emitRowSignalBindings(staticInfo, {
          row: '_el',
          prefix: '_s',
          cleanups: '_cleanups',
          commentMap: '_icm',
          hasCommentMap: commentNavStatements.length > 0,
        });
        if (needsCommentMap) commentNavStatements.push(commentMapStatement('_icm', '_el'));

        // Mixed signal+item binding navigation, fill, subscription & update (Step 13c)
        const mixedNavStatements: string[] = [];
        const mixedFillStatements: string[] = [];
        const mixedUpdateStatements: string[] = [];
        // Selection bindings are lifted out of the row: one subscription per list (emitted after
        // the reconciler exists) instead of one per row
        const selectionSubscriptions: string[] = [];
        const mixedKeyProp = rep.trackByFn ? extractKeyProperty(rep.trackByFn) : null;
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
        lines.push(`    const ${anchorVar} = _gid('${rep.id}');`);
        lines.push(`    const ${containerVar} = ${anchorVar}.parentNode;`);
        // Partition item events into delegated (container listener) vs non-delegatable (per-item)
        const { delegatedByType: delegatedEventsByType, nonDelegatable: nonDelegatableEvents } = hasItemEvents
          ? partitionItemEvents(rep.itemEvents, staticInfo.eventElementPaths, rep, indexVar)
          : { delegatedByType: new Map<string, DelegatedEvent[]>(), nonDelegatable: [] as ItemEventBinding[] };

        // Build delegated listener code (emitted AFTER reconciler creation)
        const delegatedListenerStatements = buildDelegatedListenerStatements(delegatedEventsByType, containerVar);

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

        const repMountInfo = generateMountInfo(rep.id, '        ', { itemVar: rep.itemVar });
        const hasRepMounts = repMountInfo.setupLines.length > 0;
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
        for (const v of rowSignalVars) {
          lines.push(`        const ${v} = ${use(BIND_FN.SIGNAL)}(${v === `${rep.itemVar}$` ? 'item' : indexVar});`);
        }
        for (const navStmt of navStatements) {
          lines.push(`        ${navStmt};`);
        }
        for (const navStmt of commentNavStatements) {
          lines.push(`        ${navStmt};`);
        }
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
        // Nested conditional codegen (Step 14)
        for (const cond of rep.nestedConditionals) {
          const condAnchorPath = staticInfo.directiveAnchorPaths?.get(cond.id);
          if (!condAnchorPath) continue;
          const condNavExpr = pathToSiblingNav('_el', condAnchorPath);
          lines.push(`        const _cond_${elVar(cond.id)} = ${condNavExpr};`);
          const condInitNested = generateRepeatNestedCondInitFn(
            cond.nestedBindings,
            cond.nestedEventBindings,
            rep.itemVar,
          );
          lines.push(`        _cleanups.push(${whenCall(cond, condInitNested, `_cond_${elVar(cond.id)}`)});`);
        }
        // Nested whenElse codegen (Step 14)
        for (const we of rep.nestedWhenElse) {
          const thenAnchorPath = staticInfo.directiveAnchorPaths?.get(we.thenId);
          const elseAnchorPath = staticInfo.directiveAnchorPaths?.get(we.elseId);
          if (!thenAnchorPath || !elseAnchorPath) continue;
          const thenNavExpr = pathToSiblingNav('_el', thenAnchorPath);
          const elseNavExpr = pathToSiblingNav('_el', elseAnchorPath);
          lines.push(`        const _cond_${elVar(we.thenId)} = ${thenNavExpr};`);
          lines.push(`        const _cond_${elVar(we.elseId)} = ${elseNavExpr};`);
          const thenInitFn = generateRepeatNestedCondInitFn(we.thenBindings, [], rep.itemVar);
          const elseInitFn = generateRepeatNestedCondInitFn(we.elseBindings, [], rep.itemVar);
          for (const call of whenElseCalls(we, thenInitFn, elseInitFn, [
            `_cond_${elVar(we.thenId)}`,
            `_cond_${elVar(we.elseId)}`,
          ])) {
            lines.push(`        _cleanups.push(${call});`);
          }
        }
        // Nested repeat codegen (Step 15)
        for (const nr of rep.nestedRepeats) {
          const nrAnchorPath = staticInfo.directiveAnchorPaths?.get(nr.id);
          if (!nrAnchorPath) continue;
          const nrNavExpr = pathToSiblingNav('_el', nrAnchorPath);
          lines.push(`        const _nrA_${nr.id} = ${nrNavExpr};`);
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
            `  const ${innerTplId} = _T(\`${escapeTemplateLiteral(emit.html(innerStaticInfo.staticHtml))}\`);`,
          );
          const innerIndexVar = nr.indexVar || '_idx';
          lines.push(`        const _nrTc_${nr.id} = ${innerTplId}.content.firstElementChild;`);
          lines.push(`        const _nrRc_${nr.id} = ${use(BIND_FN.KEYED_RECONCILER)}(_nrC_${nr.id}, _nrA_${nr.id},`);
          lines.push(`          (_nrItem, ${innerIndexVar}, _nrRef) => {`);
          lines.push(`            const _nrEl = _cloneNode.call(_nrTc_${nr.id}, true);`);
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
          // Inner comment-marker item bindings (mixed-content text bindings)
          const innerCommentBindings = nr.itemBindings.filter(
            (b) => b.type === 'text' && b.textBindingMode === 'commentMarker',
          );
          const innerCommentNavStatements: string[] = [];
          const innerCommentFillStatements: string[] = [];
          const innerCommentUpdateStatements: string[] = [];
          if (innerCommentBindings.length > 0) {
            innerCommentNavStatements.push(commentMapStatement('_nricm', '_nrEl'));
            for (const cb of innerCommentBindings) {
              const expr = renameIdentifierInExpression(cb.expression, nr.itemVar, '_nrItem');
              const cmVar = `_nricm['${cb.elementId}']`;
              innerCommentFillStatements.push(`if (${cmVar}) ${cmVar}.nextSibling.data = (${expr}) ?? ''`);
              innerCommentUpdateStatements.push(`if (${cmVar}) ${cmVar}.nextSibling.data = (${expr}) ?? ''`);
            }
          }
          for (const navStmt of innerCommentNavStatements) {
            lines.push(`            ${navStmt};`);
          }
          if (innerCommentFillStatements.length > 0) {
            lines.push(`            ${innerCommentFillStatements.join('; ')};`);
          }
          lines.push(`            _insertBefore.call(_nrC_${nr.id}, _nrEl, _nrRef);`);
          // Inner signal bindings navigation, fill & subscription (Step 13 for nested repeats), and
          // inner signal text bindings via comment markers, sharing _nricm with the item bindings
          const {
            nav: innerSignalNavStatements,
            fill: innerSignalFillStatements,
            subscriptions: innerSignalSubscriptions,
            needsCommentMap: innerNeedsCommentMap,
          } = emitRowSignalBindings(innerStaticInfo, {
            row: '_nrEl',
            prefix: '_nrs',
            cleanups: '_nrCleanups',
            commentMap: '_nricm',
            hasCommentMap: innerCommentBindings.length > 0,
          });
          if (innerNeedsCommentMap) innerSignalNavStatements.push(commentMapStatement('_nricm', '_nrEl'));
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
        // Restore child mount anchor IDs (Step 7)
        const repMounts = childMountsByDirective?.get(rep.id);
        if (repMounts && staticInfo.staticHtml) {
          for (const { cm } of repMounts) {
            staticInfo.staticHtml = staticInfo.staticHtml.replace(
              '<template></template>',
              `<template id="${cm.anchorId}"></template>`,
            );
          }
        }

        const templateId = `__tpl_${rep.id}`;
        staticTemplates.push(
          `  const ${templateId} = _T(\`${escapeTemplateLiteral(emit.html(staticInfo.staticHtml))}\`);`,
        );

        const tplContentVar = `_tc_${rep.id}`;
        const anchorVar = `_a_${rep.id}`;
        const containerVar = `_ct_${rep.id}`;
        const reconcilerVar = `_rc_${rep.id}`;

        lines.push(`    const ${tplContentVar} = ${templateId}.content.firstElementChild;`);
        lines.push(`    const ${anchorVar} = _gid('${rep.id}');`);
        lines.push(`    const ${containerVar} = ${anchorVar}.parentNode;`);

        lines.push(`    const ${reconcilerVar} = ${use(BIND_FN.KEYED_RECONCILER)}(${containerVar}, ${anchorVar},`);
        lines.push(`      (item, ${indexVar}, _ref) => {`);
        lines.push(`        const _el = _cloneNode.call(${tplContentVar}, true);`);
        lines.push(`        _insertBefore.call(${containerVar}, _el, _ref);`);
        // Child component mounts inside repeat items (Step 7 + Step 10)
        const fbRepMountInfo = generateMountInfo(rep.id, '        ', { itemVar: rep.itemVar });
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
    directiveId?: string,
    nestedEvents: EventBinding[] = [],
  ): string => {
    const weMountInfo = directiveId ? generateMountInfo(directiveId, '      ') : { setupLines: [], cleanupExprs: [] };
    const hasWeMounts = weMountInfo.setupLines.length > 0;
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
    initLines.push('() => {');
    const weTextIds = new Set(bindings.filter((b) => b.type === 'text').map((b) => b.id));
    const ids = [...new Set(bindings.map((b) => b.id))];
    if (weTextIds.size > 0) {
      initLines.push(`      const _wcm = _fcm(r);`);
    }
    for (const id of ids) {
      initLines.push(`      const ${elVar(id)} = ${weTextIds.has(id) ? `_wcm['${id}']` : `_gid('${id}')`};`);
    }
    const simpleNestedBindings = bindings.filter(isSimpleBinding);
    const exprNestedBindings = bindings.filter(isExpressionBinding);
    for (const binding of simpleNestedBindings) {
      initLines.push(`      ${generateInitialValueCode(binding)};`);
    }
    exprNestedBindings.forEach((binding, idx) => {
      const updFn = `_upd_${elVar(binding.id)}_${idx}`;
      const expr = binding.expression;
      const write = expressionWrite({ ...binding, id: elVar(binding.id) });
      if (write) {
        const guard = `_pv_${elVar(binding.id)}_${idx}`;
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
      const nestedEventLines = buildEventListenerStatements(nestedEvents);
      for (const line of nestedEventLines) {
        initLines.push(`      ${line}`);
      }
    }

    const nestedRepeatCleanupVars: string[] = [];
    for (const rep of nestedReps) {
      const repLines: string[] = [];
      emitRepeat(rep, repLines);
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
      const updFn = `_upd_${elVar(binding.id)}_${idx}`;
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
      );
      initLines.push(`        ${whenCall(cond, nestedBindingsCode)},`);
    }
    for (const nestedWe of nestedWE) {
      const thenInitCode = generateNestedInitializer(
        nestedWe.thenBindings,
        nestedWe.thenConditionals,
        nestedWe.thenWhenElse,
        nestedWe.thenRepeats,
        nestedWe.thenId,
        nestedWe.thenEventBindings ?? [],
      );
      const elseInitCode = generateNestedInitializer(
        nestedWe.elseBindings,
        nestedWe.elseConditionals,
        nestedWe.elseWhenElse,
        nestedWe.elseRepeats,
        nestedWe.elseId,
        nestedWe.elseEventBindings ?? [],
      );
      for (const call of whenElseCalls(nestedWe, thenInitCode, elseInitCode)) initLines.push(`        ${call},`);
    }

    for (const cleanupVar of nestedRepeatCleanupVars) {
      initLines.push(`        ${cleanupVar},`);
    }

    initLines.push('      ];');
    initLines.push('    }');
    return initLines.join('\n');
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
    );
    lines.push(`    _subs.push(${whenCall(cond, nestedCode)});`);
  }
  for (const we of whenElseBlocks) {
    const thenCode = generateNestedInitializer(
      we.thenBindings,
      we.thenConditionals,
      we.thenWhenElse,
      we.thenRepeats,
      we.thenId,
      we.thenEventBindings ?? [],
    );
    const elseCode = generateNestedInitializer(
      we.elseBindings,
      we.elseConditionals,
      we.elseWhenElse,
      we.elseRepeats,
      we.elseId,
      we.elseEventBindings ?? [],
    );
    for (const call of whenElseCalls(we, thenCode, elseCode)) lines.push(`    _subs.push(${call});`);
  }
  for (const rep of repeatBlocks) emitRepeat(rep, lines);

  if (eventBindings.length > 0) {
    // Generate direct addEventListener calls (skip conditional-bound events here)
    const topLevelEvents = eventBindings.filter((evt) => !conditionalEventIds.has(evt.id));
    const eventLines = buildEventListenerStatements(topLevelEvents);
    for (const line of eventLines) {
      lines.push(`    ${line}`);
    }
  }

  // Child components outside every directive: mounted once, destroyed with the component
  for (const { cm, globalIndex } of topLevelChildMounts) {
    const varName = `_cm${globalIndex}`;
    lines.push(`    const ${varName} = document.createElement('${emit.selector(cm.selector)}');`);
    lines.push(`    _gid('${cm.anchorId}').replaceWith(${varName});`);
    lines.push(
      `    _subs.push(${use(BIND_FN.DESTROY_CHILD)}(${cm.componentName}.__f(${varName}, ${cm.propsExpression})));`,
    );
  }

  // Return cleanup function that unsubscribes all top-level subscriptions
  lines.push(`    return () => { for (let i = 0; i < _subs.length; i++) _subs[i](); };`);

  return { code: lines.join('\n'), staticTemplates, helpers };
};

/**
 * Generate a static template property for pre-compiled HTML
 */
export const generateStaticTemplate = (content: string, emit: EmitOptions): string => {
  const escapedContent = escapeTemplateLiteral(emit.html(content));
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
