import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type Dispatch,
  type SetStateAction
} from "react";
import type { UploadedAgentMedia } from "../api/memmy-agent-client.js";
import type { CapabilityEvent, PluginCapabilityEventPayload, PluginInvocationOrigin } from "@memmy/local-api-contracts";
import { createTranscriptionJob, type PluginTranscriptionJob, type PluginTranscriptionState, type TranscribeAttempt } from "../lib/plugin-transcription-jobs.js";

export interface PluginUiCall {
  pluginId: string;
  capabilityId: string;
  callId: string;
  conversationId: string;
  /** Who asked for this call; decides occlusion and what closing a card means. */
  origin: PluginInvocationOrigin;
  events: CapabilityEvent[];
}

export interface PluginInvocationContext {
  pluginId: string;
  capabilityId: string;
  conversationId: string;
  input: unknown;
}

export interface PluginChatFeedback {
  message: string;
  clientRequestId: string;
}

interface PluginUiContextValue {
  registerChatFeedback(conversationId: string, handler: (feedback: PluginChatFeedback) => boolean): () => void;
  routeChatFeedback(chatId: string, feedback: PluginChatFeedback): boolean;
  fileDrafts: Map<string, File[]>;
  questionDrafts: Map<string, Record<string, string>>;
  recordingMaterials: Map<string, PluginRecordingMaterial[]>;
  setRecordingMaterials: Dispatch<SetStateAction<Map<string, PluginRecordingMaterial[]>>>;
  addRecordingMaterials(pluginId: string, conversationId: string, files: PluginRecordingMaterial[]): void;
  /** Transcription progress of handed-over recordings, by stored audio path. */
  transcriptions: Map<string, PluginTranscriptionState>;
  /** Starts (or returns the running) transcription for a stored recording. */
  startTranscription(audioPath: string, attempt: TranscribeAttempt): PluginTranscriptionJob;
  transcriptionJob(audioPath: string): PluginTranscriptionJob | undefined;
  /** Card decisions outlive route pages, just like the calls they belong to. */
  hiddenCallIds: Set<string>;
  setHiddenCallIds: Dispatch<SetStateAction<Set<string>>>;
  hiddenInteractionSteps: Map<string, string>;
  dismissedCallIds: Set<string>;
  setDismissedCallIds: Dispatch<SetStateAction<Set<string>>>;
  answeredInteractions: Set<string>;
  setAnsweredInteractions: Dispatch<SetStateAction<Set<string>>>;
  openingCommands: Set<string>;
  calls: PluginUiCall[];
  activeSurface: PluginInvocationContext | null;
  openSurface(context: PluginInvocationContext): void;
  closeSurface(): void;
  receive(payload: PluginCapabilityEventPayload): void;
}

/**
 * A file staged into the diagnosis upload card from a recording.
 *
 * `pending` marks the recording itself while it is still being transcribed:
 * the row is listed and counts towards submission, and submitting waits for
 * its transcript instead of being blocked by it.
 */
export type PluginRecordingMaterial = UploadedAgentMedia & {
  /** The file the plugin already holds for this recording, so it is not added twice. */
  collected?: boolean;
  /** A recording whose transcript has not arrived yet: listed, and waits on submit. */
  pending?: boolean;
  /**
   * The recording behind a pending row.
   *
   * The interview reaches the plugin as text, so a row stands for its
   * transcript; if that transcript never arrives the audio is still handed over
   * rather than dropped, which is only possible while it is carried here.
   */
  pendingAudio?: UploadedAgentMedia;
};
const EMPTY_RECORDING_MATERIALS: PluginRecordingMaterial[] = [];
function recordingMaterialKey(pluginId: string, conversationId: string) {
  return JSON.stringify([pluginId, conversationId.replace(/^websocket:/, "")]);
}

export { PLUGIN_TRANSCRIPTION_ATTEMPTS, type PluginRecordingTranscript, type PluginTranscriptionJob, type PluginTranscriptionState } from "../lib/plugin-transcription-jobs.js";

const MAX_PLUGIN_CALLS = 50;
const PluginUiContext = createContext<PluginUiContextValue | null>(null);

/**
 * A websocket chat is addressed by both its public chat id and its internal
 * session key.  Plugin events can use either spelling, so compare them by a
 * stable conversation id before deciding whether they belong together.
 */
export function normalizePluginConversationId(conversationId: string | null | undefined): string | null {
  if (typeof conversationId !== "string" || !conversationId) return null;
  return conversationId.replace(/^websocket:/, "");
}

export function PluginUiProvider(props: { children: ReactNode }) {
  const feedbackHandlers = useRef(new Map<symbol, { conversationId: string; handler: (feedback: PluginChatFeedback) => boolean }>());
  const fileDrafts = useRef(new Map<string, File[]>()).current;
  const questionDrafts = useRef(new Map<string, Record<string, string>>()).current;
  const [recordingMaterials, setRecordingMaterials] = useState(new Map<string, PluginRecordingMaterial[]>());
  const addRecordingMaterials = useCallback((pluginId: string, conversationId: string, files: PluginRecordingMaterial[]) => {
    if (!files.length) return;
    const key = recordingMaterialKey(pluginId, conversationId);
    setRecordingMaterials((current) => {
      const next = new Map(current);
      const merged = new Map((current.get(key) ?? []).map((file) => [file.path, file]));
      for (const file of files) merged.set(file.path, file);
      next.set(key, [...merged.values()]);
      return next;
    });
  }, []);
  const [hiddenCallIds, setHiddenCallIds] = useState<Set<string>>(() => new Set());
  // Jobs are keyed by the stored audio path: it is the one id the recording
  // card, the upload card's file row and the plugin's material all share.
  const transcriptionJobs = useRef(new Map<string, PluginTranscriptionJob>()).current;
  const [transcriptions, setTranscriptions] = useState(new Map<string, PluginTranscriptionState>());
  const startTranscription = useCallback((audioPath: string, attempt: TranscribeAttempt) => {
    const existing = transcriptionJobs.get(audioPath);
    if (existing) return existing;
    const job = createTranscriptionJob(attempt, (state) => setTranscriptions((current) => new Map(current).set(audioPath, state)));
    transcriptionJobs.set(audioPath, job);
    setTranscriptions((current) => new Map(current).set(audioPath, job.state));
    return job;
  }, [transcriptionJobs]);
  const transcriptionJob = useCallback((audioPath: string) => transcriptionJobs.get(audioPath), [transcriptionJobs]);
  const hiddenInteractionSteps = useRef(new Map<string, string>()).current;
  const [dismissedCallIds, setDismissedCallIds] = useState<Set<string>>(() => new Set());
  const [answeredInteractions, setAnsweredInteractions] = useState<Set<string>>(() => new Set());
  const openingCommands = useRef(new Set<string>()).current;
  const registerChatFeedback = useCallback((conversationId: string, handler: (feedback: PluginChatFeedback) => boolean) => {
    const id = Symbol();
    feedbackHandlers.current.set(id, { conversationId, handler });
    return () => { feedbackHandlers.current.delete(id); };
  }, []);
  const routeChatFeedback = useCallback((chatId: string, feedback: PluginChatFeedback) => {
    const sessionKey = chatId.startsWith("websocket:") ? chatId : `websocket:${chatId}`;
    for (const entry of [...feedbackHandlers.current.values()].reverse()) {
      if (entry.conversationId === chatId || entry.conversationId === sessionKey) {
        if (entry.handler(feedback)) return true;
      }
    }
    return false;
  }, []);
  const [calls, setCalls] = useState<PluginUiCall[]>([]);
  const [activeSurface, setActiveSurface] = useState<PluginInvocationContext | null>(null);
  const receive = useCallback((payload: PluginCapabilityEventPayload) => {
    setCalls((current) => reducePluginUiCalls(current, payload));
  }, []);
  const openSurface = useCallback((context: PluginInvocationContext) => setActiveSurface(context), []);
  const closeSurface = useCallback(() => setActiveSurface(null), []);
  const value = useMemo(() => ({ calls, activeSurface, openSurface, closeSurface, receive, registerChatFeedback, routeChatFeedback, fileDrafts, questionDrafts,
    hiddenCallIds, setHiddenCallIds, hiddenInteractionSteps, dismissedCallIds, setDismissedCallIds,
    answeredInteractions, setAnsweredInteractions, openingCommands, recordingMaterials, setRecordingMaterials, addRecordingMaterials,
    transcriptions, startTranscription, transcriptionJob
  }), [activeSurface, calls, closeSurface, openSurface, receive, registerChatFeedback, routeChatFeedback, fileDrafts, questionDrafts,
    hiddenCallIds, hiddenInteractionSteps, dismissedCallIds, answeredInteractions, openingCommands, recordingMaterials, addRecordingMaterials,
    transcriptions, startTranscription, transcriptionJob]);
  return <PluginUiContext.Provider value={value}>{props.children}</PluginUiContext.Provider>;
}

export function usePluginUi(): PluginUiContextValue {
  const value = useContext(PluginUiContext);
  if (!value) throw new Error("usePluginUi must be used within PluginUiProvider");
  return value;
}

export function reducePluginUiCalls(
  calls: PluginUiCall[],
  payload: PluginCapabilityEventPayload
): PluginUiCall[] {
  const payloadConversationId = normalizePluginConversationId(payload.conversationId);
  const index = calls.findIndex((call) => call.pluginId === payload.pluginId
    && call.capabilityId === payload.capabilityId
    && call.callId === payload.callId
    && normalizePluginConversationId(call.conversationId) === payloadConversationId);
  if (index < 0) {
    return [...calls, {
      pluginId: payload.pluginId,
      capabilityId: payload.capabilityId,
      callId: payload.callId,
      conversationId: payload.conversationId,
      origin: payload.origin,
      events: [payload.event]
    }].filter((call, position, all) => {
      // Prune completed history, never the sole UI for a still waiting tool.
      if (!call.events.some((event) => event.type === "result" || event.type === "error")) return true;
      return position >= all.length - MAX_PLUGIN_CALLS;
    });
  }
  const current = calls[index]!;
  const next = [...calls];
  next[index] = { ...current, events: mergeCapabilityEvent(current.events, payload.event) };
  return next;
}

function mergeCapabilityEvent(events: CapabilityEvent[], event: CapabilityEvent): CapabilityEvent[] {
  const replaces = (candidate: CapabilityEvent): boolean => {
    if (event.type === "progress" || event.type === "task-list") return candidate.type === event.type;
    if (event.type === "result" || event.type === "error") return candidate.type === "result" || candidate.type === "error";
    if (event.type === "interaction") {
      return candidate.type === "interaction" && candidate.request.interactionId === event.request.interactionId;
    }
    return event.type === "artifact" && candidate.type === "artifact" && candidate.artifact.id === event.artifact.id;
  };
  const index = events.findIndex(replaces);
  if (index < 0) return [...events, event];
  const next = [...events];
  next[index] = event;
  return next;
}

/** Optional for standalone renderer previews; routes only messages from the same conversation. */
export function usePluginChatFeedback(conversationId: string | undefined, handler: (feedback: PluginChatFeedback) => boolean) {
  const context = useContext(PluginUiContext);
  const latest = useRef(handler);
  latest.current = handler;
  const register = context?.registerChatFeedback;
  useEffect(() => {
    if (register && conversationId) return register(conversationId, (feedback) => latest.current(feedback));
  }, [register, conversationId]);
  return context?.fileDrafts;
}

/** Uploaded recordings can arrive before or after the material card mounts. */
export function usePluginRecordingMaterials(pluginId?: string, conversationId?: string) {
  const context = useContext(PluginUiContext);
  const key = pluginId && conversationId ? recordingMaterialKey(pluginId, conversationId) : null;
  const files = key ? context?.recordingMaterials.get(key) ?? EMPTY_RECORDING_MATERIALS : EMPTY_RECORDING_MATERIALS;
  const setter = context?.setRecordingMaterials;
  const update = useCallback((nextFiles: PluginRecordingMaterial[]) => {
    if (!key || !setter) return;
    setter((current) => { const next = new Map(current); next.set(key, nextFiles); return next; });
  }, [key, setter]);
  return { files, update };
}

/**
 * The page-level transcription jobs, for cards that hand a recording over
 * before it is transcribed. Null outside a {@link PluginUiProvider}, where a
 * card falls back to transcribing in place.
 */
export function usePluginTranscriptions() {
  const context = useContext(PluginUiContext);
  return context ? {
    transcriptions: context.transcriptions,
    startTranscription: context.startTranscription,
    transcriptionJob: context.transcriptionJob,
    addRecordingMaterials: context.addRecordingMaterials
  } : null;
}

/** Keep typed legal answers when a settings route temporarily unmounts the chat. */
export function usePluginQuestionDrafts() { return useContext(PluginUiContext)?.questionDrafts; }
