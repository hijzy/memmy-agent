/** Differential freeze: the App backend scanner against the shared Agent-source fixture. */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createSourceRegistry } from "../../adapters/outbound/agent-source/source-registry.js";
import type { ConversationMessage, SourceAdapter } from "../../adapters/outbound/agent-source/types.js";
import type { MemoryClient } from "../../adapters/outbound/memory-client/index.js";
import { createAppStateStore, type AppStateStore } from "../../infrastructure/app-state-store/index.js";
import { createMockMemoryClient } from "../../tests/support/mock-memory-client.js";
import { createAgentSourceService, type AgentSourceService } from "../agent-source-service.js";

/**
 * The fixture and the expected turn identities are shared with the standalone
 * memory-service scanner. Both pipelines must hand the memory service the same
 * adapterId/turnId/requestId for the same messages, otherwise the
 * `memory.add:<adapterId>:turn:<turnId>` dedup key stops protecting users when
 * scan ownership moves between the two. This drives the persistent
 * (production) scan path, not the legacy in-memory collect/ingest path.
 */
const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "tests", "fixtures", "agent-source-differential");

/** Later than every fixture message so a scan started "now" never trails the data. */
const SCAN_CLOCK = "2026-05-28T10:00:00.000Z";

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

type AddMemoryInput = Parameters<MemoryClient["addMemory"]>[0];

let tempDir: string | undefined;
let appState: AppStateStore | undefined;

afterEach(() => {
  appState?.close();
  appState = undefined;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("App backend Agent source scanner against the shared differential fixture", () => {
  it("imports exactly the frozen turn set with the frozen identities", async () => {
    const harness = createHarness();

    const results = await harness.service.scanAll({ mode: "full" });

    expect(results.flatMap((result) => result.errors)).toEqual([]);
    expect(observedTurns(harness.added)).toEqual(expectedTurns());
    for (const input of harness.added) {
      expect(input).toMatchObject({ layer: "L1", deferProcessing: true, tags: ["agent-source", input.source] });
    }
  });

  it("re-adds nothing on the next incremental scan", async () => {
    const harness = createHarness();
    await harness.service.scanAll({ mode: "full" });
    const importedTurns = harness.added.length;
    expect(importedTurns).toBe(expectedTurns().length);

    const results = await harness.service.scanAll();

    expect(results.flatMap((result) => result.errors)).toEqual([]);
    expect(harness.added.slice(importedTurns).map((input) => input.turnId)).toEqual([]);
  });
});

function createHarness(): { service: AgentSourceService; added: AddMemoryInput[] } {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-agent-source-differential-"));
  appState = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });
  const added: AddMemoryInput[] = [];
  const mockMemoryClient = createMockMemoryClient({ now: () => SCAN_CLOCK });
  const service = createAgentSourceService({
    sourceRegistry: createSourceRegistry(loadFixture().sources.map((source) => fixtureAdapter(tempDir!, source))),
    agentSourceRepository: appState.repositories.agentSources,
    scanStoreDirectory: join(tempDir, "scans"),
    ingestionService: {
      async ingest() {
        throw new Error("the differential fixture must run through the persistent scan path");
      }
    },
    memoryClient: {
      ...mockMemoryClient,
      async addMemory(input, context) {
        added.push(input);
        return mockMemoryClient.addMemory(input, context);
      },
      async getMemoryProcessingStatus(memoryIds) {
        return {
          items: memoryIds.map((memoryId) => ({
            memoryId,
            state: "ready" as const,
            attemptCount: 0,
            manualRetryCount: 0,
            retryAction: "retry" as const,
            updatedAt: SCAN_CLOCK
          })),
          serverTime: SCAN_CLOCK
        };
      }
    },
    skillDistributionService: {
      async install() {},
      async uninstall() {},
      async installPlugin() {},
      async uninstallPlugin() {}
    },
    now: () => SCAN_CLOCK
  });
  return { service, added };
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

function observedTurns(added: readonly AddMemoryInput[]): ObservedTurn[] {
  return added
    .map((input) => ({
      sourceId: input.source ?? "",
      adapterId: input.adapterId ?? "",
      turnId: input.turnId ?? "",
      requestId: input.requestId ?? "",
      createdAt: input.createdAt ?? "",
      contentSha256: createHash("sha256").update(input.content).digest("hex")
    }))
    .sort(compareObservedTurns);
}

function compareObservedTurns(left: ObservedTurn, right: ObservedTurn): number {
  return compareText(left.adapterId, right.adapterId) || compareText(left.turnId, right.turnId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
