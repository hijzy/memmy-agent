/** Agent sources route tests. */
import { MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH, type MemoryAgentSourceScanStatus } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryLayerError } from "../../../outbound/memory-client/errors.js";
import { createAgentSourceScanRelay, type AgentSourceScanRelay } from "../../../../services/agent-source-scan-relay.js";
import { createProgressBus } from "../../../../services/progress-bus.js";
import { createLocalApiServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { PermissionManager } from "../../../../permission/index.js";
import type { BackendServices } from "../../../../services/index.js";

let app: FastifyInstance | undefined;
let relay: AgentSourceScanRelay | undefined;

afterEach(async () => {
  await relay?.stop();
  relay = undefined;
  await app?.close();
  app = undefined;
});

describe("agent sources local api routes", () => {
  it("lists the Agent sources the memory service reports", async () => {
    const { server } = createServer();
    app = server;

    const response = await server.inject({
      method: "GET",
      url: "/api/agent-sources",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({ sourceId: "cursor", status: "not_connected" })
    ]);
  });

  it("returns detected memory plugin conflicts", async () => {
    const { server, memoryClient } = createServer();
    memoryClient.conflicts = [{
      sourceId: "openclaw",
      displayName: "OpenClaw",
      configPath: "/tmp/openclaw/openclaw.json",
      installedPluginId: "memory-core"
    }];
    app = server;

    const response = await server.inject({
      method: "GET",
      url: "/api/agent-sources/memory-plugin-conflicts",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      conflicts: [{
        sourceId: "openclaw",
        displayName: "OpenClaw",
        configPath: "/tmp/openclaw/openclaw.json",
        installedPluginId: "memory-core"
      }]
    });
  });

  it("runs agent source auto inject through the local api", async () => {
    const calls: string[] = [];
    const { server } = createServer({
      agentSourceAutoInject: {
        async runOnce() {
          calls.push("run");
          return {
            ok: true,
            skipped: false,
            installed: ["cursor"],
            failed: []
          };
        }
      }
    });
    app = server;

    const response = await server.inject({
      method: "POST",
      url: "/api/agent-sources/auto-inject/run",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      skipped: false,
      installed: ["cursor"],
      failed: []
    });
    expect(calls).toEqual(["run"]);
  });

  it("adds, removes, installs plugin, installs skill, and uninstalls agent sources", async () => {
    const { server, memoryClient } = createServer();
    app = server;

    const addResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/manual",
      headers: { "x-memmy-local-token": "test-token" },
      payload: { displayName: "Manual Agent" }
    });
    const removeResponse = await server.inject({
      method: "DELETE",
      url: "/api/agent-sources/manual-1",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const installResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/cursor/skill",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const installPluginResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/openclaw/plugin",
      headers: { "x-memmy-local-token": "test-token" },
      payload: { installType: "onboarding" }
    });
    const uninstallPluginResponse = await server.inject({
      method: "DELETE",
      url: "/api/agent-sources/openclaw/plugin",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const uninstallResponse = await server.inject({
      method: "DELETE",
      url: "/api/agent-sources/cursor/skill",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(addResponse.statusCode).toBe(200);
    expect(addResponse.json()).toMatchObject({ sourceId: "manual-1", displayName: "Manual Agent" });
    expect(removeResponse.json()).toEqual({ ok: true });
    expect(installResponse.json()).toEqual({ ok: true });
    expect(installPluginResponse.json()).toEqual({ ok: true });
    expect(uninstallPluginResponse.json()).toEqual({ ok: true });
    expect(uninstallResponse.json()).toEqual({ ok: true });
    expect(memoryClient.calls.filter((call) => !call.startsWith("list"))).toEqual([
      "addManual:Manual Agent",
      "removeManual:manual-1",
      "connect:cursor:skill:POST",
      "connect:openclaw:plugin:POST",
      "connect:openclaw:plugin:DELETE",
      "connect:cursor:skill:DELETE"
    ]);
  });

  it("accepts AI-normalized history batches and managed Skill status updates", async () => {
    const { server, memoryClient } = createServer();
    app = server;

    const importResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/manual-1/managed/import",
      headers: { "x-memmy-local-token": "test-token" },
      payload: {
        mode: "initial_subset",
        messages: [{
          messageId: "message-1",
          conversationId: "conversation-1",
          role: "user",
          content: "question",
          createdAt: "2026-07-01T10:00:00.000Z"
        }],
        syncBoundaryAt: "2026-07-01T10:00:00.000Z",
        final: true
      }
    });
    const updateResponse = await server.inject({
      method: "PATCH",
      url: "/api/agent-sources/manual-1/managed",
      headers: { "x-memmy-local-token": "test-token" },
      payload: { dataPath: "/tmp/aider", skillInstalled: true }
    });
    const syncResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/manual-1/managed/sync",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(importResponse.statusCode).toBe(200);
    expect(importResponse.json()).toMatchObject({
      sourceId: "manual-1",
      attempted: 1,
      syncBoundaryAt: "2026-07-01T10:00:00.000Z"
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      sourceId: "manual-1",
      status: "skill_installed",
      dataPath: "/tmp/aider"
    });
    expect(syncResponse.json()).toMatchObject({ sourceId: "manual-1", written: 0 });
    expect(memoryClient.calls).toEqual([
      "importManual:manual-1:initial_subset:1:true",
      "updateManual:manual-1:true",
      "syncManual:manual-1"
    ]);
  });

  /** The Desktop UI turns this code and message into "install Cursor first". */
  it("passes the memory service's unavailable-Agent error through unchanged", async () => {
    const { server, memoryClient } = createServer();
    memoryClient.connectionError = new MemoryLayerError(
      "agent_source_unavailable",
      409,
      "Opencode is not installed or its directory is unavailable"
    );
    app = server;

    const skillResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/opencode/skill",
      headers: { "x-memmy-local-token": "test-token", "x-request-id": "req-opencode-skill" }
    });
    const pluginResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/hermes/plugin",
      headers: { "x-memmy-local-token": "test-token", "x-request-id": "req-hermes-plugin" }
    });

    expect(skillResponse.statusCode).toBe(409);
    expect(skillResponse.json()).toEqual({
      error: {
        code: "agent_source_unavailable",
        message: "Opencode is not installed or its directory is unavailable",
        requestId: "req-opencode-skill"
      }
    });
    expect(pluginResponse.statusCode).toBe(409);
    expect(pluginResponse.json()).toMatchObject({ error: { requestId: "req-hermes-plugin" } });
  });

  it("hands out the job id the memory service generated", async () => {
    const { server, memoryClient } = createServer();
    app = server;

    const response = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan",
      headers: { "x-memmy-local-token": "test-token" },
      payload: { sourceId: "cursor", mode: "incremental" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jobId: "agent-scan-1" });
    expect(memoryClient.calls).toContain("startScan:cursor:incremental:app");
  });

  /** Pressing scan while a scan runs used to join the running job, and still does. */
  it("joins the running scan instead of failing when one is already running", async () => {
    const { server, memoryClient } = createServer();
    memoryClient.status = runningStatus();
    memoryClient.startScanError = new MemoryLayerError("conflict", 409, "An Agent source scan is already running");
    app = server;

    const response = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jobId: "agent-scan-1" });
  });

  it("reports a conflict the running scan cannot explain", async () => {
    const { server, memoryClient } = createServer();
    memoryClient.startScanError = new MemoryLayerError(
      "conflict",
      409,
      "Resume or stop the paused Agent source scan first"
    );
    app = server;

    const response = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "conflict", message: "Resume or stop the paused Agent source scan first" }
    });
  });

  it("forwards the memory service's scan progress and completion through SSE", async () => {
    const { server, memoryClient } = createServer();
    app = server;
    await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;

    const controller = new AbortController();
    const eventsResponse = await fetch(`${baseUrl}/api/events?token=test-token`, { signal: controller.signal });
    const scanResponse = await fetch(`${baseUrl}/api/agent-sources/scan`, {
      method: "POST",
      headers: { "x-memmy-local-token": "test-token" }
    });
    await waitFor(() => memoryClient.calls.some((call) => call.startsWith("startScan")));
    memoryClient.status = finishedStatus();
    const text = await readStreamUntil(eventsResponse, "agent_source.scan_completed");
    controller.abort();

    expect(scanResponse.status).toBe(200);
    expect(await scanResponse.json()).toEqual({ jobId: "agent-scan-1" });
    expect(text).toContain("event: agent_source.scan_progress");
    expect(text).toContain('"phase":"scan"');
    expect(text).toContain('"origin":"app"');
    expect(text).toContain("event: agent_source.scan_completed");
    expect(text).toContain('"emittedMessages":4');
  });

  /**
   * Progress events only say a scan is alive. A UI that reloads or reconnects
   * asks for the status, and that answer has to come from the memory service.
   */
  it("returns active scan status for page reload recovery", async () => {
    // Polling is parked so only the route itself can refresh the answer.
    const { server, memoryClient } = createServer({ pollIntervalMs: 60_000 });
    app = server;

    const idleResponse = await server.inject({
      method: "GET",
      url: "/api/agent-sources/scan/status",
      headers: { "x-memmy-local-token": "test-token" }
    });
    memoryClient.status = runningStatus();
    const response = await server.inject({
      method: "GET",
      url: "/api/agent-sources/scan/status",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(idleResponse.json()).toEqual({ active: false, progress: null, completion: null });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      active: true,
      progress: {
        jobId: "agent-scan-1",
        sourceId: "cursor",
        phase: "add",
        current: 2,
        total: 5,
        message: "Adding memories",
        origin: "app"
      },
      completion: null
    });
  });

  it("reports a paused scan as stopped so the UI can offer a resume", async () => {
    const { server, memoryClient } = createServer();
    app = server;

    const stopResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan/stop",
      headers: { "x-memmy-local-token": "test-token" }
    });
    memoryClient.status = pausedStatus();
    const statusResponse = await server.inject({
      method: "GET",
      url: "/api/agent-sources/scan/status",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(stopResponse.json()).toEqual({ ok: true });
    expect(memoryClient.calls).toContain("pauseScan");
    expect(statusResponse.json()).toMatchObject({
      active: false,
      progress: { jobId: "agent-scan-1", phase: "stopped", current: 2, total: 5 }
    });
  });

  it("treats stopping an already finished scan as done", async () => {
    const { server, memoryClient } = createServer();
    memoryClient.pauseError = new MemoryLayerError("conflict", 409, "No Agent source scan is running");
    app = server;

    const response = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan/stop",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("cancels the scan and forgets it", async () => {
    const { server, memoryClient } = createServer();
    memoryClient.status = runningStatus();
    app = server;

    const statusBefore = await server.inject({
      method: "GET",
      url: "/api/agent-sources/scan/status",
      headers: { "x-memmy-local-token": "test-token" }
    });
    memoryClient.status = idleStatus();
    const cancelResponse = await server.inject({
      method: "POST",
      url: "/api/agent-sources/scan/cancel",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const statusAfter = await server.inject({
      method: "GET",
      url: "/api/agent-sources/scan/status",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(statusBefore.json()).toMatchObject({ active: true });
    expect(cancelResponse.json()).toEqual({ ok: true });
    expect(memoryClient.calls).toContain("cancelScan");
    expect(statusAfter.json()).toEqual({ active: false, progress: null, completion: null });
  });

  it("serves a scan job's per-conversation results from the memory service", async () => {
    const { server, memoryClient } = createServer();
    app = server;

    const response = await server.inject({
      method: "GET",
      url: "/api/agent-sources/scan/jobs/agent-scan-1/results?cursor=10&limit=900",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [{ sourceId: "cursor", conversationId: "conversation-1", memoryId: "memory-1" }],
      nextCursor: null
    });
    expect(memoryClient.calls).toContain("scanResults:agent-scan-1:10:500");
  });
});

function createServer(
  overrides: {
    agentSourceAutoInject?: BackendServices["agentSourceAutoInject"];
    permissionManager?: PermissionManager;
    pollIntervalMs?: number;
  } = {}
): { server: FastifyInstance; memoryClient: FakeMemoryAgentSourceClient } {
  const progressBus = createProgressBus();
  const memoryClient = createFakeMemoryClient();
  relay = createAgentSourceScanRelay({
    memoryClient,
    progressBus,
    activePollIntervalMs: overrides.pollIntervalMs ?? 5,
    idlePollIntervalMs: overrides.pollIntervalMs ?? 10
  });
  relay.start();
  const services = {
    agentAdapterRegistry: {
      listAdapters: () => []
    },
    bootstrap: {
      async getBootstrap() {
        throw new Error("bootstrap not used in this test");
      }
    },
    memoryClient,
    agentSourceConnections: {
      list: async () => (await memoryClient.listAgentSources()).sources,
      connect: async (sourceId: string, kind: "plugin" | "skill") => {
        await memoryClient.mutateAgentSourceConnection({ sourceId, kind, method: "POST" });
      },
      disconnect: async (sourceId: string, kind: "plugin" | "skill") => {
        await memoryClient.mutateAgentSourceConnection({ sourceId, kind, method: "DELETE" });
      }
    },
    agentSourceScanRelay: relay,
    agentSourceAutoInject: overrides.agentSourceAutoInject ?? {
      async runOnce() {
        return {
          ok: true,
          skipped: true,
          reason: "test",
          installed: [],
          failed: []
        };
      }
    },
    progressBus
  } as unknown as BackendServices;

  return {
    server: createLocalApiServer({
      permissionManager: overrides.permissionManager ?? createFakePermissionManager(),
      services,
      heartbeatIntervalMs: 20
    }),
    memoryClient
  };
}

interface FakeMemoryAgentSourceClient {
  calls: string[];
  status: MemoryAgentSourceScanStatus;
  conflicts: Array<{ sourceId: string; displayName: string; configPath: string; installedPluginId: string }>;
  startScanError?: MemoryLayerError;
  pauseError?: MemoryLayerError;
  connectionError?: MemoryLayerError;
  listAgentSources: () => Promise<{ executorAvailable: true; sources: Array<Record<string, unknown>> }>;
  mutateAgentSourceConnection: (input: { sourceId: string; kind: "plugin" | "skill"; method: "POST" | "DELETE" }) => Promise<unknown>;
  [method: string]: unknown;
}

function createFakeMemoryClient(): FakeMemoryAgentSourceClient {
  const client = {
    calls: [] as string[],
    status: idleStatus(),
    conflicts: [] as Array<{ sourceId: string; displayName: string; configPath: string; installedPluginId: string }>,
    startScanError: undefined as MemoryLayerError | undefined,
    pauseError: undefined as MemoryLayerError | undefined,
    connectionError: undefined as MemoryLayerError | undefined,

    async listAgentSources() {
      client.calls.push("list");
      return {
        executorAvailable: true as const,
        sources: [{
          sourceId: "cursor",
          displayName: "Cursor",
          dataPath: "/tmp/cursor",
          builtin: true,
          available: true,
          status: "not_connected" as const,
          messageCount: 0,
          lastScannedAt: null,
          syncBoundaryAt: null,
          syncReady: false
        }]
      };
    },

    async startAgentSourceScan(input: { sourceId: string; mode?: string; origin: string }) {
      client.calls.push(`startScan:${input.sourceId}:${input.mode ?? "auto"}:${input.origin}`);
      if (client.startScanError) throw client.startScanError;
      client.status = runningStatus({
        sourceId: "cursor",
        phase: "scan",
        current: 0,
        total: 4,
        message: "Scanning Agent history"
      });
      return { accepted: true as const, jobId: "agent-scan-1" };
    },

    async agentSourceScanStatus() {
      return client.status;
    },

    async agentSourceScanResults(input: { jobId: string; cursor?: string; limit?: number }) {
      client.calls.push(`scanResults:${input.jobId}:${input.cursor ?? "0"}:${input.limit ?? 100}`);
      return {
        items: [{ sourceId: "cursor", conversationId: "conversation-1", memoryId: "memory-1" }],
        nextCursor: null
      };
    },

    async pauseAgentSourceScan() {
      client.calls.push("pauseScan");
      if (client.pauseError) throw client.pauseError;
      return { ok: true as const };
    },

    async cancelAgentSourceScan() {
      client.calls.push("cancelScan");
      client.status = idleStatus();
      return { ok: true as const };
    },

    async mutateAgentSourceConnection(input: { sourceId: string; kind: "plugin" | "skill"; method: "POST" | "DELETE" }) {
      client.calls.push(`connect:${input.sourceId}:${input.kind}:${input.method}`);
      if (client.connectionError) throw client.connectionError;
      return {
        ok: true as const,
        sourceId: input.sourceId,
        status: input.method === "DELETE"
          ? ("not_connected" as const)
          : input.kind === "plugin" ? ("plugin_installed" as const) : ("skill_installed" as const)
      };
    },

    async detectAgentSourcePluginConflicts() {
      return { conflicts: client.conflicts };
    },

    async addManualAgentSource(input: { displayName: string }) {
      client.calls.push(`addManual:${input.displayName}`);
      return {
        sourceId: "manual-1",
        displayName: input.displayName,
        dataPath: MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH,
        builtin: false,
        available: true,
        status: "not_connected" as const,
        messageCount: 0,
        lastScannedAt: null,
        syncBoundaryAt: null,
        syncReady: false
      };
    },

    async updateManualAgentSource(sourceId: string, input: { dataPath?: string; skillInstalled?: boolean }) {
      client.calls.push(`updateManual:${sourceId}:${input.skillInstalled}`);
      return {
        sourceId,
        displayName: "Aider",
        dataPath: input.dataPath ?? MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH,
        builtin: false,
        available: true,
        status: input.skillInstalled ? ("skill_installed" as const) : ("not_connected" as const),
        messageCount: 2,
        lastScannedAt: null,
        syncBoundaryAt: null,
        syncReady: true
      };
    },

    async removeManualAgentSource(sourceId: string) {
      client.calls.push(`removeManual:${sourceId}`);
      return { ok: true as const };
    },

    async importManualAgentSource(
      sourceId: string,
      input: { mode: string; messages: readonly unknown[]; final?: boolean; syncBoundaryAt?: string }
    ) {
      client.calls.push(`importManual:${sourceId}:${input.mode}:${input.messages.length}:${input.final}`);
      return {
        sourceId,
        attempted: input.messages.length,
        written: input.messages.length,
        deduped: 0,
        failed: 0,
        memoryIds: ["memory-1"],
        syncBoundaryAt: input.syncBoundaryAt ?? null,
        errors: []
      };
    },

    async syncManualAgentSource(sourceId: string) {
      client.calls.push(`syncManual:${sourceId}`);
      return {
        sourceId,
        attempted: 0,
        written: 0,
        deduped: 0,
        failed: 0,
        memoryIds: [],
        syncBoundaryAt: null,
        errors: []
      };
    }
  };

  return client as unknown as FakeMemoryAgentSourceClient;
}

function idleStatus(): MemoryAgentSourceScanStatus {
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

function runningStatus(
  progress: MemoryAgentSourceScanStatus["progress"] = {
    sourceId: "cursor",
    phase: "add",
    current: 2,
    total: 5,
    message: "Adding memories"
  }
): MemoryAgentSourceScanStatus {
  return {
    ...idleStatus(),
    running: true,
    jobId: "agent-scan-1",
    sourceId: "all",
    mode: "incremental",
    origin: "app",
    progress,
    startedAt: "2026-09-11T10:00:00.000Z"
  };
}

function pausedStatus(): MemoryAgentSourceScanStatus {
  return {
    ...runningStatus({ sourceId: "cursor", phase: "stopped", current: 2, total: 5, message: "Agent source scan paused" }),
    running: false
  };
}

function finishedStatus(): MemoryAgentSourceScanStatus {
  return {
    ...runningStatus({ sourceId: "cursor", phase: "done", current: 4, total: 4 }),
    running: false,
    completedAt: "2026-09-11T10:00:30.000Z",
    sources: [{
      sourceId: "cursor",
      discoveredConversations: 1,
      emittedMessages: 4,
      written: 2,
      skipped: 0,
      errorCount: 0
    }]
  };
}

function createFakePermissionManager(): PermissionManager {
  return {
    async getRuntimeToken() {
      return "test-token";
    },
    async verifyRuntimeToken(token) {
      return token === "test-token";
    },
    async getScanPermission() {
      return "scan_and_write_skill";
    },
    async setScanPermission() {
      return undefined;
    },
    async canDetectAgentSources() {
      return true;
    },
    async canScanAgentSource() {
      return true;
    },
    async canWriteAgentSkill() {
      return true;
    },
    async canSearchMemory() {
      return true;
    },
    async revokeAgentSource() {
      return undefined;
    }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const timeoutAt = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > timeoutAt) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function readStreamUntil(response: Response, expected: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Expected readable response body");
  }

  const decoder = new TextDecoder();
  let text = "";
  const timeoutAt = Date.now() + 2_000;

  while (!text.includes(expected)) {
    if (Date.now() > timeoutAt) {
      throw new Error(`Timed out waiting for ${expected}`);
    }

    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }

    text += decoder.decode(chunk.value, { stream: true });
  }

  await reader.cancel();
  return text;
}
