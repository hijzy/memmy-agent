import type { MemoryAddRequest, MemoryLayer } from "../../types.js";
import { stableHash } from "../../utils/id.js";

export function memoryAddKey(request: MemoryAddRequest, layer: MemoryLayer, title: string): string {
  if (isAgentSourceImportMemoryAdd(request) && request.adapterId && request.turnId) return `memory.add:${request.adapterId}:turn:${request.turnId}`;
  if (request.adapterId && request.requestId) return `memory.add:${request.adapterId}:${request.requestId}`;
  return `manual:${stableHash(`${layer}:${title}:${request.content}`).slice(0, 20)}`;
}

export function memoryAddTags(request: MemoryAddRequest, importTrace: boolean, traceTags: string[] = []): string[] {
  return importTrace
    ? uniq([...(request.tags ?? []), ...(request.source ? [request.source] : []), ...traceTags])
    : uniq(["manual", ...(request.source ? [request.source] : []), ...(request.tags ?? [])]);
}

export function isAgentSourceImportMemoryAdd(request: MemoryAddRequest): boolean {
  return request.adapterId?.startsWith("agent-source:") === true || request.tags?.some((tag) => tag.trim().toLowerCase() === "agent-source") === true;
}

function uniq(values: string[]): string[] { return [...new Set(values)]; }
