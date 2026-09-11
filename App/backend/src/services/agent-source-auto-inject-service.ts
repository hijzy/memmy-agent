/** Agent source auto inject service module. */
import type { AgentSourceAutoInjectResult, ScanPreferences } from "@memmy/local-api-contracts";
import type { PermissionManager } from "../permission/index.js";
import type { AgentSourceConnectionService } from "./agent-source-connection-service.js";

const AUTO_INJECT_AGENT_SOURCE_IDS = new Set([
  "cursor",
  "claude_code",
  "codex",
  "opencode",
  "openclaw",
  "hermes",
  "deepseek_harness",
  "workbuddy",
  "pi",
  "qwenwork"
]);
const HOOK_OR_PLUGIN_AGENT_SOURCE_IDS = new Set(["cursor", "claude_code", "codex", "opencode", "openclaw", "hermes", "deepseek_harness"]);

export interface AgentSourceAutoInjectService {
  runOnce(): Promise<AgentSourceAutoInjectResult>;
}

export interface CreateAgentSourceAutoInjectServiceOptions {
  agentSources: AgentSourceConnectionService;
  permissionManager: Pick<PermissionManager, "canWriteAgentSkill">;
  getScanPreferences: () => ScanPreferences;
}

/** Creates create agent source auto inject service. */
export function createAgentSourceAutoInjectService(
  options: CreateAgentSourceAutoInjectServiceOptions
): AgentSourceAutoInjectService {
  let running = false;

  return {
    async runOnce() {
      if (running) {
        return {
          ok: true,
          skipped: true,
          reason: "already_running",
          installed: [],
          failed: []
        };
      }

      const preferences = options.getScanPreferences();
      if (!preferences.autoInjectSkill) {
        return {
          ok: true,
          skipped: true,
          reason: "auto_inject_disabled",
          installed: [],
          failed: []
        };
      }

      running = true;
      try {
        const sources = await options.agentSources.list();
        const installed: string[] = [];
        const failed: Array<{ sourceId: string; reason: string }> = [];

        for (const source of sources) {
          if (!AUTO_INJECT_AGENT_SOURCE_IDS.has(source.sourceId) || !source.builtin || !source.available || source.status !== "not_connected") {
            continue;
          }

          if (!(await options.permissionManager.canWriteAgentSkill({ agentSourceId: source.sourceId }))) {
            continue;
          }

          try {
            const kind = HOOK_OR_PLUGIN_AGENT_SOURCE_IDS.has(source.sourceId) ? "plugin" : "skill";
            await options.agentSources.connect(source.sourceId, kind, "auto_inject");
            installed.push(source.sourceId);
          } catch (error) {
            failed.push({
              sourceId: source.sourceId,
              reason: error instanceof Error ? error.message : String(error)
            });
          }
        }

        return {
          ok: true,
          skipped: false,
          installed,
          failed
        };
      } finally {
        running = false;
      }
    }
  };
}
