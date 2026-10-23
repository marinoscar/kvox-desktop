import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { normalizeLibraryPath } from '@marinoscar/kvox-contract/notes';

import type { FilesErrorCode } from '../../shared/protocol';

// =============================================================================
// Paths inside a picked folder (marinoscar/kvox-desktop#47)
// =============================================================================
//
// Every relative path the renderer sends is untrusted. It must pass the
// contract's `normalizeLibraryPath` (POSIX, no leading slash, no drive letter,
// no `..`), then resolve INSIDE the folder root, twice: lexically, and once
// more after symbolic links are resolved (`realpath`), so a link inside the
// folder that points outside it cannot be read through. Nothing here decides
// what a library is; the contract does.
// =============================================================================

/** An expected failure of a file call, with the code the renderer maps to `KvoxFileAccessError`. */
export class FilesError extends Error {
  readonly code: FilesErrorCode;

  constructor(code: FilesErrorCode, message: string) {
    super(message);
    this.name = 'FilesError';
    this.code = code;
  }
}

/** True when `child` is `root` itself or below it (both absolute and normalised). */
export function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * The absolute path of `relativePath` inside `root`, or a `FilesError` (`not_found`) when the path is not a
 * library path or escapes the root (lexically or through a symbolic link).
 */
export async function resolveInside(root: string, relativePath: unknown): Promise<{ path: string; absolute: string }> {
  const normalized = typeof relativePath === 'string' ? normalizeLibraryPath(relativePath) : null;
  if (normalized === null) throw new FilesError('not_found', 'Not a path inside the folder.');
  const absolute = resolve(root, ...normalized.split('/'));
  if (!isInside(resolve(root), absolute)) throw new FilesError('not_found', 'Not a path inside the folder.');
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new FilesError('not_found', 'The folder is no longer on this computer.');
  }
  try {
    realTarget = await realpath(absolute);
  } catch {
    throw new FilesError('not_found', `No file "${normalized}" in the folder.`);
  }
  if (!isInside(realRoot, realTarget)) throw new FilesError('not_found', 'Not a path inside the folder.');
  return { path: normalized, absolute: realTarget };
}
