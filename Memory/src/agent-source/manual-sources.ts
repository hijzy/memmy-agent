import { z } from "zod";
import { MemoryServiceError } from "../utils/error.js";

/**
 * A manual source exists before anyone knows where its history lives: the user
 * names the Agent, then format discovery fills in the path and the recipe.
 */
export const MANUAL_SOURCE_DISCOVERY_PENDING_DATA_PATH = "memmy-agent://history-discovery-pending";

const ManagedSyncFieldMapSchema = z.object({
  messageId: z.string().trim().min(1).optional(),
  conversationId: z.string().trim().min(1).optional(),
  role: z.string().trim().min(1),
  content: z.string().trim().min(1),
  createdAt: z.string().trim().min(1),
  workspacePath: z.string().trim().min(1).optional(),
  gitRoot: z.string().trim().min(1).optional()
});

const ManagedSyncRecipeBaseSchema = z.object({
  version: z.literal(1),
  path: z.string().trim().min(1),
  wslDistro: z.string().trim().min(1).refine((value) => !/[\\/\0]/u.test(value), {
    message: "WSL distribution name must not contain path separators"
  }).optional(),
  fields: ManagedSyncFieldMapSchema,
  roleMap: z.record(z.string(), z.enum(["user", "assistant", "tool", "system"])).optional(),
  timestampFormat: z.enum(["auto", "iso", "unix_seconds", "unix_milliseconds"]).default("auto")
});

export const ManagedSyncRecipeSchema = z.discriminatedUnion("format", [
  ManagedSyncRecipeBaseSchema.extend({
    format: z.literal("jsonl"),
    fileSuffix: z.string().min(1).optional()
  }),
  ManagedSyncRecipeBaseSchema.extend({
    format: z.literal("json"),
    fileSuffix: z.string().min(1).optional(),
    recordsPath: z.string().trim().min(1).optional()
  }),
  ManagedSyncRecipeBaseSchema.extend({
    format: z.literal("sqlite"),
    query: z.string().trim().min(1)
  })
]);
export type ManagedSyncRecipe = z.infer<typeof ManagedSyncRecipeSchema>;

export const AddManualSourceInputSchema = z.object({
  displayName: z.string().trim().min(1).max(120)
});
export type AddManualSourceInput = z.infer<typeof AddManualSourceInputSchema>;

export const ManualSourceUpdateInputSchema = z.object({
  dataPath: z.string().trim().min(1).optional(),
  skillInstalled: z.boolean().optional(),
  syncRecipe: ManagedSyncRecipeSchema.optional()
}).refine((input) =>
  input.dataPath !== undefined ||
  input.skillInstalled !== undefined ||
  input.syncRecipe !== undefined, {
  message: "At least one manual Agent source field is required"
});
export type ManualSourceUpdateInput = z.infer<typeof ManualSourceUpdateInputSchema>;

export const ManualSourceMessageSchema = z.object({
  messageId: z.string().min(1),
  conversationId: z.string().min(1),
  role: z.enum(["user", "assistant", "tool", "system"]),
  content: z.string().min(1),
  createdAt: z.string().datetime(),
  workspacePath: z.string().nullable().optional(),
  gitRoot: z.string().nullable().optional(),
  rawMeta: z.record(z.string(), z.unknown()).optional()
});
export type ManualSourceMessage = z.infer<typeof ManualSourceMessageSchema>;

export const ManualSourceImportInputSchema = z.object({
  mode: z.enum(["initial_subset", "incremental"]),
  messages: z.array(ManualSourceMessageSchema).max(2_000),
  dataPath: z.string().trim().min(1).optional(),
  syncBoundaryAt: z.string().datetime().nullable().optional(),
  latestSeenAt: z.string().datetime().nullable().optional(),
  final: z.boolean().default(false)
});
export type ManualSourceImportInput = z.infer<typeof ManualSourceImportInputSchema>;

export interface ManualSourceImportResult {
  sourceId: string;
  attempted: number;
  written: number;
  deduped: number;
  failed: number;
  memoryIds: string[];
  syncBoundaryAt: string | null;
  errors: Array<{ conversationId: string; reason: string }>;
}

/** Rejects a malformed viewer body the same way the rest of the API does. */
export function parseOrInvalidArgument<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue?.path.join(".");
  throw new MemoryServiceError(
    "invalid_argument",
    `${path ? `${path}: ` : ""}${issue?.message ?? "invalid manual Agent source request"}`
  );
}
