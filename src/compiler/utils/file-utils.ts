import fs from 'node:fs';
import path from 'node:path';
import type { BuildContext, ComponentDefinition } from '../types.js';
import { sourceCache } from './cache.js';
import { extractComponentDefinitions } from './ast-utils.js';
import { logger } from './logger.js';
import type ts from 'typescript';

/** The definitions found in a parsed file: the cache keeps a file's parse while it is unchanged, so a rescan reuses them */
const definitionsByFile = new WeakMap<ts.SourceFile, ComponentDefinition[]>();

export const safeReadFile = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    logger.verbose(`safeReadFile: failed to read "${filePath}": ${err instanceof Error ? err.message : err}`);
    return null;
  }
};

/** Directories that should never be scanned for component sources */
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git', '.svn', '.hg', 'coverage', '.turbo', '.next', '.nuxt']);

export const collectFilesRecursively = async (
  dir: string,
  filter: (fileName: string) => boolean,
  excludeDirs: Set<string> = EXCLUDED_DIRS,
): Promise<string[]> => {
  const files: string[] = [];

  const collect = async (currentDir: string): Promise<void> => {
    try {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (!excludeDirs.has(entry.name)) {
            await collect(fullPath);
          }
        } else if (entry.isFile() && filter(entry.name)) {
          files.push(path.normalize(fullPath));
        }
      }
    } catch (err) {
      // Skip directories that can't be read, but log for diagnostics
      logger.verbose(`collectFilesRecursively: skipping "${currentDir}": ${err instanceof Error ? err.message : err}`);
    }
  };

  await collect(dir);
  return files;
};

/** Content types by file extension, for the files a web app serves. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/**
 * The content type of a served file, from its extension; `application/octet-stream` when it is unknown.
 * Takes a URL path or a file path.
 */
export const getContentType = (url: string): string => {
  const name = url.slice(Math.max(url.lastIndexOf('/'), url.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  return (dot === -1 ? undefined : CONTENT_TYPES[name.slice(dot).toLowerCase()]) ?? 'application/octet-stream';
};

/**
 * Create a shared BuildContext by scanning the working directory, and the project root when it lies
 * outside it, for component files.
 */
export const createBuildContext = async (projectRoot?: string): Promise<BuildContext> => {
  const workspaceRoot = process.cwd();
  const tsFilter = (name: string) => name.endsWith('.ts') && !name.endsWith('.d.ts');

  const components: ComponentDefinition[] = [];
  const componentsBySelector = new Map<string, ComponentDefinition>();

  // The source cache checks each file's modification time, so a rescan parses only what changed
  const tsFiles = await collectFilesRecursively(workspaceRoot, tsFilter);
  const toProject = projectRoot ? path.relative(workspaceRoot, projectRoot) : '';
  if (toProject === '..' || toProject.startsWith('..' + path.sep) || path.isAbsolute(toProject)) {
    const seen = new Set(tsFiles);
    tsFiles.push(...(await collectFilesRecursively(projectRoot!, tsFilter)).filter((file) => !seen.has(file)));
  }
  for (const filePath of tsFiles) {
    const cached = await sourceCache.get(filePath);
    if (cached) {
      let definitions = definitionsByFile.get(cached.sourceFile);
      if (!definitions) {
        definitions = extractComponentDefinitions(cached.sourceFile, filePath);
        definitionsByFile.set(cached.sourceFile, definitions);
      }
      for (const def of definitions) {
        components.push(def);
        componentsBySelector.set(def.selector, def);
      }
    }
  }

  return { tsFiles, projectRoot: projectRoot ?? workspaceRoot, components, componentsBySelector };
};

/**
 * Scan again, for a rebuild in watch mode: a component file added (or removed) since the last scan
 * is found. The context is updated in place, since every plugin of the build holds it.
 */
export const refreshBuildContext = async (context: BuildContext): Promise<void> => {
  const next = await createBuildContext(context.projectRoot);
  context.tsFiles = next.tsFiles;
  context.components = next.components;
  context.componentsBySelector = next.componentsBySelector;
};

/**
 * The directory that owns a project: the nearest ancestor of `entryFile` that
 * contains a tsconfig.json or package.json, falling back to the entry's own
 * directory. Type sync and type checking are scoped to it so that building one
 * project never touches another project's generated types.
 */
export const resolveProjectRoot = (entryFile: string): string => {
  const entryDir = path.dirname(path.resolve(entryFile));
  let dir = entryDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'tsconfig.json')) || fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return entryDir;
    dir = parent;
  }
};

/**
 * A warning when the project root lies above the folder Thane runs in. That folder has no package.json
 * or tsconfig.json of its own, so it builds as part of the enclosing one (a scratch app inside a
 * repository), which is rarely what was meant. Null when the root is that folder or elsewhere.
 */
export const projectRootWarning = (projectRoot: string, cwd: string = process.cwd()): string | null => {
  const inside = path.relative(path.resolve(projectRoot), path.resolve(cwd));
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return (
    `${cwd} has no package.json or tsconfig.json, so it builds as part of ${projectRoot}: the type check ` +
    'and the generated .thane types cover that whole folder. Add a package.json here to build this folder on its own.'
  );
};
