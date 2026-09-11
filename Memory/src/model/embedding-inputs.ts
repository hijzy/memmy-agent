import { get_encoding } from "tiktoken";

/**
 * Per-input token budget for a single embedding chunk.
 *
 * Inputs are measured with cl100k_base, which is only a proxy for whatever
 * tokenizer the serving model uses. CJK text and code routinely cost 10-20%
 * more on a non-OpenAI vocabulary than cl100k predicts, so the budget sits well
 * under the 8192-token input limit that embedding endpoints commonly enforce:
 * the estimate can be that far wrong without the request being rejected.
 */
export const EMBEDDING_INPUT_TOKEN_BUDGET = 7_000;
const EMBEDDING_BATCH_TOKEN_BUDGET = 290_000;

export interface EmbeddingChunk {
  originalIndex: number;
  tokens: number[];
  input: string | number[];
}

export interface EmbeddingPlan {
  batches: EmbeddingChunk[][];
  chunks: EmbeddingChunk[];
  originalCount: number;
}

export interface EmbeddingPlanOptions {
  model?: string;
  maxInputTokens?: number;
  /** Only OpenAI-shaped endpoints accept token-id arrays in place of text. */
  tokenIdsSupported?: boolean;
}

let encoder: ReturnType<typeof get_encoding> | undefined;

export function planEmbeddingInputs(
  texts: string[],
  options: EmbeddingPlanOptions = {}
): EmbeddingPlan | null {
  const inputTokenBudget = resolveInputTokenBudget(options.maxInputTokens);
  // Explicit budgets retain the historical token-id request shape for
  // deployments that opt into it; opaque aliases use text chunks so their
  // model-specific tokenizer is still applied by the provider.
  const useTokenIds = options.tokenIdsSupported === true &&
    (isKnownOpenAiEmbeddingModel(options.model) || options.maxInputTokens !== undefined);
  encoder ??= get_encoding("cl100k_base");
  const encoded = texts.map((text) => Array.from(encoder!.encode(text, [], [])));
  const totalTokens = encoded.reduce((sum, tokens) => sum + tokens.length, 0);
  if (totalTokens <= EMBEDDING_BATCH_TOKEN_BUDGET &&
    encoded.every((tokens) => tokens.length <= inputTokenBudget)) return null;

  const chunks = encoded.flatMap((tokens, originalIndex) => {
    if (tokens.length === 0) return [{ originalIndex, tokens, input: useTokenIds ? tokens : "" }];
    const tokenBytes = useTokenIds
      ? undefined
      : tokens.map((token) => encoder!.decode_single_token_bytes(token));
    const items: EmbeddingChunk[] = [];
    for (let offset = 0; offset < tokens.length;) {
      let end = Math.min(tokens.length, offset + inputTokenBudget);
      if (!useTokenIds && end < tokens.length) {
        while (end > offset && startsWithContinuationByte(tokenBytes?.[end])) {
          end -= 1;
        }
        if (end === offset) end = Math.min(tokens.length, offset + inputTokenBudget);
      }
      const chunkTokens = tokens.slice(offset, end);
      items.push({
        originalIndex,
        tokens: chunkTokens,
        input: useTokenIds ? chunkTokens : decodeTokenBytes(tokenBytes!.slice(offset, end))
      });
      offset = end;
    }
    return items;
  });
  return {
    batches: batchChunks(chunks),
    chunks,
    originalCount: texts.length
  };
}

export function aggregateEmbeddingVectors(plan: EmbeddingPlan, vectors: number[][]): number[][] {
  if (vectors.length !== plan.chunks.length) {
    throw new Error(`embedding provider returned ${vectors.length} embeddings for ${plan.chunks.length} chunks`);
  }
  return Array.from({ length: plan.originalCount }, (_item, originalIndex) => {
    const entries = plan.chunks
      .map((chunk, index) => ({ chunk, vector: vectors[index]! }))
      .filter((entry) => entry.chunk.originalIndex === originalIndex);
    if (entries.length === 1) return entries[0]!.vector;
    const dimensions = entries[0]?.vector.length ?? 0;
    if (dimensions === 0 || entries.some((entry) => entry.vector.length !== dimensions)) {
      throw new Error("embedding provider returned incompatible embedding dimensions for chunked input");
    }
    const totalWeight = entries.reduce((sum, entry) => sum + Math.max(1, entry.chunk.tokens.length), 0);
    const mean = Array.from({ length: dimensions }, (_value, dimension) =>
      entries.reduce((sum, entry) =>
        sum + entry.vector[dimension]! * Math.max(1, entry.chunk.tokens.length), 0) / totalWeight
    );
    const norm = Math.hypot(...mean);
    return norm > 0 ? mean.map((value) => value / norm) : mean;
  });
}

/** Narrows planned inputs for providers whose request shape is text-only. */
export function requireTextInput(input: string | number[]): string {
  if (typeof input !== "string") {
    throw new Error("embedding provider does not accept token-id input");
  }
  return input;
}

function isKnownOpenAiEmbeddingModel(model?: string): boolean {
  return /(?:^|[/.:])text-embedding-(?:3-(?:small|large)|ada-002)(?:$|[/.:])/i.test(model?.trim() ?? "");
}

function resolveInputTokenBudget(configured?: number): number {
  const explicit = typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : undefined;
  // OpenAI-compatible deployments frequently expose an opaque deployment
  // alias instead of the upstream model id.  We cannot safely assume that
  // alias has a larger context window, so apply the same conservative budget
  // used for known OpenAI embedding models unless the caller opts into a
  // smaller budget explicitly.
  return Math.min(explicit ?? EMBEDDING_INPUT_TOKEN_BUDGET, EMBEDDING_INPUT_TOKEN_BUDGET);
}

function decodeTokenBytes(tokenBytes: Uint8Array[]): string {
  const bytes = tokenBytes.flatMap((value) => Array.from(value));
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function startsWithContinuationByte(bytes: Uint8Array | undefined): boolean {
  const first = bytes?.[0];
  return first !== undefined && (first & 0xc0) === 0x80;
}

function batchChunks(chunks: EmbeddingChunk[]): EmbeddingChunk[][] {
  const batches: EmbeddingChunk[][] = [];
  let current: EmbeddingChunk[] = [];
  let currentTokens = 0;
  for (const chunk of chunks) {
    if (current.length > 0 && currentTokens + chunk.tokens.length > EMBEDDING_BATCH_TOKEN_BUDGET) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(chunk);
    currentTokens += chunk.tokens.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
