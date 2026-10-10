/**
 * Tests for the grading in scripts/eval-skills.mjs (the live evals themselves
 * need a model and are run by hand).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CASES, gradeBootstrapProbe, gradeRun, lastPromptEvents, skillLoaded, toolCalls } from "../scripts/eval-skills.mjs";

const call = (name, args) => ({ type: "toolCall", name, arguments: args });
const turn = (...parts) => ({ type: "message_end", message: { role: "assistant", content: parts } });
const readSkill = (skill) => call("read", { path: `/pkg/skills/${skill}/SKILL.md` });

describe("eval grading", () => {
  it("collects tool calls in order from assistant messages only", () => {
    const events = [
      { type: "message_end", message: { role: "user", content: "hi" } },
      turn({ type: "text", text: "ok" }, call("read", { path: "a" })),
      turn(call("bash", { command: "ls" })),
    ];
    assert.deepEqual(toolCalls(events).map((c) => c.name), ["read", "bash"]);
  });

  it("recognizes a skill load through read or bash", () => {
    assert.equal(skillLoaded({ name: "read", args: { path: "/x/skills/brainstorming/SKILL.md" } }), "brainstorming");
    assert.equal(skillLoaded({ name: "bash", args: { command: "cat ~/p/skills/systematic-debugging/SKILL.md" } }), "systematic-debugging");
    assert.equal(skillLoaded({ name: "read", args: { path: "/x/README.md" } }), undefined);
  });

  it("passes when the skill is loaded before the first file change", () => {
    const r = gradeRun([turn(readSkill("brainstorming")), turn(call("write", { path: "a.js" }))], { skill: "brainstorming" });
    assert.equal(r.pass, true);
  });

  it("passes when the skill is loaded and nothing is written (brainstorming asks first)", () => {
    assert.equal(gradeRun([turn(readSkill("brainstorming"))], { skill: "brainstorming" }).pass, true);
  });

  it("fails when code comes first, and says so", () => {
    const r = gradeRun([turn(call("write", { path: "App.jsx" })), turn(readSkill("brainstorming"))], { skill: "brainstorming" });
    assert.equal(r.pass, false);
    assert.match(r.reasons[0], /only after the first file change/);
  });

  it("fails when the skill is never loaded", () => {
    const r = gradeRun([turn(call("bash", { command: "ls" }))], { skill: "systematic-debugging" });
    assert.match(r.reasons[0], /never loaded/);
  });

  it("noWrites fails on any write or edit", () => {
    assert.equal(gradeRun([turn(call("bash", { command: "git stash --help" }))], { noWrites: true }).pass, true);
    assert.equal(gradeRun([turn(call("edit", { path: "x" }))], { noWrites: true }).pass, false);
  });

  it("grades only what follows the last user message", () => {
    const user = (t) => ({ type: "message_end", message: { role: "user", content: t } });
    const events = [user("hi"), turn(call("write", { path: "x" })), user("build it"), turn(readSkill("brainstorming"))];
    const last = lastPromptEvents(events);
    assert.equal(last.length, 1);
    assert.equal(gradeRun(last, { skill: "brainstorming" }).pass, true);
  });

  it("the bootstrap probe fails unless every model request carried the bootstrap", () => {
    assert.deepEqual(gradeBootstrapProbe(["1", "1", ""]), []);
    assert.match(gradeBootstrapProbe(["1", "0", "0", ""])[0], /missing from 2 of 3/);
    assert.match(gradeBootstrapProbe([""])[0], /no model request/);
  });

  it("every case names an expectation and a reason", () => {
    for (const c of CASES) {
      assert.ok(c.prompts.length > 0, c.name);
      assert.ok(c.expect.skill || c.expect.noWrites, c.name);
      assert.ok(c.why, c.name);
    }
  });
});
