// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginUiProvider, usePluginUi, reducePluginUiCalls, type PluginUiCall } from "../plugin-ui-context.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PluginUiProvider", () => {
  it("prunes completed history without losing an older pending confirmation", () => {
    const pending: PluginUiCall = { pluginId: "legal-labor", capabilityId: "session-start", callId: "waiting", conversationId: "chat-1", origin: "agent", events: [
      { type: "interaction", request: { interactionId: "upload", type: "file-input", payload: {} } }
    ] };
    let calls = [pending];
    for (let index = 0; index < 80; index++) {
      calls = reducePluginUiCalls(calls, { ...pending, callId: `done-${index}`, event: { type: "result", output: {} } });
    }
    expect(calls[0]?.callId).toBe(pending.callId);
    expect(calls.length).toBeLessThanOrEqual(51);
    expect(calls.at(-1)?.callId).toBe("done-79");
  });

  it("keeps same call ids isolated when two conversations invoke a plugin", () => {
    const base = {
      pluginId: "legal-labor",
      capabilityId: "session-start",
      callId: "reused-call-id",
      origin: "agent" as const
    };
    let calls: PluginUiCall[] = [];
    calls = reducePluginUiCalls(calls, {
      ...base,
      conversationId: "websocket:chat-1",
      event: { type: "interaction", request: { interactionId: "guide-1", type: "question", payload: {} } }
    });
    calls = reducePluginUiCalls(calls, {
      ...base,
      conversationId: "websocket:chat-2",
      event: { type: "interaction", request: { interactionId: "guide-2", type: "question", payload: {} } }
    });

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.conversationId)).toEqual(["websocket:chat-1", "websocket:chat-2"]);
    expect(calls[0]?.events[0]).toMatchObject({ type: "interaction", request: { interactionId: "guide-1" } });
    expect(calls[1]?.events[0]).toMatchObject({ type: "interaction", request: { interactionId: "guide-2" } });
  });
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("keeps invocation context in memory and clears it explicitly", async () => {
    function Harness() {
      const ui = usePluginUi();
      return <>
        <span>{ui.activeSurface?.pluginId ?? "closed"}</span>
        <button onClick={() => ui.openSurface({ pluginId: "com.example.review", capabilityId: "run", conversationId: "chat-1", input: {} })}>open</button>
        <button onClick={ui.closeSurface}>close</button>
      </>;
    }
    await act(async () => root.render(<PluginUiProvider><Harness /></PluginUiProvider>));
    await act(async () => container.querySelectorAll("button")[0]?.click());
    expect(container.textContent).toContain("com.example.review");
    await act(async () => container.querySelectorAll("button")[1]?.click());
    expect(container.textContent).toContain("closed");
  });
});
