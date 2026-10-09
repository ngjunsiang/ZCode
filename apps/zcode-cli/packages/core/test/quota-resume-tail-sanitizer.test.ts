// fork/N4：quota-resume 尾部净化器单元测试。
// 场景：assistant 已提交 toolCalls 但 tool result 未及提交（悬挂 tool_use）时，
// sanitize 在 canonical history 与 turnRequestState 各补一份终态合成结果；
// 已配对 / 无工具历史不动。文案与冷恢复 hydrator 一致。
import assert from "node:assert/strict";
import test from "node:test";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import type { RuntimeMessageEntry, ToolCallInput } from "../src/agent/message-history.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  sanitizeQuotaResumeTurnTail,
} from "../src/runtime/methods/quota-resume-tail-sanitizer.js";
import type { RegularTurnLoopState } from "../src/runtime/methods/turn-loop-state.js";

const INTERRUPTED_TOOL_RESULT = "[Tool execution was interrupted before resume]";

interface Fixture {
  history: MessageHistoryImpl;
  state: Pick<RegularTurnLoopState, "turnRequestState" | "turnId" | "events">;
  runtime: AgentRuntimeInternal;
  committed: RuntimeMessageEntry[][];
}

function makeFixture(entries: RuntimeMessageEntry[]): Fixture {
  const history = new MessageHistoryImpl();
  history.addEntries(entries);
  const committed: RuntimeMessageEntry[][] = [];
  const runtime = {
    messageHistory: history,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
      error: () => undefined,
    },
  } as unknown as AgentRuntimeInternal;
  const state = {
    turnId: "turn-test" as RegularTurnLoopState["turnId"],
    events: [],
    turnRequestState: {
      entries: [...history.borrowReadOnlyRuntimeEntries()],
      outputTokenContinuationCount: 0,
    },
  };
  return { history, state, runtime, committed };
}

function userEntry(text: string): RuntimeMessageEntry {
  return { message: { role: "user", content: text }, metadata: { source: "real_user" } };
}

function assistantEntry(toolCalls: ToolCallInput[]): RuntimeMessageEntry {
  return { message: { role: "assistant", content: "", toolCalls } };
}

function toolResultEntry(toolCallId: string): RuntimeMessageEntry {
  return {
    message: { role: "tool", content: "ok", toolCallId, toolName: "Read", isError: false },
  };
}

test("悬挂 tool_use：未配对工具补终态合成结果，已配对不动", () => {
  const fixture = makeFixture([
    userEntry("do the thing"),
    assistantEntry([
      { id: "call-1", name: "Read", input: { path: "a.ts" } },
      { id: "call-2", name: "Edit", input: { path: "b.ts" } },
    ]),
    toolResultEntry("call-1"),
    userEntry("unused tail"),
  ]);
  const count = sanitizeQuotaResumeTurnTail(fixture.runtime, fixture.state as RegularTurnLoopState);
  assert.equal(count, 1);
  const tail = fixture.state.turnRequestState.entries.at(-1);
  assert.ok(tail && tail.kind !== "attachment");
  assert.equal(tail.message.role, "tool");
  assert.equal(tail.message.toolCallId, "call-2");
  assert.equal(tail.message.isError, true);
  assert.ok(
    fixture.state.turnRequestState.entries.some(
      (entry) =>
        entry.kind !== "attachment" &&
        entry.message.role === "tool" &&
        entry.message.toolCallId === "call-1",
    ),
  );
  // canonical history 同步推进（commitTurnRequestEntries 双写）。
  assert.ok(
    fixture.history
      .borrowReadOnlyRuntimeEntries()
      .some((entry) => entry.kind !== "attachment" && entry.message.toolCallId === "call-2"),
  );
});

test("完全悬挂：assistant 提交了工具但一个 result 都没有", () => {
  const fixture = makeFixture([
    userEntry("go"),
    assistantEntry([{ id: "call-a", name: "Bash", input: {} }]),
  ]);
  const count = sanitizeQuotaResumeTurnTail(fixture.runtime, fixture.state as RegularTurnLoopState);
  assert.equal(count, 1);
  const tail = fixture.state.turnRequestState.entries.at(-1);
  assert.ok(tail && tail.kind !== "attachment");
  assert.equal(tail.message.content, INTERRUPTED_TOOL_RESULT);
});

test("干净历史：全部配对时是 noop", () => {
  const fixture = makeFixture([
    userEntry("go"),
    assistantEntry([{ id: "call-1", name: "Read", input: {} }]),
    toolResultEntry("call-1"),
  ]);
  const before = fixture.state.turnRequestState.entries.length;
  const count = sanitizeQuotaResumeTurnTail(fixture.runtime, fixture.state as RegularTurnLoopState);
  assert.equal(count, 0);
  assert.equal(fixture.state.turnRequestState.entries.length, before);
});

test("空历史与纯 user 历史：noop", () => {
  const empty = makeFixture([]);
  assert.equal(
    sanitizeQuotaResumeTurnTail(empty.runtime, empty.state as RegularTurnLoopState),
    0,
  );
  const users = makeFixture([userEntry("hello"), userEntry("again")]);
  assert.equal(
    sanitizeQuotaResumeTurnTail(users.runtime, users.state as RegularTurnLoopState),
    0,
  );
});
