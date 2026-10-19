import { z } from 'zod';

// =============================================================================
// The Copilot wire shapes (marinoscar/kvox#631) - TEMPORARY LOCAL MIRROR
// =============================================================================
//
// These are the exact shapes of `@marinoscar/kvox-contract/copilot`
// (`CopilotSettingsSchema`, `CopilotStatusSchema`, `CopilotSignInChallengeSchema`,
// `COPILOT_CONSENT_VERSION`). They live here ONLY until that subpath is
// published; the dependency bump replaces this file with a re-export and deletes
// the copy. Nothing else in the repository imports the shapes from anywhere but
// this module, so the swap is one file.
// =============================================================================

export const CopilotSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  consentedAt: z.string().datetime().nullable().default(null),
  /** Bumped when the consent text changes, to ask again. */
  consentVersion: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
});
export type CopilotSettings = z.infer<typeof CopilotSettingsSchema>;

export const CopilotStatusSchema = z.object({
  enabled: z.boolean(),
  signedIn: z.boolean(),
  login: z.string().nullable(),
  runtime: z.object({
    state: z.enum(['missing', 'downloading', 'ready', 'error']),
    version: z.string().nullable(),
    progress: z.number().min(0).max(1).nullable(),
  }),
  models: z.array(z.object({ id: z.string(), label: z.string(), structuredOutput: z.enum(['native', 'prompted']) })),
  unavailableTasks: z.array(z.object({ task: z.string(), reason: z.enum(['needs_tool_calling', 'needs_embeddings']) })),
});
export type CopilotStatus = z.infer<typeof CopilotStatusSchema>;

export const CopilotSignInChallengeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('device'), userCode: z.string(), verificationUri: z.string().url(), expiresAt: z.string() }),
  z.object({ kind: z.literal('browser'), url: z.string().url() }),
]);
export type CopilotSignInChallenge = z.infer<typeof CopilotSignInChallengeSchema>;

export const COPILOT_CONSENT_VERSION = '1';
