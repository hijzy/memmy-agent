/**
 * Onboarding sampling service.
 *
 * Runs every Agent's sampler in parallel and drops the ones that do not answer
 * in time: a first-login report that is missing one Agent is still a report,
 * while one that never arrives is not.
 */
import { MemoryServiceError } from "../../utils/error.js";
import { createBuiltinOnboardingSamplers } from "./samplers.js";
import { createSourceRegistryConversationWindowReader } from "./conversation-window.js";
import type { SourceRegistry } from "../adapters/source-registry.js";
import type {
  OnboardingConversationReference,
  OnboardingConversationWindow,
  OnboardingConversationWindowReader,
  OnboardingSampleOptions,
  OnboardingSampleResult,
  OnboardingSampler
} from "./types.js";

export const DEFAULT_ONBOARDING_SAMPLE_OPTIONS = {
  maxSessionFiles: 6,
  maxQueries: 12,
  maxQueryChars: 600,
  maxBytesPerFile: 768 * 1024,
  deadlineMs: 3_000
} as const;

const MAX_SESSION_FILES = 24;
const MAX_QUERIES = 64;
const MAX_QUERY_CHARS = 4_000;
const MAX_BYTES_PER_FILE = 4 * 1024 * 1024;
const MAX_DEADLINE_MS = 15_000;

export interface CreateOnboardingSampleServiceOptions {
  sourceRegistry: SourceRegistry;
  samplers?: readonly OnboardingSampler[];
  conversationWindowReader?: OnboardingConversationWindowReader;
}

export interface OnboardingSampleService {
  /** Reads a shallow recent-history window from every detected Agent. */
  sample(input: unknown): Promise<{ samples: OnboardingSampleResult[] }>;
  /** Reads one conversation, trimmed to what a prompt can carry. */
  readConversation(input: unknown): Promise<{ conversation: OnboardingConversationWindow | null }>;
}

export function createOnboardingSampleService(
  options: CreateOnboardingSampleServiceOptions
): OnboardingSampleService {
  const samplers = options.samplers ?? createBuiltinOnboardingSamplers();
  const windowReader = options.conversationWindowReader
    ?? createSourceRegistryConversationWindowReader(options.sourceRegistry);

  return {
    async sample(input) {
      const sampleOptions = normalizeSampleOptions(input);
      const deadline = AbortSignal.timeout(sampleOptions.deadlineMs);
      const results = await Promise.all(
        samplers.map((sampler) => sampleWithinDeadline(sampler, sampleOptions, deadline))
      );
      return { samples: results.filter((result): result is OnboardingSampleResult => Boolean(result)) };
    },

    async readConversation(input) {
      const request = normalizeConversationInput(input);
      if (!options.sourceRegistry.get(request.reference.sourceId)) {
        // A manual source or an Agent this build does not know: the caller
        // reports without the conversation rather than failing.
        return { conversation: null };
      }
      const conversation = await windowReader.readConversation(request.reference, {
        maxQueryChars: request.maxQueryChars,
        deadlineMs: request.deadlineMs
      });
      return { conversation };
    }
  };
}

/**
 * A sampler that overruns its deadline is abandoned rather than awaited: the
 * file it is reading may be arbitrarily large, and the report cannot wait.
 */
async function sampleWithinDeadline(
  sampler: OnboardingSampler,
  options: OnboardingSampleOptions,
  deadline: AbortSignal
): Promise<OnboardingSampleResult | null> {
  if (deadline.aborted) {
    return null;
  }
  let abandon: (() => void) | undefined;
  const abandoned = new Promise<null>((resolve) => {
    abandon = () => resolve(null);
    deadline.addEventListener("abort", abandon, { once: true });
  });

  try {
    return await Promise.race([sample(sampler, { ...options, signal: deadline }), abandoned]);
  } finally {
    if (abandon) {
      deadline.removeEventListener("abort", abandon);
    }
  }
}

async function sample(
  sampler: OnboardingSampler,
  options: OnboardingSampleOptions
): Promise<OnboardingSampleResult | null> {
  try {
    if (options.signal?.aborted || !(await sampler.detect())) {
      return null;
    }
    return await sampler.sampleRecentUserQueries(options);
  } catch (error) {
    if (options.signal?.aborted) {
      return null;
    }
    // One unreadable Agent is reported as an error row, not as a failed sample.
    return {
      sourceId: sampler.sourceId,
      displayName: sampler.displayName,
      recentSessionCount: 0,
      latestActivityAt: null,
      queries: [],
      errors: [{ target: sampler.sourceId, reason: error instanceof Error ? error.message : "sample failed" }]
    };
  }
}

function normalizeSampleOptions(input: unknown): OnboardingSampleOptions {
  const body = record(input);
  return {
    maxSessionFiles: boundedInteger(body.maxSessionFiles, DEFAULT_ONBOARDING_SAMPLE_OPTIONS.maxSessionFiles, MAX_SESSION_FILES),
    maxQueries: boundedInteger(body.maxQueries, DEFAULT_ONBOARDING_SAMPLE_OPTIONS.maxQueries, MAX_QUERIES),
    maxQueryChars: boundedInteger(body.maxQueryChars, DEFAULT_ONBOARDING_SAMPLE_OPTIONS.maxQueryChars, MAX_QUERY_CHARS),
    maxBytesPerFile: boundedInteger(body.maxBytesPerFile, DEFAULT_ONBOARDING_SAMPLE_OPTIONS.maxBytesPerFile, MAX_BYTES_PER_FILE),
    deadlineMs: boundedInteger(body.deadlineMs, DEFAULT_ONBOARDING_SAMPLE_OPTIONS.deadlineMs, MAX_DEADLINE_MS)
  };
}

function normalizeConversationInput(input: unknown): {
  reference: OnboardingConversationReference;
  maxQueryChars: number;
  deadlineMs: number;
} {
  const body = record(input);
  const sourceId = requiredString(body.sourceId, "sourceId");
  const conversationId = requiredString(body.conversationId, "conversationId");
  return {
    reference: {
      sourceId,
      displayName: typeof body.displayName === "string" && body.displayName.length > 0 ? body.displayName : sourceId,
      conversationId,
      latestActivityAt: typeof body.latestActivityAt === "string" && body.latestActivityAt.length > 0
        ? body.latestActivityAt
        : new Date(0).toISOString(),
      workspacePath: typeof body.workspacePath === "string" && body.workspacePath.length > 0 ? body.workspacePath : null
    },
    maxQueryChars: boundedInteger(body.maxQueryChars, DEFAULT_ONBOARDING_SAMPLE_OPTIONS.maxQueryChars, MAX_QUERY_CHARS),
    deadlineMs: boundedInteger(body.deadlineMs, DEFAULT_ONBOARDING_SAMPLE_OPTIONS.deadlineMs, MAX_DEADLINE_MS)
  };
}

function record(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function boundedInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), max);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MemoryServiceError("invalid_argument", `${field} is required`);
  }
  return value;
}

export type {
  OnboardingConversationReference,
  OnboardingConversationWindow,
  OnboardingSampleResult,
  OnboardingSampledMessage,
  OnboardingSampledQuery,
  OnboardingSampler
} from "./types.js";
