/** Agent sources module. */
import {
  AddManualInputSchema,
  AgentSourceAutoInjectResultSchema,
  AgentSourceIdParamsSchema,
  AgentSourceMemoryPluginConflictsResponseSchema,
  AgentSourcePluginActionInputSchema,
  AgentSourceScanInputSchema,
  AgentSourceScanJobResponseSchema,
  AgentSourceScanStatusResponseSchema,
  AgentSourceViewSchema,
  ScanResultPageSchema,
  ManagedAgentSourceImportInputSchema,
  ManagedAgentSourceImportResultSchema,
  ManagedAgentSourceUpdateInputSchema,
  OkResponseSchema
} from "@memmy/local-api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MemoryLayerError } from "../../../outbound/memory-client/errors.js";
import type { MemoryClient } from "../../../outbound/memory-client/types.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";
import type { AgentSourceAutoInjectService } from "../../../../services/agent-source-auto-inject-service.js";
import type { AgentSourceConnectionService } from "../../../../services/agent-source-connection-service.js";
import type { AgentSourceScanRelay } from "../../../../services/agent-source-scan-relay.js";

/**
 * The memory service owns cross-Agent scanning: it holds the watermarks, runs
 * the scans and hands out the job ids. These routes stay as Memmy Desktop's
 * public shape and forward to it, so the two never disagree about a scan.
 */
export interface RegisterAgentSourceRoutesOptions {
  memoryClient: Pick<
    MemoryClient,
    | "listAgentSources"
    | "startAgentSourceScan"
    | "agentSourceScanResults"
    | "pauseAgentSourceScan"
    | "cancelAgentSourceScan"
    | "detectAgentSourcePluginConflicts"
    | "addManualAgentSource"
    | "updateManualAgentSource"
    | "removeManualAgentSource"
    | "importManualAgentSource"
    | "syncManualAgentSource"
  >;
  agentSourceConnections: AgentSourceConnectionService;
  agentSourceAutoInject: AgentSourceAutoInjectService;
  scanRelay: AgentSourceScanRelay;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

/** Registers register agent source routes. */
export function registerAgentSourceRoutes(app: FastifyInstance, options: RegisterAgentSourceRoutesOptions): void {
  app.get(
    "/api/agent-sources",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const output = await options.memoryClient.listAgentSources();
      return reply.send(AgentSourceViewSchema.array().parse(output.sources));
    })
  );

  app.get(
    "/api/agent-sources/memory-plugin-conflicts",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = await options.memoryClient.detectAgentSourcePluginConflicts();
      return reply.send(AgentSourceMemoryPluginConflictsResponseSchema.parse(response));
    })
  );

  app.post(
    "/api/agent-sources/auto-inject/run",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = AgentSourceAutoInjectResultSchema.parse(await options.agentSourceAutoInject.runOnce());
      return reply.send(response);
    })
  );

  app.get(
    "/api/agent-sources/scan/status",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      // Progress events are a liveness hint; this answer is the truth, so it is
      // read from the memory service rather than from what the relay last saw.
      return reply.send(AgentSourceScanStatusResponseSchema.parse(await options.scanRelay.poll()));
    })
  );

  app.get(
    "/api/agent-sources/scan/jobs/:jobId/results",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = request.params as { jobId: string };
      const query = request.query as { cursor?: string; limit?: string };
      const limit = Math.min(500, Math.max(1, Number.parseInt(query.limit ?? "100", 10) || 100));
      const page = await options.memoryClient.agentSourceScanResults({
        jobId: params.jobId,
        cursor: query.cursor ?? "0",
        limit
      });
      return reply.send(ScanResultPageSchema.parse(page));
    })
  );

  app.post(
    "/api/agent-sources/scan",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = AgentSourceScanInputSchema.parse(request.body);
      const jobId = await startScan(input.sourceId, input.mode);
      void options.scanRelay.poll();
      return reply.send(AgentSourceScanJobResponseSchema.parse({ jobId }));
    })
  );

  app.post(
    "/api/agent-sources/scan/stop",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      try {
        await options.memoryClient.pauseAgentSourceScan();
      } catch (error) {
        // Stopping a scan that already ended is what the caller wanted anyway.
        if (!isConflict(error)) throw error;
      }
      await options.scanRelay.poll();
      return reply.send(OkResponseSchema.parse({ ok: true }));
    })
  );

  app.post(
    "/api/agent-sources/scan/cancel",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      await options.memoryClient.cancelAgentSourceScan();
      options.scanRelay.abandon();
      return reply.send(OkResponseSchema.parse({ ok: true }));
    })
  );

  app.post(
    "/api/agent-sources/manual",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = AddManualInputSchema.parse(request.body);
      const response = await options.memoryClient.addManualAgentSource(input);
      return reply.send(AgentSourceViewSchema.parse(response));
    })
  );

  app.post(
    "/api/agent-sources/:sourceId/managed/import",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      const input = ManagedAgentSourceImportInputSchema.parse(request.body);
      const response = await options.memoryClient.importManualAgentSource(params.sourceId, input);
      return reply.send(ManagedAgentSourceImportResultSchema.parse(response));
    })
  );

  app.post(
    "/api/agent-sources/:sourceId/managed/sync",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      const response = await options.memoryClient.syncManualAgentSource(params.sourceId);
      return reply.send(ManagedAgentSourceImportResultSchema.parse(response));
    })
  );

  app.patch(
    "/api/agent-sources/:sourceId/managed",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      const input = ManagedAgentSourceUpdateInputSchema.parse(request.body);
      const response = await options.memoryClient.updateManualAgentSource(params.sourceId, input);
      return reply.send(AgentSourceViewSchema.parse(response));
    })
  );

  app.delete(
    "/api/agent-sources/:sourceId",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      await options.memoryClient.removeManualAgentSource(params.sourceId);
      return reply.send(OkResponseSchema.parse({ ok: true }));
    })
  );

  app.post(
    "/api/agent-sources/:sourceId/skill",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      await options.agentSourceConnections.connect(params.sourceId, "skill");
      return reply.send(OkResponseSchema.parse({ ok: true }));
    })
  );

  app.delete(
    "/api/agent-sources/:sourceId/skill",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      await options.agentSourceConnections.disconnect(params.sourceId, "skill");
      return reply.send(OkResponseSchema.parse({ ok: true }));
    })
  );

  app.post(
    "/api/agent-sources/:sourceId/plugin",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      const action = AgentSourcePluginActionInputSchema.parse(request.body ?? {});
      await options.agentSourceConnections.connect(params.sourceId, "plugin", action.installType);
      return reply.send(OkResponseSchema.parse({ ok: true }));
    })
  );

  app.delete(
    "/api/agent-sources/:sourceId/plugin",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      const action = AgentSourcePluginActionInputSchema.parse(request.body ?? {});
      await options.agentSourceConnections.disconnect(params.sourceId, "plugin", action.installType);
      return reply.send(OkResponseSchema.parse({ ok: true }));
    })
  );

  /**
   * Asking to scan while a scan is running used to join the running job rather
   * than fail, and the Desktop UI still counts on that.
   */
  async function startScan(sourceId: string, mode?: "initial_subset" | "incremental" | "full"): Promise<string> {
    try {
      const accepted = await options.memoryClient.startAgentSourceScan({
        sourceId,
        ...(mode ? { mode } : {}),
        origin: "app"
      });
      return accepted.jobId;
    } catch (error) {
      if (!isConflict(error)) throw error;
      const running = await options.scanRelay.poll();
      if (running.active && running.progress) return running.progress.jobId;
      throw error;
    }
  }
}

function isConflict(error: unknown): boolean {
  return error instanceof MemoryLayerError && error.code === "conflict";
}
