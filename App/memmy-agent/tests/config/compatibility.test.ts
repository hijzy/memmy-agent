import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { repairIncompatibleConfigFile } from "../../src/config/compatibility.js";
import { loadConfig, saveConfig } from "../../src/config/loader.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function configFile(value: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-config-compat-"));
  roots.push(root);
  const target = path.join(root, "config.yaml");
  fs.writeFileSync(target, typeof value === "string" ? value : YAML.stringify(value), "utf8");
  return target;
}

function readQuarantine(quarantinePath: string): any {
  return YAML.parse(fs.readFileSync(quarantinePath, "utf8"));
}

describe("startup config compatibility repair", () => {
  it("keeps the agent startable when the contract refuses a field, and preserves the rest", () => {
    const target = configFile({
      memmyMemory: { enabled: true, activeProfile: "byok", embedding: { mode: "local" } },
      providers: { openai: { apiBase: "https://legacy.example/v1", apiKey: "sk-keep" } },
      tools: { my: { dead: true } },
    });
    expect(() => loadConfig(target)).toThrow(/does not accept legacy/);

    const repair = repairIncompatibleConfigFile(target, silentLogger());

    expect(repair?.quarantined.map((field) => field.path.join("."))).toEqual([
      "tools.my",
      "providers.openai.apiBase",
      "memmyMemory.activeProfile",
    ]);
    const config = loadConfig(target);
    expect(config.providers.openai.apiKey).toBe("sk-keep");
    expect(config.memmyMemory.embedding).toEqual({ mode: "local" });
  });

  it("writes the removed values to a sidecar before rewriting the config", () => {
    const target = configFile({
      memmyMemory: { profiles: { byok: { embedding: { provider: "local" } } } },
    });

    const repair = repairIncompatibleConfigFile(target, silentLogger());

    expect(repair).not.toBeNull();
    const quarantine = readQuarantine(repair!.quarantinePath);
    expect(quarantine.configPath).toBe(target);
    expect(quarantine.fields).toEqual([
      {
        path: "memmyMemory.profiles",
        reason: "memmyMemory current contract does not accept legacy field 'profiles'",
        value: { byok: { embedding: { provider: "local" } } },
      },
    ]);
    expect(fs.statSync(repair!.quarantinePath).mode & 0o777).toBe(0o600);
  });

  it("is a no-op for a config the current contract already accepts", () => {
    const target = configFile({ memmyMemory: { enabled: true, embedding: { mode: "local" } } });
    const before = fs.readFileSync(target, "utf8");
    const logger = silentLogger();

    expect(repairIncompatibleConfigFile(target, logger)).toBeNull();
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("leaves a config that fails for other reasons untouched so the real error survives", () => {
    const target = configFile({
      memmyMemory: { activeProfile: "byok" },
      providers: { openai: { endpoints: { chat: { apiBase: "https://api.example/v1", protocol: "nope" } } } },
    });
    const before = fs.readFileSync(target, "utf8");

    expect(repairIncompatibleConfigFile(target, silentLogger())).toBeNull();
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(() => loadConfig(target)).toThrow(/protocol must be one of/);
  });

  it("does not fail startup when the config file is missing or unreadable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-config-compat-"));
    roots.push(root);
    const logger = silentLogger();

    expect(repairIncompatibleConfigFile(path.join(root, "config.yaml"), logger)).toBeNull();
    expect(repairIncompatibleConfigFile(configFile("{ not: [valid"), logger)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "config_compatibility_probe_failed",
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it("does not take the runtime config write lock when there is nothing to repair", () => {
    const target = configFile({ memmyMemory: { enabled: true } });
    const lockPath = `${target}.lock`;
    // proper-lockfile leaves this directory behind only if the lock was taken,
    // and every command pays for that lock on startup.
    expect(repairIncompatibleConfigFile(target, silentLogger())).toBeNull();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe("memmyMemory pass-through", () => {
  it("round-trips fields the agent does not own instead of dropping them", () => {
    const target = configFile({
      memmyMemory: {
        enabled: true,
        embedding: { mode: "custom", custom: { endpoint: "https://e.example/v1", model: "bge-m3" } },
        summary: { provider: "openai_compatible", model: "gpt-4.1" },
        somethingOnlyANewerMemoryKnows: { keep: true },
      },
    });

    saveConfig(loadConfig(target), target);

    expect(YAML.parse(fs.readFileSync(target, "utf8")).memmyMemory).toMatchObject({
      embedding: { mode: "custom", custom: { endpoint: "https://e.example/v1", model: "bge-m3" } },
      summary: { provider: "openai_compatible", model: "gpt-4.1" },
      somethingOnlyANewerMemoryKnows: { keep: true },
    });
  });
});
