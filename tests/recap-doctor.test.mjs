/**
 * Tests for what keeps working state alive across compaction (todo and
 * subagent recaps) and for the /superpowers status report.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildDoctorReport } from "../extensions/lib/doctor.ts";
import { buildSubagentRecap, collectResumableChildren } from "../extensions/lib/subagent-run.ts";
import { buildTodoRecap } from "../extensions/lib/todo-state.ts";

const todo = (id, text, over = {}) => ({ id, text, done: false, inProgress: false, priority: "medium", createdAt: 0, ...over });
const subagentResult = (results) => ({ type: "message", message: { role: "toolResult", toolName: "subagent", details: { results } } });
const child = (id, agent, task, over = {}) => ({ id, agent, task, exitCode: 0, stopReason: "stop", ...over });

describe("buildTodoRecap", () => {
  it("lists only the open items, with progress", () => {
    const recap = buildTodoRecap([todo(1, "write test", { done: true }), todo(2, "implement", { inProgress: true }), todo(3, "review")]);
    assert.match(recap, /1\/3 done/);
    assert.match(recap, /\[~\] #2 .*implement/);
    assert.match(recap, /\[ \] #3 .*review/);
    assert.doesNotMatch(recap, /write test/);
  });

  it("is null when nothing is open", () => {
    assert.equal(buildTodoRecap([]), null);
    assert.equal(buildTodoRecap([todo(1, "x", { done: true })]), null);
  });
});

describe("collectResumableChildren", () => {
  it("reads subagent results from the branch, newest first, one row per child", () => {
    const entries = [
      subagentResult([child("impl-1", "general-purpose", "Implement task 1\\nmore")]),
      { type: "message", message: { role: "toolResult", toolName: "todo", details: { results: [child("x", "y", "z")] } } },
      subagentResult([child("rev-1", "general-purpose", "Review task 1", { stopReason: "error" })]),
      subagentResult([child("impl-1", "general-purpose", "Fix: findings")]), // a resume
      { type: "compaction" },
    ];
    const rows = collectResumableChildren(entries);
    assert.deepEqual(rows.map((r) => r.id), ["impl-1", "rev-1"]);
    assert.equal(rows[0].task, "Fix: findings");
    assert.equal(rows[1].failed, true);
  });

  it("caps the list and the task text", () => {
    const entries = Array.from({ length: 20 }, (_, i) => subagentResult([child(`c-${i}`, "scout", "t".repeat(500))]));
    const rows = collectResumableChildren(entries, 8);
    assert.equal(rows.length, 8);
    assert.equal(rows[0].id, "c-19");
    assert.ok(rows[0].task.length <= 101);
  });

  it("ignores malformed details and running placeholders without an id", () => {
    const rows = collectResumableChildren([subagentResult("nope"), subagentResult([{ agent: "a" }]), {}, null]);
    assert.deepEqual(rows, []);
  });
});

describe("buildSubagentRecap", () => {
  it("tells the model how to resume each child", () => {
    const recap = buildSubagentRecap([{ id: "impl-1", agent: "general-purpose", task: "Implement", failed: false }]);
    assert.match(recap, /resume/);
    assert.match(recap, /- impl-1 \(general-purpose\): Implement/);
    assert.equal(buildSubagentRecap([]), null);
  });
});

describe("buildDoctorReport", () => {
  const healthy = {
    packageVersion: "2.1.0",
    upstream: { ref: "v7.0.0", commit: "bb92a77741419a4ab5f06e711a283343f1ada0c3" },
    bootstrap: "x".repeat(7600),
    skillNames: ["brainstorming", "using-superpowers"],
    activeTools: ["read", "bash", "subagent", "todo", "ask_user", "web_search", "web_fetch", "web_verify", "web_watch"],
    tiers: { top: "ollama/big" },
    childSessions: 2,
    tavilyKey: true,
    sessionModel: "ollama/qwen",
  };

  it("reports a healthy install with no problems", () => {
    const { lines, problems } = buildDoctorReport(healthy);
    assert.equal(problems, 0);
    assert.equal(lines[0], "pi-superpowers 2.1.0 (Superpowers v7.0.0 @ bb92a77)");
    assert.ok(lines.some((l) => l.startsWith("✓ bootstrap")));
    assert.ok(lines.some((l) => l.includes("cheap=(session: ollama/qwen)") && l.includes("top=ollama/big")));
    assert.ok(lines.some((l) => l === "✓ 2 resumable subagent sessions for this session"));
  });

  it("fails on a missing bootstrap, skills or broken settings, and warns with the fix otherwise", () => {
    const { lines, problems } = buildDoctorReport({
      ...healthy,
      bootstrap: null,
      skillNames: [],
      activeTools: ["read"],
      tiers: {},
      settingsError: "bad json",
      tavilyKey: false,
    });
    assert.equal(problems, 3);
    assert.ok(lines.some((l) => l.startsWith("! tools not active: subagent")));
    assert.ok(lines.some((l) => l.includes("/subagent-models")));
    assert.ok(lines.some((l) => l.includes("/web-key")));
  });
});
