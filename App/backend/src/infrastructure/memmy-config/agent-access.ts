import { readFileSync } from "node:fs";
import type {
  MemoryPatchConfigInput,
  MemoryPatchConfigOutput,
  PatchScanPreferencesInput,
  ScanPermission,
  ScanPreferences
} from "@memmy/local-api-contracts";
import { ScanPreferencesSchema } from "@memmy/local-api-contracts";
import YAML from "yaml";

/**
 * `memmyMemory.agentAccess` is owned by the memory service: it is the only
 * writer of that YAML section, and it reloads itself after every write. Memmy
 * Desktop reads the file directly (a read never races the writer) but edits it
 * through `PATCH /api/v1/config`, so the Viewer, the Desktop and a text editor
 * all see one value.
 */
export interface ScanPreferencesStore {
  getScanPreferences(): ScanPreferences;
  updateScanPreferences(patch: PatchScanPreferencesInput): Promise<ScanPreferences>;
}

export const DEFAULT_MEMORY_SCAN_PREFERENCES: ScanPreferences = {
  autoScanKnownAgents: true,
  watchFileChanges: true,
  autoInjectSkill: false
};

/** The slice of the memory-service client this store needs: the config write. */
export interface MemoryConfigPatcher {
  patchConfig(input: MemoryPatchConfigInput): Promise<MemoryPatchConfigOutput>;
}

export function createMemoryScanPreferencesStore(
  configPath: string,
  memoryClient: MemoryConfigPatcher
): ScanPreferencesStore {
  return {
    getScanPreferences() {
      return readMemoryScanPreferences(configPath);
    },

    async updateScanPreferences(patch) {
      const result = await memoryClient.patchConfig({ agentAccess: patch });
      return ScanPreferencesSchema.parse(result.config.agentAccess);
    }
  };
}

/**
 * The onboarding answer is not a fourth setting next to the three switches; it
 * is those switches. Declining leaves everything off, consenting to scans turns
 * on scanning and file watching, and consenting to Skill writes adds the
 * automatic Skill install on top.
 */
export function scanPreferencesForPermission(permission: ScanPermission): ScanPreferences {
  switch (permission) {
    case "scan_and_write_skill":
      return { autoScanKnownAgents: true, watchFileChanges: true, autoInjectSkill: true };
    case "scan_only":
      return { autoScanKnownAgents: true, watchFileChanges: true, autoInjectSkill: false };
    case "none":
    case "unset":
      return { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false };
  }
}

export function readMemoryScanPreferences(configPath: string): ScanPreferences {
  try {
    const parsed = YAML.parse(readFileSync(configPath, "utf8")) as unknown;
    return ScanPreferencesSchema.parse({
      ...DEFAULT_MEMORY_SCAN_PREFERENCES,
      ...readPreferencesRecord(record(record(parsed).memmyMemory).agentAccess)
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_MEMORY_SCAN_PREFERENCES };
    }
    throw error;
  }
}

function readPreferencesRecord(value: unknown): Partial<ScanPreferences> {
  const input = record(value);
  return {
    ...(typeof input.autoScanKnownAgents === "boolean"
      ? { autoScanKnownAgents: input.autoScanKnownAgents }
      : {}),
    ...(typeof input.watchFileChanges === "boolean"
      ? { watchFileChanges: input.watchFileChanges }
      : {}),
    ...(typeof input.autoInjectSkill === "boolean"
      ? { autoInjectSkill: input.autoInjectSkill }
      : {})
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
