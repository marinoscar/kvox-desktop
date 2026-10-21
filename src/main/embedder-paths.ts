import { sep } from 'node:path';

/**
 * The copy of `file` under `app.asar.unpacked` when `file` is inside `app.asar`, else `null`
 * (a development checkout, or a file already outside the archive). `asarUnpack` in
 * electron-builder.yml puts the onnxruntime-web glue there.
 */
export function unpackedRuntimeFile(file: string): string | null {
  const marker = `app.asar${sep}`;
  const at = file.indexOf(marker);
  if (at < 0) return null;
  return `${file.slice(0, at)}app.asar.unpacked${sep}${file.slice(at + marker.length)}`;
}
