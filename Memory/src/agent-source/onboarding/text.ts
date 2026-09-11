/**
 * Text limits for onboarding samples.
 *
 * Everything sampled here ends up in an LLM prompt, so it is redacted, stripped
 * of inline media and clipped before it leaves the process.
 */
import { redactSecrets } from "../adapters/secret-redactor.js";
import type { OnboardingSampledMessage, OnboardingSampledQuery } from "./types.js";

const INLINE_MEDIA_PLACEHOLDER = "[inline media omitted]";
const DATA_URL_MEDIA_PATTERN = /\bdata:(?:image|audio|video|application)\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*;base64,[a-z0-9+/_=-]{120,}/giu;
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]\n]{0,200}\]\((?:data:[^)]+|blob:[^)]+|file:[^)]+|https?:\/\/[^)\s]+\.(?:png|jpe?g|gif|webp|svg)(?:\?[^)\s]*)?)[^)]*\)/giu;
const HTML_IMAGE_PATTERN = /<img\b[^>]*>/giu;
const BASE64_CANDIDATE_PATTERN = /[a-z0-9+/_-]{800,}={0,2}/giu;
const COMMON_MEDIA_BASE64_PREFIX_PATTERN = /^(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR|PHN2Z)/u;

export const MAX_USER_MESSAGE_CHARS = 1_200;
export const MAX_ASSISTANT_MESSAGE_CHARS = 2_000;
export const MAX_TOOL_MESSAGE_CHARS = 400;

/** Replaces pasted images and other large payloads with a placeholder. */
export function stripInlineMediaPayloads(text: string): string {
  return text
    .replace(MARKDOWN_IMAGE_PATTERN, INLINE_MEDIA_PLACEHOLDER)
    .replace(HTML_IMAGE_PATTERN, INLINE_MEDIA_PLACEHOLDER)
    .replace(DATA_URL_MEDIA_PATTERN, INLINE_MEDIA_PLACEHOLDER)
    .replace(BASE64_CANDIDATE_PATTERN, (candidate) => looksLikeLargeBase64Media(candidate) ? INLINE_MEDIA_PLACEHOLDER : candidate)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function limitSampledQuery(query: OnboardingSampledQuery, maxChars: number): OnboardingSampledQuery {
  const redacted = stripInlineMediaPayloads(redactSecrets(query.text)).trim();
  return {
    ...query,
    text: redacted.length <= maxChars ? redacted : `${redacted.slice(0, maxChars)}...`
  };
}

export function limitSampledMessage(message: OnboardingSampledMessage, maxChars: number): OnboardingSampledMessage {
  return { ...message, text: clipMessageText(message.text, maxChars) };
}

/** Keeps the head and the tail of a long message, which is where the intent is. */
export function clipMessageText(text: string, maxChars: number): string {
  const sanitized = stripInlineMediaPayloads(redactSecrets(text)).trim();
  if (sanitized.length <= maxChars) {
    return sanitized;
  }
  const headLength = Math.max(1, Math.floor(maxChars * 0.35));
  const tailLength = Math.max(1, maxChars - headLength - 5);
  return `${sanitized.slice(0, headLength)}\n...\n${sanitized.slice(-tailLength)}`;
}

export function sortQueriesRecent(queries: OnboardingSampledQuery[]): OnboardingSampledQuery[] {
  return [...queries].sort(byRecencyThenIdentity);
}

export function sortMessagesRecent(messages: OnboardingSampledMessage[]): OnboardingSampledMessage[] {
  return [...messages].sort(byRecencyThenIdentity);
}

function byRecencyThenIdentity(left: OnboardingSampledQuery, right: OnboardingSampledQuery): number {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.conversationId.localeCompare(right.conversationId) ||
    left.messageId.localeCompare(right.messageId);
}

function looksLikeLargeBase64Media(candidate: string): boolean {
  if (COMMON_MEDIA_BASE64_PREFIX_PATTERN.test(candidate)) {
    return true;
  }
  if (!/[+/=_-]/u.test(candidate)) {
    return false;
  }
  return new Set(candidate.slice(0, 512)).size >= 24;
}
