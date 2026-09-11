/** Agent source scan relay module. */
import type {
  AgentSourceScanOrigin,
  AgentSourceScanProgressPayload,
  AgentSourceScanStatusResponse,
  MemoryAgentSourceScanStatus,
  ScanResult
} from "@memmy/local-api-contracts";
import type { MemoryClient } from "../adapters/outbound/memory-client/types.js";
import type { ProgressBus } from "./progress-bus.js";

/** How often to poll while the memory service is scanning. */
const ACTIVE_POLL_INTERVAL_MS = 250;
/** How often to look for a scan nobody told us about: the Viewer's, the CLI's, the automation's. */
const IDLE_POLL_INTERVAL_MS = 5_000;
/** How long a finished scan stays in the snapshot, so a reconnecting UI still sees it. */
const COMPLETION_RETENTION_MS = 60_000;
/** How long the memory service may stay unreachable before a running scan is called failed. */
const UNREACHABLE_GRACE_MS = 10_000;
/** How many per-conversation failures to pull for the completion event. */
const ERROR_DETAIL_LIMIT = 200;

/** Contract for agent source scan relay options. */
export interface AgentSourceScanRelayOptions {
  memoryClient: Pick<MemoryClient, "agentSourceScanStatus" | "agentSourceScanResults">;
  progressBus: ProgressBus;
  logger?: { warn: (message: string, meta: Record<string, unknown>) => void };
  activePollIntervalMs?: number;
  idlePollIntervalMs?: number;
  now?: () => number;
}

/**
 * Contract for agent source scan relay.
 *
 * Scans run in the memory service, which only answers questions; it cannot push.
 * The relay polls its status and turns the changes into the SSE events the
 * Desktop UI already listens for. SSE stays a liveness hint: `status()` is the
 * truth, so a UI that reconnects reads it instead of replaying missed events.
 */
export interface AgentSourceScanRelay {
  /** The latest snapshot, without a round trip per request. */
  status(): AgentSourceScanStatusResponse;
  /** Polls now and returns the fresh snapshot. */
  poll(): Promise<AgentSourceScanStatusResponse>;
  start(): void;
  stop(): Promise<void>;
  /** Forgets the run being watched without announcing it, for cancel. */
  abandon(): void;
}

/** Creates create agent source scan relay. */
export function createAgentSourceScanRelay(options: AgentSourceScanRelayOptions): AgentSourceScanRelay {
  const activeIntervalMs = options.activePollIntervalMs ?? ACTIVE_POLL_INTERVAL_MS;
  const idleIntervalMs = options.idlePollIntervalMs ?? IDLE_POLL_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());

  let progress: AgentSourceScanProgressPayload | null = null;
  let completion: NonNullable<AgentSourceScanStatusResponse["completion"]> | null = null;
  let active = false;
  /** The last run we watched, so a run that ends between two polls still completes. */
  let watched: { jobId: string; sourceId: string; origin: AgentSourceScanOrigin | null } | null = null;
  /** No run has been seen alive yet, so a finished one is adopted rather than announced. */
  let adopted = false;
  let unreachableSince: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let polling: Promise<AgentSourceScanStatusResponse> | null = null;
  let started = false;

  const relay: AgentSourceScanRelay = {
    status() {
      return snapshot();
    },

    async poll() {
      // One flight at a time: the route calls this right after asking for a scan,
      // which may land in the middle of the timer's own poll.
      polling = polling ?? pollOnce().finally(() => {
        polling = null;
      });
      return polling;
    },

    start() {
      started = true;
      schedule(0);
    },

    async stop() {
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
      await polling?.catch(() => undefined);
    },

    abandon() {
      watched = null;
      progress = null;
      completion = null;
      active = false;
      adopted = true;
    }
  };

  return relay;

  function snapshot(): AgentSourceScanStatusResponse {
    return {
      active,
      progress: active || progress?.phase === "stopped" ? progress : null,
      completion: completion && now() - Date.parse(completion.completedAt) <= COMPLETION_RETENTION_MS
        ? completion
        : null
    };
  }

  function schedule(delayMs: number): void {
    // A one-off poll from a route must not start the loop behind the caller's back.
    if (!started) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void relay.poll().catch(() => undefined);
    }, delayMs);
    timer.unref?.();
  }

  async function pollOnce(): Promise<AgentSourceScanStatusResponse> {
    let status: MemoryAgentSourceScanStatus;
    try {
      status = await options.memoryClient.agentSourceScanStatus();
    } catch (error) {
      handleUnreachable(error);
      schedule(active ? activeIntervalMs : idleIntervalMs);
      return snapshot();
    }

    unreachableSince = null;
    await apply(status);
    schedule(status.running ? activeIntervalMs : idleIntervalMs);
    return snapshot();
  }

  async function apply(status: MemoryAgentSourceScanStatus): Promise<void> {
    const superseded = watched && watched.jobId !== status.jobId ? watched : null;
    const run = watched && watched.jobId === status.jobId ? watched : null;
    active = status.running;
    watched = status.jobId
      ? { jobId: status.jobId, sourceId: status.sourceId ?? "all", origin: status.origin }
      : null;
    reportProgress(status);

    if (superseded) {
      // The service moved on to another run before we saw this one end, so its
      // per-source counts are gone. The UI still needs to stop waiting on it.
      announceCompletion(superseded, [], null);
    }

    // A run that stopped without finishing is paused, not done: the memory
    // service keeps its staged turns and the same job id for the resume.
    const finished = Boolean(status.jobId) && !status.running && Boolean(status.completedAt || status.error);
    if (!finished) {
      adopted = true;
      return;
    }

    watched = null;
    if (!adopted) {
      // A finished run the relay never saw running, most likely because the
      // backend restarted. `status()` reports it; SSE does not replay it.
      adopted = true;
      completion = {
        jobId: status.jobId as string,
        sourceId: status.sourceId ?? "all",
        succeeded: !status.error && status.sources.every((source) => source.errorCount === 0),
        completedAt: status.completedAt ?? new Date(now()).toISOString(),
        ...(status.origin ? { origin: status.origin } : {})
      };
      return;
    }

    if (!run) return;
    announceCompletion(
      { ...run, origin: status.origin ?? run.origin },
      await scanResults(status, run.jobId),
      status.completedAt
    );
  }

  function reportProgress(status: MemoryAgentSourceScanStatus): void {
    if (!status.jobId || !status.progress) {
      if (!status.running) progress = null;
      return;
    }

    const next: AgentSourceScanProgressPayload = {
      jobId: status.jobId,
      ...status.progress,
      ...(status.origin ? { origin: status.origin } : {})
    };
    const changed = !progress || !samePayload(progress, next);
    progress = next;
    // A finished run is announced by its completion event; only a live run, or a
    // pause someone else asked for, is news worth pushing.
    const live = status.running || next.phase === "stopped";
    if (changed && live) options.progressBus.emit("agent_source.scan_progress", next);
  }

  function announceCompletion(
    run: { jobId: string; sourceId: string; origin: AgentSourceScanOrigin | null },
    results: readonly ScanResult[],
    completedAt: string | null
  ): void {
    completion = {
      jobId: run.jobId,
      sourceId: run.sourceId,
      succeeded: results.every((result) => result.errors.length === 0),
      completedAt: completedAt ?? new Date(now()).toISOString(),
      ...(run.origin ? { origin: run.origin } : {})
    };
    options.progressBus.emit("agent_source.scan_completed", {
      jobId: run.jobId,
      sourceId: run.sourceId,
      results: [...results],
      ...(run.origin ? { origin: run.origin } : {})
    });
  }

  async function scanResults(status: MemoryAgentSourceScanStatus, jobId: string): Promise<ScanResult[]> {
    const results: ScanResult[] = status.sources.map((source) => ({
      sourceId: source.sourceId,
      discoveredConversations: source.discoveredConversations,
      emittedMessages: source.emittedMessages,
      skipped: source.skipped,
      memoryIdCount: source.written,
      errorCount: source.errorCount,
      errors: []
    }));

    if (status.error) {
      // A run that failed outright never reported per-source stats.
      results.push({
        sourceId: status.sourceId ?? "all",
        discoveredConversations: 0,
        emittedMessages: 0,
        skipped: 0,
        errorCount: 1,
        errors: [{ conversationId: "scan", reason: status.error }]
      });
      return results;
    }

    if (results.every((result) => (result.errorCount ?? 0) === 0)) return results;
    await attachErrorDetails(results, jobId);
    return results;
  }

  /**
   * Per-conversation reasons live in the job's own results page. The UI needs at
   * least one reason per failing source to say anything useful about it.
   */
  async function attachErrorDetails(results: ScanResult[], jobId: string): Promise<void> {
    let page;
    try {
      page = await options.memoryClient.agentSourceScanResults({ jobId, limit: ERROR_DETAIL_LIMIT });
    } catch (error) {
      options.logger?.warn("agent_source.scan_relay_results_failed", { jobId, error: describe(error) });
      return;
    }

    for (const item of page.items) {
      if (!item.error) continue;
      const result = results.find((candidate) => candidate.sourceId === item.sourceId);
      if (!result) continue;
      result.errors.push({ conversationId: item.conversationId, reason: item.error });
    }
    for (const result of results) {
      if ((result.errorCount ?? 0) > result.errors.length) result.detailsTruncated = true;
    }
  }

  function handleUnreachable(error: unknown): void {
    unreachableSince = unreachableSince ?? now();
    if (!watched || now() - unreachableSince < UNREACHABLE_GRACE_MS) return;

    // The scan lives in the memory service. If we cannot reach it for this long
    // we cannot say the run is still going, and a UI waiting on a progress card
    // has to be released.
    const run = watched;
    watched = null;
    active = false;
    progress = null;
    options.logger?.warn("agent_source.scan_relay_unreachable", { jobId: run.jobId, error: describe(error) });
    announceCompletion(run, [{
      sourceId: run.sourceId,
      discoveredConversations: 0,
      emittedMessages: 0,
      skipped: 0,
      errorCount: 1,
      errors: [{ conversationId: "scan", reason: `Memory service unreachable: ${describe(error)}` }]
    }], null);
  }
}

function samePayload(left: AgentSourceScanProgressPayload, right: AgentSourceScanProgressPayload): boolean {
  return left.jobId === right.jobId
    && left.sourceId === right.sourceId
    && left.phase === right.phase
    && left.current === right.current
    && left.total === right.total
    && left.message === right.message
    && left.origin === right.origin;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
