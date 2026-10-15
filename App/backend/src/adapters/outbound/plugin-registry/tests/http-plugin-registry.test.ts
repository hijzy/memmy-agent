import { describe, expect, it, vi } from "vitest";
import { createHttpPluginRegistry } from "../http-plugin-registry.js";

const release = {
  manifest: {
    apiVersion: "memmy/v1",
    id: "com.example.review",
    name: "Review",
    version: "1.0.0",
    runtime: { adapter: "http", config: { baseUrl: "https://plugin.example" } },
    capabilities: [{
      id: "run",
      name: "Run",
      description: "Run review",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      execution: "request"
    }],
    permissions: [{ type: "network", hosts: ["plugin.example"] }]
  },
  artifact: {
    url: "https://registry.example/artifacts/review.zip",
    sha256: "a".repeat(64)
  }
};

describe("HttpPluginRegistry", () => {
  it("resolves the local registry's relative download URL against its origin", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ...release, artifact: { ...release.artifact, url: "/api/v1/plugins/com.example.review/artifact?version=1.0.0" }
    })));
    const registry = createHttpPluginRegistry({ baseUrl: "https://registry.example", fetchFn });
    const resolved = await registry.resolve(release.manifest.id);
    expect(resolved.artifact?.url).toBe("https://registry.example/api/v1/plugins/com.example.review/artifact?version=1.0.0");
  });

  it("preserves an OSS signature while authenticating only the resolve request", async () => {
    const url = "https://memos-file.oss-cn-shanghai.aliyuncs.com/memmy/legal-plugins/legal.zip?Expires=123&Signature=a%2Bb%3D";
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ...release, artifact: { ...release.artifact, url }
    })));
    const registry = createHttpPluginRegistry({
      baseUrl: "https://registry.example", fetchFn, authHeaders: () => ({ authorization: "Bearer test" })
    });
    expect((await registry.resolve(release.manifest.id)).artifact?.url).toBe(url);
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer test" });
  });

  it("rejects an insecure storage download URL", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ...release, artifact: { ...release.artifact, url: "http://storage.example/legal.zip" }
    })));
    const registry = createHttpPluginRegistry({ baseUrl: "https://registry.example", fetchFn });
    await expect(registry.resolve(release.manifest.id)).rejects.toThrow(/HTTPS/);
  });

  it("resolves a plugin by id and version without accepting a client URL", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(release), {
      headers: { "content-type": "application/json" }
    }));
    const registry = createHttpPluginRegistry({ baseUrl: "https://registry.example", fetchFn: fetchFn as typeof fetch });
    await expect(registry.resolve(release.manifest.id, "1.0.0")).resolves.toEqual(release);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      "https://registry.example/api/v1/plugins/com.example.review?version=1.0.0"
    );
  });

  it("rejects a mismatched manifest", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      ...release,
      manifest: { ...release.manifest, id: "com.example.other" }
    })));
    const registry = createHttpPluginRegistry({ baseUrl: "https://registry.example", fetchFn: fetchFn as typeof fetch });
    await expect(registry.resolve(release.manifest.id)).rejects.toThrow(/different release/);
  });

  it("rejects an insecure non-loopback registry", () => {
    expect(() => createHttpPluginRegistry({ baseUrl: "http://registry.example" })).toThrow(/HTTPS/);
  });
});
