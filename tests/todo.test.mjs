/**
 * Tests for the todo tool logic (extensions/todo.ts).
 *
 * Since todo.ts imports from Pi packages, we cannot import it directly.
 * We extract the pure state-management logic (the switch cases in execute)
 * into a testable harness that simulates the tool's behavior without TUI
 * or Pi runtime dependencies.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Re-implement the todo state machine from todo.ts
// ---------------------------------------------------------------------------

const ACTIONS = ["list", "add", "toggle", "remove", "rename", "in_progress", "clear"];
const PRIORITIES = ["low", "medium", "high"];

/**
 * A self-contained todo manager that mirrors the state logic in todo.ts.
 * Each method returns a result object matching the TodoDetails shape.
 */
class TodoManager {
  constructor() {
    this.todos = [];
    this.nextId = 1;
  }

  _snapshot() {
    return { todos: [...this.todos.map((t) => ({ ...t }))], nextId: this.nextId };
  }

  list() {
    return {
      action: "list",
      ...this._snapshot(),
      text: this.todos.length
        ? this.todos.map((t) => `[${t.done ? "x" : t.inProgress ? "~" : " "}] #${t.id}: ${t.text}`).join("\n")
        : "No todos",
    };
  }

  add(text, priority) {
    if (!text) {
      return { action: "add", ...this._snapshot(), error: "text required" };
    }
    const p = priority ?? "medium";
    const newTodo = {
      id: this.nextId++,
      text,
      done: false,
      inProgress: false,
      priority: p,
      createdAt: Date.now(),
    };
    this.todos.push(newTodo);
    return { action: "add", ...this._snapshot() };
  }

  toggle(id) {
    if (id === undefined) {
      return { action: "toggle", ...this._snapshot(), error: "id required" };
    }
    const todo = this.todos.find((t) => t.id === id);
    if (!todo) {
      return { action: "toggle", ...this._snapshot(), error: `#${id} not found` };
    }
    todo.done = !todo.done;
    if (todo.done) todo.inProgress = false;
    return { action: "toggle", ...this._snapshot() };
  }

  remove(id) {
    if (id === undefined) {
      return { action: "remove", ...this._snapshot(), error: "id required" };
    }
    const idx = this.todos.findIndex((t) => t.id === id);
    if (idx === -1) {
      return { action: "remove", ...this._snapshot(), error: `#${id} not found` };
    }
    this.todos.splice(idx, 1);
    return { action: "remove", ...this._snapshot() };
  }

  rename(id, text) {
    if (id === undefined) {
      return { action: "rename", ...this._snapshot(), error: "id required" };
    }
    if (!text) {
      return { action: "rename", ...this._snapshot(), error: "text required" };
    }
    const target = this.todos.find((t) => t.id === id);
    if (!target) {
      return { action: "rename", ...this._snapshot(), error: `#${id} not found` };
    }
    target.text = text;
    return { action: "rename", ...this._snapshot() };
  }

  inProgress(id) {
    if (id === undefined) {
      return { action: "in_progress", ...this._snapshot(), error: "id required" };
    }
    const wip = this.todos.find((t) => t.id === id);
    if (!wip) {
      return { action: "in_progress", ...this._snapshot(), error: `#${id} not found` };
    }
    if (wip.done) {
      return { action: "in_progress", ...this._snapshot(), error: `#${id} already completed` };
    }
    wip.inProgress = !wip.inProgress;
    return { action: "in_progress", ...this._snapshot() };
  }

  clear() {
    this.todos = [];
    this.nextId = 1;
    return { action: "clear", todos: [], nextId: 1 };
  }

  /**
   * Reconstruct state from a list of details snapshots (simulating the
   * session-entry replay in reconstructState).
   */
  static fromSnapshots(snapshots) {
    const mgr = new TodoManager();
    for (const snap of snapshots) {
      if (snap && snap.todos !== undefined && snap.nextId !== undefined) {
        mgr.todos = snap.todos.map((t) => ({ ...t }));
        mgr.nextId = snap.nextId;
      }
    }
    return mgr;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("todo: add", () => {
  let mgr;
  beforeEach(() => {
    mgr = new TodoManager();
  });

  it("creates a todo with incrementing ID", () => {
    const r1 = mgr.add("First task");
    assert.equal(r1.todos.length, 1);
    assert.equal(r1.todos[0].id, 1);
    assert.equal(r1.todos[0].text, "First task");

    const r2 = mgr.add("Second task");
    assert.equal(r2.todos.length, 2);
    assert.equal(r2.todos[1].id, 2);
  });

  it("defaults priority to medium", () => {
    mgr.add("Task");
    assert.equal(mgr.todos[0].priority, "medium");
  });

  it("accepts explicit priority", () => {
    mgr.add("Urgent", "high");
    assert.equal(mgr.todos[0].priority, "high");

    mgr.add("Later", "low");
    assert.equal(mgr.todos[1].priority, "low");
  });

  it("starts with done=false and inProgress=false", () => {
    mgr.add("New task");
    assert.equal(mgr.todos[0].done, false);
    assert.equal(mgr.todos[0].inProgress, false);
  });

  it("has a createdAt timestamp", () => {
    const before = Date.now();
    mgr.add("Timed task");
    const after = Date.now();
    assert.ok(mgr.todos[0].createdAt >= before);
    assert.ok(mgr.todos[0].createdAt <= after);
  });

  it("returns error when text is missing", () => {
    const result = mgr.add(undefined);
    assert.equal(result.error, "text required");
    assert.equal(result.todos.length, 0);
  });

  it("returns error when text is empty string", () => {
    const result = mgr.add("");
    assert.equal(result.error, "text required");
  });
});

describe("todo: toggle", () => {
  let mgr;
  beforeEach(() => {
    mgr = new TodoManager();
    mgr.add("Task 1");
    mgr.add("Task 2");
  });

  it("flips done from false to true", () => {
    mgr.toggle(1);
    assert.equal(mgr.todos[0].done, true);
  });

  it("flips done from true to false", () => {
    mgr.toggle(1);
    mgr.toggle(1);
    assert.equal(mgr.todos[0].done, false);
  });

  it("clears inProgress when marking done", () => {
    mgr.inProgress(1);
    assert.equal(mgr.todos[0].inProgress, true);
    mgr.toggle(1); // mark done
    assert.equal(mgr.todos[0].done, true);
    assert.equal(mgr.todos[0].inProgress, false);
  });

  it("returns error when id is missing", () => {
    const result = mgr.toggle(undefined);
    assert.equal(result.error, "id required");
  });

  it("returns error when id not found", () => {
    const result = mgr.toggle(999);
    assert.equal(result.error, "#999 not found");
  });

  it("does not affect other todos", () => {
    mgr.toggle(1);
    assert.equal(mgr.todos[0].done, true);
    assert.equal(mgr.todos[1].done, false);
  });
});

describe("todo: remove", () => {
  let mgr;
  beforeEach(() => {
    mgr = new TodoManager();
    mgr.add("Task 1");
    mgr.add("Task 2");
    mgr.add("Task 3");
  });

  it("deletes a todo by ID", () => {
    mgr.remove(2);
    assert.equal(mgr.todos.length, 2);
    assert.ok(!mgr.todos.find((t) => t.id === 2));
  });

  it("preserves remaining todos", () => {
    mgr.remove(2);
    assert.equal(mgr.todos[0].id, 1);
    assert.equal(mgr.todos[1].id, 3);
  });

  it("returns error when id is missing", () => {
    const result = mgr.remove(undefined);
    assert.equal(result.error, "id required");
    assert.equal(mgr.todos.length, 3);
  });

  it("returns error when id not found", () => {
    const result = mgr.remove(999);
    assert.equal(result.error, "#999 not found");
    assert.equal(mgr.todos.length, 3);
  });
});

describe("todo: rename", () => {
  let mgr;
  beforeEach(() => {
    mgr = new TodoManager();
    mgr.add("Original text");
  });

  it("updates the text of a todo", () => {
    mgr.rename(1, "Updated text");
    assert.equal(mgr.todos[0].text, "Updated text");
  });

  it("returns error when id is missing", () => {
    const result = mgr.rename(undefined, "New text");
    assert.equal(result.error, "id required");
  });

  it("returns error when text is missing", () => {
    const result = mgr.rename(1, undefined);
    assert.equal(result.error, "text required");
  });

  it("returns error when id not found", () => {
    const result = mgr.rename(999, "New text");
    assert.equal(result.error, "#999 not found");
  });
});

describe("todo: in_progress", () => {
  let mgr;
  beforeEach(() => {
    mgr = new TodoManager();
    mgr.add("Task 1");
  });

  it("marks a todo as in-progress", () => {
    mgr.inProgress(1);
    assert.equal(mgr.todos[0].inProgress, true);
  });

  it("toggles in-progress off when called again", () => {
    mgr.inProgress(1);
    mgr.inProgress(1);
    assert.equal(mgr.todos[0].inProgress, false);
  });

  it("returns error when the todo is already completed", () => {
    mgr.toggle(1); // mark done
    const result = mgr.inProgress(1);
    assert.equal(result.error, "#1 already completed");
  });

  it("returns error when id is missing", () => {
    const result = mgr.inProgress(undefined);
    assert.equal(result.error, "id required");
  });

  it("returns error when id not found", () => {
    const result = mgr.inProgress(999);
    assert.equal(result.error, "#999 not found");
  });
});

describe("todo: clear", () => {
  let mgr;
  beforeEach(() => {
    mgr = new TodoManager();
    mgr.add("Task 1");
    mgr.add("Task 2");
    mgr.add("Task 3");
  });

  it("removes all todos", () => {
    const result = mgr.clear();
    assert.equal(result.todos.length, 0);
    assert.equal(mgr.todos.length, 0);
  });

  it("resets nextId to 1", () => {
    const result = mgr.clear();
    assert.equal(result.nextId, 1);
    assert.equal(mgr.nextId, 1);
  });

  it("nextId increments correctly after clear", () => {
    mgr.clear();
    mgr.add("After clear");
    assert.equal(mgr.todos[0].id, 1);
    mgr.add("Second after clear");
    assert.equal(mgr.todos[1].id, 2);
  });
});

describe("todo: list", () => {
  it("returns 'No todos' for empty list", () => {
    const mgr = new TodoManager();
    const result = mgr.list();
    assert.equal(result.text, "No todos");
    assert.equal(result.todos.length, 0);
  });

  it("lists all todos with status markers", () => {
    const mgr = new TodoManager();
    mgr.add("Pending");
    mgr.add("In progress");
    mgr.add("Done");
    mgr.inProgress(2);
    mgr.toggle(3);

    const result = mgr.list();
    assert.ok(result.text.includes("[ ] #1"));
    assert.ok(result.text.includes("[~] #2"));
    assert.ok(result.text.includes("[x] #3"));
  });
});

describe("todo: state reconstruction from snapshots", () => {
  it("reconstructs from the last snapshot", () => {
    const snapshots = [
      { action: "add", todos: [{ id: 1, text: "A", done: false, inProgress: false, priority: "medium" }], nextId: 2 },
      { action: "add", todos: [
        { id: 1, text: "A", done: false, inProgress: false, priority: "medium" },
        { id: 2, text: "B", done: false, inProgress: false, priority: "high" },
      ], nextId: 3 },
      { action: "toggle", todos: [
        { id: 1, text: "A", done: true, inProgress: false, priority: "medium" },
        { id: 2, text: "B", done: false, inProgress: false, priority: "high" },
      ], nextId: 3 },
    ];

    const mgr = TodoManager.fromSnapshots(snapshots);
    assert.equal(mgr.todos.length, 2);
    assert.equal(mgr.todos[0].done, true);
    assert.equal(mgr.todos[1].done, false);
    assert.equal(mgr.nextId, 3);
  });

  it("reconstructs from empty snapshots to empty state", () => {
    const mgr = TodoManager.fromSnapshots([]);
    assert.equal(mgr.todos.length, 0);
    assert.equal(mgr.nextId, 1);
  });

  it("skips null/undefined entries in snapshots", () => {
    const snapshots = [
      null,
      undefined,
      { action: "add", todos: [{ id: 1, text: "X", done: false, inProgress: false, priority: "low" }], nextId: 2 },
    ];

    const mgr = TodoManager.fromSnapshots(snapshots);
    assert.equal(mgr.todos.length, 1);
    assert.equal(mgr.todos[0].text, "X");
    assert.equal(mgr.nextId, 2);
  });

  it("last snapshot wins (simulates branch replay)", () => {
    const snapshots = [
      { action: "add", todos: [{ id: 1, text: "Before", done: false, inProgress: false, priority: "medium" }], nextId: 2 },
      { action: "clear", todos: [], nextId: 1 },
    ];

    const mgr = TodoManager.fromSnapshots(snapshots);
    assert.equal(mgr.todos.length, 0);
    assert.equal(mgr.nextId, 1);
  });
});

describe("todo: nextId behavior", () => {
  it("increments on each add", () => {
    const mgr = new TodoManager();
    assert.equal(mgr.nextId, 1);
    mgr.add("A");
    assert.equal(mgr.nextId, 2);
    mgr.add("B");
    assert.equal(mgr.nextId, 3);
  });

  it("does not decrement on remove", () => {
    const mgr = new TodoManager();
    mgr.add("A"); // id=1
    mgr.add("B"); // id=2
    mgr.remove(1);
    assert.equal(mgr.nextId, 3, "nextId should not decrease on remove");
    mgr.add("C"); // id=3
    assert.equal(mgr.todos[1].id, 3);
  });

  it("resets to 1 on clear", () => {
    const mgr = new TodoManager();
    mgr.add("A");
    mgr.add("B");
    assert.equal(mgr.nextId, 3);
    mgr.clear();
    assert.equal(mgr.nextId, 1);
  });
});

describe("todo: ACTIONS and PRIORITIES constants", () => {
  it("defines the expected actions", () => {
    assert.deepEqual(ACTIONS, ["list", "add", "toggle", "remove", "rename", "in_progress", "clear"]);
  });

  it("defines the expected priorities", () => {
    assert.deepEqual(PRIORITIES, ["low", "medium", "high"]);
  });
});
