import type { RuntimeHelperName } from '../runtime/internal-helpers.js';

/** What the code generator returns for a component's bindings (`generateInitBindingsFunction`). */
export interface GeneratedInitBindingsArtifact {
  code: string;
  staticTemplates: string[];
  /** The runtime helpers the generated code calls: the component imports exactly these. */
  helpers: Set<RuntimeHelperName>;
}
