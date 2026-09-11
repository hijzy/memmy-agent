import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { mutateRuntimeConfigSync } from "@memmy/migrations";
import { VERSION } from "../version.js";
import { Config, LegacyConfigFieldError } from "./schema.js";

/** A field removed from config.yaml because this build's contract refuses it. */
export type QuarantinedConfigField = {
  path: string[];
  value: unknown;
  reason: string;
};

export type ConfigCompatibilityRepair = {
  configPath: string;
  quarantinePath: string;
  quarantined: QuarantinedConfigField[];
};

export type CompatibilityLogger = {
  info: (event: string, fields?: Record<string, string | number>) => void;
  warn: (event: string, fields?: Record<string, string | number>) => void;
};

// Every pass removes exactly one field, so this only has to exceed the number
// of refused fields a single file can realistically carry.
const MAX_REPAIR_PASSES = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeAt(
  document: Record<string, unknown>,
  fieldPath: readonly string[],
): { removed: boolean; value: unknown } {
  if (fieldPath.length === 0) return { removed: false, value: undefined };
  let parent = document;
  for (const key of fieldPath.slice(0, -1)) {
    const next = parent[key];
    if (!isRecord(next)) return { removed: false, value: undefined };
    parent = next;
  }
  const leaf = fieldPath[fieldPath.length - 1]!;
  if (!Object.prototype.hasOwnProperty.call(parent, leaf)) {
    return { removed: false, value: undefined };
  }
  const value = parent[leaf];
  delete parent[leaf];
  return { removed: true, value };
}

/**
 * Removes, in place, the fields this build's contract refuses.
 *
 * Returns null when `document` cannot be made loadable this way, so callers
 * leave the file alone and let the real validation error reach the user.
 */
export function stripIncompatibleConfigFields(
  document: Record<string, unknown>,
): QuarantinedConfigField[] | null {
  const quarantined: QuarantinedConfigField[] = [];
  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass += 1) {
    let failure: unknown;
    try {
      new Config(structuredClone(document));
      return quarantined;
    } catch (error) {
      failure = error;
    }
    if (!(failure instanceof LegacyConfigFieldError)) return null;
    const { removed, value } = removeAt(document, failure.path);
    if (!removed) return null;
    quarantined.push({ path: [...failure.path], value, reason: failure.message });
  }
  return null;
}

function quarantineFileFor(configPath: string, now: Date): string {
  const stamp = now.toISOString().replaceAll(":", "-").replace(".", "-");
  return path.join(
    path.dirname(configPath),
    `${path.basename(configPath)}.incompatible-${stamp}.yaml`,
  );
}

function writeQuarantineFile(
  quarantinePath: string,
  configPath: string,
  quarantined: readonly QuarantinedConfigField[],
  now: Date,
): void {
  const header = [
    `# Memmy ${VERSION} could not load ${configPath} with these fields present,`,
    "# so it removed them and kept the originals here. They are safe to discard;",
    "# restore them by hand if you go back to the version that wrote them.",
    "",
  ].join("\n");
  const body = YAML.stringify(
    {
      removedAt: now.toISOString(),
      memmyVersion: VERSION,
      configPath,
      fields: quarantined.map((field) => ({
        path: field.path.join("."),
        reason: field.reason,
        value: field.value,
      })),
    },
    { lineWidth: 0 },
  );
  fs.writeFileSync(quarantinePath, `${header}${body}`, { encoding: "utf8", mode: 0o600 });
}

/**
 * Lock-free check for whether the file is worth locking. The result is only a
 * hint: the repair below re-derives everything from the locked read.
 */
function needsRepair(configPath: string, logger: CompatibilityLogger): boolean {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed: unknown = raw.trim() ? YAML.parse(raw) : {};
    if (!isRecord(parsed)) return false;
    return Boolean(stripIncompatibleConfigFields(parsed)?.length);
  } catch (error) {
    logger.warn("config_compatibility_probe_failed", {
      configPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Quarantines config fields this build refuses, so an agent paired with a
 * newer Memory release — or rolled back to an older one — still starts.
 *
 * Registered migrations cannot cover this: they are stamped as applied once
 * per profile and never reconsidered, while the Memory service rewrites
 * config.yaml on every launch. This runs on every startup instead, and is a
 * no-op for a config the current contract already accepts.
 */
export function repairIncompatibleConfigFile(
  configPath: string,
  logger: CompatibilityLogger,
  now: Date = new Date(),
): ConfigCompatibilityRepair | null {
  if (!fs.existsSync(configPath)) return null;
  // Probe without the write lock. Nearly every startup finds nothing to do,
  // and taking the runtime config lock there would add contention to every
  // command — and fail outright under a caller that already holds it.
  if (!needsRepair(configPath, logger)) return null;

  const quarantinePath = quarantineFileFor(configPath, now);
  let quarantined: QuarantinedConfigField[] = [];
  try {
    mutateRuntimeConfigSync(
      configPath,
      (document) => {
        // Repair a copy: a partial strip that cannot finish must not reach the file.
        const candidate = structuredClone(document);
        const removed = stripIncompatibleConfigFields(candidate);
        if (!removed?.length) return;
        quarantined = removed;
        for (const key of Object.keys(document)) delete document[key];
        Object.assign(document, candidate);
      },
      {
        createIfMissing: false,
        // Runs before config.yaml is replaced, so the originals are on disk
        // before anything is dropped from the live file.
        beforeCommit: () => writeQuarantineFile(quarantinePath, configPath, quarantined, now),
      },
    );
  } catch (error) {
    // Never block startup on repair. An unreadable or locked config surfaces
    // its own error from loadConfig, which reports it far more precisely.
    logger.warn("config_compatibility_repair_failed", {
      configPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (quarantined.length === 0) return null;
  for (const field of quarantined) {
    logger.warn("config_incompatible_field_quarantined", {
      field: field.path.join("."),
      reason: field.reason,
    });
  }
  logger.info("config_compatibility_repaired", {
    configPath,
    quarantinePath,
    fields: quarantined.length,
  });
  return { configPath, quarantinePath, quarantined };
}
