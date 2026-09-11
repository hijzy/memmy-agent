import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import YAML from "yaml";
import {
  mutateRuntimeConfig,
  mutateRuntimeConfigLockHeld,
  type RuntimeConfigDocument,
} from "../../runtime-config-writer.js";
import {
  MigrationError,
  type AgentWorkspaceMigrationContext,
  type MigrationDefinition,
  type MigrationResult,
} from "../../types.js";

const MIGRATION_ID = "v1.1.5/0001-move-agent-source-scan-state-to-memory-service";

/**
 * Cross-Agent scanning moves from the Desktop backend to the memory service in
 * this release. Both sides already derive the same turn id, so a turn imported
 * by the Desktop is not duplicated by the service — but it is rewritten: the
 * upsert reactivates a memory the user archived, resets the summary to a
 * placeholder, and changes the content hash, which drops the vectors and
 * re-queues summarization. For a user with years of history that is thousands
 * of memories and a large summarization bill.
 *
 * So the boundaries have to come along. The Desktop tables are only read, never
 * dropped: rolling back means installing the old version, which resumes from
 * its own rows.
 */
const SCAN_SCOPE_UUID = "local-agent-sources";

/** The switches the memory service reads to decide whether to scan at all. */
const SCAN_SWITCHES = ["autoScanKnownAgents", "watchFileChanges", "autoInjectSkill"] as const;

type ScanSwitch = (typeof SCAN_SWITCHES)[number];

type LegacySource = {
  sourceId: string;
  displayName: string;
  dataPath: string;
  builtin: boolean;
  status: string;
  lastScannedAt: string | null;
  syncRecipe: unknown;
  createdAt: string | null;
  baselineAt: string | null;
  latestSeenAt: string | null;
  checkpoints: Record<string, LegacyCheckpoint>;
};

type LegacyCheckpoint = {
  lastMessageId: string;
  lastCreatedAt: string;
  contentHash: string;
  updatedAt: string;
};

type LegacyScanState = {
  sources: LegacySource[];
  scanPermission: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wrapError(error: unknown): MigrationError {
  if (error instanceof MigrationError) return error;
  return new MigrationError("migration_io_failed", "Agent source scan state could not be moved to the memory service", {
    migrationId: MIGRATION_ID,
    scope: "runtime-config",
    cause: error,
  });
}

/**
 * Every boundary is written as an ISO string. Both the adapter filter and the
 * turn filter read a timestamp they cannot parse as "no boundary" and let the
 * entire history through, so a value that does not parse must not survive.
 */
function toIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function maxIso(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw wrapError(error);
  }
}

/**
 * The memory service loads this file into memory once and from then on only
 * writes it, so writing underneath a running service would be overwritten by
 * its next persist. Memmy Desktop runs migrations before it spawns anything;
 * only a service the user started separately hits this, and it can wait for
 * the next startup.
 */
async function memoryServiceIsRunning(runtimeConfigFile: string): Promise<boolean> {
  let sqlitePath: string | null = null;
  try {
    const document = YAML.parse(await fs.readFile(runtimeConfigFile, "utf8")) as unknown;
    const memory = isObject(document) && isObject(document.memmyMemory) ? document.memmyMemory : {};
    const storage = isObject(memory.storage) ? memory.storage : {};
    if (typeof storage.sqlitePath === "string" && storage.sqlitePath.trim()) {
      sqlitePath = path.resolve(storage.sqlitePath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
  }
  if (!sqlitePath) return false;
  try {
    const lock = JSON.parse(await fs.readFile(`${sqlitePath}.server.lock`, "utf8")) as Record<string, unknown>;
    const pid = lock.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but belongs to someone else.
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  } catch {
    return false;
  }
}

function readLegacyScanState(databaseFile: string): LegacyScanState | null {
  const db = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    if (!tables.has("account_agent_sources")) return null;
    const rows = db
      .prepare(
        `SELECT source_id, display_name, data_path, builtin, status, last_scanned_at, sync_recipe_json, created_at
         FROM account_agent_sources WHERE uuid = ?`,
      )
      .all(SCAN_SCOPE_UUID) as Array<Record<string, unknown>>;
    const watermarks = tables.has("account_agent_source_watermarks")
      ? db
          .prepare(
            `SELECT source_id, baseline_at, latest_seen_created_at
             FROM account_agent_source_watermarks WHERE uuid = ?`,
          )
          .all(SCAN_SCOPE_UUID) as Array<Record<string, unknown>>
      : [];
    const checkpoints = tables.has("account_agent_source_conversation_checkpoints")
      ? db
          .prepare(
            `SELECT source_id, conversation_id, last_message_id, last_created_at, content_hash, updated_at
             FROM account_agent_source_conversation_checkpoints WHERE uuid = ?`,
          )
          .all(SCAN_SCOPE_UUID) as Array<Record<string, unknown>>
      : [];
    const watermarkBySource = new Map(watermarks.map((row) => [String(row.source_id), row]));
    const checkpointsBySource = new Map<string, Record<string, LegacyCheckpoint>>();
    for (const row of checkpoints) {
      const lastCreatedAt = toIso(row.last_created_at);
      if (!lastCreatedAt || typeof row.last_message_id !== "string" || typeof row.content_hash !== "string") continue;
      const sourceId = String(row.source_id);
      const forSource = checkpointsBySource.get(sourceId) ?? {};
      forSource[String(row.conversation_id)] = {
        lastMessageId: row.last_message_id,
        lastCreatedAt,
        contentHash: row.content_hash,
        updatedAt: toIso(row.updated_at) ?? lastCreatedAt,
      };
      checkpointsBySource.set(sourceId, forSource);
    }
    return {
      scanPermission: readScanPermission(db, tables),
      sources: rows.map((row) => {
        const sourceId = String(row.source_id);
        const watermark = watermarkBySource.get(sourceId);
        return {
          sourceId,
          displayName: typeof row.display_name === "string" ? row.display_name : sourceId,
          dataPath: typeof row.data_path === "string" ? row.data_path : "",
          builtin: row.builtin === 1,
          status: typeof row.status === "string" ? row.status : "not_connected",
          lastScannedAt: toIso(row.last_scanned_at),
          syncRecipe: parseSyncRecipe(row.sync_recipe_json),
          createdAt: toIso(row.created_at),
          baselineAt: toIso(watermark?.baseline_at),
          latestSeenAt: toIso(watermark?.latest_seen_created_at),
          checkpoints: checkpointsBySource.get(sourceId) ?? {},
        };
      }),
    };
  } finally {
    db.close();
  }
}

function readScanPermission(db: Database.Database, tables: Set<string>): string {
  if (!tables.has("account_onboarding_state")) return "unset";
  const row = db
    .prepare("SELECT scan_permission FROM account_onboarding_state WHERE uuid = ? LIMIT 1")
    .get(SCAN_SCOPE_UUID) as { scan_permission?: unknown } | undefined;
  return typeof row?.scan_permission === "string" ? row.scan_permission : "unset";
}

/**
 * A recipe the memory service cannot parse costs that one source its sync, and
 * it re-validates the shape on load anyway. Passing the stored object through
 * keeps this migration out of the business of knowing recipe versions.
 */
function parseSyncRecipe(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readServiceState(statePath: string): Promise<Record<string, unknown>> {
  let source: string;
  try {
    source = await fs.readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw wrapError(error);
  }
  // Overwriting a state file we could not read would throw away the boundaries
  // it holds, which is the mass rewrite this migration exists to prevent. The
  // service refuses to start on an unparsable file too, so fail and retry.
  const parsed = JSON.parse(source) as unknown;
  return isObject(parsed) ? parsed : {};
}

function mergeSource(existing: unknown, legacy: LegacySource): Record<string, unknown> {
  const current = isObject(existing) ? existing : {};
  const currentLatestSeenAt = toIso(current.latestSeenAt);
  // The Desktop's own cursor is max(latest_seen, baseline): for a source that
  // was already idle when it was first scanned, latest_seen predates the
  // baseline, and carrying only the former would pull the boundary backwards.
  const latestSeenAt = maxIso(maxIso(currentLatestSeenAt, legacy.latestSeenAt), legacy.baselineAt);
  return {
    ...current,
    status: current.status === "skill_installed" || current.status === "plugin_installed"
      ? current.status
      : legacy.status,
    messageCount: typeof current.messageCount === "number" ? current.messageCount : 0,
    // Without this the service treats the source as never scanned and runs a
    // bounded first scan, which is exactly the mass rewrite to avoid.
    lastScannedAt: maxIso(toIso(current.lastScannedAt), legacy.lastScannedAt),
    latestSeenAt,
    baselineAt: toIso(current.baselineAt) ?? legacy.baselineAt ?? latestSeenAt,
    checkpoints: mergeCheckpoints(current.checkpoints, legacy.checkpoints),
  };
}

/** The further-advanced boundary wins, for the same reason the watermark takes a max. */
function mergeCheckpoints(
  existing: unknown,
  legacy: Record<string, LegacyCheckpoint>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = isObject(existing) ? { ...existing } : {};
  for (const [conversationId, checkpoint] of Object.entries(legacy)) {
    const current = merged[conversationId];
    const currentAt = isObject(current) ? toIso(current.lastCreatedAt) : null;
    if (currentAt && Date.parse(currentAt) >= Date.parse(checkpoint.lastCreatedAt)) continue;
    merged[conversationId] = checkpoint;
  }
  return merged;
}

function mergeManualSource(existing: unknown, legacy: LegacySource): Record<string, unknown> {
  const current = isObject(existing) ? existing : {};
  return {
    ...current,
    displayName: legacy.displayName,
    dataPath: typeof current.dataPath === "string" && current.dataPath ? current.dataPath : legacy.dataPath,
    syncRecipe: current.syncRecipe ?? legacy.syncRecipe,
    baselineAt: toIso(current.baselineAt) ?? legacy.baselineAt,
    createdAt: toIso(current.createdAt) ?? legacy.createdAt ?? new Date().toISOString(),
  };
}

async function writeServiceState(statePath: string, state: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, statePath);
}

/**
 * The Desktop used to refuse scan requests with a 403 when the onboarding
 * answer did not allow scanning. That gate disappears with the routes, so the
 * answer has to survive as the switches themselves — a user who answered "no"
 * must not be scanned by a service that only reads the YAML.
 */
function projectScanPermission(config: RuntimeConfigDocument, permission: string): void {
  const memory = isObject(config.memmyMemory) ? config.memmyMemory : {};
  const agentAccess = isObject(memory.agentAccess) ? memory.agentAccess : {};
  const allowed: Record<ScanSwitch, boolean> = {
    autoScanKnownAgents: permission === "scan_only" || permission === "scan_and_write_skill",
    watchFileChanges: permission === "scan_only" || permission === "scan_and_write_skill",
    autoInjectSkill: permission === "scan_and_write_skill",
  };
  for (const key of SCAN_SWITCHES) {
    // A switch the YAML never recorded stays unrecorded; the Desktop fills the
    // missing ones with false before it starts the service.
    if (typeof agentAccess[key] !== "boolean") continue;
    agentAccess[key] = agentAccess[key] === true && allowed[key];
  }
  config.memmyMemory = { ...memory, agentAccess };
}

async function migrate(context: AgentWorkspaceMigrationContext): Promise<MigrationResult> {
  const databaseFile = context.appDatabaseFile;
  if (!databaseFile || !(await fileExists(databaseFile))) {
    return { scanned: 0, changed: 0, ignored: 0, deferred: true };
  }
  try {
    if (await memoryServiceIsRunning(context.runtimeConfigFile)) {
      context.logger.info("agent_source_state_migration_deferred", { reason: "memory_service_running" });
      return { scanned: 0, changed: 0, ignored: 0, deferred: true };
    }
    const legacy = readLegacyScanState(databaseFile);
    if (!legacy || legacy.sources.length === 0) {
      return { scanned: 0, changed: 0, ignored: 1 };
    }
    const statePath = path.join(path.dirname(context.runtimeConfigFile), "memory-service", "agent-sources.json");
    const state = await readServiceState(statePath);
    const sources = isObject(state.sources) ? { ...state.sources } : {};
    const manual = isObject(state.manual) ? { ...state.manual } : {};
    for (const source of legacy.sources) {
      sources[source.sourceId] = mergeSource(sources[source.sourceId], source);
      if (!source.builtin) manual[source.sourceId] = mergeManualSource(manual[source.sourceId], source);
    }
    await writeServiceState(statePath, { ...state, version: 3, sources, manual });
    const mutator = (config: RuntimeConfigDocument): void => projectScanPermission(config, legacy.scanPermission);
    await (context.runtimeConfigLock
      ? mutateRuntimeConfigLockHeld(context.runtimeConfigLock, mutator)
      : mutateRuntimeConfig(context.runtimeConfigFile, mutator));
    context.logger.info("agent_source_state_migrated", {
      sources: legacy.sources.length,
      scanPermission: legacy.scanPermission,
    });
    return { scanned: legacy.sources.length, changed: legacy.sources.length, ignored: 0 };
  } catch (error) {
    throw wrapError(error);
  }
}

export const moveAgentSourceScanStateToMemoryServiceV115: MigrationDefinition = {
  id: MIGRATION_ID,
  introducedIn: "1.1.5",
  scope: "runtime-config",
  description: "Move cross-Agent scan boundaries and manual sources from the Desktop database into the memory service",
  requiredTargets: ["appDatabaseFile"],
  up: migrate,
};

export function moveAgentSourceScanStateToMemoryServiceForTest(
  context: AgentWorkspaceMigrationContext,
): Promise<MigrationResult> {
  return migrate(context);
}
