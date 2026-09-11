import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSourceExecutor } from "../src/agent-source/runtime.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import type { ConversationMessage, SourceAdapter } from "../src/agent-source/adapters/types.js";
import type { MemoryService } from "../src/service/memory-service.js";

/**
 * Differential freeze for the standalone scanner. The fixture and the expected
 * turn identities are shared with the App backend scanner; both pipelines must
 * hand the memory service the same adapterId/turnId/requestId for the same
 * messages, otherwise the `memory.add:<adapterId>:turn:<turnId>` dedup key
 * stops protecting users when scan ownership moves between the two.
 */
const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "fixtures", "agent-source-differential");

interface DifferentialFixture {
  sources: Array<{ sourceId: string; displayName: string; messages: ConversationMessage[] }>;
}

interface ExpectedTurn {
  sourceId: string;
  conversationId: string;
  adapterId: string;
  turnId: string;
  requestId: string;
  createdAt: string;
  contentSha256: string;
}

interface ObservedTurn {
  sourceId: string;
  adapterId: string;
  turnId: string;
  requestId: string;
  createdAt: string;
  contentSha256: string;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standalone Agent source scanner against the shared differential fixture", () => {
  it("imports exactly the frozen turn set with the frozen identities", async () => {
    const harness = createHarness();
    try {
      await harness.executor.startScan({ sourceId: "all", mode: "full" });
      await waitForScan(harness.executor);

      expect(observedTurns(harness.addMemory)).toEqual(expectedTurns());
      for (const [input] of harness.addMemory.mock.calls) {
        expect(input).toMatchObject({ layer: "L1", deferProcessing: true, tags: ["agent-source", input.source] });
      }
    } finally {
      await harness.executor.dispose();
    }
  });

  // Known defect, frozen on purpose: the incremental boundary is inclusive
  // (`isAtOrAfter`) and prepare never consults the saved conversation
  // checkpoints, so every incremental scan hands the newest turn of each source
  // back to addMemory, which rewrites that memory. The App scanner gates on
  // checkpoints and re-adds nothing. Once the standalone prepare step consults
  // checkpoints too, the expectation below must become an empty list. Anything
  // beyond the newest turn per source is a regression toward mass re-import.
  it("re-adds only the newest turn of each source on the next incremental scan", async () => {
    const harness = createHarness();
    try {
      await harness.executor.startScan({ sourceId: "all", mode: "full" });
      await waitForScan(harness.executor);
      const importedTurns = harness.addMemory.mock.calls.length;
      expect(importedTurns).toBe(expectedTurns().length);

      await harness.executor.startScan({ sourceId: "all" });
      await waitForScan(harness.executor);

      expect(harness.executor.scanStatus().error).toBeNull();
      const reAdded = harness.addMemory.mock.calls.slice(importedTurns).map(([input]) => input.turnId).sort();
      expect(reAdded).toEqual(newestTurnIdPerSource(expectedTurns()));
    } finally {
      await harness.executor.dispose();
    }
  });
});

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), "memmy-agent-source-differential-"));
  roots.push(root);
  let nextMemoryId = 0;
  const addMemory = vi.fn((_input: { source: string; adapterId: string; turnId: string; requestId: string; createdAt: string; content: string }) => {
    nextMemoryId += 1;
    return { id: `memory-${nextMemoryId}`, duplicate: false };
  });
  const service = { addMemory, enqueuePendingImportSummaries: vi.fn() } as unknown as MemoryService;
  const executor = createAgentSourceExecutor({
    service,
    configPath: join(root, "config.yaml"),
    statePath: join(root, "agent-sources.json"),
    scanStoreDirectory: join(root, "scans"),
    sourceRegistry: createSourceRegistry(loadFixture().sources.map((source) => fixtureAdapter(root, source))),
    scheduleWorker: vi.fn(),
    resolveAgentSkillRoot: () => null
  });
  return { executor, addMemory };
}

function fixtureAdapter(root: string, source: DifferentialFixture["sources"][number]): SourceAdapter {
  return {
    descriptor: { sourceId: source.sourceId, displayName: source.displayName, builtin: true, dataPath: join(root, source.sourceId) },
    async detect() { return true; },
    async *scan() { for (const message of source.messages) yield message; }
  };
}

function loadFixture(): DifferentialFixture {
  return JSON.parse(readFileSync(join(fixtureDirectory, "messages.json"), "utf8")) as DifferentialFixture;
}

function expectedTurns(): ObservedTurn[] {
  const turns = JSON.parse(readFileSync(join(fixtureDirectory, "expected-turns.json"), "utf8")) as ExpectedTurn[];
  return turns
    .map(({ conversationId: _conversationId, ...turn }) => turn)
    .sort(compareObservedTurns);
}

function observedTurns(addMemory: ReturnType<typeof createHarness>["addMemory"]): ObservedTurn[] {
  return addMemory.mock.calls
    .map(([input]) => ({
      sourceId: input.source,
      adapterId: input.adapterId,
      turnId: input.turnId,
      requestId: input.requestId,
      createdAt: input.createdAt,
      contentSha256: createHash("sha256").update(input.content).digest("hex")
    }))
    .sort(compareObservedTurns);
}

function newestTurnIdPerSource(turns: readonly ObservedTurn[]): string[] {
  const newest = new Map<string, ObservedTurn>();
  for (const turn of turns) {
    const current = newest.get(turn.sourceId);
    if (!current || turn.createdAt > current.createdAt) newest.set(turn.sourceId, turn);
  }
  return [...newest.values()].map((turn) => turn.turnId).sort();
}

function compareObservedTurns(left: ObservedTurn, right: ObservedTurn): number {
  return compareText(left.adapterId, right.adapterId) || compareText(left.turnId, right.turnId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function waitForScan(executor: ReturnType<typeof createAgentSourceExecutor>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (!executor.scanStatus().running) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("scan did not complete");
}
