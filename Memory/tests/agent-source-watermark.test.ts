import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSourceExecutor } from "../src/agent-source/runtime.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import type { ConversationMessage } from "../src/agent-source/adapters/types.js";
import type { MemoryService } from "../src/service/memory-service.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standalone scan boundaries", () => {
  it("stops a routine run that would import more than one run may, then imports it once approved", async () => {
    const root = tempRoot();
    const history = [...turn("early", "2026-08-28T00:00:00.000Z")];
    const harness = createHarness(root, history, { additionBudget: 2 });
    try {
      await harness.executor.startScan({ sourceId: "fixture-agent", mode: "full" });
      await waitForScan(harness.executor);
      expect(harness.addMemory).toHaveBeenCalledTimes(1);

      for (const [index, at] of ["01", "02", "03"].entries()) {
        history.push(...turn(`later-${index}`, `2026-08-28T${at}:00:00.000Z`));
      }
      await harness.executor.startScan({ sourceId: "fixture-agent" });
      await waitForScan(harness.executor);

      const stopped = harness.executor.scanStatus();
      expect(stopped.pendingAdditions).toEqual({ sourceId: "fixture-agent", selected: 3, budget: 2 });
      expect(stopped.progress?.phase).toBe("stopped");
      expect(stopped.error).toBeNull();
      expect(harness.addMemory).toHaveBeenCalledTimes(1);

      await harness.executor.startScan({ sourceId: "fixture-agent" });
      await waitForScan(harness.executor);
      expect(harness.executor.scanStatus().pendingAdditions).toBeNull();
      expect(harness.addMemory).toHaveBeenCalledTimes(4);
    } finally {
      await harness.executor.dispose();
    }
  });

  it("imports whatever a full run selects without asking", async () => {
    const root = tempRoot();
    const history = [
      ...turn("one", "2026-08-28T00:00:00.000Z"),
      ...turn("two", "2026-08-28T01:00:00.000Z"),
      ...turn("three", "2026-08-28T02:00:00.000Z")
    ];
    const harness = createHarness(root, history, { additionBudget: 1 });
    try {
      await harness.executor.startScan({ sourceId: "fixture-agent", mode: "full" });
      await waitForScan(harness.executor);
      expect(harness.executor.scanStatus().pendingAdditions).toBeNull();
      expect(harness.addMemory).toHaveBeenCalledTimes(3);
    } finally {
      await harness.executor.dispose();
    }
  });

  it("pins the first-sync boundary of a built-in source and never moves it", async () => {
    const root = tempRoot();
    const history = [...turn("first", "2026-08-28T00:00:00.000Z")];
    const harness = createHarness(root, history);
    try {
      await harness.executor.startScan({ sourceId: "fixture-agent", mode: "full" });
      await waitForScan(harness.executor);
      const boundary = turnEndedAt("2026-08-28T00:00:00.000Z");
      const [source] = (await harness.executor.list()).sources;
      expect(source).toMatchObject({
        syncBoundaryAt: boundary,
        // Nothing to discover: an adapter already knows its own format.
        syncReady: false
      });

      history.push(...turn("second", "2026-08-29T00:00:00.000Z"));
      await harness.executor.startScan({ sourceId: "fixture-agent" });
      await waitForScan(harness.executor);
      expect((await harness.executor.list()).sources[0]?.syncBoundaryAt).toBe(boundary);
      expect(harness.executor.scanStatus().sources).toEqual([{
        sourceId: "fixture-agent",
        discoveredConversations: 1,
        emittedMessages: 4,
        written: 1,
        skipped: 2,
        errorCount: 0
      }]);
    } finally {
      await harness.executor.dispose();
    }
  });

  it("adopts an existing watermark as the boundary instead of today", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "agent-sources.json"), JSON.stringify({
      version: 2,
      sources: {
        "fixture-agent": {
          status: "not_connected",
          messageCount: 4,
          lastScannedAt: "2026-08-28T03:00:00.000Z",
          latestSeenAt: "2026-08-28T02:00:00.000Z"
        }
      }
    }));
    const harness = createHarness(root, []);
    try {
      // Reading a boundary of "now" for a source scanned long ago would move
      // the incremental cursor forward and skip every turn in between.
      expect((await harness.executor.list()).sources[0]?.syncBoundaryAt).toBe("2026-08-28T02:00:00.000Z");
    } finally {
      await harness.executor.dispose();
    }
  });

  it("drops a watermark it cannot parse rather than treating it as no boundary", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "agent-sources.json"), JSON.stringify({
      version: 3,
      sources: {
        "fixture-agent": {
          status: "not_connected",
          messageCount: 2,
          lastScannedAt: "yesterday afternoon",
          latestSeenAt: "2026/08/28 02:00",
          baselineAt: "",
          checkpoints: {
            "conversation-fixture": { lastMessageId: "one", lastCreatedAt: "not a date", contentHash: "abc" }
          }
        }
      },
      manual: {}
    }));
    const history = [...turn("one", "2026-08-28T00:00:00.000Z")];
    const harness = createHarness(root, history);
    try {
      expect((await harness.executor.list()).sources[0]).toMatchObject({
        lastScannedAt: null,
        syncBoundaryAt: null
      });
      // `isAtOrAfter` reads an unparsable boundary as "select everything", so
      // an unusable watermark has to become a first scan, not a silent
      // full-history rewrite against a boundary nothing can compare to.
      await harness.executor.startScan({ sourceId: "fixture-agent" });
      await waitForScan(harness.executor);
      expect(harness.addMemory).toHaveBeenCalledTimes(1);
      const persisted = JSON.parse(readFileSync(join(root, "agent-sources.json"), "utf8"));
      expect(persisted.sources["fixture-agent"].latestSeenAt).toBe(turnEndedAt("2026-08-28T00:00:00.000Z"));
      expect(persisted.sources["fixture-agent"].checkpoints).toEqual({
        "conversation-fixture": {
          lastMessageId: "one:assistant",
          lastCreatedAt: turnEndedAt("2026-08-28T00:00:00.000Z"),
          contentHash: expect.any(String),
          updatedAt: expect.any(String)
        }
      });
    } finally {
      await harness.executor.dispose();
    }
  });

  // The v1.1.5 migration hands over per-conversation checkpoints but no
  // source-level content hash, because the Desktop never kept one. The old
  // prepare step read a missing hash as "the source changed" and reselected
  // every conversation, which is a rewrite of the user's whole history.
  it("does not reselect a migrated source just because it has no source content hash", async () => {
    const root = tempRoot();
    const history = [
      ...turn("one", "2026-08-28T00:00:00.000Z"),
      ...turn("two", "2026-08-28T01:00:00.000Z")
    ];
    const harness = createHarness(root, history);
    try {
      await harness.executor.startScan({ sourceId: "fixture-agent", mode: "full" });
      await waitForScan(harness.executor);
      expect(harness.addMemory).toHaveBeenCalledTimes(2);

      const state = JSON.parse(readFileSync(join(root, "agent-sources.json"), "utf8"));
      delete state.sources["fixture-agent"].contentHash;
      writeFileSync(join(root, "agent-sources.json"), JSON.stringify(state));
      await harness.executor.dispose();

      const migrated = createHarness(root, history);
      try {
        await migrated.executor.startScan({ sourceId: "fixture-agent" });
        await waitForScan(migrated.executor);
        expect(migrated.executor.scanStatus().error).toBeNull();
        expect(migrated.addMemory).not.toHaveBeenCalled();
      } finally {
        await migrated.executor.dispose();
      }
    } finally {
      await harness.executor.dispose();
    }
  });

  it("leaves history older than a migrated boundary alone even with no checkpoint for it", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "agent-sources.json"), JSON.stringify({
      version: 3,
      sources: {
        "fixture-agent": {
          status: "not_connected",
          messageCount: 200,
          lastScannedAt: "2026-08-28T00:00:00.000Z",
          // A source first scanned with initial_subset: only the newest turns
          // were imported, and the boundary is the scan itself.
          latestSeenAt: "2026-08-28T00:00:00.000Z",
          baselineAt: "2026-08-28T00:00:00.000Z",
          checkpoints: {}
        }
      },
      manual: {}
    }));
    const harness = createHarness(root, [
      ...turn("ancient", "2020-01-01T00:00:00.000Z"),
      ...turn("old", "2024-06-01T00:00:00.000Z")
    ]);
    try {
      await harness.executor.startScan({ sourceId: "fixture-agent" });
      await waitForScan(harness.executor);
      expect(harness.executor.scanStatus().error).toBeNull();
      expect(harness.addMemory).not.toHaveBeenCalled();
    } finally {
      await harness.executor.dispose();
    }
  });

  it("records who asked for the scan", async () => {
    const root = tempRoot();
    const harness = createHarness(root, [...turn("one", "2026-08-28T00:00:00.000Z")]);
    try {
      await harness.executor.startScan({ sourceId: "fixture-agent", mode: "full", origin: "app" });
      await waitForScan(harness.executor);
      expect(harness.executor.scanStatus().origin).toBe("app");

      await harness.executor.startScan({ sourceId: "fixture-agent", mode: "full" });
      await waitForScan(harness.executor);
      expect(harness.executor.scanStatus().origin).toBe("viewer");
    } finally {
      await harness.executor.dispose();
    }
  });
});

function createHarness(
  root: string,
  history: ConversationMessage[],
  options: { additionBudget?: number } = {}
) {
  const addMemory = vi.fn((input: { turnId: string }) => ({ id: `memory-${input.turnId}`, duplicate: false }));
  const executor = createAgentSourceExecutor({
    ...options,
    service: { addMemory, enqueuePendingImportSummaries: vi.fn() } as unknown as MemoryService,
    configPath: join(root, "config.yaml"),
    statePath: join(root, "agent-sources.json"),
    scanStoreDirectory: join(root, "scans"),
    sourceRegistry: createSourceRegistry([{
      descriptor: { sourceId: "fixture-agent", displayName: "Fixture Agent", builtin: true, dataPath: root },
      detect: async () => true,
      async *scan() { for (const message of history) yield message; }
    }]),
    scheduleWorker: vi.fn(),
    resolveAgentSkillRoot: () => null
  });
  return { executor, addMemory };
}

/** The staging store replays messages in timestamp order, so a turn's reply
 *  has to be newer than its question or the turn boundaries move. */
function turn(messageId: string, startedAt: string): ConversationMessage[] {
  return [
    fixtureMessage(`${messageId}:user`, "user", startedAt),
    fixtureMessage(`${messageId}:assistant`, "assistant", turnEndedAt(startedAt))
  ];
}

function turnEndedAt(startedAt: string): string {
  return new Date(Date.parse(startedAt) + 1000).toISOString();
}

function fixtureMessage(
  messageId: string,
  role: "user" | "assistant",
  createdAt: string
): ConversationMessage {
  return {
    messageId,
    sourceId: "fixture-agent",
    conversationId: "conversation-fixture",
    role,
    content: role === "user" ? "Remember this" : "Done",
    createdAt,
    workspacePath: null,
    gitRoot: null,
    rawMeta: {}
  };
}

async function waitForScan(executor: ReturnType<typeof createAgentSourceExecutor>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!executor.scanStatus().running) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("scan did not settle");
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-agent-source-watermark-"));
  roots.push(root);
  return root;
}