import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importLegacyAppScanPreferencesForTest } from "../src/migrations/v1.1.4/0001-import-legacy-app-scan-preferences.js";
import type { AgentWorkspaceMigrationContext } from "../src/types.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-legacy-scan-prefs-"));
  roots.push(value);
  return value;
}

function context(base: string, configPath: string, databaseFile?: string): AgentWorkspaceMigrationContext {
  return {
    profileWorkspace: base,
    sessionsDir: path.join(base, "sessions"),
    runtimeConfigFile: configPath,
    sessionDagDir: path.join(base, "session-dag"),
    ...(databaseFile ? { appDatabaseFile: databaseFile } : {}),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function createDatabase(
  databaseFile: string,
  row: { autoScan: number; watch: number; inject: number } | null,
  options: { withColumns?: boolean } = {},
): void {
  const db = new Database(databaseFile);
  db.exec(options.withColumns === false
    ? "CREATE TABLE app_settings (id TEXT PRIMARY KEY, theme TEXT)"
    : `CREATE TABLE app_settings (
        id TEXT PRIMARY KEY,
        auto_scan_known_agents INTEGER NOT NULL DEFAULT 1,
        watch_file_changes INTEGER NOT NULL DEFAULT 1,
        auto_inject_skill INTEGER NOT NULL DEFAULT 0
      )`);
  if (row && options.withColumns !== false) {
    db.prepare("INSERT INTO app_settings (id, auto_scan_known_agents, watch_file_changes, auto_inject_skill) VALUES ('default', ?, ?, ?)")
      .run(row.autoScan, row.watch, row.inject);
  }
  db.close();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => fs.rm(value, { recursive: true, force: true })));
});

describe("v1.1.4/0001-import-legacy-app-scan-preferences", () => {
  it("defers when the app database is not there yet", async () => {
    const base = await root();
    const configPath = path.join(base, "config.yaml");
    await expect(importLegacyAppScanPreferencesForTest(context(base, configPath)))
      .resolves.toEqual({ scanned: 0, changed: 0, ignored: 0, deferred: true });
    await expect(importLegacyAppScanPreferencesForTest(context(base, configPath, path.join(base, "missing.sqlite"))))
      .resolves.toEqual({ scanned: 0, changed: 0, ignored: 0, deferred: true });
    await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("carries the legacy Desktop switches into memmyMemory.agentAccess without touching other memory fields", async () => {
    const base = await root();
    const databaseFile = path.join(base, "app.sqlite");
    const configPath = path.join(base, "config.yaml");
    createDatabase(databaseFile, { autoScan: 0, watch: 1, inject: 1 });
    await fs.writeFile(configPath, YAML.stringify({ memmyMemory: { summary: { model: "keep-me" } } }), "utf8");
    const before = await fs.readFile(databaseFile);

    await expect(importLegacyAppScanPreferencesForTest(context(base, configPath, databaseFile)))
      .resolves.toEqual({ scanned: 1, changed: 1, ignored: 0 });

    const config = YAML.parse(await fs.readFile(configPath, "utf8"));
    expect(config.memmyMemory).toEqual({
      summary: { model: "keep-me" },
      agentAccess: { autoScanKnownAgents: false, watchFileChanges: true, autoInjectSkill: true },
    });
    // Read-only against the Desktop database.
    expect(await fs.readFile(databaseFile)).toEqual(before);
  });

  it("only fills switches the YAML does not have; recorded ones win over the legacy row", async () => {
    const base = await root();
    const databaseFile = path.join(base, "app.sqlite");
    const configPath = path.join(base, "config.yaml");
    createDatabase(databaseFile, { autoScan: 1, watch: 1, inject: 1 });
    await fs.writeFile(configPath, YAML.stringify({
      memmyMemory: { agentAccess: { autoScanKnownAgents: false, autoInjectSkill: false } },
    }), "utf8");

    await expect(importLegacyAppScanPreferencesForTest(context(base, configPath, databaseFile)))
      .resolves.toEqual({ scanned: 1, changed: 1, ignored: 0 });
    expect(YAML.parse(await fs.readFile(configPath, "utf8")).memmyMemory.agentAccess).toEqual({
      autoScanKnownAgents: false,
      watchFileChanges: true,
      autoInjectSkill: false,
    });
  });

  it("leaves a complete agentAccess section alone", async () => {
    const base = await root();
    const databaseFile = path.join(base, "app.sqlite");
    const configPath = path.join(base, "config.yaml");
    createDatabase(databaseFile, { autoScan: 1, watch: 1, inject: 1 });
    const source = YAML.stringify({
      memmyMemory: { agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false } },
    });
    await fs.writeFile(configPath, source, "utf8");

    await expect(importLegacyAppScanPreferencesForTest(context(base, configPath, databaseFile)))
      .resolves.toEqual({ scanned: 0, changed: 0, ignored: 1 });
    expect(await fs.readFile(configPath, "utf8")).toBe(source);
  });

  it("ignores databases from before the switches existed", async () => {
    const base = await root();
    const configPath = path.join(base, "config.yaml");
    await fs.writeFile(configPath, YAML.stringify({ memmyMemory: {} }), "utf8");

    const withoutColumns = path.join(base, "old.sqlite");
    createDatabase(withoutColumns, null, { withColumns: false });
    await expect(importLegacyAppScanPreferencesForTest(context(base, configPath, withoutColumns)))
      .resolves.toEqual({ scanned: 1, changed: 0, ignored: 1 });

    const withoutRow = path.join(base, "empty.sqlite");
    createDatabase(withoutRow, null);
    await expect(importLegacyAppScanPreferencesForTest(context(base, configPath, withoutRow)))
      .resolves.toEqual({ scanned: 1, changed: 0, ignored: 1 });

    expect(YAML.parse(await fs.readFile(configPath, "utf8"))).toEqual({ memmyMemory: {} });
  });
});
