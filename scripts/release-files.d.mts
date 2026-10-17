// Types of scripts/release-files.mjs, for the unit tests.
export declare function mergeUpdateInfo(texts: string[]): string;
export declare function checksums(dir: string): string;
export declare function gate(
  plans: Array<{ platform: string; arch: string; windowsSigned: boolean; macSigned: boolean; macNotarized: boolean }>,
): { publish: boolean; reasons: string[] };
