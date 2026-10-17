// Types of scripts/dist.mjs, for the unit tests.
export declare const AZURE_VARIABLES: readonly string[];
export declare const NOTARIZE_VARIABLES: readonly string[];
export declare function signingPlan(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): { args: string[]; env: Record<string, string>; notices: string[]; windowsSigned: boolean; macSigned: boolean; macNotarized: boolean };
export declare function archsOf(argv: string[], fallback?: string): string[];
