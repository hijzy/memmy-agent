import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryScanPreferencesStore,
  readMemoryScanPreferences,
  scanPreferencesForPermission,
  type MemoryConfigPatcher
} from "../agent-access.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("memmyMemory agent access preferences", () => {
  it("reads the switches from the YAML the memory service owns, with defaults for missing keys", () => {
    expect(readMemoryScanPreferences(fixture({ memmyMemory: { agentAccess: { autoInjectSkill: true } } }))).toEqual({
      autoScanKnownAgents: true,
      watchFileChanges: true,
      autoInjectSkill: true
    });
    expect(readMemoryScanPreferences(join(tempRoot(), "missing.yaml"))).toEqual({
      autoScanKnownAgents: true,
      watchFileChanges: true,
      autoInjectSkill: false
    });
  });

  it("writes through the memory service instead of the YAML and returns what the service now holds", async () => {
    const path = fixture({ memmyMemory: { agentAccess: { autoScanKnownAgents: true, watchFileChanges: true, autoInjectSkill: false } } });
    const patchConfig = vi.fn<MemoryConfigPatcher["patchConfig"]>(async (input) => ({
      ok: true,
      reload: { changed: true, requiresRestart: false, models: models(), reloadedAt: "2026-05-28T10:00:00.000Z" },
      config: { agentAccess: { autoScanKnownAgents: true, watchFileChanges: false, autoInjectSkill: true, ...input.agentAccess } }
    }));
    const store = createMemoryScanPreferencesStore(path, { patchConfig });

    const updated = await store.updateScanPreferences({ watchFileChanges: false, autoInjectSkill: true });

    expect(patchConfig).toHaveBeenCalledWith({ agentAccess: { watchFileChanges: false, autoInjectSkill: true } });
    expect(updated).toEqual({ autoScanKnownAgents: true, watchFileChanges: false, autoInjectSkill: true });
    // The store never touched the file itself; the memory service is the writer.
    expect(readMemoryScanPreferences(path)).toEqual({ autoScanKnownAgents: true, watchFileChanges: true, autoInjectSkill: false });
  });

  it("surfaces a failed write instead of pretending the switches changed", async () => {
    const path = fixture({ memmyMemory: {} });
    const store = createMemoryScanPreferencesStore(path, {
      patchConfig: async () => { throw new Error("memory layer unavailable"); }
    });

    await expect(store.updateScanPreferences({ autoScanKnownAgents: false })).rejects.toThrow("memory layer unavailable");
  });

  it("projects the onboarding answer onto the three switches", () => {
    expect(scanPreferencesForPermission("unset")).toEqual({ autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false });
    expect(scanPreferencesForPermission("none")).toEqual({ autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false });
    expect(scanPreferencesForPermission("scan_only")).toEqual({ autoScanKnownAgents: true, watchFileChanges: true, autoInjectSkill: false });
    expect(scanPreferencesForPermission("scan_and_write_skill")).toEqual({ autoScanKnownAgents: true, watchFileChanges: true, autoInjectSkill: true });
  });
});

function fixture(content: unknown): string {
  const path = join(tempRoot(), "config.yaml");
  writeFileSync(path, YAML.stringify(content));
  return path;
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-agent-access-"));
  roots.push(root);
  return root;
}

function models() {
  const status = { provider: "mock", model: "mock", configured: true, remote: false };
  return {
    summary: { ...status, routing: "fixed" as const },
    evolution: { ...status, routing: "follow" as const },
    embedding: status
  };
}
