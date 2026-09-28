/** Utilities for position-based source code editing. */

export interface SourceEdit {
  start: number;
  end: number;
  replacement: string;
}

/** Apply multiple edits to source code (applied bottom-to-top to avoid position shifting). */
export const applyEdits = (source: string, edits: SourceEdit[]): string => {
  if (edits.length === 0) return source;

  // Sort by position descending (apply from bottom to top)
  const sortedEdits = [...edits].sort((a, b) => b.start - a.start);

  // Validate: no overlapping ranges (compare adjacent pairs after sorting)
  for (let i = 0; i < sortedEdits.length - 1; i++) {
    const higher = sortedEdits[i]!;
    const lower = sortedEdits[i + 1]!;
    if (lower.end > higher.start) {
      throw new Error(
        `Overlapping edits detected: [${lower.start}..${lower.end}) overlaps [${higher.start}..${higher.end})`,
      );
    }
  }

  let result = source;
  for (const edit of sortedEdits) {
    result = result.substring(0, edit.start) + edit.replacement + result.substring(edit.end);
  }

  return result;
};
