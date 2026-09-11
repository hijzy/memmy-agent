import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSourceExecutor } from "../src/agent-source/runtime.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import {
  extractManagedAgentHistory,
  selectIncrementalManagedMessages
} from "../src/agent-source/managed-history.js";
import type { ManagedSyncRecipe } from "../src/agent-source/manual-sources.js";
import type { MemoryService } from "../src/service/memory-service.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("manual Agent sources in the Memory service", () => {
  it("records a manual source before its history format is known", async () => {
    const root = tempRoot();
    const executor = manualExecutor(root);

    const added = await executor.addManualSource({ displayName: "  Internal Agent  " });

    expect(added).toMatchObject({
      displayName: "Internal Agent",
      dataPath: "memmy-agent://history-discovery-pending",
      builtin: false,
      available: true,
      status: "not_connected",
      messageCount: 0,
      lastScannedAt: null,
      syncBoundaryAt: null,
      syncReady: false
    });
    expect((await executor.list()).sources.map((source) => source.sourceId)).toEqual([added.sourceId]);
    await expect(executor.addManualSource({ displayName: "  " })).rejects.toThrow(/displayName/);
    await expect(executor.syncManualSource(added.sourceId)).rejects.toThrow(/format discovery/);
    await expect(executor.syncManualSource("missing")).rejects.toThrow(/Unknown manual Agent source/);
  });

  it("imports a page of messages and pins the first sync boundary", async () => {
    const root = tempRoot();
    const addMemory = vi.fn((request: { turnId: string }) => ({ id: `memory-${request.turnId}`, duplicate: false }));
    const enqueuePendingImportSummaries = vi.fn();
    const scheduleWorker = vi.fn();
    const executor = manualExecutor(root, { addMemory, enqueuePendingImportSummaries }, scheduleWorker);
    const { sourceId } = await executor.addManualSource({ displayName: "Internal Agent" });

    const result = await executor.importManualSource(sourceId, {
      mode: "initial_subset",
      dataPath: "/opt/internal-agent/history.jsonl",
      messages: [
        message("m1", "c1", "user", "2026-08-28T01:00:00.000Z"),
        message("m2", "c1", "assistant", "2026-08-28T01:00:05.000Z"),
        // A turn with no assistant reply is not a memory yet.
        message("m3", "c1", "user", "2026-08-28T01:01:00.000Z")
      ],
      final: true
    });

    expect(result).toMatchObject({
      sourceId,
      attempted: 3,
      written: 2,
      deduped: 1,
      failed: 0,
      syncBoundaryAt: "2026-08-28T01:00:00.000Z",
      errors: []
    });
    expect(addMemory).toHaveBeenCalledOnce();
    expect(addMemory.mock.calls[0]![0]).toMatchObject({
      adapterId: `agent-source:${sourceId}`,
      layer: "L1",
      source: "Internal Agent",
      tags: ["agent-source", "Internal Agent"],
      createdAt: "2026-08-28T01:00:00.000Z"
    });
    expect(enqueuePendingImportSummaries).toHaveBeenCalledOnce();
    expect(scheduleWorker).toHaveBeenCalledOnce();

    const [listed] = (await executor.list()).sources;
    expect(listed).toMatchObject({
      dataPath: "/opt/internal-agent/history.jsonl",
      messageCount: 2,
      syncBoundaryAt: "2026-08-28T01:00:00.000Z"
    });
    expect(listed?.lastScannedAt).toEqual(expect.any(String));

    const persisted = JSON.parse(readFileSync(join(root, "memory-service", "agent-sources.json"), "utf8"));
    expect(persisted.version).toBe(3);
    expect(persisted.manual[sourceId]).toMatchObject({
      displayName: "Internal Agent",
      baselineAt: "2026-08-28T01:00:00.000Z"
    });
  });

  it("keeps the boundary and the watermark when a later page fails", async () => {
    const root = tempRoot();
    const addMemory = vi.fn(() => { throw new Error("storage is full"); });
    const executor = manualExecutor(root, { addMemory });
    const { sourceId } = await executor.addManualSource({ displayName: "Internal Agent" });

    const result = await executor.importManualSource(sourceId, {
      mode: "initial_subset",
      messages: [
        message("m1", "c1", "user", "2026-08-28T01:00:00.000Z"),
        message("m2", "c1", "assistant", "2026-08-28T01:00:05.000Z")
      ],
      final: true
    });

    expect(result).toMatchObject({ written: 0, failed: 2 });
    expect(result.errors).toEqual([{ conversationId: "c1", reason: "storage is full" }]);
    // A failed final page must not pin a boundary a later sync would trust.
    expect((await executor.list()).sources[0]).toMatchObject({
      syncBoundaryAt: null,
      lastScannedAt: null,
      messageCount: 0
    });
  });

  it("reads the recipe on every sync and only imports past the boundary", async () => {
    const root = tempRoot();
    const historyPath = join(root, "history.jsonl");
    writeFileSync(historyPath, [
      historyLine("m1", "c1", "user", "2026-08-28T01:00:00.000Z"),
      historyLine("m2", "c1", "assistant", "2026-08-28T01:00:05.000Z")
    ].join("\n"));
    const addMemory = vi.fn((request: { turnId: string }) => ({ id: `memory-${request.turnId}`, duplicate: false }));
    const executor = manualExecutor(root, { addMemory });
    const { sourceId } = await executor.addManualSource({ displayName: "Internal Agent" });

    const updated = await executor.updateManualSource(sourceId, {
      dataPath: historyPath,
      skillInstalled: true,
      syncRecipe: recipe(historyPath)
    });
    expect(updated).toMatchObject({ syncReady: true, status: "skill_installed", dataPath: historyPath });

    // Discovery only produced the recipe; the first import still pins the boundary.
    await expect(executor.syncManualSource(sourceId)).rejects.toThrow(/initial sync boundary/);
    await executor.importManualSource(sourceId, {
      mode: "initial_subset",
      messages: [
        message("m1", "c1", "user", "2026-08-28T01:00:00.000Z"),
        message("m2", "c1", "assistant", "2026-08-28T01:00:05.000Z")
      ],
      final: true
    });
    expect(addMemory).toHaveBeenCalledOnce();

    // Nothing new on disk: the boundary is exclusive, so the imported turn
    // must not be rewritten.
    expect(await executor.syncManualSource(sourceId)).toMatchObject({ attempted: 0, written: 0 });
    expect(addMemory).toHaveBeenCalledOnce();

    writeFileSync(historyPath, [
      historyLine("m1", "c1", "user", "2026-08-28T01:00:00.000Z"),
      historyLine("m2", "c1", "assistant", "2026-08-28T01:00:05.000Z"),
      historyLine("m3", "c1", "user", "2026-08-28T02:00:00.000Z"),
      historyLine("m4", "c1", "assistant", "2026-08-28T02:00:05.000Z")
    ].join("\n"));
    expect(await executor.syncManualSource(sourceId)).toMatchObject({ attempted: 2, written: 2 });
    expect(addMemory).toHaveBeenCalledTimes(2);
    expect((await executor.list()).sources[0]).toMatchObject({
      messageCount: 4,
      syncBoundaryAt: "2026-08-28T01:00:00.000Z"
    });
  });

  it("rejects a recipe that finds no complete turn and forgets a removed source", async () => {
    const root = tempRoot();
    const historyPath = join(root, "history.jsonl");
    writeFileSync(historyPath, historyLine("m1", "c1", "user", "2026-08-28T01:00:00.000Z"));
    const executor = manualExecutor(root);
    const { sourceId } = await executor.addManualSource({ displayName: "Internal Agent" });

    await expect(executor.updateManualSource(sourceId, { syncRecipe: recipe(historyPath) }))
      .rejects.toThrow(/no complete user\/assistant turns/);
    await expect(executor.updateManualSource(sourceId, { syncRecipe: recipe(join(root, "absent.jsonl")) }))
      .rejects.toThrow(/history could not be read/);
    await expect(executor.updateManualSource(sourceId, {})).rejects.toThrow(/At least one/);
    expect((await executor.list()).sources[0]).toMatchObject({ syncReady: false });

    expect(await executor.removeManualSource(sourceId)).toEqual({ ok: true });
    expect((await executor.list()).sources).toEqual([]);
    await expect(executor.removeManualSource(sourceId)).rejects.toThrow(/Unknown manual Agent source/);
  });

  it("upgrades a version 2 state file and drops a recipe it can no longer parse", async () => {
    const root = tempRoot();
    const statePath = join(root, "memory-service", "agent-sources.json");
    mkdirSync(join(root, "memory-service"), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      sources: {
        legacy: { status: "skill_installed", messageCount: 7, lastScannedAt: "2026-08-01T00:00:00.000Z", latestSeenAt: "2026-08-01T00:00:00.000Z" }
      },
      manual: {
        legacy: { displayName: "Legacy Agent", dataPath: "/opt/legacy", baselineAt: "2026-08-01T00:00:00.000Z", syncRecipe: { version: 1, format: "toml" } },
        nameless: { dataPath: "/opt/nameless" }
      }
    }));
    const executor = manualExecutor(root);

    expect((await executor.list()).sources).toEqual([{
      sourceId: "legacy",
      displayName: "Legacy Agent",
      dataPath: "/opt/legacy",
      builtin: false,
      available: true,
      status: "skill_installed",
      messageCount: 7,
      lastScannedAt: "2026-08-01T00:00:00.000Z",
      syncBoundaryAt: "2026-08-01T00:00:00.000Z",
      syncReady: false
    }]);
    expect(JSON.parse(readFileSync(statePath, "utf8")).version).toBe(3);
  });

  it("maps a sqlite recipe onto turns and keeps whole turns at the boundary", () => {
    const root = tempRoot();
    const historyPath = join(root, "history.jsonl");
    writeFileSync(historyPath, [
      historyLine("m1", "c1", "human", "2026-08-28T01:00:00.000Z"),
      historyLine("m2", "c1", "bot", "2026-08-28T01:00:05.000Z"),
      historyLine("m3", "c2", "human", "2026-08-28T03:00:00.000Z"),
      historyLine("m4", "c2", "bot", "2026-08-28T03:00:05.000Z")
    ].join("\n"));

    const messages = extractManagedAgentHistory("internal", {
      ...recipe(historyPath),
      roleMap: { human: "user", bot: "assistant" }
    });
    expect(messages.map((entry) => [entry.conversationId, entry.role])).toEqual([
      ["c1", "user"], ["c1", "assistant"], ["c2", "user"], ["c2", "assistant"]
    ]);
    expect(messages.every((entry) => entry.sourceId === "internal")).toBe(true);

    // The boundary is the first turn's own timestamp: it stays imported, and
    // the later conversation comes through whole.
    expect(selectIncrementalManagedMessages(messages, "2026-08-28T01:00:00.000Z")
      .map((entry) => entry.messageId)).toEqual(["m3", "m4"]);
    expect(selectIncrementalManagedMessages(messages, "2026-08-27T00:00:00.000Z")
      .map((entry) => entry.messageId)).toEqual(["m1", "m2", "m3", "m4"]);
  });
});

function manualExecutor(
  root: string,
  service: Record<string, unknown> = {},
  scheduleWorker?: () => void
) {
  return createAgentSourceExecutor({
    service: {
      enqueuePendingImportSummaries: () => undefined,
      ...service
    } as unknown as MemoryService,
    configPath: join(root, "config.yaml"),
    sourceRegistry: createSourceRegistry([]),
    ...(scheduleWorker ? { scheduleWorker } : {})
  });
}

function recipe(path: string): ManagedSyncRecipe {
  return {
    version: 1,
    format: "jsonl",
    path,
    fields: {
      messageId: "messageId",
      conversationId: "conversationId",
      role: "role",
      content: "content",
      createdAt: "createdAt"
    },
    timestampFormat: "iso"
  };
}

function message(
  messageId: string,
  conversationId: string,
  role: "user" | "assistant",
  createdAt: string
) {
  return {
    messageId,
    conversationId,
    role,
    content: role === "user" ? "Remember this" : "Done",
    createdAt
  };
}

function historyLine(
  messageId: string,
  conversationId: string,
  role: string,
  createdAt: string
): string {
  return JSON.stringify({
    messageId,
    conversationId,
    role,
    content: role === "user" || role === "human" ? "Remember this" : "Done",
    createdAt
  });
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-agent-source-manual-"));
  roots.push(root);
  return root;
}
