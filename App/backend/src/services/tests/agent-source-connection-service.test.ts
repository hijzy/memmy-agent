/** Agent source connection service tests. */
import type { AgentSourceView } from "@memmy/local-api-contracts";
import { describe, expect, it, vi } from "vitest";
import { MemoryLayerError } from "../../adapters/outbound/memory-client/errors.js";
import { createAgentSourceConnectionService } from "../agent-source-connection-service.js";
import type { AgentSourceLifecycleAnalytics } from "../../analytics/agent-source-analytics.js";

describe("agent source connection service", () => {
  it("installs through the memory service and reports the status it moved between", async () => {
    const harness = createHarness();

    await harness.service.connect("openclaw", "plugin", "auto_inject");

    expect(harness.mutate).toHaveBeenCalledWith({ sourceId: "openclaw", kind: "plugin", method: "POST" });
    expect(harness.analytics.trackPluginInstalled).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "openclaw",
      permission: "scan_and_write_skill",
      statusBefore: "not_connected",
      statusAfter: "plugin_installed",
      installType: "auto_inject",
      success: true
    }));
  });

  it("reports a failed install with the memory service's error code", async () => {
    const harness = createHarness();
    harness.mutate.mockRejectedValue(new MemoryLayerError(
      "agent_source_unavailable",
      409,
      "OpenClaw is not installed or its directory is unavailable"
    ));

    await expect(harness.service.connect("openclaw", "skill")).rejects.toThrow("is not installed");

    expect(harness.analytics.trackSkillInstalled).toHaveBeenCalledWith(expect.objectContaining({
      statusBefore: "not_connected",
      statusAfter: "not_connected",
      success: false,
      errorCode: "agent_source_unavailable"
    }));
  });

  it("uninstalls and reports the disconnect", async () => {
    const harness = createHarness();

    await harness.service.disconnect("cursor", "plugin");

    expect(harness.mutate).toHaveBeenCalledWith({ sourceId: "cursor", kind: "plugin", method: "DELETE" });
    expect(harness.analytics.trackPluginUninstalled).toHaveBeenCalledWith(expect.objectContaining({
      statusAfter: "not_connected",
      success: true
    }));
  });

  /** Analytics dimensions are not worth failing a user's click over. */
  it("still installs when the Agent list or the permission read fails", async () => {
    const harness = createHarness();
    harness.list.mockRejectedValue(new MemoryLayerError("internal", 500, "list unavailable"));

    await harness.service.connect("openclaw", "plugin");

    expect(harness.mutate).toHaveBeenCalledOnce();
    expect(harness.analytics.trackPluginInstalled).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "openclaw",
      statusBefore: undefined,
      statusAfter: "plugin_installed",
      success: true
    }));
  });
});

function createHarness() {
  const list = vi.fn(async () => ({ executorAvailable: true as const, sources: [source("openclaw"), source("cursor")] }));
  const mutate = vi.fn(async (input: { sourceId: string; kind: "plugin" | "skill"; method: "POST" | "DELETE" }) => ({
    ok: true as const,
    sourceId: input.sourceId,
    status: input.method === "DELETE"
      ? ("not_connected" as const)
      : input.kind === "plugin" ? ("plugin_installed" as const) : ("skill_installed" as const)
  }));
  const analytics = {
    trackPluginInstalled: vi.fn(),
    trackPluginUninstalled: vi.fn(),
    trackSkillInstalled: vi.fn(),
    trackSkillUninstalled: vi.fn(),
    trackPluginConflictDetected: vi.fn(),
    flush: vi.fn(async () => undefined)
  } satisfies AgentSourceLifecycleAnalytics;

  return {
    list,
    mutate,
    analytics,
    service: createAgentSourceConnectionService({
      memoryClient: { listAgentSources: list, mutateAgentSourceConnection: mutate },
      agentSourceAnalytics: analytics,
      getScanPermission: async () => "scan_and_write_skill"
    })
  };
}

function source(sourceId: string): AgentSourceView {
  return {
    sourceId,
    displayName: sourceId,
    dataPath: `/home/user/.${sourceId}`,
    builtin: true,
    available: true,
    status: "not_connected",
    messageCount: 0,
    lastScannedAt: null,
    syncBoundaryAt: null,
    syncReady: false
  };
}
