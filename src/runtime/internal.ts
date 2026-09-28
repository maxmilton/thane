/** Internal runtime exports used by compiler-generated code. */

export { signal as __sig } from './signal.js';
export {
  __registerComponent,
  __registerComponentLean,
  __enableComponentStyles,
  __dc,
  mountComponent,
} from './component.js';
export { __bindIf, __bindIfExpr, createKeyedReconciler } from './dom-binding.js';
