/**
 * Template event handlers in the project type check (`thane build`, `thane typecheck`): a handler
 * gets its event's type, a handler for another event is an error, and every diagnostic points at
 * the source as written.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runProjectTypeCheck } from './tsc-type-checker.js';
import { createTempProject, removeTempProject, type TempProject } from '../../testing/build-project.js';

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ESNext',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    lib: ['ESNext', 'DOM'],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  },
  include: ['./src/**/*.ts', './.thane/types/**/*.d.ts'],
});

/** A component file whose setup declares `setup` and whose template is `markup`. */
const component = (name: string, setup: string, markup: string): string =>
  [
    "import { defineComponent, html, signal } from 'thane';",
    '',
    `export const ${name} = defineComponent(() => {`,
    '  const count = signal(0);',
    `  ${setup}`,
    `  return { template: html\`${markup}\` };`,
    '});',
    '',
  ].join('\n');

const CASES: Record<string, string> = {
  // An untyped parameter gets the event's type
  'src/untyped.ts': component(
    'Untyped',
    '',
    '<b @click=${(e) => count(e.clientX)} @keydown.enter=${(e) => e.key.length}>x</b>',
  ),
  // A handler for a wider event, no parameter, a custom event, and an expression that runs on the event
  'src/accepted.ts': component(
    'Accepted',
    'const onEvent = (e: Event) => e.type;',
    '<b @click=${onEvent} @input=${() => count(1)} @my-event=${(e: CustomEvent<number>) => e.detail} @focus=${count(2)}>x</b>',
  ),
  'src/wrong-member.ts': component('WrongMember', '', '<b @click=${(e) => e.key}>x</b>'),
  'src/wrong-event.ts': component('WrongEvent', '', '<b @click=${(e: KeyboardEvent) => e.key}>x</b>'),
  'src/wrong-reference.ts': component(
    'WrongReference',
    'const onKey = (e: KeyboardEvent) => e.key;',
    '<b @keydown=${onKey} @click=${onKey}>x</b>',
  ),
};

let project: TempProject;
let output = '';

beforeAll(async () => {
  project = await createTempProject('export {};\n', { 'tsconfig.json': TSCONFIG, ...CASES });
  const saved = console.error;
  const lines: string[] = [];
  console.error = (...a: unknown[]) => lines.push(a.map((v) => String(v).replace(/\x1b\[[0-9;]*m/g, '')).join(' '));
  try {
    await runProjectTypeCheck({ strict: false, projectRoot: project.root });
  } finally {
    console.error = saved;
  }
  output = lines.join('\n');
}, 60_000);

afterAll(async () => {
  await removeTempProject(project);
});

/** The error lines (`file:line:column - error TS…: message`) reported for one file. */
const errorsIn = (file: string): string[] =>
  output.split('\n').filter((line) => line.includes(`${file}:`) && line.includes(' - error TS'));

/** `line:column` of the first `needle` in a case file, 1-based. */
const at = (file: string, needle: string): string => {
  const lines = CASES[file]!.split('\n');
  const line = lines.findIndex((l) => l.includes(needle));
  return `${line + 1}:${lines[line]!.indexOf(needle) + 1}`;
};

describe('template event handlers in the type check', () => {
  test('an untyped parameter gets the event type, and accepted handlers pass', () => {
    expect(errorsIn('src/untyped.ts')).toEqual([]);
    expect(errorsIn('src/accepted.ts')).toEqual([]);
  });

  test("a member the event does not have is an error, at the member's position", () => {
    const errors = errorsIn('src/wrong-member.ts');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`src/wrong-member.ts:${at('src/wrong-member.ts', 'key}')} - error TS2339`);
    expect(errors[0]).toContain("Property 'key' does not exist on type 'PointerEvent'");
  });

  test('a handler for another event is an error, at the handler as written', () => {
    const errors = errorsIn('src/wrong-event.ts');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`src/wrong-event.ts:${at('src/wrong-event.ts', '(e: KeyboardEvent)')} - error TS1360`);
    expect(errors[0]).toContain(`does not satisfy the expected type 'ThaneEventListener<"click">'`);
  });

  test('a reference is checked against each event it is bound to', () => {
    const errors = errorsIn('src/wrong-reference.ts');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`src/wrong-reference.ts:${at('src/wrong-reference.ts', 'onKey}>')} - error TS1360`);
  });

  test('the printed source is the source as written', () => {
    expect(output).toContain('<b @click=${(e: KeyboardEvent) => e.key}>x</b>');
    expect(output).not.toContain('satisfies ThaneEventListener');
  });
});
