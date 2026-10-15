// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { InstalledPluginSchema } from "@memmy/local-api-contracts";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PluginUiProvider, type PluginUiCall } from "../../app/plugin-ui-context.js";
import { RecordingEntryPage, type RecordingEntrySession } from "../recording-entry.js";
import { PluginCapabilityHost } from "../plugin-capability-host.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const legal = InstalledPluginSchema.parse({ id: "legal-labor", version: "1.0.0", state: "active", approvedPermissions: [], config: {}, lastError: null,
  createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z", manifest: {
    apiVersion: "memmy/v1", id: "legal-labor", name: "用工合规诊断", version: "1.0.0", runtime: { adapter: "http" }, permissions: [],
    capabilities: ["session-start", "gap-resolve", "material-collect"].map((id) => ({ id, name: id, description: id, inputSchema: {}, outputSchema: {}, execution: "job" })),
    commands: [{ command: "/legal-guide", name: "诊断指引", description: "Guide", capabilityId: "session-start", pinned: true }]
  } });
const guide: PluginUiCall = { pluginId: legal.id, capabilityId: "session-start", callId: "guide", conversationId: "chat", origin: "agent", events: [
  { type: "artifact", artifact: { id: "template", name: "准备清单.xlsx", role: "setup", uri: "plugin-artifact://legal-labor/template", mediaType: "application/vnd.ms-excel" } },
  { type: "interaction", request: { interactionId: "guide-choice", type: "question", payload: { title: "诊断指引", options: [{ label: "录音", value: "record" }, { label: "上传", value: "upload" }] } } }
] };
const questions: PluginUiCall = { pluginId: legal.id, capabilityId: "gap-resolve", callId: "gaps", conversationId: "chat", origin: "agent", events: [
  { type: "interaction", request: { interactionId: "question", type: "question", payload: { title: "补充企业情况", questions: [
    { id: "location", label: "实际参保地区", required: true }, { id: "inspection", label: "是否正在接受调查", required: false, options: ["是", "否"] }
  ] } } }
] };
const materials: PluginUiCall = { pluginId: legal.id, capabilityId: "material-collect", callId: "uploads", conversationId: "chat", origin: "agent", events: [
  { type: "interaction", request: { interactionId: "upload", type: "file-input", payload: { title: "补充诊断材料", accept: ".txt,.pdf", multiple: true, maxFiles: 20 } } }
] };

async function fixture(run: (container: HTMLDivElement, root: ReturnType<typeof createRoot>) => Promise<void>) {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try { await run(container, root); } finally { act(() => root.unmount()); container.remove(); }
}
const wrap = (children: React.ReactNode) => <PluginUiProvider><I18nProvider language="zh-CN">{children}</I18nProvider></PluginUiProvider>;

describe("legal PoC flow", () => {
  it("occludes guidance with a question card and closes the round with partial answers, once", async () => fixture(async (container, root) => {
    const respond = vi.fn(async () => undefined); const cancel = vi.fn();
    await act(async () => root.render(wrap(<PluginCapabilityHost region="pinned" calls={[guide, questions]} plugins={[legal]} client={{ respond, cancel, getUi: vi.fn() }} />)));
    expect(container.querySelector(".diagnostic-guidance-card")).toBeNull();
    expect(container.querySelectorAll(".legal-question-card")).toHaveLength(1);
    const field = container.querySelector<HTMLInputElement>('input[aria-label="实际参保地区"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "上海徐汇区"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    const close = container.querySelector<HTMLButtonElement>('[aria-label="关闭卡片"]')!;
    await act(async () => { close.click(); close.click(); });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(legal.id, "gaps", "question", { action: "skip", answers: { location: "上海徐汇区" } });
    expect(cancel).not.toHaveBeenCalled();
    expect(container.querySelector(".legal-question-card")).toBeNull();
  }));

  it("retains typed answers across settings navigation", async () => fixture(async (container, root) => {
    const client = { respond: vi.fn(async () => undefined), cancel: vi.fn(), getUi: vi.fn() };
    function Routes() { const [settings, setSettings] = useState(false); return <><button data-settings onClick={() => setSettings(!settings)}>Settings</button>{settings ? null : <PluginCapabilityHost region="pinned" calls={[questions]} plugins={[legal]} client={client} />}</>; }
    await act(async () => root.render(wrap(<Routes />)));
    const field = container.querySelector<HTMLInputElement>('input[aria-label="实际参保地区"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "上海徐汇区"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => container.querySelector<HTMLButtonElement>("[data-settings]")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>("[data-settings]")!.click());
    expect(container.querySelector<HTMLInputElement>('input[aria-label="实际参保地区"]')!.value).toBe("上海徐汇区");
    expect(client.respond).not.toHaveBeenCalled();
  }));

  it("keeps a failed close actionable and retries without cancelling the task", async () => fixture(async (container, root) => {
    const respond = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined); const cancel = vi.fn();
    await act(async () => root.render(wrap(<PluginCapabilityHost region="pinned" calls={[materials]} plugins={[legal]} client={{ respond, cancel, getUi: vi.fn() }} onCallHidden={vi.fn()} />)));
    const close = container.querySelector<HTMLButtonElement>('[aria-label="关闭卡片"]')!;
    await act(async () => { close.click(); close.click(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("重试");
    expect(respond).toHaveBeenCalledTimes(1);
    await act(async () => close.click());
    expect(respond).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".diagnostic-upload-card")).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
  }));

  it("accepts dropped files locally before the explicit report action", async () => fixture(async (container, root) => {
    const uploadFiles = vi.fn(); const respond = vi.fn(async () => undefined);
    await act(async () => root.render(wrap(<PluginCapabilityHost region="pinned" calls={[materials]} plugins={[legal]} client={{ respond, cancel: vi.fn(), getUi: vi.fn() }} uploadFiles={uploadFiles} />)));
    const body = container.querySelector(".diagnostic-upload-card__body")!;
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files: [new File(["访谈材料"], "访谈.txt", { type: "text/plain" })] } });
    await act(async () => body.dispatchEvent(event));
    expect(container.querySelectorAll(".diagnostic-upload-card__file")).toHaveLength(1);
    expect(container.querySelector<HTMLButtonElement>(".diagnostic-upload-card__footer button")!.disabled).toBe(false);
    expect(uploadFiles).not.toHaveBeenCalled(); expect(respond).not.toHaveBeenCalled();
  }));
});

it("uses the pending plugin recorder from the list and blocks a second microphone", async () => fixture(async (container, root) => {
  const localStart = vi.fn(); const pluginStart = vi.fn(); const openLive = vi.fn();
  const session: RecordingEntrySession = { view: "list", status: "idle", elapsedMs: 0, lines: [], live: null,
    recordings: [], opened: null, deliverables: [], error: null, start: localStart, pause() {}, resume() {},
    finish() {}, back() {}, showLive() {}, open() {}, upload() {}, deliver() {}, reset() {} };
  await act(async () => root.render(wrap(<RecordingEntryPage session={session} onStart={pluginStart} uploadBlocked />)));
  await act(async () => container.querySelector<HTMLButtonElement>(".recording-panel__action--primary")!.click());
  expect(pluginStart).toHaveBeenCalledTimes(1); expect(localStart).not.toHaveBeenCalled();
  await act(async () => root.render(wrap(<RecordingEntryPage session={session} onStart={pluginStart} uploadBlocked
    externalRecording={{ title: "现场访谈", elapsedMs: 2000, status: "recording", onOpen: openLive }} />)));
  expect(container.querySelector<HTMLButtonElement>(".recording-panel__action--primary")!.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>(".recording-panel__action:not(.recording-panel__action--primary)")!.disabled).toBe(true);
  await act(async () => container.querySelector<HTMLButtonElement>(".recording-page__list-open")!.click());
  expect(openLive).toHaveBeenCalledTimes(1); expect(localStart).not.toHaveBeenCalled();
}));
