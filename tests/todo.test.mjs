/**
 * Tests for the todo state machine (extensions/lib/todo-state.ts) — the real
 * reducer that extensions/todo.ts calls from its tool handler.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIONS,
  EMPTY_TODO_STATE,
  PRIORITIES,
  applyTodoAction,
  formatTodoList,
  reconstructTodoState,
  summarizeTodos,
} from "../extensions/lib/todo-state.ts";

const NOW = 1_700_000_000_000;
const apply = (state, params) => applyTodoAction(state, params, NOW);

/** Apply a sequence of actions, returning the final result. */
function run(...actions) {
  let state = EMPTY_TODO_STATE;
  let result;
  for (const a of actions) {
    result = apply(state, a);
    state = result.state;
  }
  return result;
}

const add = (text, priority) => ({ action: "add", text, priority });

// ---------------------------------------------------------------------------

describe("add", () => {
  it("creates todos with incrementing ids and medium default priority", () => {
    const { state, text } = run(add("a"), add("b", "high"));
    assert.deepEqual(state.todos.map((t) => [t.id, t.text, t.priority]), [[1, "a", "medium"], [2, "b", "high"]]);
    assert.equal(state.nextId, 3);
    assert.equal(text, "Added todo #2 [!!!]: b");
  });

  it("starts not done, not in progress, stamped with the given time", () => {
    const [t] = run(add("a")).state.todos;
    assert.equal(t.done, false);
    assert.equal(t.inProgress, false);
    assert.equal(t.createdAt, NOW);
  });

  it("rejects missing or empty text without changing state", () => {
    for (const text of [undefined, ""]) {
      const r = apply(EMPTY_TODO_STATE, { action: "add", text });
      assert.equal(r.details.error, "text required");
      assert.equal(r.state, EMPTY_TODO_STATE);
    }
  });
});

describe("toggle", () => {
  it("flips done both ways and clears inProgress when completing", () => {
    let r = run(add("a"), { action: "in_progress", id: 1 }, { action: "toggle", id: 1 });
    assert.equal(r.state.todos[0].done, true);
    assert.equal(r.state.todos[0].inProgress, false);
    assert.equal(r.text, "Todo #1 completed");
    r = apply(r.state, { action: "toggle", id: 1 });
    assert.equal(r.state.todos[0].done, false);
    assert.equal(r.text, "Todo #1 uncompleted");
  });

  it("reports missing and unknown ids", () => {
    assert.equal(apply(EMPTY_TODO_STATE, { action: "toggle" }).details.error, "id required");
    assert.equal(apply(EMPTY_TODO_STATE, { action: "toggle", id: 9 }).details.error, "#9 not found");
  });
});

describe("remove", () => {
  it("deletes by id, keeps others, never reuses ids", () => {
    const r = run(add("a"), add("b"), { action: "remove", id: 1 }, add("c"));
    assert.deepEqual(r.state.todos.map((t) => [t.id, t.text]), [[2, "b"], [3, "c"]]);
  });

  it("reports missing and unknown ids", () => {
    assert.equal(apply(EMPTY_TODO_STATE, { action: "remove" }).details.error, "id required");
    assert.equal(apply(EMPTY_TODO_STATE, { action: "remove", id: 1 }).details.error, "#1 not found");
  });
});

describe("rename", () => {
  it("updates text", () => {
    const r = run(add("old"), { action: "rename", id: 1, text: "new" });
    assert.equal(r.state.todos[0].text, "new");
    assert.equal(r.text, 'Renamed todo #1: "old" -> "new"');
  });

  it("validates id and text", () => {
    const s = run(add("a")).state;
    assert.equal(apply(s, { action: "rename", text: "x" }).details.error, "id required");
    assert.equal(apply(s, { action: "rename", id: 1 }).details.error, "text required");
    assert.equal(apply(s, { action: "rename", id: 5, text: "x" }).details.error, "#5 not found");
  });
});

describe("in_progress", () => {
  it("toggles in-progress on and off", () => {
    let r = run(add("a"), { action: "in_progress", id: 1 });
    assert.equal(r.state.todos[0].inProgress, true);
    assert.equal(r.text, "Todo #1 started");
    r = apply(r.state, { action: "in_progress", id: 1 });
    assert.equal(r.state.todos[0].inProgress, false);
    assert.equal(r.text, "Todo #1 paused");
  });

  it("refuses completed todos", () => {
    const r = run(add("a"), { action: "toggle", id: 1 }, { action: "in_progress", id: 1 });
    assert.equal(r.details.error, "#1 already completed");
  });
});

describe("clear and list", () => {
  it("clear empties the list and resets ids", () => {
    const r = run(add("a"), add("b"), { action: "clear" });
    assert.deepEqual(r.state, { todos: [], nextId: 1 });
    assert.equal(r.text, "Cleared 2 todos");
    assert.equal(apply(r.state, add("c")).state.todos[0].id, 1);
  });

  it("list renders status markers and priorities", () => {
    const s = run(add("a", "low"), add("b"), add("c", "high"), { action: "toggle", id: 1 }, { action: "in_progress", id: 2 }).state;
    const r = apply(s, { action: "list" });
    assert.equal(r.text, "[x] #1 [!]: a\n[~] #2 [!!]: b\n[ ] #3 [!!!]: c");
    assert.equal(r.text, formatTodoList(s.todos));
    assert.equal(apply(EMPTY_TODO_STATE, { action: "list" }).text, "No todos");
  });

  it("unknown actions are reported, not thrown", () => {
    const r = apply(EMPTY_TODO_STATE, { action: "explode" });
    assert.equal(r.details.error, "unknown action: explode");
  });
});

describe("snapshots are immutable (session branching relies on it)", () => {
  it("later actions never alter an earlier result's details", () => {
    const first = run(add("a"));
    const snapshot = JSON.stringify(first.details);
    let state = first.state;
    for (const a of [
      { action: "in_progress", id: 1 },
      { action: "toggle", id: 1 },
      { action: "rename", id: 1, text: "changed" },
      { action: "remove", id: 1 },
    ]) {
      state = apply(state, a).state;
    }
    assert.equal(JSON.stringify(first.details), snapshot);
  });

  it("does not mutate the input state", () => {
    const s = run(add("a")).state;
    const before = JSON.stringify(s);
    apply(s, { action: "toggle", id: 1 });
    apply(s, { action: "rename", id: 1, text: "z" });
    apply(s, { action: "clear" });
    assert.equal(JSON.stringify(s), before);
  });
});

describe("reconstructTodoState", () => {
  const entry = (toolName, details) => ({ type: "message", message: { role: "toolResult", toolName, details } });

  it("takes the last todo snapshot on the branch", () => {
    const d1 = run(add("a")).details;
    const d2 = run(add("a"), add("b")).details;
    const state = reconstructTodoState([entry("todo", d1), { type: "other" }, entry("bash", { todos: [] }), entry("todo", d2)]);
    assert.deepEqual(state.todos.map((t) => t.text), ["a", "b"]);
    assert.equal(state.nextId, 3);
  });

  it("returns the empty state when there are no snapshots", () => {
    assert.deepEqual(reconstructTodoState([]), { todos: [], nextId: 1 });
    assert.deepEqual(reconstructTodoState([entry("todo", undefined)]), { todos: [], nextId: 1 });
  });
});

describe("summarizeTodos", () => {
  it("counts done, in progress and pending", () => {
    const s = run(add("a"), add("b"), add("c"), { action: "toggle", id: 1 }, { action: "in_progress", id: 2 }).state;
    assert.deepEqual(summarizeTodos(s.todos), { done: 1, inProgress: 1, pending: 1, total: 3 });
  });
});

describe("constants", () => {
  it("expose the supported actions and priorities", () => {
    assert.deepEqual([...ACTIONS], ["list", "add", "toggle", "remove", "rename", "in_progress", "clear"]);
    assert.deepEqual([...PRIORITIES], ["low", "medium", "high"]);
  });
});
