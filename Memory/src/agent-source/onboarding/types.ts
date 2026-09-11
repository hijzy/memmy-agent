/**
 * Onboarding sampling contracts.
 *
 * Memmy Desktop's first-login report is written from a shallow read of the
 * Agents' recent history. Reading other Agents' history is the memory service's
 * job, so the sampling happens here and Desktop only orchestrates and generates.
 */

export interface OnboardingSampleOptions {
  /** History files or databases to look at per Agent. */
  maxSessionFiles: number;
  maxQueries: number;
  maxQueryChars: number;
  maxBytesPerFile: number;
  /** How long one Agent may take before it is dropped from the sample. */
  deadlineMs: number;
  signal?: AbortSignal;
}

export interface OnboardingSampledQuery {
  sourceId: string;
  conversationId: string;
  messageId: string;
  createdAt: string;
  text: string;
  workspacePath: string | null;
}

export interface OnboardingSampledMessage extends OnboardingSampledQuery {
  role: "user" | "assistant" | "tool";
}

export interface OnboardingConversationReference {
  sourceId: string;
  displayName: string;
  conversationId: string;
  latestActivityAt: string;
  workspacePath: string | null;
}

export interface OnboardingConversationWindow extends OnboardingConversationReference {
  messages: OnboardingSampledMessage[];
}

export interface OnboardingSampleResult {
  sourceId: string;
  displayName: string;
  recentSessionCount: number;
  latestActivityAt: string | null;
  queries: OnboardingSampledQuery[];
  /** Recent visible messages, used only to identify the newest conversation. */
  recentMessages?: OnboardingSampledMessage[];
  errors: Array<{ target: string; reason: string }>;
}

export interface OnboardingSampler {
  readonly sourceId: string;
  readonly displayName: string;
  detect(): Promise<boolean>;
  sampleRecentUserQueries(options: OnboardingSampleOptions): Promise<OnboardingSampleResult>;
}

export interface OnboardingConversationWindowReader {
  readConversation(
    reference: OnboardingConversationReference,
    options: Pick<OnboardingSampleOptions, "maxQueryChars" | "deadlineMs" | "signal">
  ): Promise<OnboardingConversationWindow | null>;
}

/** Builds the "nothing to report" answer an Agent returns when it has no history. */
export function emptyOnboardingSampleResult(input: {
  sourceId: string;
  displayName: string;
  errors?: Array<{ target: string; reason: string }>;
}): OnboardingSampleResult {
  return {
    sourceId: input.sourceId,
    displayName: input.displayName,
    recentSessionCount: 0,
    latestActivityAt: null,
    queries: [],
    recentMessages: [],
    errors: input.errors ?? []
  };
}
