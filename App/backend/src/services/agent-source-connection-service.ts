/** Agent source connection service module. */
import type { AgentSourceStatus, AgentSourceView, ScanPermission } from "@memmy/local-api-contracts";
import {
  createAgentSourceLifecycleAnalytics,
  type AgentSourceInstallType,
  type AgentSourceLifecycleAnalytics
} from "../analytics/agent-source-analytics.js";
import type { MemoryClient } from "../adapters/outbound/memory-client/types.js";

/** Contract for create agent source connection service options. */
export interface CreateAgentSourceConnectionServiceOptions {
  memoryClient: Pick<MemoryClient, "listAgentSources" | "mutateAgentSourceConnection">;
  agentSourceAnalytics?: AgentSourceLifecycleAnalytics;
  getScanPermission?: () => Promise<ScanPermission>;
}

/**
 * Contract for agent source connection service.
 *
 * The memory service installs the Hook, plugin or Skill; Memmy Desktop still
 * owns the product analytics around those clicks, which is all this adds.
 */
export interface AgentSourceConnectionService {
  list(): Promise<AgentSourceView[]>;
  connect(sourceId: string, kind: "plugin" | "skill", installType?: AgentSourceInstallType): Promise<void>;
  disconnect(sourceId: string, kind: "plugin" | "skill", installType?: AgentSourceInstallType): Promise<void>;
}

/** Creates create agent source connection service. */
export function createAgentSourceConnectionService(
  options: CreateAgentSourceConnectionServiceOptions
): AgentSourceConnectionService {
  const analytics = options.agentSourceAnalytics ?? createAgentSourceLifecycleAnalytics();

  return {
    async list() {
      return (await options.memoryClient.listAgentSources()).sources;
    },

    async connect(sourceId, kind, installType) {
      await mutate(sourceId, kind, "POST", installType);
    },

    async disconnect(sourceId, kind, installType) {
      await mutate(sourceId, kind, "DELETE", installType);
    }
  };

  async function mutate(
    sourceId: string,
    kind: "plugin" | "skill",
    method: "POST" | "DELETE",
    installType: AgentSourceInstallType | undefined
  ): Promise<void> {
    const startedAt = Date.now();
    const before = await describeSource(sourceId);
    const permission = await readPermission();
    try {
      const result = await options.memoryClient.mutateAgentSourceConnection({ sourceId, kind, method });
      track(kind, method, {
        sourceId,
        builtin: before.builtin,
        permission,
        statusBefore: before.status,
        statusAfter: result.status,
        installType,
        success: true,
        latencyMs: Date.now() - startedAt
      });
    } catch (error) {
      track(kind, method, {
        sourceId,
        builtin: before.builtin,
        permission,
        statusBefore: before.status,
        statusAfter: before.status,
        installType,
        success: false,
        latencyMs: Date.now() - startedAt,
        errorCode: errorCode(error)
      });
      throw error;
    }
  }

  function track(
    kind: "plugin" | "skill",
    method: "POST" | "DELETE",
    input: {
      sourceId: string;
      builtin?: boolean;
      permission?: ScanPermission;
      statusBefore?: AgentSourceStatus;
      statusAfter?: AgentSourceStatus;
      installType?: AgentSourceInstallType;
      success: boolean;
      latencyMs: number;
      errorCode?: string;
    }
  ): void {
    if (kind === "plugin") {
      if (method === "POST") analytics.trackPluginInstalled(input);
      else analytics.trackPluginUninstalled(input);
      return;
    }
    if (method === "POST") analytics.trackSkillInstalled(input);
    else analytics.trackSkillUninstalled(input);
  }

  /** A source the memory service does not know is reported as it will be recorded. */
  async function describeSource(sourceId: string): Promise<{ status?: AgentSourceStatus; builtin?: boolean }> {
    try {
      const sources = await options.memoryClient.listAgentSources();
      const source = sources.sources.find((candidate) => candidate.sourceId === sourceId);
      return { status: source?.status, builtin: source?.builtin };
    } catch {
      // Analytics dimensions are not worth failing a user's click over.
      return {};
    }
  }

  async function readPermission(): Promise<ScanPermission | undefined> {
    try {
      return await options.getScanPermission?.();
    } catch {
      return undefined;
    }
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
