import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  legacyTurnId,
  legacyTurnRequestId,
  orderedTurns,
  renderTurnClipped,
  type ConversationMessage,
  type ImportedTurn
} from "./index.js";

/**
 * The two Agent-source scanners (Memory runtime and App backend) stage the same
 * messages through the same store layout and must call addMemory with exactly
 * these identities. This test derives the frozen expectation straight from the
 * shared core functions; the scanner tests compare their real pipeline output
 * against the resulting file. Regenerate with `vitest run -u` after changing the
 * fixture on purpose.
 */
const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "fixtures", "agent-source-differential");

interface DifferentialFixture {
  sources: Array<{ sourceId: string; displayName: string; messages: ConversationMessage[] }>;
}

interface ExpectedTurn {
  sourceId: string;
  conversationId: string;
  adapterId: string;
  turnId: string;
  requestId: string;
  createdAt: string;
  contentSha256: string;
}

describe("agent source differential fixture", () => {
  it("derives the turn identities both scanners must reproduce", async () => {
    const fixture = JSON.parse(readFileSync(join(fixtureDirectory, "messages.json"), "utf8")) as DifferentialFixture;
    const expected: ExpectedTurn[] = [];
    for (const source of fixture.sources) {
      for await (const turn of orderedTurns(iterate(stageLikeScanStore(source.messages)))) {
        expected.push(describeTurn(source.sourceId, turn));
      }
    }
    expected.sort(compareExpectedTurns);

    // Each conversation in the fixture exists to pin one grouping rule.
    expect(countByConversation(expected)).toEqual({
      "alpha-basic": 2,
      "alpha-tools": 1,
      "alpha-unordered": 1,
      "alpha-trailing-incomplete": 1,
      "alpha-leading-assistant": 1,
      "alpha-same-timestamp": 2,
      "alpha-system": 1,
      "beta-basic": 1,
      "beta-multiline": 1
    });
    expect(new Set(expected.map((turn) => turn.requestId)).size).toBe(expected.length);
    expect(new Set(expected.map((turn) => turn.turnId)).size).toBe(expected.length);

    await expect(`${JSON.stringify(expected, null, 2)}\n`).toMatchFileSnapshot(join(fixtureDirectory, "expected-turns.json"));
  });
});

/**
 * Mirrors the staging store both scanners read from: ordinals follow yield
 * order and reads are ordered by (conversation_id, created_at, message_id,
 * ordinal) under SQLite's binary collation, not by locale.
 */
function stageLikeScanStore(messages: readonly ConversationMessage[]): ConversationMessage[] {
  return messages
    .map((message, ordinal) => ({ ...message, ordinal }))
    .sort((left, right) => compareText(left.conversationId, right.conversationId)
      || compareText(left.createdAt, right.createdAt)
      || compareText(left.messageId, right.messageId)
      || (left.ordinal ?? 0) - (right.ordinal ?? 0));
}

function describeTurn(sourceId: string, turn: ImportedTurn): ExpectedTurn {
  return {
    sourceId,
    conversationId: turn.conversationId,
    adapterId: `agent-source:${sourceId}`,
    turnId: legacyTurnId(turn),
    requestId: legacyTurnRequestId(turn),
    createdAt: turn.messages[0]!.createdAt,
    contentSha256: createHash("sha256").update(renderTurnClipped(turn.messages)).digest("hex")
  };
}

function compareExpectedTurns(left: ExpectedTurn, right: ExpectedTurn): number {
  return compareText(left.adapterId, right.adapterId)
    || compareText(left.conversationId, right.conversationId)
    || compareText(left.createdAt, right.createdAt)
    || compareText(left.turnId, right.turnId);
}

function countByConversation(turns: readonly ExpectedTurn[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const turn of turns) counts[turn.conversationId] = (counts[turn.conversationId] ?? 0) + 1;
  return counts;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function* iterate<T>(items: Iterable<T>): AsyncIterable<T> {
  for (const item of items) yield item;
}
