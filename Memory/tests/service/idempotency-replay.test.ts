import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb, createMemoryHttpServer } from "../../src/index.js";
import { Repositories } from "../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
const roots: string[] = [];

afterEach(() => {
  cleanup();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface AddResponse {
  status: number;
  body: { id?: string; title?: string; duplicate?: boolean; error?: { message?: string } };
}

async function withMemoryApi(run: (add: (body: unknown) => Promise<AddResponse>) => Promise<void>): Promise<void> {
  const { service } = createTestService();
  const server = createMemoryHttpServer({ service });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const endpoint = `http://127.0.0.1:${address.port}/api/v1/memory/add`;
    await run(async (body) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// An agent-source scan keys a skill on its content hash but still ships the
// file mtime, so a Codex upgrade that rewrites a bundled SKILL.md byte for byte
// replays the same key with a different body.
const skillAdd = {
  requestId: "agent-source-skill:codex:.system/review-agent:contenthash-abc",
  adapterId: "agent-source:codex",
  content: "# Review agent\n\nReview changed code.",
  layer: "Skill",
  title: "review-agent",
  tags: ["agent-source", "cross-agent-skill", "codex"],
  source: "codex",
  turnId: "skill:.system/review-agent:1",
  sourceAgentId: "codex",
  sourceSkillId: ".system/review-agent",
  sourceSkillPath: "/Users/me/.codex/skills/.system/review-agent/SKILL.md",
  sourceSkillVersion: "1",
  sourceContentHash: "contenthash-abc"
};

describe("memory.add idempotency replay", () => {
  it("supersedes a reused idempotency key instead of rejecting the scan", async () => {
    await withMemoryApi(async (add) => {
      const first = await add({ ...skillAdd, createdAt: "2026-09-01T10:00:00.000Z" });
      expect(first.status).toBe(200);

      const afterUpgrade = await add({ ...skillAdd, createdAt: "2026-09-10T08:00:00.000Z" });
      expect(afterUpgrade.status).toBe(200);
      expect(afterUpgrade.body.id).toBe(first.body.id);

      const replay = await add({ ...skillAdd, createdAt: "2026-09-10T08:00:00.000Z" });
      expect(replay.status).toBe(200);
      expect(replay.body.duplicate).toBe(true);
    });
  });

  it("still short-circuits an unchanged retry of the same request", async () => {
    await withMemoryApi(async (add) => {
      const body = { ...skillAdd, createdAt: "2026-09-01T10:00:00.000Z" };
      const first = await add(body);
      const second = await add(body);

      expect(first.body.duplicate).toBeUndefined();
      expect(second.body.duplicate).toBe(true);
      expect(second.body.id).toBe(first.body.id);
    });
  });

  it("serves a superseded write from cache on the next identical replay", async () => {
    await withMemoryApi(async (add) => {
      await add({ ...skillAdd, createdAt: "2026-09-01T10:00:00.000Z" });
      const renamed = await add({ ...skillAdd, createdAt: "2026-09-01T10:00:00.000Z", title: "review-agent v2" });

      expect(renamed.status).toBe(200);
      expect(renamed.body.title).toBe("review-agent v2");
    });
  });
});

describe("idempotency record retention", () => {
  it("expires cached records and prunes both new and legacy rows", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-idempotency-ttl-"));
    roots.push(root);
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const repos = new Repositories(db.db);

    repos.runtime.saveIdempotency("memory.add:agent:fresh", "hash-1", { ok: true }, "2026-09-10T00:00:00.000Z");
    db.db.prepare(
      `INSERT INTO idempotency_keys (key, request_hash, response_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, NULL)`
    ).run("memory.add:agent:legacy", "hash-2", JSON.stringify({ ok: true }), "2026-09-01T00:00:00.000Z");

    expect(repos.runtime.getIdempotency("memory.add:agent:fresh", "2026-09-10T12:00:00.000Z")).toBeTruthy();
    expect(repos.runtime.getIdempotency("memory.add:agent:fresh", "2026-09-13T00:00:00.000Z")).toBeUndefined();
    expect(repos.runtime.getIdempotency("memory.add:agent:legacy", "2026-09-10T00:00:00.000Z")).toBeUndefined();

    expect(repos.runtime.pruneIdempotency("2026-09-10T12:00:00.000Z")).toBe(1);
    expect(repos.runtime.pruneIdempotency("2026-09-13T00:00:00.000Z")).toBe(1);
    expect(db.db.prepare(`SELECT COUNT(*) AS total FROM idempotency_keys`).get()).toEqual({ total: 0 });
  });
});
