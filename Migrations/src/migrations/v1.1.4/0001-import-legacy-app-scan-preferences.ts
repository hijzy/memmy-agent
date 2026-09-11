import fs from "node:fs/promises";
import Database from "better-sqlite3";
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

const MIGRATION_ID = "v1.1.4/0001-import-legacy-app-scan-preferences";

/**
 * Before v1.1.2 the three cross-Agent scan switches lived in Memmy Desktop's
 * `app_settings` row. Since then the memory service owns them as
 * `memmyMemory.agentAccess`, and up to v1.1.3 the Desktop backend re-seeded
 * that section from the row on every startup. The seed is gone (the Desktop
 * no longer writes memory-service config); this migration carries the row
 * over exactly once for installs that skipped v1.1.2 and v1.1.3. A switch that
 * is already present in the YAML was written by a newer surface and wins.
 */
const SWITCH_COLUMNS = {
  autoScanKnownAgents: "auto_scan_known_agents",
  watchFileChanges: "watch_file_changes",
  autoInjectSkill: "auto_inject_skill",
} as const;

type SwitchKey = keyof typeof SWITCH_COLUMNS;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wrapError(error: unknown): MigrationError {
  if (error instanceof MigrationError) return error;
  return new MigrationError("migration_io_failed", "Legacy Desktop scan preferences could not be imported", {
    migrationId: MIGRATION_ID,
    scope: "runtime-config",
    cause: error,
  });
}

async function databaseExists(databaseFile: string): Promise<boolean> {
  try {
    return (await fs.stat(databaseFile)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw wrapError(error);
  }
}

function readLegacyScanPreferences(databaseFile: string): Record<SwitchKey, boolean> | null {
  const db = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'")
      .get();
    if (!hasTable) return null;
    const columns = new Set(
      (db.prepare("PRAGMA table_info(app_settings)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!Object.values(SWITCH_COLUMNS).every((column) => columns.has(column))) return null;
    const row = db
      .prepare(
        "SELECT auto_scan_known_agents, watch_file_changes, auto_inject_skill FROM app_settings WHERE id = 'default' LIMIT 1",
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      autoScanKnownAgents: row.auto_scan_known_agents === 1,
      watchFileChanges: row.watch_file_changes === 1,
      autoInjectSkill: row.auto_inject_skill === 1,
    };
  } finally {
    db.close();
  }
}

async function migrate(context: AgentWorkspaceMigrationContext): Promise<MigrationResult> {
  const databaseFile = context.appDatabaseFile;
  if (!databaseFile || !(await databaseExists(databaseFile))) {
    return { scanned: 0, changed: 0, ignored: 0, deferred: true };
  }
  try {
    let scanned = 0;
    const mutator = (config: RuntimeConfigDocument): void => {
      const memory = isObject(config.memmyMemory) ? config.memmyMemory : {};
      const agentAccess = isObject(memory.agentAccess) ? memory.agentAccess : {};
      const missing = (Object.keys(SWITCH_COLUMNS) as SwitchKey[])
        .filter((key) => typeof agentAccess[key] !== "boolean");
      if (missing.length === 0) return;
      scanned = 1;
      const legacy = readLegacyScanPreferences(databaseFile);
      if (!legacy) return;
      for (const key of missing) agentAccess[key] = legacy[key];
      config.memmyMemory = { ...memory, agentAccess };
    };
    const result = context.runtimeConfigLock
      ? await mutateRuntimeConfigLockHeld(context.runtimeConfigLock, mutator)
      : await mutateRuntimeConfig(context.runtimeConfigFile, mutator);
    return result.changed
      ? { scanned: 1, changed: 1, ignored: 0 }
      : { scanned, changed: 0, ignored: 1 };
  } catch (error) {
    throw wrapError(error);
  }
}

export const importLegacyAppScanPreferencesV114: MigrationDefinition = {
  id: MIGRATION_ID,
  introducedIn: "1.1.4",
  scope: "runtime-config",
  description: "Import the legacy Memmy Desktop scan switches into memmyMemory.agentAccess once",
  requiredTargets: ["appDatabaseFile"],
  up: migrate,
};

export function importLegacyAppScanPreferencesForTest(
  context: AgentWorkspaceMigrationContext,
): Promise<MigrationResult> {
  return migrate(context);
}
