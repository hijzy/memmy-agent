/** Mock memory client tests. */
import { randomUUID } from "node:crypto";
import {
  MANAGED_AGENT_DISCOVERY_PENDING_DATA_PATH,
  type AgentSourceView,
  type OnboardingConversationWindow,
  type OnboardingSampleResult,
  type MemoryAgentSourceScanStatus,
  type MemoryHealthSnapshot,
  type MemoryKind
} from "@memmy/local-api-contracts";
import { MemoryLayerError } from "../../adapters/outbound/memory-client/errors.js";
import type { MemoryClient } from "../../adapters/outbound/memory-client/types.js";

export interface CreateMockMemoryClientOptions {
  /** Health. */
  health?: MemoryHealthSnapshot;
  /** Now. */
  now?: () => string;
  /** Failure rate. */
  failureRate?: number;
  /** Agent sources the memory service reports as detected. */
  agentSources?: readonly AgentSourceView[];
  /** Recent-history samples the first-login report reads. */
  onboardingSamples?: readonly OnboardingSampleResult[];
  onboardingConversation?: OnboardingConversationWindow | null;
}

/** Creates create mock memory client. */
export function createMockMemoryClient(options: CreateMockMemoryClientOptions = {}): MemoryClient {
  const bootedAt = Date.now();
  const now = options.now ?? (() => new Date().toISOString());
  const failureRate = options.failureRate ?? 0;
  let changeSeqCounter = 0;
  let agentAccess = { autoScanKnownAgents: true, watchFileChanges: true, autoInjectSkill: false };
  let scan = emptyScanStatus();
  const agentSources = new Map<string, AgentSourceView>(
    (options.agentSources ?? []).map((source) => [source.sourceId, source])
  );

  const requireAgentSource = (sourceId: string): AgentSourceView => {
    const source = agentSources.get(sourceId);
    if (!source) throw new MemoryLayerError("not_found", 404, `Unknown Agent source: ${sourceId}`);
    return source;
  };

  const nextChange = () => {
    changeSeqCounter += 1;
    return {
      changeSeq: changeSeqCounter,
      syncCursor: `mock-${changeSeqCounter}`
    };
  };

  const failIfNeeded = () => {
    if (Math.random() < failureRate) {
      throw new MemoryLayerError("internal", 500, "mock-induced failure");
    }
  };

  return {
    async health() {
      failIfNeeded();
      return (
        options.health ?? {
          ok: true,
          version: "mock-0.0.0",
          uptimeMs: Math.max(0, Date.now() - bootedAt),
          mode: "dev",
          storage: {
            backend: "sqlite",
            schemaVersion: "mock",
            ready: true
          },
          models: mockModels(),
          capabilities: {
            routes: ["/api/v1/health"],
            tools: [],
            memoryLayers: ["L1", "L2", "L3", "Skill"],
            supportsCli: true
          },
          serverTime: now()
        }
      );
    },

    async reloadConfig() {
      failIfNeeded();
      return {
        changed: true,
        requiresRestart: false,
        models: mockModels(),
        reloadedAt: now()
      };
    },

    async patchConfig(input) {
      failIfNeeded();
      agentAccess = { ...agentAccess, ...input.agentAccess };
      return {
        ok: true,
        reload: { changed: true, requiresRestart: false, models: mockModels(), reloadedAt: now() },
        config: { agentAccess }
      };
    },

    async openSession() {
      failIfNeeded();
      return {
        sessionId: randomUUID(),
        status: "open",
        episodeId: randomUUID(),
        resumed: false,
        serverTime: now()
      };
    },

    async closeSession(input) {
      failIfNeeded();
      return {
        ok: true,
        sessionId: input.sessionId,
        status: "closed",
        closedEpisodeIds: [],
        ...nextChange(),
        serverTime: now()
      };
    },

    async startTurn(input) {
      failIfNeeded();
      return {
        turnId: input.turnId ?? randomUUID(),
        contextPacketId: randomUUID(),
        sessionId: input.sessionId,
        injectedContext: {
          markdown: "",
          sections: []
        },
        searchEventId: randomUUID(),
        sourceMemoryIds: [],
        hits: [],
        status: [],
        serverTime: now()
      };
    },

    async completeTurn(input) {
      failIfNeeded();
      return {
        turnId: input.turnId,
        sessionId: input.sessionId,
        episodeId: randomUUID(),
        rawTurnId: randomUUID(),
        l1MemoryId: randomUUID(),
        l1MemoryIds: [],
        closedEpisodeIds: [],
        scheduledEvolution: false,
        jobs: [],
        ...nextChange(),
        serverTime: now()
      };
    },

    async search(input) {
      failIfNeeded();
      const injectedContext = {
        markdown: "",
        sections: []
      };
      if (input.verbose !== true) {
        return { injectedContext: injectedContext.markdown };
      }
      return {
        injectedContext: injectedContext.markdown,
        debug: {
          searchEventId: randomUUID(),
          hits: [],
          sourceMemoryIds: [],
          status: [],
          sections: injectedContext.sections,
          serverTime: now()
        }
      };
    },

    async addMemory(input) {
      failIfNeeded();
      const serverTime = now();
      const layer = input.layer ?? "L1";
      return {
        id: randomUUID(),
        kind: kindForLayer(layer),
        memoryLayer: layer,
        status: "activated",
        title: input.title ?? firstLine(input.content),
        summary: firstLine(input.content),
        tags: input.tags ?? [],
        createdAt: input.createdAt ?? serverTime,
        serverTime
      };
    },

    async getMemory(input) {
      failIfNeeded();
      const serverTime = now();
      const kind: MemoryKind = "trace";
      return {
        item: {
          id: input.memoryId,
          kind,
          memoryLayer: memoryLayerForKind(kind),
          status: "activated",
          title: input.memoryId,
          summary: "",
          tags: [],
          createdAt: serverTime,
          updatedAt: serverTime,
          version: 1,
          body: "",
          createdAt: serverTime,
          sourceMemoryIds: [],
          metadata: {}
        },
        version: 1
      };
    },

    async deleteMemory(input) {
      failIfNeeded();
      return {
        ok: true,
        id: input.memoryId,
        kind: "trace",
        status: "deleted",
        ...nextChange(),
        auditId: randomUUID(),
        serverTime: now()
      };
    },

    async enqueueImportSummaries() {
      failIfNeeded();
      return {
        enqueued: 0,
        memoryIds: [],
        serverTime: now()
      };
    },

    async getMemoryProcessingStatus() {
      failIfNeeded();
      return { items: [], serverTime: now() };
    },

    async retryMemoryProcessing(memoryId) {
      failIfNeeded();
      return {
        accepted: false,
        processing: {
          memoryId,
          state: "ready" as const,
          attemptCount: 0,
          manualRetryCount: 0,
          retryAction: "retry" as const,
          updatedAt: now()
        },
        serverTime: now()
      };
    },

    async runWorker() {
      failIfNeeded();
      return {
        leased: 0,
        succeeded: 0,
        failed: 0,
        jobs: [],
        embeddingRetries: {
          leased: 0,
          succeeded: 0,
          failed: 0,
          items: []
        },
        ...nextChange(),
        serverTime: now()
      };
    },

    async panelOverview() {
      failIfNeeded();
      return {
        counts: { memories: 0, userMemories: 0, skills: 0, experiences: 0, worldModels: 0 },
        dailyActivity: emptyPanelDays(now()),
        sourceDistribution: []
      };
    },

    async panelAnalysis() {
      failIfNeeded();
      return {
        metrics: {
          avgRecallScore: 0,
          recallEvents: 0,
          activeSkills: 0,
          recentlyUsedSkills: 0,
          avgToolLatencyMs: 0,
          p95ToolLatencyMs: 0
        },
        dailyMemoryWrites: emptyPanelDays(now()),
        dailySkillEvolutions: emptyPanelDays(now()),
        toolLatency: { tools: [], series: [] }
      };
    },

    async panelItems() {
      failIfNeeded();
      return {
        items: [],
        page: 1,
        pageSize: 20,
        total: 0,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
        serverTime: now()
      };
    },

    async memoryApiLogs(input) {
      failIfNeeded();
      const limit = input.limit ?? 50;
      const offset = input.offset ?? 0;
      return {
        logs: [],
        total: 0,
        limit,
        offset,
        serverTime: now()
      };
    },

    async listAgentSources() {
      failIfNeeded();
      return { executorAvailable: true, sources: [...agentSources.values()] };
    },

    async startAgentSourceScan(input) {
      failIfNeeded();
      if (scan.running) {
        throw new MemoryLayerError("conflict", 409, "An Agent source scan is already running");
      }
      scan = {
        ...scan,
        running: true,
        jobId: `mock-scan-${randomUUID()}`,
        sourceId: input.sourceId,
        mode: input.mode ?? null,
        origin: input.origin,
        progress: { sourceId: input.sourceId, phase: "scan", current: 0, total: 0 },
        startedAt: now(),
        completedAt: null,
        error: null,
        sources: []
      };
      return { accepted: true, jobId: scan.jobId as string };
    },

    async agentSourceScanStatus() {
      failIfNeeded();
      return scan;
    },

    async agentSourceScanResults() {
      failIfNeeded();
      return { items: [], nextCursor: null };
    },

    async pauseAgentSourceScan() {
      failIfNeeded();
      scan = { ...scan, running: false, progress: scan.progress ? { ...scan.progress, phase: "stopped" } : null };
      return { ok: true };
    },

    async cancelAgentSourceScan() {
      failIfNeeded();
      scan = emptyScanStatus();
      return { ok: true };
    },

    async mutateAgentSourceConnection(input) {
      failIfNeeded();
      const source = requireAgentSource(input.sourceId);
      const status = input.method === "DELETE"
        ? "not_connected"
        : input.kind === "plugin" ? "plugin_installed" : "skill_installed";
      agentSources.set(input.sourceId, { ...source, status });
      return { ok: true, sourceId: input.sourceId, status };
    },

    async detectAgentSourcePluginConflicts() {
      failIfNeeded();
      return { conflicts: [] };
    },

    async sampleOnboardingHistory() {
      failIfNeeded();
      return { samples: options.onboardingSamples ?? [] };
    },

    async readOnboardingConversation() {
      failIfNeeded();
      return { conversation: options.onboardingConversation ?? null };
    },

    async addManualAgentSource(input) {
      failIfNeeded();
      const sourceId = randomUUID();
      const view = {
        sourceId,
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
      agentSources.set(sourceId, view);
      return view;
    },

    async updateManualAgentSource(sourceId, input) {
      failIfNeeded();
      const source = requireAgentSource(sourceId);
      const view = {
        ...source,
        ...(input.dataPath ? { dataPath: input.dataPath } : {}),
        ...(input.syncRecipe ? { syncReady: true } : {}),
        ...(input.skillInstalled === undefined
          ? {}
          : { status: input.skillInstalled ? "skill_installed" as const : "not_connected" as const })
      };
      agentSources.set(sourceId, view);
      return view;
    },

    async removeManualAgentSource(sourceId) {
      failIfNeeded();
      requireAgentSource(sourceId);
      agentSources.delete(sourceId);
      return { ok: true };
    },

    async importManualAgentSource(sourceId, input) {
      failIfNeeded();
      const source = requireAgentSource(sourceId);
      const syncBoundaryAt = input.syncBoundaryAt ?? source.syncBoundaryAt ?? null;
      agentSources.set(sourceId, {
        ...source,
        messageCount: source.messageCount + input.messages.length,
        lastScannedAt: now(),
        syncBoundaryAt
      });
      return {
        sourceId,
        attempted: input.messages.length,
        written: input.messages.length,
        deduped: 0,
        failed: 0,
        memoryIds: input.messages.map(() => randomUUID()),
        syncBoundaryAt,
        errors: []
      };
    },

    async syncManualAgentSource(sourceId) {
      failIfNeeded();
      const source = requireAgentSource(sourceId);
      return {
        sourceId,
        attempted: 0,
        written: 0,
        deduped: 0,
        failed: 0,
        memoryIds: [],
        syncBoundaryAt: source.syncBoundaryAt ?? null,
        errors: []
      };
    }
  };
}

/** Builds a detected Agent the way the memory service reports one. */
export function mockAgentSourceView(
  sourceId: string,
  displayName: string,
  overrides: Partial<AgentSourceView> = {}
): AgentSourceView {
  return {
    sourceId,
    displayName,
    dataPath: `/home/user/.${sourceId}`,
    builtin: true,
    available: true,
    status: "not_connected",
    messageCount: 0,
    lastScannedAt: null,
    syncBoundaryAt: null,
    syncReady: false,
    ...overrides
  };
}

function emptyScanStatus(): MemoryAgentSourceScanStatus {
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

function mockModels() {
  return {
    summary: {
      provider: "mock",
      model: "mock-summary",
      configured: true,
      remote: false,
      routing: "fixed" as const
    },
    evolution: {
      provider: "mock",
      model: "mock-skill",
      configured: true,
      remote: false,
      routing: "follow" as const
    },
    embedding: {
      provider: "mock",
      model: "mock-embedding",
      configured: true,
      remote: false,
      mode: "local" as const
    }
  };
}

/**
 * Maps a memory kind to a memory layer.
 *
 * @param kind Memory kind.
 * @returns The corresponding memory layer.
 */
function memoryLayerForKind(kind: MemoryKind): "L1" | "L2" | "L3" | "Skill" {
  if (kind === "policy") {
    return "L2";
  }

  if (kind === "world_model") {
    return "L3";
  }

  if (kind === "skill") {
    return "Skill";
  }

  return "L1";
}

function emptyPanelDays(nowIso: string): Array<{ date: string; count: number }> {
  const parsed = Date.parse(nowIso);
  const end = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  return Array.from({ length: 7 }, (_item, index) => {
    const day = new Date(end);
    day.setUTCDate(end.getUTCDate() - (6 - index));
    return { date: day.toISOString().slice(0, 10), count: 0 };
  });
}

/**
 * Maps a memory layer to a default memory kind.
 *
 * @param layer Memory layer.
 * @returns The corresponding default memory kind.
 */
function kindForLayer(layer: "L1" | "L2" | "L3" | "Skill"): MemoryKind {
  if (layer === "L2") return "policy";
  if (layer === "L3") return "world_model";
  if (layer === "Skill") return "skill";
  return "trace";
}

/**
 * Takes the first line of the body as the mock title.
 *
 * @param value The original body.
 * @returns The first non-empty line, or a fallback title.
 */
function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim() || value.trim() || "Untitled memory";
}
