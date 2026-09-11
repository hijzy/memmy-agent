/** Http memory client module. */
import {
  AddMemoryOutputSchema,
  AgentSourceMemoryPluginConflictsResponseSchema,
  AgentSourceViewSchema,
  ApiErrorBodySchema,
  CloseSessionOutputSchema,
  CompleteTurnOutputSchema,
  DeleteMemoryOutputSchema,
  DeletePanelTaskOutputSchema,
  EnqueueImportSummariesOutputSchema,
  GetMemoryOutputSchema,
  ManagedAgentSourceImportResultSchema,
  MemoryAgentSourceConnectionOutputSchema,
  MemoryAgentSourceListOutputSchema,
  MemoryAgentSourceScanAcceptedSchema,
  MemoryAgentSourceScanStatusSchema,
  MemoryApiLogsOutputSchema,
  MemoryHealthSnapshotSchema,
  MemoryPatchConfigOutputSchema,
  MemoryProcessingStatusOutputSchema,
  MemoryReloadConfigOutputSchema,
  OkResponseSchema,
  RecallEvidenceOutputSchema,
  ScanResultPageSchema,
  PanelAnalysisOutputSchema,
  PanelItemsOutputSchema,
  PanelOverviewOutputSchema,
  PanelTasksOutputSchema,
  OpenSessionOutputSchema,
  SearchOutputSchema,
  StartTurnOutputSchema,
  RetryMemoryProcessingOutputSchema,
  WorkerRunOutputSchema
} from "@memmy/local-api-contracts";
import { z, type ZodType } from "zod";
import { MemoryLayerError, MemoryLayerNetworkError } from "./errors.js";
import { buildMemoryLayerUrl, MEMORY_LAYER_PATHS } from "./memory-layer-endpoints.js";
import { retryWithBackoff } from "./retry.js";
import type { MemoryClient, MemoryRequestContext } from "./types.js";
import { normalizeTimeZoneOffset } from "../../../utils/time-zone.js";

export interface MemoryLayerConfig {
  /** Base url. */
  baseUrl: string;
  /** Token. */
  token: string;
  /** Timeout ms. */
  timeoutMs: number;
  /** Max retries. */
  maxRetries: number;
}

export interface CreateHttpMemoryClientOptions {
  /** Fetch impl. */
  fetchImpl?: typeof fetch;
}

type PathKey = keyof typeof MEMORY_LAYER_PATHS;

/** Creates create http memory client. */
export function createHttpMemoryClient(
  config: MemoryLayerConfig,
  options: CreateHttpMemoryClientOptions = {}
): MemoryClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  async function request<Output>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    pathKey: PathKey,
    responseSchema: ZodType<Output>,
    requestOptions: {
      body?: unknown;
      params?: Readonly<Record<string, string>>;
      query?: Readonly<Record<string, unknown>>;
      headers?: Readonly<Record<string, string>>;
      signal?: AbortSignal;
      timeoutMs?: number;
      maxRetries?: number;
      context?: MemoryRequestContext;
    } = {}
  ): Promise<Output> {
    const url = appendQuery(buildMemoryLayerUrl(config.baseUrl, pathKey, requestOptions.params), requestOptions.query);

    const json = await retryWithBackoff(
      async () => {
        const timeoutSignal = AbortSignal.timeout(requestOptions.timeoutMs ?? config.timeoutMs);
        const hasBody = requestOptions.body !== undefined;
        const response = await fetchWithMappedNetworkErrors(fetchImpl, url, {
          method,
          headers: {
            ...(hasBody ? { "content-type": "application/json" } : {}),
            "x-memmy-time-zone": normalizeTimeZoneOffset(requestOptions.context?.timeZone),
            ...(requestOptions.context?.userId ? { "x-memmy-user-id": requestOptions.context.userId } : {}),
            authorization: `Bearer ${config.token}`,
            ...requestOptions.headers
          },
          body: hasBody ? JSON.stringify(requestOptions.body) : undefined,
          signal: combineAbortSignals(timeoutSignal, requestOptions.signal)
        });

        if (response.ok) {
          return response.json();
        }

        if (response.status >= 500) {
          throw new MemoryLayerError("memory_layer_unavailable", 503, "memory layer 5xx");
        }

        const rawBody = await response.json().catch(() => undefined);
        const parsed = ApiErrorBodySchema.safeParse(rawBody);
        if (parsed.success) {
          throw new MemoryLayerError(parsed.data.error.code, response.status, parsed.data.error.message);
        }
        throw new MemoryLayerError(
          response.status >= 500 ? "memory_layer_unavailable" : "internal",
          response.status,
          "memory layer returned an unrecognized error response",
          rawBody
        );
      },
      {
        maxRetries: requestOptions.maxRetries ?? config.maxRetries,
        baseDelayMs: 100,
        factor: 3,
        jitter: 0.2,
        shouldRetry: shouldRetryMemoryLayerError
      }
    );

    return responseSchema.parse(json);
  }

  return {
    async health() {
      return request("GET", "health", MemoryHealthSnapshotSchema);
    },

    async reloadConfig(input = {}) {
      return request("POST", "reloadConfig", MemoryReloadConfigOutputSchema, { body: input });
    },

    async patchConfig(input) {
      // The config route belongs to the memory service's local Viewer API,
      // which rejects state-changing requests without this marker header
      // (its CSRF guard, not an auth token).
      return request("PATCH", "patchConfig", MemoryPatchConfigOutputSchema, {
        body: { config: input },
        headers: { "x-memmy-viewer": "1" }
      });
    },

    async exportBundle() {
      return request("GET", "exportBundle", z.record(z.string(), z.unknown()));
    },

    async clearAllData() {
      return request("DELETE", "clearAllData", z.object({
        ok: z.literal(true),
        clearedAt: z.string(),
        cleared: z.record(z.string(), z.number())
      }), { body: {} });
    },

    async openSession(input, context) {
      return request("POST", "openSession", OpenSessionOutputSchema, { body: input, context });
    },

    async closeSession(input, context) {
      const { sessionId, ...body } = input;
      return request("POST", "closeSession", CloseSessionOutputSchema, {
        params: { sessionId },
        body,
        context
      });
    },

    async startTurn(input, context) {
      return request("POST", "startTurn", StartTurnOutputSchema, { body: input, context });
    },

    async completeTurn(input, context) {
      const { turnId, ...body } = input;
      return request("POST", "completeTurn", CompleteTurnOutputSchema, {
        params: { turnId },
        body,
        context
      });
    },

    async search(input, context) {
      return request("POST", "search", SearchOutputSchema, { body: input, context });
    },

    async addMemory(input, context) {
      return request("POST", "addMemory", AddMemoryOutputSchema, { body: input, context });
    },

    async getMemory(input, context) {
      return request("GET", "getMemory", GetMemoryOutputSchema, {
        params: { id: input.memoryId },
        context
      });
    },

    async deleteMemory(input, context) {
      const { memoryId, ...body } = input;
      return request("DELETE", "deleteMemory", DeleteMemoryOutputSchema, {
        params: { id: memoryId },
        body,
        context
      });
    },

    async recallEvidence(queryId, context) {
      return request("GET", "recallEvidence", RecallEvidenceOutputSchema, {
        params: { queryId },
        context
      });
    },

    async enqueueImportSummaries(memoryIds) {
      return request("POST", "enqueueImportSummaries", EnqueueImportSummariesOutputSchema, {
        body: memoryIds ? { memoryIds } : {}
      });
    },

    async getMemoryProcessingStatus(memoryIds) {
      return request("POST", "memoryProcessingStatus", MemoryProcessingStatusOutputSchema, {
        body: { memoryIds }
      });
    },

    async retryMemoryProcessing(memoryId) {
      return request("POST", "retryMemoryProcessing", RetryMemoryProcessingOutputSchema, {
        params: { id: memoryId },
        body: {}
      });
    },

    async runWorker(input) {
      return request("POST", "runWorker", WorkerRunOutputSchema, {
        body: {
          limit: input.limit,
          targetMemoryIds: input.targetMemoryIds,
          priorityCohortOnly: input.priorityCohortOnly
        },
        signal: input.signal,
        timeoutMs: input.timeoutMs,
        maxRetries: 0
      });
    },

    async panelOverview(context) {
      return request("GET", "panelOverview", PanelOverviewOutputSchema, { context, maxRetries: 0 });
    },

    async panelAnalysis(context) {
      return request("GET", "panelAnalysis", PanelAnalysisOutputSchema, { context, maxRetries: 0 });
    },

    async panelItems(input, context) {
      return request("GET", "panelItems", PanelItemsOutputSchema, { query: input, context });
    },

    async panelTasks(input, context) {
      return request("GET", "panelTasks", PanelTasksOutputSchema, { query: input, context });
    },

    async deletePanelTask(taskId, context) {
      return request("DELETE", "deletePanelTask", DeletePanelTaskOutputSchema, {
        params: { id: taskId },
        body: {},
        context
      });
    },

    async memoryApiLogs(input, context) {
      return request("GET", "memoryApiLogs", MemoryApiLogsOutputSchema, {
        context,
        query: {
          ...input,
          tools: input.tools?.join(",")
        }
      });
    },

    async listAgentSources() {
      return request("GET", "agentSources", MemoryAgentSourceListOutputSchema);
    },

    async startAgentSourceScan(input) {
      // Starting a scan twice would not be idempotent: the second request is
      // rejected as a conflict, or worse, taken as approval to import a batch
      // the user has not seen.
      return request("POST", "agentSourceScan", MemoryAgentSourceScanAcceptedSchema, {
        body: input,
        headers: VIEWER_WRITE_HEADERS,
        maxRetries: 0
      });
    },

    async agentSourceScanStatus() {
      // Polled while a scan runs, so a stalled retry chain would be worse than
      // a missed sample.
      return request("GET", "agentSourceScanStatus", MemoryAgentSourceScanStatusSchema, { maxRetries: 0 });
    },

    async agentSourceScanResults(input) {
      return request("GET", "agentSourceScanResults", ScanResultPageSchema, {
        params: { jobId: input.jobId },
        query: { cursor: input.cursor, limit: input.limit }
      });
    },

    async pauseAgentSourceScan() {
      return request("POST", "agentSourceScanStop", OkResponseSchema, {
        body: {},
        headers: VIEWER_WRITE_HEADERS
      });
    },

    async cancelAgentSourceScan() {
      return request("POST", "agentSourceScanCancel", OkResponseSchema, {
        body: {},
        headers: VIEWER_WRITE_HEADERS
      });
    },

    async mutateAgentSourceConnection(input) {
      return request(input.method, input.kind === "plugin" ? "agentSourcePlugin" : "agentSourceSkill", MemoryAgentSourceConnectionOutputSchema, {
        params: { id: input.sourceId },
        body: {},
        headers: VIEWER_WRITE_HEADERS
      });
    },

    async detectAgentSourcePluginConflicts() {
      return request("GET", "agentSourcePluginConflicts", AgentSourceMemoryPluginConflictsResponseSchema);
    },

    async addManualAgentSource(input) {
      return request("POST", "agentSourceManual", AgentSourceViewSchema, {
        body: input,
        headers: VIEWER_WRITE_HEADERS,
        maxRetries: 0
      });
    },

    async updateManualAgentSource(sourceId, input) {
      return request("PATCH", "agentSource", AgentSourceViewSchema, {
        params: { id: sourceId },
        body: input,
        headers: VIEWER_WRITE_HEADERS
      });
    },

    async removeManualAgentSource(sourceId) {
      return request("DELETE", "agentSource", OkResponseSchema, {
        params: { id: sourceId },
        body: {},
        headers: VIEWER_WRITE_HEADERS
      });
    },

    async importManualAgentSource(sourceId, input) {
      // Each page advances the sync boundary, so a retried page would be
      // counted twice.
      return request("POST", "agentSourceImport", ManagedAgentSourceImportResultSchema, {
        params: { id: sourceId },
        body: input,
        headers: VIEWER_WRITE_HEADERS,
        maxRetries: 0
      });
    },

    async syncManualAgentSource(sourceId) {
      return request("POST", "agentSourceSync", ManagedAgentSourceImportResultSchema, {
        params: { id: sourceId },
        body: {},
        headers: VIEWER_WRITE_HEADERS,
        maxRetries: 0
      });
    }
  };
}

/**
 * Agent source routes belong to the memory service's local Viewer API, which
 * rejects state-changing requests without this marker header (its CSRF guard,
 * not an auth token) and requires a JSON content type, which is why the
 * bodiless calls above still send `{}`.
 */
const VIEWER_WRITE_HEADERS = Object.freeze({ "x-memmy-viewer": "1" });

function combineAbortSignals(primary: AbortSignal, secondary: AbortSignal | undefined): AbortSignal {
  if (!secondary) {
    return primary;
  }

  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([primary, secondary]);
  }

  return secondary.aborted ? secondary : primary;
}

/**
 * Executes fetch and maps network/timeout errors into MemoryClient errors.
 *
 * @param fetchImpl fetch implementation.
 * @param url request URL.
 * @param init fetch init.
 * @returns the fetch Response.
 */
async function fetchWithMappedNetworkErrors(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new MemoryLayerError("memory_layer_unavailable", 503, "memory layer timeout", error);
    }

    throw new MemoryLayerNetworkError(error);
  }
}

/**
 * Determines whether the error comes from a request timeout or abort.
 *
 * @param error the caught fetch error.
 * @returns whether it should be handled as a 503 timeout.
 */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/**
 * Determines whether a MemoryClient error is retryable.
 *
 * @param error the caught error.
 * @returns whether it should be retried.
 */
function shouldRetryMemoryLayerError(error: unknown): boolean {
  return (
    error instanceof MemoryLayerNetworkError ||
    (error instanceof MemoryLayerError && error.status >= 500)
  );
}

/**
 * Appends query parameters to a GET URL.
 *
 * @param url the original URL.
 * @param query the query object.
 * @returns the URL with the query appended.
 */
function appendQuery(url: string, query: Readonly<Record<string, unknown>> | undefined): string {
  if (!query) {
    return url;
  }

  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    appendQueryValue(parsed, key, value);
  }

  return parsed.toString();
}

/**
 * Appends a single query value; arrays are expanded into repeated keys.
 *
 * @param url the URL object.
 * @param key query key.
 * @param value query value.
 */
function appendQueryValue(url: URL, key: string, value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendQueryValue(url, key, item);
    }
    return;
  }

  if (typeof value === "object") {
    url.searchParams.append(key, JSON.stringify(value));
    return;
  }

  url.searchParams.append(key, String(value));
}
