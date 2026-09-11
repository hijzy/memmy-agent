/** Agent source scan relay tests. */
import type { MemoryAgentSourceScanStatus, ScanPhase, ScanResultPage } from "@memmy/local-api-contracts";
import { describe, expect, it, vi } from "vitest";
import { createAgentSourceScanRelay } from "../agent-source-scan-relay.js";
import { createProgressBus } from "../progress-bus.js";
import type { AgentSourceScanCompletedEvent, AgentSourceScanProgressEvent } from "../progress-bus.js";

describe("createAgentSourceScanRelay", () => {
  it("turns the memory service's status changes into scan progress and one completion", async () => {
    const harness = createHarness([
      running({ phase: "scan", current: 0, total: 4 }),
      running({ phase: "add", current: 2, total: 4 }),
      running({ phase: "add", current: 2, total: 4 }),
      finished()
    ]);

    await harness.relay.poll();
    await harness.relay.poll();
    await harness.relay.poll();
    await harness.relay.poll();

    expect(harness.progress).toEqual([
      { jobId: "agent-scan-1", sourceId: "cursor", phase: "scan", current: 0, total: 4, origin: "app" },
      { jobId: "agent-scan-1", sourceId: "cursor", phase: "add", current: 2, total: 4, origin: "app" }
    ]);
    expect(harness.completed).toEqual([{
      jobId: "agent-scan-1",
      sourceId: "all",
      origin: "app",
      results: [{
        sourceId: "cursor",
        discoveredConversations: 3,
        emittedMessages: 12,
        skipped: 1,
        memoryIdCount: 2,
        errorCount: 0,
        errors: []
      }]
    }]);
    expect(harness.relay.status()).toEqual({
      active: false,
      progress: null,
      completion: {
        jobId: "agent-scan-1",
        sourceId: "all",
        succeeded: true,
        completedAt: "2026-09-11T10:00:30.000Z",
        origin: "app"
      }
    });
  });

  /** The Desktop UI has no business popping a progress card for the hourly automation. */
  it("labels a run the memory service started on its own with its origin", async () => {
    const harness = createHarness([
      { ...running({ phase: "scan", current: 1, total: 9 }), origin: "automation" }
    ]);

    await harness.relay.poll();

    expect(harness.progress[0]?.origin).toBe("automation");
  });

  /**
   * SSE only reports liveness; the status snapshot is the truth. Replaying a run
   * that ended while the backend was down would show a stale toast on every boot.
   */
  it("adopts a run that ended before the relay was watching without announcing it", async () => {
    const harness = createHarness([finished()]);

    await harness.relay.poll();

    expect(harness.progress).toEqual([]);
    expect(harness.completed).toEqual([]);
    expect(harness.relay.status().completion).toMatchObject({ jobId: "agent-scan-1", succeeded: true });
  });

  /**
   * A paused run keeps its staged turns and its job id for the resume, so it is
   * not finished and must not be reported as such.
   */
  it("keeps a paused run open and reports it as stopped", async () => {
    const harness = createHarness([
      running({ phase: "add", current: 2, total: 4 }),
      {
        ...running({ phase: "stopped", current: 2, total: 4, message: "Agent source scan paused" }),
        running: false
      },
      finished()
    ]);

    await harness.relay.poll();
    await harness.relay.poll();

    expect(harness.completed).toEqual([]);
    expect(harness.relay.status()).toMatchObject({
      active: false,
      progress: { phase: "stopped", current: 2, total: 4, message: "Agent source scan paused" }
    });

    await harness.relay.poll();

    expect(harness.completed).toHaveLength(1);
  });

  /**
   * The UI needs a reason per failing source to say anything useful, and the
   * reasons live in the job's own results page rather than the status snapshot.
   */
  it("pulls the per-conversation reasons behind a source's error count", async () => {
    const harness = createHarness([
      running({ phase: "add", current: 1, total: 2 }),
      {
        ...finished(),
        sources: [{ sourceId: "cursor", discoveredConversations: 3, emittedMessages: 12, written: 1, skipped: 0, errorCount: 3 }]
      }
    ], {
      items: [
        { sourceId: "cursor", conversationId: "conv-1", memoryId: "memory-1" },
        { sourceId: "cursor", conversationId: "conv-2", error: "memory layer unavailable" },
        { sourceId: "hermes", conversationId: "conv-9", error: "belongs to another source" }
      ],
      nextCursor: null
    });

    await harness.relay.poll();
    await harness.relay.poll();

    expect(harness.memoryClient.agentSourceScanResults).toHaveBeenCalledWith({ jobId: "agent-scan-1", limit: 200 });
    expect(harness.completed[0]?.results).toEqual([{
      sourceId: "cursor",
      discoveredConversations: 3,
      emittedMessages: 12,
      skipped: 0,
      memoryIdCount: 1,
      errorCount: 3,
      detailsTruncated: true,
      errors: [{ conversationId: "conv-2", reason: "memory layer unavailable" }]
    }]);
    expect(harness.relay.status().completion).toMatchObject({ succeeded: false });
  });

  it("reports a run that failed outright as a scan error", async () => {
    const harness = createHarness([
      running({ phase: "scan", current: 0, total: 0 }),
      { ...finished(), sources: [], error: "Agent source directory is unavailable" }
    ]);

    await harness.relay.poll();
    await harness.relay.poll();

    expect(harness.memoryClient.agentSourceScanResults).not.toHaveBeenCalled();
    expect(harness.completed[0]?.results).toEqual([{
      sourceId: "all",
      discoveredConversations: 0,
      emittedMessages: 0,
      skipped: 0,
      errorCount: 1,
      errors: [{ conversationId: "scan", reason: "Agent source directory is unavailable" }]
    }]);
  });

  /** The scan lives in the memory service, so an unreachable service ends the story. */
  it("releases a run once the memory service has been unreachable long enough", async () => {
    const harness = createHarness([running({ phase: "add", current: 1, total: 4 })]);

    await harness.relay.poll();
    harness.memoryClient.agentSourceScanStatus.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8765"));

    await harness.relay.poll();
    expect(harness.completed).toEqual([]);

    harness.advance(10_000);
    await harness.relay.poll();

    expect(harness.completed[0]?.results[0]?.errors).toEqual([{
      conversationId: "scan",
      reason: "Memory service unreachable: connect ECONNREFUSED 127.0.0.1:8765"
    }]);
    expect(harness.relay.status()).toMatchObject({ active: false, progress: null });
  });

  it("forgets a canceled run instead of announcing it", async () => {
    const harness = createHarness([
      running({ phase: "add", current: 1, total: 4 }),
      emptyStatus()
    ]);

    await harness.relay.poll();
    harness.relay.abandon();
    await harness.relay.poll();

    expect(harness.completed).toEqual([]);
    expect(harness.relay.status()).toEqual({ active: false, progress: null, completion: null });
  });

  /** A finished run stops being news, so a UI that reconnects much later sees nothing. */
  it("drops a finished run from the snapshot after a minute", async () => {
    const harness = createHarness([running({ phase: "add", current: 1, total: 4 }), finished()]);

    await harness.relay.poll();
    await harness.relay.poll();
    expect(harness.relay.status().completion).not.toBeNull();

    harness.advance(90_001);

    expect(harness.relay.status().completion).toBeNull();
  });
});

function createHarness(
  statuses: readonly MemoryAgentSourceScanStatus[],
  results: ScanResultPage = { items: [], nextCursor: null }
) {
  let clock = Date.parse("2026-09-11T10:00:00.000Z");
  let index = 0;
  const agentSourceScanStatus = vi.fn(async () => statuses[Math.min(index++, statuses.length - 1)] as MemoryAgentSourceScanStatus);
  const agentSourceScanResults = vi.fn(async () => results);
  const progressBus = createProgressBus();
  const progress: AgentSourceScanProgressEvent[] = [];
  const completed: AgentSourceScanCompletedEvent[] = [];
  progressBus.on("agent_source.scan_progress", (event) => progress.push(event));
  progressBus.on("agent_source.scan_completed", (event) => completed.push(event));

  const relay = createAgentSourceScanRelay({
    memoryClient: { agentSourceScanStatus, agentSourceScanResults },
    progressBus,
    now: () => clock
  });

  return {
    relay,
    progress,
    completed,
    memoryClient: { agentSourceScanStatus, agentSourceScanResults },
    advance(ms: number) {
      clock += ms;
    }
  };
}

function running(progress: { phase: ScanPhase; current: number; total: number; message?: string }): MemoryAgentSourceScanStatus {
  return {
    ...emptyStatus(),
    running: true,
    jobId: "agent-scan-1",
    sourceId: "all",
    mode: "incremental",
    origin: "app",
    progress: { sourceId: "cursor", ...progress },
    startedAt: "2026-09-11T10:00:00.000Z"
  };
}

function finished(): MemoryAgentSourceScanStatus {
  return {
    ...running({ phase: "done", current: 4, total: 4 }),
    running: false,
    completedAt: "2026-09-11T10:00:30.000Z",
    sources: [{ sourceId: "cursor", discoveredConversations: 3, emittedMessages: 12, written: 2, skipped: 1, errorCount: 0 }]
  };
}

function emptyStatus(): MemoryAgentSourceScanStatus {
  return {
    running: false,
    jobId: null,
    sourceId: null,
    mode: null,
    origin: null,
    progress: null,
    startedAt: null,
    completedAt: null,
    error: null,
    sources: [],
    pendingAdditions: null
  };
}
