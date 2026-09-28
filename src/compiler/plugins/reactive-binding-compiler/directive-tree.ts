/** One walk over the nested directive blocks (`when`, `whenElse`, `repeat`) of a template. */

import type { ConditionalBlock, RepeatBlock, WhenElseBlock } from './types.js';

/** The directive blocks at the top of a template (or of any branch or row). */
export interface DirectiveRoots {
  conditionals?: readonly ConditionalBlock[] | undefined;
  whenElse?: readonly WhenElseBlock[] | undefined;
  repeats?: readonly RepeatBlock[] | undefined;
}

/** Called once per block, before its children. Returning `false` skips the block's subtree. */
export interface DirectiveVisitor {
  cond?: ((block: ConditionalBlock) => boolean | void) | undefined;
  whenElse?: ((block: WhenElseBlock) => boolean | void) | undefined;
  repeat?: ((block: RepeatBlock) => boolean | void) | undefined;
}

/**
 * Visit every directive block in pre-order. At each level conditionals come first, then
 * whenElse blocks, then repeats. A whenElse block's children are its then and else
 * conditionals, then its then and else whenElse blocks, then its then and else repeats.
 */
export const walkDirectives = (roots: DirectiveRoots, visit: DirectiveVisitor): void => {
  const cond = (block: ConditionalBlock): void => {
    if (visit.cond?.(block) === false) return;
    level(block.nestedConditionals, block.nestedWhenElse, block.nestedRepeats);
  };
  const whenElse = (block: WhenElseBlock): void => {
    if (visit.whenElse?.(block) === false) return;
    block.thenConditionals.forEach(cond);
    block.elseConditionals.forEach(cond);
    block.thenWhenElse.forEach(whenElse);
    block.elseWhenElse.forEach(whenElse);
    block.thenRepeats.forEach(repeat);
    block.elseRepeats.forEach(repeat);
  };
  const repeat = (block: RepeatBlock): void => {
    if (visit.repeat?.(block) === false) return;
    level(block.nestedConditionals, block.nestedWhenElse, block.nestedRepeats);
  };
  const level = (
    conditionals: readonly ConditionalBlock[] | undefined,
    whenElseBlocks: readonly WhenElseBlock[] | undefined,
    repeats: readonly RepeatBlock[] | undefined,
  ): void => {
    conditionals?.forEach(cond);
    whenElseBlocks?.forEach(whenElse);
    repeats?.forEach(repeat);
  };
  level(roots.conditionals, roots.whenElse, roots.repeats);
};
