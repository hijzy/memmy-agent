import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readdirSync, rmSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import Database from "better-sqlite3";
import { loadMemmyConfig } from "../config/index.js";
import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";
import type { MemoryService } from "../service/memory-service.js";
import { MemoryServiceError } from "../utils/error.js";
import {
  resolveClaudeCodeHomeDirectory,
  resolveCodexHomeDirectory,
  resolveDeepseekHarnessHomeDirectory,
  resolveHermesHomeDirectory,
  resolveOpenclawStateDirectory,
  resolveOpencodeConfigDirectory,
  resolvePiAgentDirectory,
  resolveQwenworkHomeDirectory,
  resolveWorkbuddyHomeDirectory
} from "./agent-paths.js";
import { createClaudeCodeSourceAdapter } from "./adapters/claude-code/index.js";
import { createCodexSourceAdapter } from "./adapters/codex/index.js";
import { createCursorSourceAdapter } from "./adapters/cursor/index.js";
import { createDeepseekHarnessSourceAdapter } from "./adapters/deepseek-harness/index.js";
import { createHermesSourceAdapter } from "./adapters/hermes/index.js";
import { createOpenclawSourceAdapter } from "./adapters/openclaw/index.js";
import { createOpencodeSourceAdapter } from "./adapters/opencode/index.js";
import { createPiSourceAdapter } from "./adapters/pi/index.js";
import { createQwenworkSourceAdapter } from "./adapters/qwenwork/index.js";
import { createSourceRegistry, type SourceRegistry } from "./adapters/source-registry.js";
import type { ConversationMessage, ScanProgress, SourceAdapter } from "./adapters/types.js";
import {
  isCompleteTurn,
  orderedTurns,
  renderTurnClipped,
  stableTurnIdentity,
  legacyTurnId,
  legacyTurnRequestId,
  type ConversationCheckpoint,
  type ImportedTurn,
  type ScanStore
} from "@memmy/agent-source-core";
import { openMemoryAgentSourceScanStore, type MemoryAgentSourceScanStore } from "./scan-store.js";
import {
  extractManagedAgentHistory,
  selectIncrementalManagedMessages
} from "./managed-history.js";
import {
  AddManualSourceInputSchema,
  MANUAL_SOURCE_DISCOVERY_PENDING_DATA_PATH,
  ManagedSyncRecipeSchema,
  ManualSourceImportInputSchema,
  ManualSourceUpdateInputSchema,
  parseOrInvalidArgument,
  type ManagedSyncRecipe,
  type ManualSourceImportInput,
  type ManualSourceImportResult
} from "./manual-sources.js";
import { createWorkbuddySourceAdapter } from "./adapters/workbuddy/index.js";
import { createClaudeCodeSkillTarget } from "./integration/claude-code/index.js";
import { createCodexSkillTarget } from "./integration/codex/index.js";
import { createCursorSkillTarget } from "./integration/cursor/index.js";
import { createDeepseekHarnessSkillTarget } from "./integration/deepseek-harness/index.js";
import { createHermesSkillTarget } from "./integration/hermes/index.js";
import { createOpenclawSkillTarget } from "./integration/openclaw/index.js";
import { createOpencodeSkillTarget } from "./integration/opencode/index.js";
import { createPiSkillTarget } from "./integration/pi/index.js";
import { createQwenworkSkillTarget } from "./integration/qwenwork/index.js";
import {
  createSkillTargetRegistry,
  type SkillTargetRegistry
} from "./integration/target-registry.js";
import { renderMemmyDefaultSkillManifest } from "./integration/templates/memmy-default.js";
import type { MemoryPluginConflict } from "./integration/types.js";
import { createWorkbuddySkillTarget } from "./integration/workbuddy/index.js";

const logger = createMemoryLogger("agent-source");
const INITIAL_SCAN_DELAY_MS = 5 * 60 * 1000;
const SCHEDULED_SCAN_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_SCAN_MESSAGE_LIMIT = 1_000;
const COMPLETED_DETAILS_RETENTION_MS = 60 * 60 * 1000;

export type AgentConnectionStatus = "not_connected" | "skill_installed" | "plugin_installed";

export interface AgentSourceView {
  sourceId: string;
  displayName: string;
  dataPath: string;
  builtin: boolean;
  available: boolean;
  status: AgentConnectionStatus;
  messageCount: number;
  lastScannedAt: string | null;
  /** The permanent first-sync boundary. Only manual sources record one today. */
  syncBoundaryAt?: string | null;
  /** Whether format discovery has produced a usable sync recipe. */
  syncReady?: boolean;
}

/** Who asked for a scan, so a UI only reports progress for its own runs. */
export type AgentSourceScanOrigin = "app" | "viewer" | "cli" | "automation";

export interface AgentSourceScanSourceStats {
  sourceId: string;
  discoveredConversations: number;
  emittedMessages: number;
  written: number;
  skipped: number;
  errorCount: number;
}

export interface AgentSourceScanState {
  running: boolean;
  jobId: string | null;
  sourceId: string | null;
  mode: "initial_subset" | "incremental" | "full" | null;
  origin: AgentSourceScanOrigin | null;
  progress: ScanProgress | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  /** Per-source counts, appended as each source finishes. */
  sources: AgentSourceScanSourceStats[];
  /**
   * Set when a non-full run selected more turns than one run may import. The
   * run waits in `stopped` until the caller restarts it, which approves the
   * import.
   */
  pendingAdditions: { sourceId: string; selected: number; budget: number } | null;
}

export interface AgentSourceExecutor {
  list(): Promise<{ executorAvailable: true; sources: AgentSourceView[] }>;
  startScan(input: unknown): Promise<{ accepted: true; jobId: string }>;
  scanStatus(): AgentSourceScanState;
  pauseScan(): Promise<{ ok: true }>;
  cancelScan(): Promise<{ ok: true }>;
  scanResults?(jobId: string, cursor?: string, limit?: number): Promise<{ items: Array<{ sourceId: string; conversationId: string; memoryId?: string; error?: string }>; nextCursor: string | null }>;
  mutateConnection(sourceId: string, kind: "plugin" | "skill", method: "POST" | "DELETE"): Promise<unknown>;
  /** Reports Agents whose config already holds a competing memory plugin. */
  detectPluginConflicts(): Promise<{ conflicts: MemoryPluginConflict[] }>;
  /** Registers a user-added Agent whose history format is not yet known. */
  addManualSource(input: unknown): Promise<AgentSourceView>;
  updateManualSource(sourceId: string, input: unknown): Promise<AgentSourceView>;
  removeManualSource(sourceId: string): Promise<{ ok: true }>;
  /** Imports messages a caller already extracted, in pages. */
  importManualSource(sourceId: string, input: unknown): Promise<ManualSourceImportResult>;
  /** Re-reads the recipe and imports whatever appeared after the boundary. */
  syncManualSource(sourceId: string): Promise<ManualSourceImportResult>;
  startAutomation(): void;
  /** Re-arms the automation timer after `memmyMemory.agentAccess` changed on disk. */
  rescheduleAutomation(): void;
  dispose(): void | Promise<void>;
}

interface PersistedSourceState {
  status: AgentConnectionStatus;
  messageCount: number;
  lastScannedAt: string | null;
  latestSeenAt: string | null;
  /** The permanent first-sync boundary; never moves once recorded. */
  baselineAt: string | null;
  /**
   * Where the last import stopped in each conversation. A job-scoped store
   * used to hold these, so every new job re-imported the boundary turn.
   */
  checkpoints: Record<string, PersistedCheckpoint>;
  contentHash?: string;
}

interface PersistedCheckpoint {
  lastMessageId: string;
  lastCreatedAt: string;
  contentHash: string;
  updatedAt: string;
}

/**
 * A manual source has no adapter, so the state file is the only record that it
 * exists at all, where its history lives and how to read it.
 */
interface PersistedManualSource {
  displayName: string;
  dataPath: string;
  syncRecipe: ManagedSyncRecipe | null;
  baselineAt: string | null;
  createdAt: string;
}

interface PersistedState {
  version: 3;
  sources: Record<string, PersistedSourceState>;
  manual: Record<string, PersistedManualSource>;
}

export interface CreateAgentSourceExecutorOptions {
  service: MemoryService;
  configPath?: string;
  sourceRegistry?: SourceRegistry;
  statePath?: string;
  initialScanDelayMs?: number;
  scheduledScanIntervalMs?: number;
  scheduleWorker?: () => void;
  integrationRegistry?: SkillTargetRegistry;
  /** Resolves the Agent root used for optional cross-Agent Skill ingestion. */
  resolveAgentSkillRoot?: (sourceId: string) => string | null;
  scanStoreDirectory?: string;
  /** Turns one non-full run may import before it stops to ask. */
  additionBudget?: number;
}

export function createAgentSourceExecutor(options: CreateAgentSourceExecutorOptions): AgentSourceExecutor {
  const registry = options.sourceRegistry ?? createBuiltinSourceRegistry();
  const configPath = options.configPath ?? join(
    process.env.MEMMY_HOME?.trim() || join(homedir(), ".memmy"),
    "config.yaml"
  );
  const integrationRegistry = options.integrationRegistry ?? createBuiltinIntegrationRegistry(configPath);
  const statePath = options.statePath ?? join(dirname(configPath), "memory-service", "agent-sources.json");
  const scanStoreDirectory = options.scanStoreDirectory ?? join(dirname(statePath), "agent-source-scans");
  let statePromise: Promise<PersistedState> | undefined;
  let scan: AgentSourceScanState = emptyScanState();
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let scanAbortController: AbortController | undefined;
  let activeScanRequest: ReturnType<typeof normalizeScanInput> | undefined;
  let scanPaused = false;
  let progressBeforePause: ScanProgress | null = null;
  let resumePausedScan: (() => void) | undefined;
  let disposed = false;
  let automationStarted = false;
  let additionsApproved = false;
  const activeScans = new Set<Promise<void>>();
  let activeAutomation: Promise<void> | undefined;

  const readState = () => statePromise ??= loadState(statePath);
  const persist = async (state: PersistedState) => writeState(statePath, state);

  async function list(): Promise<{ executorAvailable: true; sources: AgentSourceView[] }> {
    const state = await readState();
    const sources = await Promise.all(registry.list().map(async (adapter) => {
      const stored = state.sources[adapter.descriptor.sourceId];
      const available = await adapter.detect();
      const target = integrationRegistry.get(adapter.descriptor.sourceId);
      const installed = target
        ? await target.isInstalled(adapter.descriptor.sourceId).catch((error) => {
            logger.warn("connection.status_read_failed", {
              sourceId: adapter.descriptor.sourceId,
              ...memoryErrorFields(error)
            });
            return false;
          })
        : false;
      return {
        ...adapter.descriptor,
        available,
        status: installed ? connectionStatus(adapter.descriptor.sourceId) : "not_connected",
        messageCount: stored?.messageCount ?? 0,
        lastScannedAt: stored?.lastScannedAt ?? null,
        syncBoundaryAt: stored?.baselineAt ?? null,
        // An adapter knows its own format, so there is nothing to discover.
        // Only manual sources can be "not ready yet".
        syncReady: false
      };
    }));
    return {
      executorAvailable: true,
      sources: [...sources, ...Object.keys(state.manual).map((sourceId) => manualView(state, sourceId))]
    };
  }

  function manualView(state: PersistedState, sourceId: string): AgentSourceView {
    const manual = requireManualSource(state, sourceId);
    const stored = state.sources[sourceId];
    return {
      sourceId,
      displayName: manual.displayName,
      dataPath: manual.dataPath,
      builtin: false,
      // The user vouched for a manual source by adding it; there is no
      // adapter to detect, so nothing can withdraw that.
      available: true,
      status: stored?.status ?? "not_connected",
      messageCount: stored?.messageCount ?? 0,
      lastScannedAt: stored?.lastScannedAt ?? null,
      syncBoundaryAt: manual.baselineAt,
      syncReady: Boolean(manual.syncRecipe)
    };
  }

  function requireManualSource(state: PersistedState, sourceId: string): PersistedManualSource {
    const manual = state.manual[sourceId];
    if (!manual) throw new MemoryServiceError("not_found", `Unknown manual Agent source: ${sourceId}`);
    return manual;
  }

  async function addManualSource(input: unknown): Promise<AgentSourceView> {
    const { displayName } = parseOrInvalidArgument(AddManualSourceInputSchema, input);
    const state = await readState();
    const sourceId = randomUUID();
    state.manual[sourceId] = {
      displayName,
      dataPath: MANUAL_SOURCE_DISCOVERY_PENDING_DATA_PATH,
      syncRecipe: null,
      baselineAt: null,
      createdAt: new Date().toISOString()
    };
    state.sources[sourceId] = emptySourceState();
    await persist(state);
    logger.info("manual_source.added", { sourceId, displayName });
    return manualView(state, sourceId);
  }

  async function updateManualSource(sourceId: string, input: unknown): Promise<AgentSourceView> {
    const patch = parseOrInvalidArgument(ManualSourceUpdateInputSchema, input);
    const state = await readState();
    const manual = requireManualSource(state, sourceId);
    if (patch.syncRecipe) assertRecipeFindsTurns(sourceId, patch.syncRecipe);
    state.manual[sourceId] = {
      ...manual,
      ...(patch.dataPath ? { dataPath: patch.dataPath } : {}),
      ...(patch.syncRecipe ? { syncRecipe: patch.syncRecipe } : {})
    };
    if (patch.skillInstalled !== undefined) {
      state.sources[sourceId] = {
        ...(state.sources[sourceId] ?? emptySourceState()),
        status: patch.skillInstalled ? "skill_installed" : "not_connected"
      };
    }
    await persist(state);
    return manualView(state, sourceId);
  }

  async function removeManualSource(sourceId: string): Promise<{ ok: true }> {
    const state = await readState();
    requireManualSource(state, sourceId);
    delete state.manual[sourceId];
    delete state.sources[sourceId];
    await persist(state);
    logger.info("manual_source.removed", { sourceId });
    return { ok: true };
  }

  async function importManualSource(sourceId: string, input: unknown): Promise<ManualSourceImportResult> {
    return ingestManualMessages(sourceId, parseOrInvalidArgument(ManualSourceImportInputSchema, input));
  }

  async function syncManualSource(sourceId: string): Promise<ManualSourceImportResult> {
    const state = await readState();
    const manual = requireManualSource(state, sourceId);
    if (!manual.syncRecipe) {
      throw new MemoryServiceError("conflict", "Manual Agent source has not completed first-time format discovery");
    }
    if (!manual.baselineAt) {
      throw new MemoryServiceError("conflict", "Manual Agent source has no recorded initial sync boundary");
    }
    const messages = selectIncrementalManagedMessages(
      readManagedHistory(sourceId, manual.syncRecipe),
      manual.baselineAt
    );
    const result = await ingestManualMessages(sourceId, {
      mode: "incremental",
      messages,
      syncBoundaryAt: manual.baselineAt,
      latestSeenAt: latestCreatedAt(messages),
      final: true
    });
    if (result.errors.length > 0) {
      throw new MemoryServiceError(
        "internal",
        `Manual Agent sync failed: ${result.errors.map((error) => error.reason).join("; ")}`
      );
    }
    return result;
  }

  async function ingestManualMessages(
    sourceId: string,
    input: ManualImportRequest
  ): Promise<ManualSourceImportResult> {
    const state = await readState();
    const manual = requireManualSource(state, sourceId);
    if (input.dataPath) {
      state.manual[sourceId] = { ...manual, dataPath: input.dataPath };
      await persist(state);
    }
    const messages = manualMessagesForIngestion(sourceId, input.messages);
    const ingested = await ingestManualTurns(
      options.service,
      manual.displayName,
      messages,
      options.scheduleWorker
    );
    const stored = state.sources[sourceId] ?? emptySourceState();
    const earliest = earliestCreatedAt(messages);
    const syncBoundaryAt = input.mode === "initial_subset"
      ? input.syncBoundaryAt ?? manual.baselineAt ?? earliest
      : manual.baselineAt ?? input.syncBoundaryAt ?? earliest;
    if (input.final && ingested.errors.length === 0) {
      const scannedAt = new Date().toISOString();
      state.manual[sourceId] = { ...state.manual[sourceId]!, baselineAt: syncBoundaryAt };
      state.sources[sourceId] = {
        ...stored,
        messageCount: input.mode === "incremental"
          ? stored.messageCount + ingested.written
          : ingested.written,
        lastScannedAt: scannedAt,
        latestSeenAt: maxIso(
          maxIso(stored.latestSeenAt, input.latestSeenAt ?? null),
          latestCreatedAt(messages)
        )
      };
      await persist(state);
    }
    return { sourceId, syncBoundaryAt, ...ingested };
  }

  /** A recipe that finds no complete turn is a failed discovery, not a setting. */
  function assertRecipeFindsTurns(sourceId: string, recipe: ManagedSyncRecipe): void {
    const messages = selectIncrementalManagedMessages(
      readManagedHistory(sourceId, recipe),
      new Date(0).toISOString()
    );
    if (messages.length === 0) {
      throw new MemoryServiceError(
        "invalid_argument",
        "Manual Agent sync recipe found no complete user/assistant turns"
      );
    }
  }

  async function startScan(input: unknown): Promise<{ accepted: true; jobId: string }> {
    if (disposed) throw new MemoryServiceError("conflict", "Agent source executor is shutting down");
    const request = normalizeScanInput(input);
    if (scan.running) throw new MemoryServiceError("conflict", "An Agent source scan is already running");
    if (scanPaused && scanAbortController && activeScanRequest && scan.jobId) {
      if (!sameScanRequest(activeScanRequest, request)) {
        throw new MemoryServiceError("conflict", "Resume or stop the paused Agent source scan first");
      }
      const jobId = scan.jobId;
      scanPaused = false;
      // Restarting the same run is how a caller answers "import N additions?".
      additionsApproved = true;
      scan = {
        ...scan,
        running: true,
        pendingAdditions: null,
        progress: progressBeforePause ?? {
          sourceId: request.sourceId,
          phase: "scan",
          current: 0,
          total: 0,
          message: "Scanning Agent history"
        },
        error: null
      };
      resumePausedScan?.();
      resumePausedScan = undefined;
      logger.info("scan.resumed", { jobId, sourceId: request.sourceId });
      return { accepted: true, jobId };
    }
    if (scanPaused) {
      throw new MemoryServiceError("conflict", "Stop the paused Agent source scan before starting another scan");
    }
    const jobId = findReusableScanJob(scanStoreDirectory, request.sourceId, request.mode)
      ?? `agent-scan-${Date.now().toString(36)}`;
    scan = {
      running: true,
      jobId,
      sourceId: request.sourceId,
      mode: request.mode ?? null,
      origin: request.origin,
      progress: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      sources: [],
      pendingAdditions: null
    };
    activeScanRequest = request;
    progressBeforePause = null;
    additionsApproved = false;
    const controller = new AbortController();
    scanAbortController = controller;
    const activeScan = runScan(request, controller.signal, jobId).then(() => {
      if (scan.jobId !== jobId) return;
      scan = { ...scan, running: false, completedAt: new Date().toISOString() };
      logger.info("scan.completed", { jobId, sourceId: request.sourceId });
    }).catch((error) => {
      if (scan.jobId !== jobId || controller.signal.aborted) return;
      scan = {
        ...scan,
        running: false,
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
      logger.error("scan.failed", { jobId, sourceId: request.sourceId, ...memoryErrorFields(error) });
    }).finally(() => {
      activeScans.delete(activeScan);
      if (scanAbortController === controller) {
        scanAbortController = undefined;
        activeScanRequest = undefined;
        scanPaused = false;
        progressBeforePause = null;
        resumePausedScan = undefined;
      }
    });
    activeScans.add(activeScan);
    logger.info("scan.started", { jobId, sourceId: request.sourceId, mode: request.mode });
    return { accepted: true, jobId };
  }

  async function runScan(
    request: ReturnType<typeof normalizeScanInput>,
    signal: AbortSignal,
    jobId: string
  ): Promise<void> {
    const failures: string[] = [];
    let failureCount = 0;
    const adapters = request.sourceId === "all"
      ? registry.list()
      : [registry.require(request.sourceId)];
    const state = await readState();
    let store: MemoryAgentSourceScanStore | undefined;
    let completed = false;
    const preparedContentHashes = new Map<string, string>();
    try {
      store = await openMemoryAgentSourceScanStore(join(scanStoreDirectory, `${jobId}.sqlite`), {
        jobId, sourceId: request.sourceId, mode: request.mode ?? "incremental", phase: "stage",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
      const available: SourceAdapter[] = [];
      for (const adapter of adapters) {
        await waitWhilePaused(signal);
        signal.throwIfAborted();
        if (await adapter.detect()) available.push(adapter);
        else if (request.sourceId !== "all") throw new MemoryServiceError("not_found", `${adapter.descriptor.displayName} is not installed`);
      }
      const globalInitial = request.sourceId === "all" && available.length > 0 &&
        (request.mode === "initial_subset" || (request.mode === undefined && available.every((adapter) => !state.sources[adapter.descriptor.sourceId]?.lastScannedAt)));
      const stages: StandaloneSourceStage[] = [];
      for (const adapter of available) {
        const stored = state.sources[adapter.descriptor.sourceId] ?? emptySourceState();
        const mode = request.mode ?? (stored.lastScannedAt ? "incremental" : "initial_subset");
        store.saveMeta({ jobId, sourceId: store.getMeta()?.sourceId ?? request.sourceId, mode, phase: "stage", createdAt: store.getMeta()?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() });
        stages.push(await stageStandaloneSource(adapter, stored, mode, store, signal, () => waitWhilePaused(signal), (progress) => {
          if (!scanPaused) { progressBeforePause = progress; scan = { ...scan, progress }; }
        }));
      }
      for (const stage of stages) {
        await waitWhilePaused(signal);
        signal.throwIfAborted();
        const { sourceId, mode } = stage;
        store.saveMeta({ jobId, sourceId: store.getMeta()?.sourceId ?? request.sourceId, mode, phase: "prepare", createdAt: store.getMeta()?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() });
        const sourceState = store.getSourceState(sourceId);
        store.saveSourceState({ ...(sourceState ?? { sourceId, mode, messageCount: store.count(sourceId), resultCount: store.resultCount(sourceId), errorCount: stage.scanErrorCount, updatedAt: new Date().toISOString() }), phase: "prepare", updatedAt: new Date().toISOString() });
        // Hand the job the boundaries earlier jobs committed, so prepare can
        // tell an unchanged conversation from one with a new turn.
        const checkpoints = Object.entries(stage.stored.checkpoints);
        store.saveCheckpoints(checkpoints.map(([conversationId, checkpoint]) => ({
          sourceId, conversationId, ...checkpoint
        })));
        preparedContentHashes.set(sourceId, await prepareStandaloneSource(store, sourceId, mode, stage.stored.latestSeenAt, checkpoints.length > 0, stage.stored.contentHash));
      }
      if (globalInitial) store.selectInitialTurns(stages.map((stage) => stage.sourceId), INITIAL_SCAN_MESSAGE_LIMIT, 200);
      for (const stage of stages) {
        await waitWhilePaused(signal);
        signal.throwIfAborted();
        const { adapter, stored, mode, sourceId, staged } = stage;
        if (mode === "initial_subset" && !globalInitial) store.selectInitialTurns([sourceId], INITIAL_SCAN_MESSAGE_LIMIT, 0);
        await waitForAdditionsApproval(store, sourceId, mode, signal);
        store.saveMeta({ jobId, sourceId: store.getMeta()?.sourceId ?? request.sourceId, mode, phase: "ingest", createdAt: store.getMeta()?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() });
        const preparedState = store.getSourceState(sourceId);
        store.saveSourceState({ ...(preparedState ?? { sourceId, mode, messageCount: store.count(sourceId), resultCount: store.resultCount(sourceId), errorCount: stage.scanErrorCount, updatedAt: new Date().toISOString() }), phase: "ingest", updatedAt: new Date().toISOString() });
        const result = await ingestStagedMessages(options.service, store, sourceId, signal, (progress) => {
          if (!scanPaused) { progressBeforePause = progress; scan = { ...scan, progress }; }
        }, options.scheduleWorker);
        const skillResult = await ingestAgentSkills(
          options.service,
          sourceId,
          store,
          options.resolveAgentSkillRoot,
          options.scheduleWorker
        );
        const sourceErrorCount = stage.scanErrorCount + result.errorCount + skillResult.errorCount;
        failureCount += sourceErrorCount;
        for (const detail of [...stage.errors, ...result.errors, ...skillResult.errors]) {
          if (failures.length >= 1000) break;
          failures.push(detail);
        }
        const now = new Date().toISOString();
        const clean = stage.scanErrorCount === 0 && result.errorCount === 0 && skillResult.errorCount === 0;
        state.sources[sourceId] = {
          ...stored,
          messageCount: mode === "incremental"
            ? stored.messageCount + result.messageCount
            : result.messageCount,
          lastScannedAt: now,
          ...(clean && preparedContentHashes.has(sourceId)
            ? { contentHash: preparedContentHashes.get(sourceId) }
            : stored.contentHash ? { contentHash: stored.contentHash } : {}),
          latestSeenAt: clean
            ? (result.latestSeenAt ?? stored.latestSeenAt)
            : stored.latestSeenAt,
          // The boundary is whatever the first scan of this source saw; later
          // scans must never move it, or the GUI's sync boundary would drift.
          baselineAt: stored.baselineAt ?? (clean ? (result.latestSeenAt ?? stored.latestSeenAt) : null),
          checkpoints: clean ? committedCheckpoints(store, sourceId) : stored.checkpoints
        };
        await persist(state);
        scan = {
          ...scan,
          sources: [...scan.sources.filter((entry) => entry.sourceId !== sourceId), {
            sourceId,
            discoveredConversations: result.conversationCount,
            emittedMessages: staged,
            written: result.written,
            skipped: result.skipped,
            errorCount: sourceErrorCount
          }]
        };
        store.saveSourceState({
          sourceId,
          mode,
          phase: sourceErrorCount > 0 ? "failed" : "done",
          messageCount: result.messageCount,
          resultCount: store.resultCount(sourceId),
          errorCount: sourceErrorCount,
          updatedAt: now
        });
        store.saveMeta({ jobId, sourceId: store.getMeta()?.sourceId ?? request.sourceId, mode, phase: "summarize", createdAt: store.getMeta()?.createdAt ?? now, updatedAt: now });
        scan = { ...scan, progress: { sourceId, phase: "done", current: staged, total: staged, message: `Imported ${result.written} memories and ${skillResult.written} skills` } };
      }
      store.saveMeta({ jobId, sourceId: request.sourceId, mode: request.mode ?? "incremental", phase: "done", createdAt: store.getMeta()?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() });
      if (failureCount > 0) {
        const meta = store.getMeta();
        if (meta) store.saveMeta({ ...meta, phase: "failed", updatedAt: new Date().toISOString(), error: failures.slice(0, 3).join("; ") });
      }
      completed = failureCount === 0 && store.resultCount() <= INITIAL_SCAN_MESSAGE_LIMIT;
    } catch (error) {
      if (store) {
        const meta = store.getMeta();
        if (meta) store.saveMeta({ ...meta, phase: "failed", updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    } finally {
      if (store) {
        if (completed) store.remove();
        else store.close();
      }
    }
    if (failureCount > 0) {
      throw new Error(`Agent source scan completed with ${failureCount} import failure${failureCount === 1 ? "" : "s"}: ${failures.slice(0, 3).join("; ")}`);
    }
  }

  async function pauseScan(): Promise<{ ok: true }> {
    if (scanPaused) return { ok: true };
    if (!scan.running || !scanAbortController || !activeScanRequest) {
      throw new MemoryServiceError("conflict", "No Agent source scan is running");
    }
    progressBeforePause = scan.progress;
    scanPaused = true;
    scan = {
      ...scan,
      running: false,
      progress: {
        sourceId: scan.progress?.sourceId ?? activeScanRequest.sourceId,
        phase: "stopped",
        current: scan.progress?.current ?? 0,
        total: scan.progress?.total ?? 0,
        message: "Agent source scan paused"
      }
    };
    logger.info("scan.paused", { jobId: scan.jobId, sourceId: activeScanRequest.sourceId });
    return { ok: true };
  }

  async function cancelScan(): Promise<{ ok: true }> {
    const controller = scanAbortController;
    if (!controller && !scanPaused) return { ok: true };
    const jobId = scan.jobId;
    const sourceId = activeScanRequest?.sourceId;
    scanPaused = false;
    controller?.abort();
    if (jobId) {
      const path = join(scanStoreDirectory, `${jobId}.sqlite`);
      await Promise.all([
        rm(path, { force: true }),
        rm(`${path}-wal`, { force: true }),
        rm(`${path}-shm`, { force: true })
      ]);
    }
    resumePausedScan?.();
    resumePausedScan = undefined;
    scan = emptyScanState();
    activeScanRequest = undefined;
    progressBeforePause = null;
    logger.info("scan.canceled", { jobId, sourceId });
    return { ok: true };
  }

  async function scanResults(jobId: string, cursor = "0", limit = 100): Promise<{ items: Array<{ sourceId: string; conversationId: string; memoryId?: string; error?: string }>; nextCursor: string | null }> {
    const path = join(scanStoreDirectory, `${jobId}.sqlite`);
    if (!existsSync(path)) return { items: [], nextCursor: null };
    const store = await openMemoryAgentSourceScanStore(path, { jobId, sourceId: "all", mode: "incremental", phase: "ingest", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    let removeAfterRead = false;
    try {
      const safeLimit = Math.min(500, Math.max(1, limit));
      const safeCursor = Number.isFinite(Number(cursor)) && Number(cursor) >= 0 ? String(Math.floor(Number(cursor))) : "0";
      const rows = [...store.results(undefined, safeCursor, safeLimit)];
      const items = rows.map(({ cursor: _cursor, ...item }) => item);
      const nextCursor = rows.length < safeLimit ? null : rows.at(-1)?.cursor ?? null;
      removeAfterRead = nextCursor === null && store.getMeta()?.phase === "done";
      return { items, nextCursor };
    } finally {
      store.close();
      if (removeAfterRead) {
        await Promise.all([rm(path, { force: true }), rm(`${path}-wal`, { force: true }), rm(`${path}-shm`, { force: true })]);
      }
    }
  }

  /**
   * A routine incremental run should import a handful of turns. Thousands mean
   * something moved the boundary, so the run stops and shows the number
   * instead of quietly rewriting that much memory.
   */
  async function waitForAdditionsApproval(
    store: MemoryAgentSourceScanStore,
    sourceId: string,
    mode: "initial_subset" | "incremental" | "full",
    signal: AbortSignal
  ): Promise<void> {
    if (mode === "full" || additionsApproved) return;
    const budget = options.additionBudget ?? INITIAL_SCAN_MESSAGE_LIMIT;
    const selected = store.selectedTurnCount(sourceId);
    if (selected <= budget) return;
    const progress: ScanProgress = {
      sourceId,
      phase: "stopped",
      current: 0,
      total: selected,
      message: `Found ${selected} new turns, more than the ${budget} one run may import`
    };
    progressBeforePause = progress;
    scanPaused = true;
    scan = { ...scan, running: false, progress, pendingAdditions: { sourceId, selected, budget } };
    logger.info("scan.additions_pending", { sourceId, selected, budget });
    await waitWhilePaused(signal);
  }

  async function waitWhilePaused(signal: AbortSignal): Promise<void> {
    while (scanPaused) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          resumePausedScan = undefined;
          reject(signal.reason ?? new Error("Agent source scan canceled"));
        };
        resumePausedScan = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    signal.throwIfAborted();
  }

  async function mutateConnection(
    sourceId: string,
    kind: "plugin" | "skill",
    method: "POST" | "DELETE"
  ): Promise<unknown> {
    const adapter = registry.require(sourceId);
    if (!(await adapter.detect())) {
      throw new MemoryServiceError("not_found", `${adapter.descriptor.displayName} is not installed`);
    }
    const target = integrationRegistry.get(sourceId);
    if (!target) throw new MemoryServiceError("invalid_argument", `Agent source ${sourceId} cannot be connected automatically`);
    if (method === "POST") {
      if (!(await target.resolveRootDirectory())) {
        throw new MemoryServiceError("not_found", `${adapter.descriptor.displayName} is not installed`);
      }
      if (kind === "plugin") {
        if (!target.installPlugin) {
          throw new MemoryServiceError("invalid_argument", `${adapter.descriptor.displayName} does not support automatic Hook or plugin installation`);
        }
        await target.installPlugin(sourceId);
      } else {
        await target.install(renderMemmyDefaultSkillManifest(sourceId));
      }
    } else {
      if (kind === "plugin" && target.uninstallPlugin) await target.uninstallPlugin(sourceId);
      await target.uninstall(sourceId);
    }
    const state = await readState();
    const stored = state.sources[sourceId] ?? emptySourceState();
    state.sources[sourceId] = {
      ...stored,
      status: method === "POST" ? connectionStatus(sourceId) : "not_connected"
    };
    await persist(state);
    logger.info(method === "POST" ? "connection.installed" : "connection.removed", { sourceId, kind });
    return { ok: true, sourceId, status: state.sources[sourceId].status };
  }

  /**
   * Another memory plugin writing into the same Agent config fights ours over
   * the same file, so the UI has to be able to say which Agent it found.
   */
  async function detectPluginConflicts(): Promise<{ conflicts: MemoryPluginConflict[] }> {
    const conflicts: MemoryPluginConflict[] = [];
    for (const target of integrationRegistry.list()) {
      try {
        const conflict = await target.detectMemoryPluginConflict?.();
        if (conflict) conflicts.push(conflict);
      } catch (error) {
        // One unreadable Agent config must not hide the conflicts we did find.
        logger.warn("plugin_conflict.detect_failed", { targetId: target.targetId, ...memoryErrorFields(error) });
      }
    }
    return { conflicts };
  }

  function scheduleAutomation(delay: number, startup: boolean): void {
    if (disposed) return;
    scanTimer = setTimeout(() => {
      scanTimer = undefined;
      activeAutomation = runAutomation(startup)
        .catch((error) => logger.warn("automation.failed", memoryErrorFields(error)))
        .finally(() => scheduleAutomation(
          options.scheduledScanIntervalMs ?? SCHEDULED_SCAN_INTERVAL_MS,
          false
        ));
    }, delay);
    scanTimer.unref?.();
  }

  function scheduleAutomationFromConfig(): void {
    const config = loadMemmyConfig(configPath).config.agentAccess;
    scheduleAutomation(
      config.autoScanKnownAgents
        ? options.initialScanDelayMs ?? INITIAL_SCAN_DELAY_MS
        : options.scheduledScanIntervalMs ?? SCHEDULED_SCAN_INTERVAL_MS,
      config.autoScanKnownAgents
    );
  }

  async function runAutomation(startup: boolean): Promise<void> {
    if (disposed || scan.running) return;
    const config = loadMemmyConfig(configPath).config.agentAccess;
    if (config.autoInjectSkill) {
      const discovered = await list();
      for (const source of discovered.sources) {
        if (disposed) return;
        if (!source.available || source.status !== "not_connected") continue;
        try {
          await mutateConnection(source.sourceId, agentConnectionKind(source.sourceId), "POST");
        } catch (error) {
          logger.warn("connection.auto_install_failed", { sourceId: source.sourceId, ...memoryErrorFields(error) });
        }
      }
    }
    const enabled = startup ? config.autoScanKnownAgents : config.watchFileChanges;
    if (enabled && !disposed) await startScan({ sourceId: "all", origin: "automation" });
  }

  return {
    list,
    startScan,
    scanStatus: () => scan,
    pauseScan,
    cancelScan,
    scanResults,
    mutateConnection,
    detectPluginConflicts,
    addManualSource,
    updateManualSource,
    removeManualSource,
    importManualSource,
    syncManualSource,
    startAutomation() {
      if (automationStarted || disposed) return;
      automationStarted = true;
      scheduleAutomationFromConfig();
    },
    rescheduleAutomation() {
      // Only a pending timer was armed under the old config. A run that is
      // already in flight reads the config itself and re-arms when it exits.
      if (!automationStarted || disposed || !scanTimer) return;
      clearTimeout(scanTimer);
      scanTimer = undefined;
      scheduleAutomationFromConfig();
    },
    async dispose() {
      disposed = true;
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = undefined;
      scanPaused = false;
      scanAbortController?.abort();
      resumePausedScan?.();
      resumePausedScan = undefined;
      await activeAutomation;
      await Promise.all(activeScans);
    }
  };
}

interface ManualImportMessage {
  messageId: string;
  conversationId: string;
  role: ConversationMessage["role"];
  content: string;
  createdAt: string;
  workspacePath?: string | null;
  gitRoot?: string | null;
  rawMeta?: Readonly<Record<string, unknown>>;
}

/**
 * The internal form of an import. The HTTP schema caps a page at 2000 messages
 * because the caller pages; a recipe-driven sync builds its own request and is
 * bounded by the recipe limits instead.
 */
interface ManualImportRequest {
  mode: ManualSourceImportInput["mode"];
  messages: readonly ManualImportMessage[];
  dataPath?: string;
  syncBoundaryAt?: string | null;
  latestSeenAt?: string | null;
  final: boolean;
}

/** Reports a recipe that cannot be read as a bad recipe, not a service fault. */
function readManagedHistory(sourceId: string, recipe: ManagedSyncRecipe): ConversationMessage[] {
  try {
    return extractManagedAgentHistory(sourceId, recipe);
  } catch (error) {
    if (error instanceof MemoryServiceError) throw error;
    throw new MemoryServiceError(
      "invalid_argument",
      `Manual Agent history could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function manualMessagesForIngestion(
  sourceId: string,
  messages: readonly ManualImportMessage[]
): ConversationMessage[] {
  return messages
    .map((message, index) => ({
      index,
      message: {
        messageId: message.messageId,
        sourceId,
        conversationId: message.conversationId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        workspacePath: message.workspacePath ?? null,
        gitRoot: message.gitRoot ?? null,
        rawMeta: message.rawMeta ?? {}
      } satisfies ConversationMessage
    }))
    .sort((left, right) =>
      left.message.conversationId.localeCompare(right.message.conversationId) ||
      Date.parse(left.message.createdAt) - Date.parse(right.message.createdAt) ||
      left.index - right.index
    )
    .map((entry) => entry.message);
}

/**
 * Writes one memory per complete turn, with the same turn identity the adapter
 * path uses, so a turn imported here is the same memory either way.
 */
async function ingestManualTurns(
  service: MemoryService,
  memorySource: string,
  messages: readonly ConversationMessage[],
  scheduleWorker?: () => void
): Promise<Omit<ManualSourceImportResult, "sourceId" | "syncBoundaryAt">> {
  const memoryIds: string[] = [];
  const errors: ManualSourceImportResult["errors"] = [];
  let written = 0;
  let deduped = 0;
  let failed = 0;
  for (const turn of manualTurns(messages)) {
    if (!isCompleteTurn(turn.messages)) {
      deduped += turn.messages.length;
      continue;
    }
    try {
      const added = service.addMemory({
        requestId: legacyTurnRequestId(turn),
        adapterId: `agent-source:${turn.sourceId}`,
        content: renderTurnClipped(turn.messages),
        layer: "L1",
        title: titleForTurn(memorySource, turn.messages),
        tags: ["agent-source", memorySource],
        source: memorySource,
        turnId: legacyTurnId(turn),
        createdAt: turn.messages[0]!.createdAt,
        deferProcessing: true
      });
      if (added.duplicate) {
        deduped += turn.messages.length;
      } else {
        written += turn.messages.length;
        memoryIds.push(added.id);
      }
    } catch (error) {
      failed += turn.messages.length;
      errors.push({
        conversationId: turn.conversationId,
        reason: error instanceof Error ? error.message : "manual Agent import failed"
      });
    }
  }
  if (memoryIds.length > 0) {
    service.enqueuePendingImportSummaries(INITIAL_SCAN_MESSAGE_LIMIT, memoryIds);
    scheduleWorker?.();
  }
  return { attempted: messages.length, written, deduped, failed, memoryIds, errors };
}

function* manualTurns(messages: readonly ConversationMessage[]): Generator<ImportedTurn> {
  let current: ConversationMessage[] = [];
  let conversationId = "";
  let turnIndex = 0;
  for (const message of messages) {
    if (message.conversationId !== conversationId) {
      if (current.length > 0) yield { sourceId: current[0]!.sourceId, conversationId, turnIndex, messages: current };
      current = [];
      conversationId = message.conversationId;
      turnIndex = 0;
    } else if (message.role === "user" && current.length > 0) {
      yield { sourceId: current[0]!.sourceId, conversationId, turnIndex, messages: current };
      turnIndex += 1;
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) yield { sourceId: current[0]!.sourceId, conversationId, turnIndex, messages: current };
}

function earliestCreatedAt(messages: readonly { createdAt: string }[]): string | null {
  return messages.reduce<string | null>((earliest, message) =>
    !earliest || Date.parse(message.createdAt) < Date.parse(earliest) ? message.createdAt : earliest, null);
}

function latestCreatedAt(messages: readonly { createdAt: string }[]): string | null {
  return messages.reduce<string | null>((latest, message) => maxIso(latest, message.createdAt), null);
}

function maxIso(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function findReusableScanJob(directory: string, sourceId: string, mode?: string): string | null {
  if (!existsSync(directory)) return null;
  let selected: { jobId: string; updatedAt: number } | null = null;
  for (const name of readdirSync(directory).filter((value) => value.endsWith(".sqlite"))) {
    const path = join(directory, name);
    try {
      const db = new Database(path, { readonly: true });
      const row = db.prepare("SELECT job_id AS jobId, source_id AS sourceId, mode, phase, updated_at AS updatedAt FROM scan_meta WHERE id=1").get() as { jobId: string; sourceId: string; mode?: string; phase: string; updatedAt: string } | undefined;
      db.close();
      if (row?.phase === "done") {
        const updatedAt = Date.parse(row.updatedAt);
        if (Number.isFinite(updatedAt) && Date.now() - updatedAt > COMPLETED_DETAILS_RETENTION_MS) {
          rmSync(path, { force: true });
          rmSync(`${path}-wal`, { force: true });
          rmSync(`${path}-shm`, { force: true });
        }
        continue;
      }
      if (row && row.sourceId === sourceId && (!mode || !row.mode || row.mode === mode)) {
        const updatedAt = Date.parse(row.updatedAt);
        if (!selected || updatedAt > selected.updatedAt) selected = { jobId: row.jobId, updatedAt };
      }
    } catch { /* leave corrupt stores for explicit diagnostics */ }
  }
  return selected?.jobId ?? null;
}

function sameScanRequest(
  left: ReturnType<typeof normalizeScanInput>,
  right: ReturnType<typeof normalizeScanInput>
): boolean {
  return left.sourceId === right.sourceId && (right.mode === undefined || left.mode === right.mode);
}

export function createBuiltinSourceRegistry(): SourceRegistry {
  return createSourceRegistry([
    createCursorSourceAdapter(),
    createClaudeCodeSourceAdapter(),
    createCodexSourceAdapter(),
    createOpencodeSourceAdapter(),
    createOpenclawSourceAdapter(),
    createHermesSourceAdapter(),
    createDeepseekHarnessSourceAdapter(),
    createWorkbuddySourceAdapter(),
    createPiSourceAdapter(),
    createQwenworkSourceAdapter()
  ]);
}

export function createBuiltinIntegrationRegistry(configPath: string): SkillTargetRegistry {
  return createSkillTargetRegistry([
    createCursorSkillTarget({ memmyConfigPath: configPath }),
    createClaudeCodeSkillTarget({ memmyConfigPath: configPath }),
    createCodexSkillTarget({ memmyConfigPath: configPath }),
    createOpencodeSkillTarget({ memmyConfigPath: configPath }),
    createOpenclawSkillTarget({ memmyConfigPath: configPath }),
    createHermesSkillTarget({ memmyConfigPath: configPath }),
    createDeepseekHarnessSkillTarget({ memmyConfigPath: configPath }),
    createWorkbuddySkillTarget(),
    createPiSkillTarget(),
    createQwenworkSkillTarget()
  ]);
}

interface StandaloneSourceStage {
  adapter: SourceAdapter;
  stored: PersistedSourceState;
  sourceId: string;
  mode: "initial_subset" | "incremental" | "full";
  staged: number;
  scanErrorCount: number;
  errors: string[];
}

async function stageStandaloneSource(
  adapter: SourceAdapter,
  stored: PersistedSourceState,
  mode: "initial_subset" | "incremental" | "full",
  store: MemoryAgentSourceScanStore,
  signal: AbortSignal,
  waitIfPaused: () => Promise<void>,
  onProgress: (progress: ScanProgress) => void
): Promise<StandaloneSourceStage> {
  const sourceId = adapter.descriptor.sourceId;
  const errors: string[] = [];
  let scanErrorCount = 0;
  const batch: ConversationMessage[] = [];
  let batchBytes = 0;
  let staged = 0;
  let emittedOrdinal = 0;
  store.saveSourceState({
    sourceId,
    mode,
    phase: "stage",
    messageCount: store.count(sourceId),
    resultCount: store.resultCount(sourceId),
    errorCount: 0,
    updatedAt: new Date().toISOString(),
    ...(stored.latestSeenAt ? { watermarkedSince: stored.latestSeenAt } : {})
  });
  try {
    for await (const message of adapter.scan({
      ...(mode === "incremental" && stored.latestSeenAt ? { since: stored.latestSeenAt } : {}),
      order: mode === "initial_subset" ? "recent_first" : "source_default",
      // Incremental scans must honor the persisted boundary. Full-history
      // streaming is only safe for an explicit full scan; otherwise the
      // adapter would stage every historical message in an active session.
      fullHistory: mode === "full",
      signal,
      onProgress
    })) {
      await waitIfPaused();
      signal.throwIfAborted();
      const normalizedMessage = message.sourceId === sourceId ? message : { ...message, sourceId };
      const bytes = Buffer.byteLength(JSON.stringify(normalizedMessage));
      if (bytes > 64 * 1024 * 1024) {
        const reason = "record exceeds 64 MiB";
        scanErrorCount += 1;
        if (errors.length < 1000) errors.push(`${sourceId}:${message.conversationId}: ${reason}`);
        store.saveResult({ sourceId, conversationId: message.conversationId, error: reason });
        continue;
      }
      if (batch.length > 0 && (batch.length >= 500 || batchBytes + bytes > 8 * 1024 * 1024)) {
        staged += store.stageBatch(batch);
        const last = batch[batch.length - 1]!;
        store.saveScanCursor(sourceId, { conversationId: last.conversationId, createdAt: last.createdAt, messageId: last.messageId, ordinal: last.ordinal ?? 0 });
        batch.length = 0;
        batchBytes = 0;
      }
      batch.push({ ...normalizedMessage, ordinal: emittedOrdinal++ });
      batchBytes += bytes;
      if (batch.length >= 500 || batchBytes >= 8 * 1024 * 1024) {
        staged += store.stageBatch(batch);
        const last = batch[batch.length - 1]!;
        store.saveScanCursor(sourceId, { conversationId: last.conversationId, createdAt: last.createdAt, messageId: last.messageId, ordinal: last.ordinal ?? 0 });
        batch.length = 0;
        batchBytes = 0;
      }
    }
    if (batch.length > 0) {
      staged += store.stageBatch(batch);
      const last = batch[batch.length - 1]!;
      store.saveScanCursor(sourceId, { conversationId: last.conversationId, createdAt: last.createdAt, messageId: last.messageId, ordinal: last.ordinal ?? 0 });
    }
  } catch (error) {
    if (signal.aborted) throw error;
    scanErrorCount += 1;
    const reason = error instanceof Error ? error.message : "Agent source scan failed";
    if (errors.length < 1000) errors.push(`${sourceId}: ${reason}`);
    store.saveResult({ sourceId, conversationId: "scan", error: reason });
  }
  store.saveSourceState({
    sourceId,
    mode,
    phase: scanErrorCount > 0 ? "failed" : "stage",
    messageCount: store.count(sourceId),
    resultCount: store.resultCount(sourceId),
    errorCount: scanErrorCount,
    updatedAt: new Date().toISOString(),
    ...(stored.latestSeenAt ? { watermarkedSince: stored.latestSeenAt } : {})
  });
  return { adapter, stored, sourceId, mode, staged, scanErrorCount, errors };
}

async function ingestStagedMessages(
  service: MemoryService,
  store: MemoryAgentSourceScanStore,
  sourceId: string,
  signal: AbortSignal,
  onProgress: (progress: ScanProgress) => void,
  scheduleWorker?: () => void
): Promise<{
  written: number;
  messageCount: number;
  skipped: number;
  conversationCount: number;
  errors: string[];
  errorCount: number;
  latestSeenAt: string | null;
}> {
  let written = 0;
  let messageCount = 0;
  let skipped = 0;
  let processed = 0;
  let latestSeenAt: string | null = null;
  const errors: string[] = [];
  let errorCount = 0;
  let activeConversationId: string | null = null;
  let activeConversationFailed = false;
  const commitConversation = () => {
    if (!activeConversationId || activeConversationFailed) return;
    const meta = store.getConversationMeta(sourceId, activeConversationId);
    if (!meta) return;
    const checkpoint = {
      sourceId,
      conversationId: activeConversationId,
      lastMessageId: meta.lastMessageId,
      lastCreatedAt: meta.lastCreatedAt,
      contentHash: meta.contentHash,
      updatedAt: new Date().toISOString()
    };
    store.saveCheckpoint(checkpoint);
  };
  const memoryIds: string[] = [];
  const flush = (force = false) => {
    if (memoryIds.length === 0 || (!force && memoryIds.length < 100)) return;
    service.enqueuePendingImportSummaries(INITIAL_SCAN_MESSAGE_LIMIT, memoryIds.splice(0));
    scheduleWorker?.();
  };
  const pages = (async function*() {
    let cursor: Parameters<ScanStore["messages"]>[1];
    while (true) {
      const page = readScanPage(store, sourceId, cursor);
      if (page.length === 0) break;
      for (const message of page) {
        yield message;
      }
      const last = page[page.length - 1]!;
      cursor = { conversationId: last.conversationId, createdAt: last.createdAt, messageId: last.messageId, ordinal: last.ordinal ?? 0 };
    }
  })();
  for await (const turn of orderedTurns(pages)) {
    signal.throwIfAborted();
    const turnLatest = turn.messages[turn.messages.length - 1]?.createdAt ?? null;
    if (turnLatest && (latestSeenAt === null || Date.parse(turnLatest) > Date.parse(latestSeenAt))) latestSeenAt = turnLatest;
    if (turn.conversationId !== activeConversationId) {
      commitConversation();
      activeConversationId = turn.conversationId;
      activeConversationFailed = false;
    }
    const conversationMeta = store.getConversationMeta(sourceId, turn.conversationId);
    if (conversationMeta?.selected === false) {
      skipped += turn.messages.length;
      continue;
    }
    const selectedTurn = store.getTurnMeta(sourceId, turn.conversationId, stableTurnIdentity(turn));
    if (selectedTurn && !selectedTurn.selected) {
      skipped += turn.messages.length;
      continue;
    }
    let succeeded = true;
    // One turn is one memory. Splitting an agentic turn fans a single exchange
    // out into hundreds of near-empty tool-call fragments, so an oversized turn
    // is clipped to the wire budget instead of being fanned out.
    try {
      const added = service.addMemory({
        requestId: legacyTurnRequestId(turn), adapterId: `agent-source:${sourceId}`,
        content: renderTurnClipped(turn.messages), layer: "L1",
        title: titleForTurn(sourceId, turn.messages), tags: ["agent-source", sourceId], source: sourceId,
        turnId: legacyTurnId(turn), createdAt: turn.messages[0]!.createdAt, deferProcessing: true
      });
      store.saveResult({ sourceId, conversationId: turn.conversationId, memoryId: added.id });
      if (added.duplicate) skipped += turn.messages.length;
      else { memoryIds.push(added.id); written += 1; }
    } catch (error) {
      succeeded = false;
      activeConversationFailed = true;
      const reason = error instanceof Error ? error.message : String(error);
      errorCount += 1;
      if (errors.length < 1000) errors.push(`${turn.conversationId}: ${reason}`);
      store.saveResult({ sourceId, conversationId: turn.conversationId, error: reason });
    }
    if (succeeded) {
      messageCount += turn.messages.length;
      flush();
    }
    processed += turn.messages.length;
    onProgress({ sourceId, phase: "add", current: processed, total: store.count(sourceId), message: "Adding raw memories" });
  }
  flush(true);
  commitConversation();
  return {
    written,
    messageCount,
    skipped,
    conversationCount: store.conversationCount(sourceId),
    errors,
    errorCount,
    latestSeenAt
  };
}

async function prepareStandaloneSource(
  store: MemoryAgentSourceScanStore,
  sourceId: string,
  mode: "initial_subset" | "incremental" | "full",
  latestSeenAt: string | null,
  hasCheckpoints: boolean,
  previousContentHash?: string
): Promise<string> {
  let cursor: Parameters<ScanStore["messages"]>[1];
  let currentConversation: string | null = null;
  let currentTurn: ConversationMessage[] = [];
  let hash = createHash("sha256");
  let first = true;
  let latest: ConversationMessage | null = null;
  const sourceHash = createHash("sha256");
  sourceHash.update("[");
  let firstSourceMessage = true;
  let checkpoint: ConversationCheckpoint | null = null;
  const flushTurn = () => {
    if (!currentTurn.length || !isCompleteTurn(currentTurn)) return;
    const firstMessage = currentTurn[0]!;
    const lastMessage = currentTurn[currentTurn.length - 1]!;
    const turn = { sourceId, conversationId: firstMessage.conversationId, turnIndex: 0, messages: currentTurn };
    store.saveTurnMeta({
      sourceId,
      conversationId: firstMessage.conversationId,
      turnId: stableTurnIdentity(turn),
      firstMessageId: firstMessage.messageId,
      firstCreatedAt: firstMessage.createdAt,
      lastMessageId: lastMessage.messageId,
      lastCreatedAt: lastMessage.createdAt,
      // A conversation may contain years of history but only one new turn.
      // Select turns at the watermark, not every turn in that conversation.
      //
      // A checkpoint means everything up to it was committed, so comparing
      // against it is strict. The watermark fallback has to include equality,
      // because it is a max over turns that were imported and would otherwise
      // drop a turn that shares its timestamp; that is why the turn sitting on
      // the watermark used to be rewritten by every incremental run.
      selected: mode !== "incremental" ? true
        : checkpoint ? Date.parse(lastMessage.createdAt) > Date.parse(checkpoint.lastCreatedAt)
        : !latestSeenAt || isAtOrAfter(lastMessage.createdAt, latestSeenAt)
    });
  };
  const flushConversation = () => {
    if (!currentConversation || !latest) return;
    hash.update("]");
    const contentHash = hash.digest("hex");
    const selected = mode !== "incremental" ? true
      : checkpoint ? checkpoint.contentHash !== contentHash
      : !latestSeenAt || isAtOrAfter(latest.createdAt, latestSeenAt);
    store.saveConversationMeta({
      sourceId,
      conversationId: currentConversation,
      lastMessageId: latest.messageId,
      lastCreatedAt: latest.createdAt,
      contentHash,
      selected
    });
  };
  while (true) {
    const page = readScanPage(store, sourceId, cursor);
    if (page.length === 0) break;
    for (const message of page) {
      if (message.conversationId !== currentConversation) {
        flushTurn();
        flushConversation();
        currentConversation = message.conversationId;
        checkpoint = store.getCheckpoint(sourceId, message.conversationId);
        currentTurn = [];
        hash = createHash("sha256");
        hash.update("[");
        first = true;
      }
      if (message.role === "user" && currentTurn.length > 0) {
        flushTurn();
        currentTurn = [];
      }
      currentTurn.push(message);
      if (!first) hash.update(",");
      first = false;
      const hashable = {
        messageId: message.messageId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        toolName: hashMeta(message, "toolName") ?? hashMeta(message, "hermesToolName"),
        toolCallId: hashMeta(message, "toolCallId") ?? hashMeta(message, "hermesToolCallId")
      };
      const serialized = JSON.stringify(hashable);
      if (!firstSourceMessage) sourceHash.update(",");
      firstSourceMessage = false;
      sourceHash.update(serialized);
      hash.update(serialized);
      latest = message;
    }
    const last = page[page.length - 1]!;
    cursor = { conversationId: last.conversationId, createdAt: last.createdAt, messageId: last.messageId, ordinal: last.ordinal ?? 0 };
  }
  flushTurn();
  flushConversation();
  sourceHash.update("]");
  const contentHash = sourceHash.digest("hex");
  // Before checkpoints existed, a changed source could only be handled by
  // reconsidering every conversation. Once a source has checkpoints, the
  // per-conversation hashes say precisely which ones changed.
  if (mode === "incremental" && previousContentHash !== contentHash && !hasCheckpoints) {
    store.selectAllConversations(sourceId);
  }
  return contentHash;
}

function committedCheckpoints(
  store: MemoryAgentSourceScanStore,
  sourceId: string
): Record<string, PersistedCheckpoint> {
  return Object.fromEntries(store.listCheckpoints(sourceId).map((checkpoint) => [
    checkpoint.conversationId,
    {
      lastMessageId: checkpoint.lastMessageId,
      lastCreatedAt: checkpoint.lastCreatedAt,
      contentHash: checkpoint.contentHash,
      updatedAt: checkpoint.updatedAt
    } satisfies PersistedCheckpoint
  ]));
}

function isAtOrAfter(value: string, boundary: string): boolean {
  const valueAt = Date.parse(value);
  const boundaryAt = Date.parse(boundary);
  return !Number.isFinite(valueAt) || !Number.isFinite(boundaryAt) || valueAt >= boundaryAt;
}

function hashMeta(message: ConversationMessage, key: string): string | undefined {
  const value = message.rawMeta[key];
  return typeof value === "string" ? value : undefined;
}

function readScanPage(store: MemoryAgentSourceScanStore, sourceId: string, cursor?: { conversationId: string; createdAt: string; messageId: string; ordinal: number }): ConversationMessage[] {
  const page: ConversationMessage[] = [];
  let bytes = 0;
  for (const message of store.messages(sourceId, cursor, 500)) {
    page.push(message);
    bytes += Buffer.byteLength(JSON.stringify(message));
    if (page.length >= 500 || bytes >= 8 * 1024 * 1024) break;
  }
  return page;
}

async function ingestAgentSkills(
  service: MemoryService,
  sourceId: string,
  store: MemoryAgentSourceScanStore,
  resolveAgentSkillRoot: (sourceId: string) => string | null = agentRootDirectory,
  scheduleWorker?: () => void
): Promise<{ written: number; memoryIdCount: number; errorCount: number; errors: string[] }> {
  const root = resolveAgentSkillRoot(sourceId);
  if (!root) return { written: 0, memoryIdCount: 0, errorCount: 0, errors: [] };
  const skillsRoot = join(root, "skills");
  const errors: string[] = [];
  let written = 0;
  let memoryIdCount = 0;
  let errorCount = 0;
  const pendingIds: string[] = [];
  const flush = (force = false) => {
    if (pendingIds.length === 0 || (!force && pendingIds.length < 100)) return;
    service.enqueuePendingImportSummaries(INITIAL_SCAN_MESSAGE_LIMIT, pendingIds.splice(0));
    scheduleWorker?.();
  };
  for await (const filePath of findSkillFiles(skillsRoot)) {
    const content = await readFile(filePath, "utf8");
    const contentHash = createHash("sha256").update(content).digest("hex");
    const sourceSkillId = relative(skillsRoot, dirname(filePath)).replaceAll("\\", "/");
    const requestId = `agent-source-skill:${sourceId}:${sourceSkillId}:${contentHash}`;
    const fileStat = await stat(filePath);
    try {
      const added = service.addMemory({
        requestId,
        adapterId: `agent-source:${sourceId}`,
        content,
        layer: "Skill",
        title: frontmatterValue(content, "name") ?? sourceSkillId,
        tags: ["agent-source", "cross-agent-skill", sourceId],
        source: sourceId,
        turnId: `skill:${sourceSkillId}:${contentHash}`,
        createdAt: fileStat.mtime.toISOString(),
        sourceAgentId: sourceId,
        sourceSkillId,
        sourceSkillPath: filePath,
        sourceSkillVersion: frontmatterValue(content, "version") ?? contentHash,
        sourceContentHash: contentHash,
        deferProcessing: true
      });
      written += 1;
      memoryIdCount += 1;
      store.saveResult({ sourceId, conversationId: `skill:${sourceSkillId}`, memoryId: added.id });
      if (!added.duplicate) {
        pendingIds.push(added.id);
        flush();
      }
    } catch (error) {
      const reason = `skill ${sourceSkillId}: ${error instanceof Error ? error.message : String(error)}`;
      errorCount += 1;
      if (errors.length < 1000) errors.push(reason);
      store.saveResult({ sourceId, conversationId: `skill:${sourceSkillId}`, error: reason });
    }
  }
  flush(true);
  return { written, memoryIdCount, errorCount, errors };
}

async function* findSkillFiles(root: string): AsyncGenerator<string> {
  yield* visit(root, 0);

  async function* visit(directory: string, depth: number): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === "memmy-memory" || entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === "skill.md") yield path;
      else if (depth < 2 && entry.isDirectory()) yield* visit(path, depth + 1);
    }
  }
}

function agentRootDirectory(sourceId: string): string | null {
  switch (sourceId) {
    case "cursor": return join(homedir(), ".cursor");
    case "claude_code": return resolveClaudeCodeHomeDirectory();
    case "codex": return resolveCodexHomeDirectory();
    case "opencode": return resolveOpencodeConfigDirectory();
    case "openclaw": return resolveOpenclawStateDirectory();
    case "hermes": return resolveHermesHomeDirectory();
    case "deepseek_harness": return resolveDeepseekHarnessHomeDirectory();
    case "workbuddy": return resolveWorkbuddyHomeDirectory();
    case "pi": return resolvePiAgentDirectory();
    case "qwenwork": return resolveQwenworkHomeDirectory();
    default: return null;
  }
}

function frontmatterValue(content: string, key: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return undefined;
  return content.slice(3, end)
    .match(new RegExp(`^${key}:\\s*["']?([^\\n"']+)["']?\\s*$`, "im"))?.[1]
    ?.trim();
}

function titleForTurn(sourceId: string, messages: readonly ConversationMessage[]): string {
  const firstLine = messages[0]?.content.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  const title = firstLine || `${sourceId} conversation`;
  return title.length <= 120 ? title : `${title.slice(0, 117)}...`;
}

function normalizeScanInput(value: unknown): {
  sourceId: string;
  mode?: "initial_subset" | "incremental" | "full";
  origin: AgentSourceScanOrigin;
} {
  const input = record(value);
  const sourceId = typeof input.sourceId === "string" && input.sourceId.trim() ? input.sourceId.trim() : "all";
  const mode = input.mode === "initial_subset" || input.mode === "incremental" || input.mode === "full"
    ? input.mode
    : undefined;
  const origin = input.origin === "app" || input.origin === "cli" || input.origin === "automation"
    ? input.origin
    : "viewer";
  return { sourceId, origin, ...(mode ? { mode } : {}) };
}

function emptyScanState(): AgentSourceScanState {
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

function emptySourceState(): PersistedSourceState {
  return {
    status: "not_connected",
    messageCount: 0,
    lastScannedAt: null,
    latestSeenAt: null,
    baselineAt: null,
    checkpoints: {}
  };
}

async function loadState(path: string): Promise<PersistedState> {
  try {
    const parsed = JSON.parse(await readStateWithoutLegacyIds(path)) as unknown;
    const value = record(parsed);
    const sourceValues = record(value.sources);
    const hasLegacyIds = Object.values(sourceValues).some((raw) => Object.hasOwn(record(raw), "importedRequestIds"));
    const sources = Object.fromEntries(Object.entries(sourceValues).map(([sourceId, raw]) => {
      const source = record(raw);
      const status = source.status === "skill_installed" || source.status === "plugin_installed" ? source.status : "not_connected";
      const lastScannedAt = readIso(source.lastScannedAt);
      const latestSeenAt = readIso(source.latestSeenAt);
      return [sourceId, {
        status,
        messageCount: typeof source.messageCount === "number" && Number.isFinite(source.messageCount) ? Math.max(0, Math.floor(source.messageCount)) : 0,
        lastScannedAt,
        latestSeenAt,
        // A source scanned before boundaries were recorded gets its watermark
        // as the boundary, so the max() in later merges is a no-op instead of
        // dragging the cursor forward to today and skipping history.
        baselineAt: readIso(source.baselineAt) ?? (lastScannedAt ? latestSeenAt : null),
        checkpoints: readCheckpoints(source.checkpoints),
        ...(typeof source.contentHash === "string" ? { contentHash: source.contentHash } : {})
      } satisfies PersistedSourceState];
    }));
    const state: PersistedState = {
      version: 3,
      sources,
      manual: readManualSources(value.manual)
    };
    if (value.version !== 3 || hasLegacyIds) await writeState(path, state);
    return state;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { version: 3, sources: {}, manual: {} };
    throw error;
  }
}

/**
 * An unparsable timestamp must not survive a load. `isAtOrAfter` and the
 * adapters treat a boundary they cannot parse as "no boundary", which lets a
 * whole history through; dropping it falls back to the bounded first scan.
 */
function readIso(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function readCheckpoints(value: unknown): Record<string, PersistedCheckpoint> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([conversationId, raw]) => {
    const checkpoint = record(raw);
    const lastCreatedAt = readIso(checkpoint.lastCreatedAt);
    if (!lastCreatedAt
      || typeof checkpoint.lastMessageId !== "string"
      || typeof checkpoint.contentHash !== "string") return [];
    return [[conversationId, {
      lastMessageId: checkpoint.lastMessageId,
      lastCreatedAt,
      contentHash: checkpoint.contentHash,
      updatedAt: readIso(checkpoint.updatedAt) ?? lastCreatedAt
    } satisfies PersistedCheckpoint]];
  }));
}

/**
 * A recipe that no longer parses costs that one source its sync, which the
 * viewer shows as "not ready". Refusing to load the whole file would cost
 * every source instead.
 */
function readManualSources(value: unknown): Record<string, PersistedManualSource> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([sourceId, raw]) => {
    const source = record(raw);
    const displayName = typeof source.displayName === "string" ? source.displayName.trim() : "";
    if (!displayName) return [];
    const recipe = ManagedSyncRecipeSchema.safeParse(source.syncRecipe);
    return [[sourceId, {
      displayName,
      dataPath: typeof source.dataPath === "string" && source.dataPath.trim()
        ? source.dataPath
        : MANUAL_SOURCE_DISCOVERY_PENDING_DATA_PATH,
      syncRecipe: recipe.success ? recipe.data : null,
      baselineAt: typeof source.baselineAt === "string" ? source.baselineAt : null,
      createdAt: typeof source.createdAt === "string" ? source.createdAt : new Date(0).toISOString()
    } satisfies PersistedManualSource]];
  }));
}

/** Streams legacy state while replacing the unbounded ID arrays with empty arrays. */
async function readStateWithoutLegacyIds(path: string): Promise<string> {
  const temporaryPath = `${path}.v2-migration-${process.pid}-${Date.now()}-${randomUUID()}`;
  const input = createReadStream(path, { encoding: "utf8" });
  await new Promise<void>((resolve, reject) => {
    input.once("open", () => resolve());
    input.once("error", reject);
  });
  const output = createWriteStream(temporaryPath, { encoding: "utf8" });
  let inString = false;
  let escaped = false;
  let pendingLegacyArray = false;
  let skipDepth = 0;
  let skipString = false;
  let skipEscaped = false;
  let keyBuffer = "";
  try {
    for await (const chunk of input) {
      const text = String(chunk);
      let emitted = "";
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]!;
        if (skipDepth > 0) {
          if (skipString) {
            if (skipEscaped) skipEscaped = false;
            else if (char === "\\") skipEscaped = true;
            else if (char === '"') skipString = false;
          } else if (char === '"') skipString = true;
          else if (char === "[") skipDepth += 1;
          else if (char === "]") skipDepth -= 1;
          continue;
        }
        if (inString) {
          emitted += char;
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') { inString = false; keyBuffer += char; }
          else if (keyBuffer.length < 32) keyBuffer += char;
          continue;
        }
        if (char === '"') {
          inString = true;
          keyBuffer = '"';
          emitted += char;
          continue;
        }
        if (pendingLegacyArray) {
          emitted += char;
          if (/\s/u.test(char)) continue;
          if (char === "[") {
            emitted = emitted.slice(0, -1) + "[]";
            pendingLegacyArray = false;
            skipDepth = 1;
            skipString = false;
            skipEscaped = false;
          } else {
            pendingLegacyArray = false;
          }
          continue;
        }
        emitted += char;
        if (char === ":" && keyBuffer === '"importedRequestIds"') pendingLegacyArray = true;
        if (!/\s/u.test(char)) keyBuffer = "";
      }
      if (emitted && !output.write(emitted)) await once(output, "drain");
    }
    output.end();
    await once(output, "close");
    return await readFile(temporaryPath, "utf8");
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function writeState(path: string, state: PersistedState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function connectionStatus(sourceId: string): AgentConnectionStatus {
  return agentConnectionKind(sourceId) === "plugin" ? "plugin_installed" : "skill_installed";
}

function agentConnectionKind(sourceId: string): "plugin" | "skill" {
  return ["cursor", "claude_code", "codex", "opencode", "openclaw", "hermes", "deepseek_harness"].includes(sourceId)
    ? "plugin"
    : "skill";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
