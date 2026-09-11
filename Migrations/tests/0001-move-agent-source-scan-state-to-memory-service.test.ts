import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moveAgentSourceScanStateToMemoryServiceForTest } from "../src/migrations/v1.1.5/0001-move-agent-source-scan-state-to-memory-service.js";
import type { AgentWorkspaceMigrationContext } from "../src/types.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-agent-source-state-migration-"));
  roots.push(value);
  return value;
}

function context(base: string, databaseFile?: string): AgentWorkspaceMigrationContext {
  return {
    profileWorkspace: base,
    sessionsDir: path.join(base, "sessions"),
    runtimeConfigFile: path.join(base, "config.yaml"),
    sessionDagDir: path.join(base, "session-dag"),
    ...(databaseFile ? { appDatabaseFile: databaseFile } : {}),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function statePath(base: string): string {
  return path.join(base, "memory-service", "agent-sources.json");
}

async function readState(base: string): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(statePath(base), "utf8"));
}

async function writeConfig(base: string, document: unknown): Promise<void> {
  await fs.writeFile(path.join(base, "config.yaml"), YAML.stringify(document), "utf8");
}

type LegacySourceInput = {
  sourceId: string;
  displayName?: string;
  dataPath?: string;
  builtin?: 0 | 1;
  status?: string;
  lastScannedAt?: string | null;
  syncRecipeJson?: string | null;
  baselineAt?: string | null;
  latestSeenAt?: string | null;
  checkpoints?: Array<{ conversationId: string; lastMessageId: string; lastCreatedAt: string; contentHash: string }>;
};

function createDatabase(
  databaseFile: string,
  sources: LegacySourceInput[],
  options: { scanPermission?: string; withOnboarding?: boolean } = {},
): void {
  const db = new Database(databaseFile);
  db.exec(`
    CREATE TABLE account_agent_sources (
      uuid TEXT NOT NULL,
      source_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      data_path TEXT NOT NULL,
      builtin INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'not_connected',
      last_scanned_at TEXT,
      sync_recipe_json TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      PRIMARY KEY (uuid, source_id)
    );
    CREATE TABLE account_agent_source_watermarks (
      uuid TEXT NOT NULL,
      source_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      baseline_at TEXT,
      latest_seen_created_at TEXT,
      PRIMARY KEY (uuid, source_id)
    );
    CREATE TABLE account_agent_source_conversation_checkpoints (
      uuid TEXT NOT NULL,
      source_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      last_message_id TEXT NOT NULL,
      last_created_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      PRIMARY KEY (uuid, source_id, conversation_id)
    );
  `);
  if (options.withOnboarding !== false) {
    db.exec("CREATE TABLE account_onboarding_state (uuid TEXT PRIMARY KEY, scan_permission TEXT NOT NULL)");
    db.prepare("INSERT INTO account_onboarding_state (uuid, scan_permission) VALUES ('local-agent-sources', ?)")
      .run(options.scanPermission ?? "scan_and_write_skill");
  }
  for (const source of sources) {
    db.prepare(
      `INSERT INTO account_agent_sources (uuid, source_id, display_name, data_path, builtin, status, last_scanned_at, sync_recipe_json)
       VALUES ('local-agent-sources', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      source.sourceId,
      source.displayName ?? source.sourceId,
      source.dataPath ?? `/home/user/.${source.sourceId}`,
      source.builtin ?? 1,
      source.status ?? "not_connected",
      source.lastScannedAt ?? "2026-08-28T03:00:00.000Z",
      source.syncRecipeJson ?? null,
    );
    db.prepare(
      `INSERT INTO account_agent_source_watermarks (uuid, source_id, mode, baseline_at, latest_seen_created_at)
       VALUES ('local-agent-sources', ?, 'incremental', ?, ?)`,
    ).run(source.sourceId, source.baselineAt ?? null, source.latestSeenAt ?? null);
    for (const checkpoint of source.checkpoints ?? []) {
      db.prepare(
        `INSERT INTO account_agent_source_conversation_checkpoints
           (uuid, source_id, conversation_id, last_message_id, last_created_at, content_hash)
         VALUES ('local-agent-sources', ?, ?, ?, ?, ?)`,
      ).run(source.sourceId, checkpoint.conversationId, checkpoint.lastMessageId, checkpoint.lastCreatedAt, checkpoint.contentHash);
    }
  }
  db.close();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => fs.rm(value, { recursive: true, force: true })));
});

describe("v1.1.5/0001-move-agent-source-scan-state-to-memory-service", () => {
  it("defers when the Desktop database is not there", async () => {
    const base = await root();
    await expect(moveAgentSourceScanStateToMemoryServiceForTest(context(base)))
      .resolves.toEqual({ scanned: 0, changed: 0, ignored: 0, deferred: true });
    await expect(moveAgentSourceScanStateToMemoryServiceForTest(context(base, path.join(base, "missing.sqlite"))))
      .resolves.toEqual({ scanned: 0, changed: 0, ignored: 0, deferred: true });
    await expect(fs.stat(statePath(base))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("carries the boundary forward so the first service scan is incremental", async () => {
    const base = await root();
    const databaseFile = path.join(base, "app.sqlite");
    createDatabase(databaseFile, [{
      sourceId: "cursor",
      status: "plugin_installed",
      lastScannedAt: "2026-08-28T03:00:00.000Z",
      baselineAt: "2026-08-20T00:00:00.000Z",
      latestSeenAt: "2026-08-28T02:00:00.000Z",
      checkpoints: [{
        conversationId: "conversation-a",
        lastMessageId: "message-9",
        lastCreatedAt: "2026-08-28T02:00:00.000Z",
        contentHash: "hash-a",
      }],
    }]);
    await writeConfig(base, { memmyMemory: {} });
    const before = await fs.readFile(databaseFile);

    await expect(moveAgentSourceScanStateToMemoryServiceForTest(context(base, databaseFile)))
      .resolves.toEqual({ scanned: 1, changed: 1, ignored: 0 });

    const state = await readState(base);
    expect(state).toMatchObject({ version: 3, manual: {} });
    expect(state.sources.cursor).toEqual({
      status: "plugin_installed",
      messageCount: 0,
      lastScannedAt: "2026-08-28T03:00:00.000Z",
      latestSeenAt: "2026-08-28T02:00:00.000Z",
      baselineAt: "2026-08-20T00:00:00.000Z",
      checkpoints: {
        "conversation-a": {
          lastMessageId: "message-9",
          lastCreatedAt: "2026-08-28T02:00:00.000Z",
          contentHash: "hash-a",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    // Read-only against the Desktop database; rolling back means the old
    // version resumes from these same rows.
    expect(await fs.readFile(databaseFile)).toEqual(before);
  });

  it("takes the baseline into the cursor for a source that went idle before its first scan", async () => {
    const base = await root();
    const databaseFile = path.join(base, "app.sqlite");
    // 10k turns, only the newest 200 imported: latest_seen is the oldest of
    // those 200, the baseline is the scan itself. Migrating only latest_seen
    // would pull the cursor back and re-import everything after it.
    createDatabase(databaseFile, [{
      sourceId: "codex",
      baselineAt: "2026-08-28T00:00:00.000Z",
      latestSeenAt: "2025-01-01T00:00:00.000Z",
    }]);
    await writeConfig(base, { memmyMemory: {} });

    await moveAgentSourceScanStateToMemoryServiceForTest(context(base, databaseFile));

    expect((await readState(base)).sources.codex).toMatchObject({
      latestSeenAt: "2026-08-28T00:00:00.000Z",
      baselineAt: "2026-08-28T00:00:00.000Z",
    });
  });

  it("keeps the boundary the memory service already reached and drops timestamps it cannot parse", async () => {
    const base = await root();
    const databaseFile = path.join(base, "app.sqlite");
    createDatabase(databaseFile, [{
      sourceId: "cursor",
      lastScannedAt: "yesterday",
      baselineAt: "2026-08-01T00:00:00.000Z",
      latestSeenAt: "2026-08-10T00:00:00.000Z",
      checkpoints: [{
        conversationId: "conversation-a",
        lastMessageId: "message-1",
        lastCreatedAt: "2026-08-10T00:00:00.000Z",
        contentHash: "stale",
      }],
    }]);
    await writeConfig(base, { memmyMemory: {} });
    await fs.mkdir(path.dirname(statePath(base)), { recursive: true });
    await fs.writeFile(statePath(base), JSON.stringify({
      version: 3,
      sources: {
        cursor: {
          status: "skill_installed",
          messageCount: 12,
          lastScannedAt: "2026-08-29T00:00:00.000Z",
          latestSeenAt: "2026-08-28T00:00:00.000Z",
          baselineAt: "2026-08-27T00:00:00.000Z",
          checkpoints: {
            "conversation-a": {
              lastMessageId: "message-4",
              lastCreatedAt: "2026-08-28T00:00:00.000Z",
              contentHash: "fresh",
              updatedAt: "2026-08-28T00:00:00.000Z",
            },
          },
        },
      },
      manual: {},
    }), "utf8");

    await moveAgentSourceScanStateToMemoryServiceForTest(context(base, databaseFile));

    expect((await readState(base)).sources.cursor).toEqual({
      status: "skill_installed",
      messageCount: 12,
      lastScannedAt: "2026-08-29T00:00:00.000Z",
      latestSeenAt: "2026-08-28T00:00:00.000Z",
      baselineAt: "2026-08-27T00:00:00.000Z",
      checkpoints: {
        "conversation-a": {
          lastMessageId: "message-4",
          lastCreatedAt: "2026-08-28T00:00:00.000Z",
          contentHash: "fresh",
          updatedAt: "2026-08-28T00:00:00.000Z",
        },
      },
    });
  });

  it("moves a manually added Agent with its sync recipe", async () => {
    const base = await root();
    const databaseFile = path.join(base, "app.sqlite");
    const recipe = {
      version: 1,
      format: "jsonl",
      historyPath: "/opt/internal/history.jsonl",
      fields: { messageId: "id", conversationId: "session", role: "role", content: "text", createdAt: "at" },
    };
    createDatabase(databaseFile, [{
      sourceId: "b2f1c0de-0000-4000-8000-000000000001",
      displayName: "Internal Agent",
      dataPath: "/opt/internal",
      builtin: 0,
      syncRecipeJson: JSON.stringify(recipe),
      baselineAt: "2026-08-28T00:00:00.000Z",
      latestSeenAt: "2026-08-28T00:00:00.000Z",
    }, {
      sourceId: "b2f1c0de-0000-4000-8000-000000000002",
      displayName: "Half Configured Agent",
      builtin: 0,
      syncRecipeJson: "{not json",
    }]);
    await writeConfig(base, { memmyMemory: {} });

    await moveAgentSourceScanStateToMemoryServiceForTest(context(base, databaseFile));

    const state = await readState(base);
    expect(Object.keys(state.sources)).toHaveLength(2);
    expect(state.manual["b2f1c0de-0000-4000-8000-000000000001"]).toEqual({
      displayName: "Internal Agent",
      dataPath: "/opt/internal",
      syncRecipe: recipe,
      baselineAt: "2026-08-28T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    // An unusable recipe costs that source its sync, not its history.
    expect(state.manual["b2f1c0de-0000-4000-8000-000000000002"]).toMatchObject({ syncRecipe: null });
  });

  it("folds the onboarding answer into the switches, since the 403 gate goes away with the routes", async () => {
    for (const [permission, expected] of [
      ["none", { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false }],
      ["unset", { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false }],
      ["scan_only", { autoScanKnownAgents: true, watchFileChanges: true, autoInjectSkill: false }],
      ["scan_and_write_skill", { autoScanKnownAgents: true, watchFileChanges: true, autoInjectSkill: true }],
    ] as const) {
      const base = await root();
      const databaseFile = path.join(base, "app.sqlite");
      createDatabase(databaseFile, [{ sourceId: "cursor" }], { scanPermission: permission });
      await writeConfig(base, {
        memmyMemory: {
          summary: { model: "keep-me" },
          agentAccess: { autoScanKnownAgents: true, watchFileChanges: true, autoInjectSkill: true },
        },
      });

      await moveAgentSourceScanStateToMemoryServiceForTest(context(base, databaseFile));

      const config = YAML.parse(await fs.readFile(path.join(base, "config.yaml"), "utf8"));
      expect([permission, config.memmyMemory.agentAccess]).toEqual([permission, expected]);
      expect(config.memmyMemory.summary).toEqual({ model: "keep-me" });
    }
  });

  it("never turns a switch on and leaves one the YAML never recorded alone", async () => {
    const base = await root();
    const databaseFile = path.join(base, "app.sqlite");
    createDatabase(databaseFile, [{ sourceId: "cursor" }], { scanPermission: "scan_and_write_skill" });
    await writeConfig(base, { memmyMemory: { agentAccess: { autoScanKnownAgents: false } } });

    await moveAgentSourceScanStateToMemoryServiceForTest(context(base, databaseFile));

    expect(YAML.parse(await fs.readFile(path.join(base, "config.yaml"), "utf8")).memmyMemory.agentAccess)
      .toEqual({ autoScanKnownAgents: false });
  });

  it("defers while a separately started memory service holds the database lock", async () => {
    const base = await root();
    const databaseFile = path.join(base, "app.sqlite");
    const memorySqlite = path.join(base, "memory-service", "memory.sqlite");
    createDatabase(databaseFile, [{ sourceId: "cursor" }]);
    await writeConfig(base, { memmyMemory: { storage: { sqlitePath: memorySqlite } } });
    await fs.mkdir(path.dirname(memorySqlite), { recursive: true });
    await fs.writeFile(`${memorySqlite}.server.lock`, JSON.stringify({ pid: process.pid }), "utf8");

    // It loads this file once and only writes it afterwards, so writing
    // underneath it would be lost at its next persist.
    await expect(moveAgentSourceScanStateToMemoryServiceForTest(context(base, databaseFile)))
      .resolves.toEqual({ scanned: 0, changed: 0, ignored: 0, deferred: true });
    await expect(fs.stat(statePath(base))).rejects.toMatchObject({ code: "ENOENT" });

    await fs.writeFile(`${memorySqlite}.server.lock`, JSON.stringify({ pid: 2 ** 30 }), "utf8");
    await expect(moveAgentSourceScanStateToMemoryServiceForTest(context(base, databaseFile)))
      .resolves.toEqual({ scanned: 1, changed: 1, ignored: 0 });
  });

  it("ignores a database with no recorded Agent sources", async () => {
    const base = await root();
    const databaseFile = path.join(base, "app.sqlite");
    createDatabase(databaseFile, []);
    await writeConfig(base, { memmyMemory: {} });

    await expect(moveAgentSourceScanStateToMemoryServiceForTest(context(base, databaseFile)))
      .resolves.toEqual({ scanned: 0, changed: 0, ignored: 1 });
    await expect(fs.stat(statePath(base))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite a state file it could not read", async () => {
    const base = await root();
    const databaseFile = path.join(base, "app.sqlite");
    createDatabase(databaseFile, [{ sourceId: "cursor", latestSeenAt: "2026-08-28T00:00:00.000Z" }]);
    await writeConfig(base, { memmyMemory: {} });
    await fs.mkdir(path.dirname(statePath(base)), { recursive: true });
    await fs.writeFile(statePath(base), "{ truncated", "utf8");

    await expect(moveAgentSourceScanStateToMemoryServiceForTest(context(base, databaseFile)))
      .rejects.toMatchObject({ code: "migration_io_failed" });
    expect(await fs.readFile(statePath(base), "utf8")).toBe("{ truncated");
  });

  it("ignores a database from before the scan tables existed", async () => {
    const base = await root();
    const databaseFile = path.join(base, "app.sqlite");
    const db = new Database(databaseFile);
    db.exec("CREATE TABLE app_settings (id TEXT PRIMARY KEY, theme TEXT)");
    db.close();
    await writeConfig(base, { memmyMemory: {} });

    await expect(moveAgentSourceScanStateToMemoryServiceForTest(context(base, databaseFile)))
      .resolves.toEqual({ scanned: 0, changed: 0, ignored: 1 });
  });
});
