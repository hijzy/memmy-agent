/**
 * The newest conversation, trimmed to fit a prompt.
 *
 * The first-login report quotes one conversation back to the user, so it needs
 * the opening turns for context and the latest turns for what they are doing
 * now, with the tool chatter in between thinned out.
 */
import type { SourceRegistry } from "../adapters/source-registry.js";
import {
  MAX_ASSISTANT_MESSAGE_CHARS,
  MAX_TOOL_MESSAGE_CHARS,
  MAX_USER_MESSAGE_CHARS,
  limitSampledMessage
} from "./text.js";
import type {
  OnboardingConversationWindow,
  OnboardingConversationWindowReader,
  OnboardingSampledMessage
} from "./types.js";

const CONVERSATION_SCAN_TARGETS = 6;
const FIRST_CONVERSATION_TURNS = 2;
const LAST_CONVERSATION_TURNS = 12;
const MAX_ASSISTANT_MESSAGES_PER_TURN = 2;
const MAX_TOOL_MESSAGES_PER_TURN = 4;
const MAX_CONVERSATION_WINDOW_CHARS = 24_000;

export function createSourceRegistryConversationWindowReader(
  sourceRegistry: SourceRegistry
): OnboardingConversationWindowReader {
  return {
    async readConversation(reference, options) {
      const adapter = sourceRegistry.require(reference.sourceId);
      const deadlineSignal = AbortSignal.timeout(options.deadlineMs);
      const signal = options.signal ? AbortSignal.any([options.signal, deadlineSignal]) : deadlineSignal;
      const messages: OnboardingSampledMessage[] = [];
      let foundConversation = false;

      try {
        for await (const message of adapter.scan({
          maxScanTargets: CONVERSATION_SCAN_TARGETS,
          order: "recent_first",
          signal
        })) {
          if (message.conversationId !== reference.conversationId) {
            // Recent-first order means the wanted conversation arrives in one
            // run: once it ends, everything after it is older.
            if (foundConversation) {
              break;
            }
            continue;
          }
          foundConversation = true;
          if (message.role === "system") {
            continue;
          }
          messages.push({
            sourceId: message.sourceId,
            conversationId: message.conversationId,
            messageId: message.messageId,
            role: message.role,
            createdAt: message.createdAt,
            text: message.content,
            workspacePath: message.workspacePath
          });
        }
      } catch (error) {
        if (!deadlineSignal.aborted && !options.signal?.aborted) {
          throw error;
        }
      }

      const windowMessages = selectConversationWindow(messages);
      if (windowMessages.length === 0) {
        return null;
      }
      return { ...reference, messages: windowMessages } satisfies OnboardingConversationWindow;
    }
  };
}

export function selectConversationWindow(
  messages: readonly OnboardingSampledMessage[]
): OnboardingSampledMessage[] {
  const chronological = [...messages]
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "tool")
    .sort((left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.messageId.localeCompare(right.messageId)
    );
  const turns: OnboardingSampledMessage[][] = [];
  let currentTurn: OnboardingSampledMessage[] | null = null;
  for (const message of chronological) {
    if (message.role === "user") {
      currentTurn = [message];
      turns.push(currentTurn);
      continue;
    }
    currentTurn?.push(message);
  }

  const selectedTurns = [...turns.slice(0, FIRST_CONVERSATION_TURNS), ...turns.slice(-LAST_CONVERSATION_TURNS)];
  const seen = new Set<string>();
  const compacted = selectedTurns.flatMap(compactConversationTurn).filter((message) => {
    if (seen.has(message.messageId)) {
      return false;
    }
    seen.add(message.messageId);
    return true;
  }).map((message) => limitSampledMessage(
    message,
    message.role === "user"
      ? MAX_USER_MESSAGE_CHARS
      : message.role === "assistant"
        ? MAX_ASSISTANT_MESSAGE_CHARS
        : MAX_TOOL_MESSAGE_CHARS
  ));
  return boundConversationWindowChars(compacted);
}

function compactConversationTurn(turn: readonly OnboardingSampledMessage[]): OnboardingSampledMessage[] {
  const assistantIds = new Set(turn.filter((message) => message.role === "assistant")
    .slice(-MAX_ASSISTANT_MESSAGES_PER_TURN)
    .map((message) => message.messageId));
  const toolIds = new Set(turn.filter((message) => message.role === "tool")
    .slice(-MAX_TOOL_MESSAGES_PER_TURN)
    .map((message) => message.messageId));
  return turn.filter((message) =>
    message.role === "user" || assistantIds.has(message.messageId) || toolIds.has(message.messageId)
  );
}

/** Shrinks every message proportionally rather than dropping the last turns. */
function boundConversationWindowChars(
  messages: readonly OnboardingSampledMessage[]
): OnboardingSampledMessage[] {
  const totalChars = messages.reduce((sum, message) => sum + message.text.length, 0);
  if (totalChars <= MAX_CONVERSATION_WINDOW_CHARS) {
    return [...messages];
  }
  const ratio = MAX_CONVERSATION_WINDOW_CHARS / totalChars;
  return messages.map((message) => limitSampledMessage(message, Math.max(120, Math.floor(message.text.length * ratio))));
}
