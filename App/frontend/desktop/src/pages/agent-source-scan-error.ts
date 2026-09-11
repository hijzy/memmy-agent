import type { AgentSourceView, ScanResult } from "@memmy/local-api-contracts";
import { ApiRequestError } from "../api/http.js";
import type { MessageKey } from "../i18n/messages.js";
import { agentSourceDisplayName } from "./agent-source-logos.js";

export type AgentSourceScanErrorTranslator = (
  key: MessageKey,
  values?: Record<string, string | number>
) => string;

export function formatScanCompletedError(
  results: readonly ScanResult[],
  sources: readonly AgentSourceView[],
  t: AgentSourceScanErrorTranslator
): string | null {
  const messages = results.flatMap((result) => formatScanResult(result, sources, t));
  const uniqueMessages = [...new Set(messages)];
  return uniqueMessages.length > 0 ? uniqueMessages.join("; ") : null;
}

/**
 * A missing path or an unavailable source blocks the whole scan and needs the
 * user to act, so it stays a failure. Anything else is a per-item failure: the
 * memories that landed are kept and the scan watermark is held back so the rest
 * are picked up next time, which is a retry notice rather than a failure.
 */
function formatScanResult(
  result: ScanResult,
  sources: readonly AgentSourceView[],
  t: AgentSourceScanErrorTranslator
): string[] {
  const blocking = result.errors
    .map((error) => formatBlockingScanError(result.sourceId, error.reason, sources, t))
    .filter((message): message is string => message !== null);
  if (blocking.length > 0 || result.errors.length === 0) {
    return [...new Set(blocking)];
  }

  if (result.sourceId === "all") {
    return [t("memory.scanFailed")];
  }

  const source = sources.find((candidate) => candidate.sourceId === result.sourceId);
  const agent = source?.displayName ?? agentSourceDisplayName(result.sourceId);
  const imported = result.memoryIdCount ?? result.memoryIds?.length ?? 0;
  if (imported === 0) {
    return [t("memory.scanSourceFailed", { agent })];
  }
  return [t("memory.scanSourcePartial", { agent, count: result.errorCount ?? result.errors.length })];
}

export function formatAgentSourceScanRequestError(
  error: unknown,
  source: AgentSourceView | undefined,
  t: AgentSourceScanErrorTranslator
): string {
  const reason = error instanceof Error ? error.message : String(error);
  const missingPath = extractMissingScanPath(reason);
  if (missingPath) {
    return t("memory.scanPathNotFound", { path: missingPath });
  }

  if (error instanceof ApiRequestError && error.code === "agent_source_unavailable") {
    return source?.dataPath
      ? t("memory.scanPathNotFound", { path: source.dataPath })
      : t("memory.scanSourcePathNotFound", { agent: source?.displayName ?? t("common.unknown") });
  }

  return source
    ? t("memory.scanSourceFailed", { agent: source.displayName })
    : t("memory.scanFailed");
}

function formatBlockingScanError(
  sourceId: string,
  reason: string,
  sources: readonly AgentSourceView[],
  t: AgentSourceScanErrorTranslator
): string | null {
  const missingPath = extractMissingScanPath(reason);
  if (missingPath) {
    return t("memory.scanPathNotFound", { path: missingPath });
  }

  if (!isSourceUnavailableReason(reason)) {
    return null;
  }

  const source = sources.find((candidate) => candidate.sourceId === sourceId);
  return source?.dataPath
    ? t("memory.scanPathNotFound", { path: source.dataPath })
    : t("memory.scanSourcePathNotFound", {
        agent: source?.displayName ?? agentSourceDisplayName(sourceId)
      });
}

function extractMissingScanPath(reason: string): string | null {
  if (!reason.includes("ENOENT")) {
    return null;
  }

  const operationMatch = reason.match(
    /\b(?:access|lstat|mkdir|open|opendir|readlink|realpath|scandir|stat)\s+(['"])(.*?)\1/u
  );
  if (operationMatch?.[2]?.trim()) {
    return operationMatch[2].trim();
  }

  const quotedPathMatch = reason.match(/\bENOENT\b[\s\S]*?(['"])(.*?)\1/u);
  return quotedPathMatch?.[2]?.trim() || null;
}

function isSourceUnavailableReason(reason: string): boolean {
  return /not installed or its directory is unavailable/iu.test(reason);
}
