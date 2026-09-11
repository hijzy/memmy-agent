import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import { createOnboardingSampleService } from "../src/agent-source/onboarding/index.js";
import {
  createBuiltinOnboardingSamplers,
  createCodexSampler,
  createWorkbuddySampler
} from "../src/agent-source/onboarding/samplers.js";
import { createSourceRegistryConversationWindowReader } from "../src/agent-source/onboarding/conversation-window.js";
import type { OnboardingSampleResult, OnboardingSampler } from "../src/agent-source/onboarding/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("agent source onboarding samplers", () => {
  it("samples all ten built-in Agents", () => {
    expect(createBuiltinOnboardingSamplers().map((sampler) => sampler.sourceId)).toEqual([
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
  });

  /** Rollouts embed whole tool payloads, which are expensive to even parse. */
  it("screens Codex tool records before JSON.parse sees them", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-codex-onboarding-sample-"));
    roots.push(root);
    writeFileSync(
      join(root, "rollout-2026-06-29T10-00-00-00000000-0000-4000-8000-000000000001.jsonl"),
      [
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-29T10:00:01.000Z",
          payload: { type: "custom_tool_call", name: "deep_tool", input: { sentinel: "deep-tool-sentinel" } }
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-29T10:00:02.000Z",
          cwd: "/tmp/project",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "首登采样要跳过 Codex 的 tool 原始记录。" }] }
        })
      ].join("\n"),
      "utf8"
    );

    const parseJson = JSON.parse.bind(JSON);
    vi.spyOn(JSON, "parse").mockImplementation(((input: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (input.includes("deep-tool-sentinel")) {
        throw new RangeError("Maximum call stack size exceeded");
      }
      return parseJson(input, reviver);
    }) as typeof JSON.parse);

    const result = await createCodexSampler({ root }).sampleRecentUserQueries(sampleOptions());

    expect(result.errors).toEqual([]);
    expect(result.queries).toHaveLength(1);
    expect(result.queries[0]).toMatchObject({
      sourceId: "codex",
      text: "首登采样要跳过 Codex 的 tool 原始记录。",
      workspacePath: "/tmp/project"
    });
  });

  it("reads user messages out of both WorkBuddy history shapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-workbuddy-onboarding-sample-"));
    roots.push(root);
    writeFileSync(join(root, "current.jsonl"), [
      JSON.stringify({ type: "function_call_result", role: "tool", output: { text: "large tool output" } }),
      JSON.stringify({ type: "message", role: "user", id: "current-user", sessionId: "current-session", timestamp: 1_784_170_100_000, cwd: "/current", content: [{ type: "input_text", text: "Current WorkBuddy question" }] }),
      JSON.stringify({ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] })
    ].join("\n"), "utf8");
    writeFileSync(join(root, "migrated.jsonl"), JSON.stringify({
      role: "human",
      uuid: "migrated-user",
      conversationId: "migrated-session",
      createdAt: "2026-07-15T10:00:00.000Z",
      message: JSON.stringify({ content: [{ type: "text", text: "Migrated WorkBuddy question" }] })
    }), "utf8");

    const result = await createWorkbuddySampler({ root }).sampleRecentUserQueries(sampleOptions());

    expect(result.sourceId).toBe("workbuddy");
    expect(result.queries.map((query) => query.text).sort()).toEqual([
      "Current WorkBuddy question",
      "Migrated WorkBuddy question"
    ]);
    expect(result.recentMessages?.some((message) => message.role === "assistant")).toBe(true);
  });
});

describe("agent source onboarding sample service", () => {
  it("returns the Agents that answered and leaves out the ones that are not installed", async () => {
    const service = createOnboardingSampleService({
      sourceRegistry: createSourceRegistry([]),
      samplers: [
        fakeSampler("cursor", { queries: 2 }),
        { sourceId: "codex", displayName: "Codex", detect: async () => false, sampleRecentUserQueries: async () => { throw new Error("must not sample"); } }
      ]
    });

    const { samples } = await service.sample({});

    expect(samples.map((sample) => sample.sourceId)).toEqual(["cursor"]);
    expect(samples[0]?.queries).toHaveLength(2);
  });

  /** A report missing one Agent is still a report; one that never arrives is not. */
  it("drops an Agent that overruns the deadline and keeps the rest", async () => {
    const service = createOnboardingSampleService({
      sourceRegistry: createSourceRegistry([]),
      samplers: [
        {
          sourceId: "openclaw",
          displayName: "OpenClaw",
          detect: async () => true,
          sampleRecentUserQueries: () => new Promise<OnboardingSampleResult>(() => undefined)
        },
        fakeSampler("cursor", { queries: 1 })
      ]
    });

    const { samples } = await service.sample({ deadlineMs: 20 });

    expect(samples.map((sample) => sample.sourceId)).toEqual(["cursor"]);
  });

  it("reports an unreadable Agent as an error row rather than failing the sample", async () => {
    const service = createOnboardingSampleService({
      sourceRegistry: createSourceRegistry([]),
      samplers: [{
        sourceId: "hermes",
        displayName: "Hermes",
        detect: async () => true,
        sampleRecentUserQueries: async () => { throw new Error("state.db is locked"); }
      }]
    });

    const { samples } = await service.sample({});

    expect(samples).toEqual([expect.objectContaining({
      sourceId: "hermes",
      queries: [],
      errors: [{ target: "hermes", reason: "state.db is locked" }]
    })]);
  });

  it("clamps a caller's sampling budget", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const service = createOnboardingSampleService({
      sourceRegistry: createSourceRegistry([]),
      samplers: [{
        sourceId: "cursor",
        displayName: "Cursor",
        detect: async () => true,
        async sampleRecentUserQueries(options) {
          seen.push({ maxQueries: options.maxQueries, maxSessionFiles: options.maxSessionFiles });
          return { sourceId: "cursor", displayName: "Cursor", recentSessionCount: 0, latestActivityAt: null, queries: [], errors: [] };
        }
      }]
    });

    await service.sample({ maxQueries: 5_000, maxSessionFiles: -3 });

    expect(seen).toEqual([{ maxQueries: 64, maxSessionFiles: 6 }]);
  });

  it("answers with no conversation for an Agent it has no adapter for", async () => {
    const service = createOnboardingSampleService({ sourceRegistry: createSourceRegistry([]) });

    await expect(service.readConversation({ sourceId: "manual-1", conversationId: "c-1" }))
      .resolves.toEqual({ conversation: null });
  });

  it("rejects a conversation request without a conversation id", async () => {
    const service = createOnboardingSampleService({ sourceRegistry: createSourceRegistry([]) });

    await expect(service.readConversation({ sourceId: "codex" })).rejects.toThrow("conversationId is required");
  });
});

describe("agent source onboarding conversation window", () => {
  it("keeps the first two and last twelve turns and thins out the tool chatter", async () => {
    const baseTime = Date.parse("2026-07-20T10:00:00.000Z");
    const messages = Array.from({ length: 15 }, (_, index) => [
      conversationMessage(`user-${index}`, "user", `user ${index}`),
      conversationMessage(`tool-${index}`, "tool", `Tool: shell\n${"x".repeat(700)}\nStatus: success`),
      conversationMessage(`assistant-${index}`, "assistant", `assistant ${index}`)
    ]).flat().map((message, index) => ({
      ...message,
      createdAt: new Date(baseTime + index * 1000).toISOString()
    }));
    const reader = createSourceRegistryConversationWindowReader(createSourceRegistry([{
      descriptor: { sourceId: "codex", displayName: "Codex", builtin: true, dataPath: "/tmp/codex" },
      detect: async () => true,
      async *scan() {
        yield* messages;
      }
    }]));

    const window = await reader.readConversation({
      sourceId: "codex",
      displayName: "Codex",
      conversationId: "latest-conversation",
      latestActivityAt: messages.at(-1)?.createdAt ?? new Date(baseTime).toISOString(),
      workspacePath: "/tmp/project"
    }, { maxQueryChars: 600, deadlineMs: 5_000 });

    expect(window?.messages.filter((message) => message.role === "user").map((message) => message.messageId))
      .toEqual(["user-0", "user-1", ...Array.from({ length: 12 }, (_, index) => `user-${index + 3}`)]);
    expect(window?.messages.filter((message) => message.role === "assistant")).toHaveLength(14);
    expect(window?.messages.find((message) => message.role === "tool")?.text.length).toBeLessThanOrEqual(405);
    expect(window?.messages.find((message) => message.role === "tool")?.text).toContain("Status: success");
  });
});

function sampleOptions() {
  return { maxSessionFiles: 10, maxQueries: 10, maxQueryChars: 500, maxBytesPerFile: 64 * 1024, deadlineMs: 5_000 };
}

function fakeSampler(sourceId: string, input: { queries: number }): OnboardingSampler {
  return {
    sourceId,
    displayName: sourceId,
    detect: async () => true,
    async sampleRecentUserQueries() {
      const queries = Array.from({ length: input.queries }, (_, index) => ({
        sourceId,
        conversationId: "c-1",
        messageId: `m-${index}`,
        createdAt: new Date(Date.parse("2026-07-20T10:00:00.000Z") + index * 1000).toISOString(),
        text: `question ${index}`,
        workspacePath: null
      }));
      return {
        sourceId,
        displayName: sourceId,
        recentSessionCount: 1,
        latestActivityAt: queries.at(-1)?.createdAt ?? null,
        queries,
        recentMessages: queries.map((query) => ({ ...query, role: "user" as const })),
        errors: []
      };
    }
  };
}

function conversationMessage(messageId: string, role: "user" | "assistant" | "tool", content: string) {
  return {
    sourceId: "codex",
    conversationId: "latest-conversation",
    messageId,
    role,
    content,
    createdAt: new Date(Date.parse("2026-07-20T10:00:00.000Z")).toISOString(),
    workspacePath: "/tmp/project",
    gitRoot: "/tmp/project",
    rawMeta: Object.freeze({})
  };
}
