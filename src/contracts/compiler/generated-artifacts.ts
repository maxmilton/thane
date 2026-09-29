import type { RuntimeHelperName } from '../runtime/internal-helpers.js';

/** What the code generator returns for a component's bindings (`generateInitBindingsFunction`). */
export interface GeneratedInitBindingsArtifact {
  code: string;
  staticTemplates: string[];
  /** The runtime helpers the generated code calls: the component imports exactly these. */
  helpers: Set<RuntimeHelperName>;
  /**
   * Whether the code reads the component template's elements, which the registration factory
   * passes as `__b`'s second argument (`__b(ctx, _ns)`, `_ns[i]` the template's i-th element).
   */
  elementList: boolean;
  /** Whether the code calls `_cloneNode` and `_insertBefore` (it has a list): the file imports them */
  domPrototype: boolean;
}
