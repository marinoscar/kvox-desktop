// Types of scripts/build-icons.mjs, for the unit tests.
export declare const MARK_SPECIFIER: string;
export declare const ICO_SIZES: readonly number[];
export declare const LINUX_SIZES: readonly number[];
export declare const ICNS_ENTRIES: readonly (readonly [string, number])[];
export declare const MARK_COLOURS: readonly string[];
export declare const LINUX_ICON_DIR: string;
export declare function resolveMark(from?: string): string | null;
export declare function assertKvoxMark(svg: string, label?: string): void;
export declare function rasterize(svg: string, size: number): Buffer;
export declare function buildIco(images: { size: number; png: Buffer }[]): Buffer;
export declare function buildIcns(entries: { type: string; png: Buffer }[]): Buffer;
export declare function generateIcons(svg: string): Map<string, Buffer>;
export declare function compareIcons(
  generated: Map<string, Buffer>,
  root?: string,
): { missing: string[]; changed: string[]; stale: string[] };
export declare function writeIcons(generated: Map<string, Buffer>, root?: string): void;
