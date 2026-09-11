/** Types module. */
import type {
  AddManualInput,
  AddMemoryInput,
  AddMemoryOutput,
  AgentSourceScanMode,
  AgentSourceScanOrigin,
  AgentSourceMemoryPluginConflictsResponse,
  AgentSourceView,
  CloseSessionInput,
  CloseSessionOutput,
  DeleteMemoryInput,
  DeleteMemoryOutput,
  DeletePanelTaskOutput,
  CompleteTurnInput,
  CompleteTurnOutput,
  EnqueueImportSummariesOutput,
  GetMemoryOutput,
  ManagedAgentSourceImportInput,
  ManagedAgentSourceImportResult,
  ManagedAgentSourceUpdateInput,
  MemoryAgentSourceConnectionOutput,
  MemoryAgentSourceListOutput,
  MemoryAgentSourceScanAccepted,
  MemoryAgentSourceScanStatus,
  MemoryApiLogsInput,
  MemoryApiLogsOutput,
  MemoryHealthSnapshot,
  MemoryOnboardingConversationOutput,
  MemoryOnboardingSampleOutput,
  MemoryPatchConfigInput,
  MemoryPatchConfigOutput,
  MemoryProcessingStatusOutput,
  MemoryReloadConfigInput,
  MemoryReloadConfigOutput,
  OkResponse,
  RecallEvidenceOutput,
  ScanResultPage,
  PanelAnalysisOutput,
  PanelItemsInput,
  PanelItemsOutput,
  PanelOverviewOutput,
  PanelTasksInput,
  PanelTasksOutput,
  OpenSessionInput,
  OpenSessionOutput,
  SearchInput,
  SearchOutput,
  StartTurnInput,
  StartTurnOutput,
  RetryMemoryProcessingOutput,
  WorkerRunOutput
} from "@memmy/local-api-contracts";

/** Contract for memory client. */
export interface MemoryRequestContext {
  timeZone?: string;
  userId?: string;
}

export interface MemoryClient {
  health(): Promise<MemoryHealthSnapshot>;
  reloadConfig(input?: MemoryReloadConfigInput): Promise<MemoryReloadConfigOutput>;
  /** Edits memory-service-owned config sections; the service writes the YAML and reloads itself. */
  patchConfig(input: MemoryPatchConfigInput): Promise<MemoryPatchConfigOutput>;
  exportBundle?(): Promise<Record<string, unknown>>;
  clearAllData?(): Promise<{ ok: true; clearedAt: string; cleared: Record<string, number> }>;

  openSession(input: OpenSessionInput, context?: MemoryRequestContext): Promise<OpenSessionOutput>;
  closeSession(input: CloseSessionInput & { sessionId: string }, context?: MemoryRequestContext): Promise<CloseSessionOutput>;

  startTurn(input: StartTurnInput, context?: MemoryRequestContext): Promise<StartTurnOutput>;
  completeTurn(input: CompleteTurnInput & { turnId: string }, context?: MemoryRequestContext): Promise<CompleteTurnOutput>;

  search(input: SearchInput, context?: MemoryRequestContext): Promise<SearchOutput>;
  addMemory(input: AddMemoryInput, context?: MemoryRequestContext): Promise<AddMemoryOutput>;
  getMemory(input: { memoryId: string }, context?: MemoryRequestContext): Promise<GetMemoryOutput>;
  deleteMemory(input: DeleteMemoryInput & { memoryId: string }, context?: MemoryRequestContext): Promise<DeleteMemoryOutput>;
  recallEvidence(queryId: string, context?: MemoryRequestContext): Promise<RecallEvidenceOutput>;

  enqueueImportSummaries(memoryIds?: string[]): Promise<EnqueueImportSummariesOutput>;
  getMemoryProcessingStatus(memoryIds: string[]): Promise<MemoryProcessingStatusOutput>;
  retryMemoryProcessing(memoryId: string): Promise<RetryMemoryProcessingOutput>;
  runWorker(input: {
    limit: number;
    targetMemoryIds?: string[];
    priorityCohortOnly?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<WorkerRunOutput>;

  panelOverview(context?: MemoryRequestContext): Promise<PanelOverviewOutput>;
  panelAnalysis(context?: MemoryRequestContext): Promise<PanelAnalysisOutput>;
  panelItems(input: PanelItemsInput, context?: MemoryRequestContext): Promise<PanelItemsOutput>;
  panelTasks(input: PanelTasksInput, context?: MemoryRequestContext): Promise<PanelTasksOutput>;
  deletePanelTask(taskId: string, context?: MemoryRequestContext): Promise<DeletePanelTaskOutput>;
  memoryApiLogs(input: MemoryApiLogsInput, context?: MemoryRequestContext): Promise<MemoryApiLogsOutput>;

  /**
   * Cross-Agent scanning lives in the memory service, next to the memories it
   * writes. Memmy Desktop forwards its own Agent source routes to these.
   */
  listAgentSources(): Promise<MemoryAgentSourceListOutput>;
  startAgentSourceScan(input: {
    sourceId: string;
    mode?: AgentSourceScanMode;
    origin: AgentSourceScanOrigin;
  }): Promise<MemoryAgentSourceScanAccepted>;
  agentSourceScanStatus(): Promise<MemoryAgentSourceScanStatus>;
  agentSourceScanResults(input: { jobId: string; cursor?: string; limit?: number }): Promise<ScanResultPage>;
  pauseAgentSourceScan(): Promise<OkResponse>;
  cancelAgentSourceScan(): Promise<OkResponse>;
  mutateAgentSourceConnection(input: {
    sourceId: string;
    kind: "plugin" | "skill";
    method: "POST" | "DELETE";
  }): Promise<MemoryAgentSourceConnectionOutput>;
  detectAgentSourcePluginConflicts(): Promise<AgentSourceMemoryPluginConflictsResponse>;
  /**
   * The first-login report reads other Agents' recent history, which only the
   * memory service does. It samples every Agent, then asks for the newest
   * conversation it found.
   */
  sampleOnboardingHistory(
    input: { maxQueries?: number; maxQueryChars?: number; deadlineMs?: number },
    context?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<MemoryOnboardingSampleOutput>;
  readOnboardingConversation(
    input: {
      sourceId: string;
      displayName: string;
      conversationId: string;
      latestActivityAt: string;
      workspacePath: string | null;
      maxQueryChars?: number;
      deadlineMs?: number;
    },
    context?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<MemoryOnboardingConversationOutput>;
  addManualAgentSource(input: AddManualInput): Promise<AgentSourceView>;
  updateManualAgentSource(sourceId: string, input: ManagedAgentSourceUpdateInput): Promise<AgentSourceView>;
  removeManualAgentSource(sourceId: string): Promise<OkResponse>;
  importManualAgentSource(sourceId: string, input: ManagedAgentSourceImportInput): Promise<ManagedAgentSourceImportResult>;
  syncManualAgentSource(sourceId: string): Promise<ManagedAgentSourceImportResult>;
}
