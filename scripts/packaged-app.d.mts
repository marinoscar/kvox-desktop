// Types of scripts/packaged-app.mjs, for the unit tests.
export declare const EXPECTED_FUSES: Readonly<Record<string, boolean>>;
export declare function locate(platform?: NodeJS.Platform): string;
export declare function resourcesOf(executable: string): string;
export declare function readFuses(executable: string): Promise<Record<string, boolean | string>>;
export declare function unpackedApps(platform?: NodeJS.Platform, arch?: string): string[];
export declare const MAX_LOOSE_FILE_BYTES: number;
export declare function copilotRuntimeProblems(
  resources: string,
  options?: { archiveEntries?: string[]; allowBundled?: boolean },
): string[];
export declare function embedderRuntimeProblems(unpacked: string, archiveEntries?: readonly string[]): string[];
