/**
 * Tests for the subagent tool's child handling — the code
 * extensions/subagent/index.ts runs:
 *   - extensions/lib/subagent-child.ts   (argv, task text, event stream, output)
 *   - extensions/lib/subagent-config.ts  (settings, model tiers)
 *   - extensions/lib/subagent-run.ts     (process runner, session store)
 * The runner is driven end to end against tests/fixtures/fake-pi.mjs.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CHILD_ISOLATION_FLAGS,
  ChildEventCollector,
  PROMPT_MODE_ENV,
  buildChildArgs,
  buildChildTask,
  childModelLabel,
  childNeedsWebTools,
  getFinalAnswer,
  getFinalOutput,
  isValidChildSessionId,
  newChildSessionId,
  resolvePromptMode,
  shouldAppendSystemPrompt,
} from "../extensions/lib/subagent-child.ts";
import {
  DEFAULT_SETTINGS,
  TIERS,
  loadSettings,
  normalizeSettings,
  resolveModelChoice,
} from "../extensions/lib/subagent-config.ts";
import {
  childSessionDir,
  findChildSession,
  findChildSessionFile,
  isDirectory,
  isPathInside,
  pruneChildSessions,
  touchDir,
  runChildProcess,
  writeChildMeta,
} from "../extensions/lib/subagent-run.ts";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs");
const scratch = mkdtempSync(join(tmpdir(), "sp-subagent-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const agent = (over = {}) => ({
  name: "scout",
  description: "Fast recon",
  tools: ["read", "grep"],
  systemPrompt: "You are a codebase scout.\n\n## Output format\n...",
  ...over,
});
const session = { dir: "/s", id: "scout-abcd1234" };
const base = { agent: agent(), choice: {}, promptMode: "full", session, projectTrusted: true, systemPromptFile: "/tmp/p.md" };

/** Value following a flag, or undefined when the flag is absent. */
const flag = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

// ---------------------------------------------------------------------------
// Prompt mode and argv
// ---------------------------------------------------------------------------

describe("resolvePromptMode", () => {
  it('defaults to "full"', () => {
    assert.equal(resolvePromptMode({}), "full");
    assert.equal(resolvePromptMode({ [PROMPT_MODE_ENV]: "something-else" }), "full");
  });

  it(`is "lean" only when ${PROMPT_MODE_ENV}=lean (case/space-insensitive)`, () => {
    assert.equal(resolvePromptMode({ [PROMPT_MODE_ENV]: " LEAN " }), "lean");
  });
});

describe("buildChildArgs", () => {
  it("starts with the isolation flags and keeps no parent extensions, skills or themes", () => {
    const args = buildChildArgs(base);
    assert.deepEqual(args.slice(0, CHILD_ISOLATION_FLAGS.length), [...CHILD_ISOLATION_FLAGS]);
    for (const f of ["--no-extensions", "--no-skills", "--no-themes"]) assert.ok(args.includes(f), f);
  });

  it("persists the child session so it can be resumed (no --no-session)", () => {
    const args = buildChildArgs(base);
    assert.ok(!args.includes("--no-session"));
    assert.equal(flag(args, "--session-dir"), "/s");
    assert.equal(flag(args, "--session-id"), "scout-abcd1234");
  });

  it("never puts the task in argv (it goes to stdin)", () => {
    const args = buildChildArgs(base);
    assert.ok(!args.some((a) => a.startsWith("Task:")));
  });

  it("passes the parent's project-trust decision instead of a blanket --approve", () => {
    assert.ok(buildChildArgs(base).includes("--approve"));
    const untrusted = buildChildArgs({ ...base, projectTrusted: false });
    assert.ok(untrusted.includes("--no-approve"));
    assert.ok(!untrusted.includes("--approve"));
  });

  it("loads project context files (AGENTS.md) unless the agent opts out", () => {
    assert.ok(!buildChildArgs(base).includes("--no-context-files"));
    assert.ok(buildChildArgs({ ...base, agent: agent({ contextFiles: false }) }).includes("--no-context-files"));
  });

  it("passes model and thinking only when chosen", () => {
    assert.ok(!buildChildArgs(base).includes("--model"));
    const args = buildChildArgs({ ...base, choice: { model: "ollama/qwen", thinking: "high" } });
    assert.equal(flag(args, "--model"), "ollama/qwen");
    assert.equal(flag(args, "--thinking"), "high");
  });

  it("restricts tools to the agent's list, or leaves them all", () => {
    assert.equal(flag(buildChildArgs(base), "--tools"), "read,grep");
    assert.ok(!buildChildArgs({ ...base, agent: agent({ tools: undefined }) }).includes("--tools"));
  });

  it("full mode appends the agent body from a file, and refuses to drop it silently", () => {
    assert.equal(flag(buildChildArgs(base), "--append-system-prompt"), "/tmp/p.md");
    assert.throws(() => buildChildArgs({ ...base, systemPromptFile: undefined }), /systemPromptFile/);
    assert.equal(shouldAppendSystemPrompt(agent({ systemPrompt: "  \n" }), "full"), false);
  });

  it("lean mode appends nothing", () => {
    const args = buildChildArgs({ ...base, promptMode: "lean", systemPromptFile: undefined });
    assert.ok(!args.includes("--append-system-prompt"));
  });
});

describe("buildChildTask", () => {
  it("prefixes the task, with a role line in lean mode only", () => {
    assert.equal(buildChildTask(agent(), "map it", "full"), "Task: map it");
    assert.equal(buildChildTask(agent(), "map it", "lean"), "[Role: scout — Fast recon] Task: map it");
    assert.equal(buildChildTask(agent({ description: "" }), "t", "lean"), "Task: t");
  });
});

describe("web tools in children", () => {
  const WEB = "/pkg/extensions/web.ts";

  it("are needed when the agent lists a web_* tool or allows all tools", () => {
    assert.equal(childNeedsWebTools(agent({ tools: ["read", "web_search"] })), true);
    assert.equal(childNeedsWebTools(agent({ tools: undefined })), true);
    assert.equal(childNeedsWebTools(agent({ tools: ["read", "grep"] })), false);
  });

  it("load the web extension explicitly, after --no-extensions", () => {
    const args = buildChildArgs({ ...base, agent: agent({ tools: ["web_search"] }), webExtensionPath: WEB });
    assert.equal(flag(args, "-e"), WEB);
    assert.ok(args.indexOf("-e") > args.indexOf("--no-extensions"));
    assert.ok(!buildChildArgs({ ...base, webExtensionPath: WEB }).includes("-e"));
  });
});

describe("child session ids", () => {
  it("are derived from the agent name and valid for Pi", () => {
    assert.equal(newChildSessionId("Code Reviewer!", "1a2b"), "code-reviewer-1a2b");
    assert.equal(newChildSessionId("---", "ff"), "agent-ff");
    for (let i = 0; i < 20; i++) assert.ok(isValidChildSessionId(newChildSessionId("general-purpose")));
  });

  it("rejects ids that could escape the session directory", () => {
    for (const bad of ["../x", "a/b", "-a", "a-", "", "a b"]) assert.equal(isValidChildSessionId(bad), false, bad);
  });
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

describe("final output", () => {
  const text = (t) => ({ type: "text", text: t });

  it("is every text part of the last assistant message with text", () => {
    const msgs = [
      { role: "assistant", content: [text("first")] },
      { role: "assistant", content: [text("final"), { type: "toolCall" }, text("answer")] },
      { role: "assistant", content: [text("   ")] },
    ];
    assert.equal(getFinalAnswer(msgs), "final\n\nanswer");
    assert.equal(getFinalOutput(msgs), "final\n\nanswer");
  });

  it("labels the last tool output as such when the model never answered", () => {
    const msgs = [
      { role: "toolResult", content: [text("old")] },
      { role: "toolResult", content: [text("newest")] },
      { role: "assistant", content: [] },
    ];
    assert.equal(getFinalAnswer(msgs), "");
    assert.match(getFinalOutput(msgs), /ended without a final answer[\s\S]*newest$/);
    assert.ok(!getFinalOutput(msgs).includes("old"));
  });

  it("caps that fallback", () => {
    const out = getFinalOutput([{ role: "toolResult", content: [text("x".repeat(20000))] }]);
    assert.ok(out.length < 4200);
  });

  it("is empty when there is nothing", () => {
    assert.equal(getFinalOutput([]), "");
  });
});

describe("childModelLabel", () => {
  it("formats provider/model", () => {
    assert.equal(childModelLabel({ provider: "nalyk-ollama", model: "qwen" }), "nalyk-ollama/qwen");
    assert.equal(childModelLabel({ model: "qwen" }), "qwen");
    assert.equal(childModelLabel({}), undefined);
  });
});

describe("ChildEventCollector", () => {
  it("records the session id, usage, model, stop reason and a trimmed display list", () => {
    const c = new ChildEventCollector();
    c.handle({ type: "session", id: "scout-1" });
    c.handle({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "p",
        model: "m",
        stopReason: "stop",
        usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6, cost: { total: 0.5 } },
        content: [{ type: "toolCall", name: "write", arguments: { path: "/a", content: "y".repeat(5000), nested: { a: 1 } } }],
      },
    });
    assert.equal(c.sessionId, "scout-1");
    assert.equal(c.model, "p/m");
    assert.equal(c.stopReason, "stop");
    assert.deepEqual({ ...c.usage }, { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, cost: 0.5, contextTokens: 6, turns: 1 });
    const call = c.items[0];
    assert.equal(call.name, "write");
    assert.ok(call.args.content.length < 400, "long arguments are trimmed");
    assert.equal(call.args.nested, "…");
  });

  it("keeps at most 40 display items", () => {
    const c = new ChildEventCollector();
    for (let i = 0; i < 100; i++) c.handle({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `t${i}` }] } });
    assert.equal(c.items.length, 40);
    assert.equal(c.items.at(-1).text, "t99");
  });

  it("ignores events it does not use", () => {
    const c = new ChildEventCollector();
    assert.equal(c.handle({ type: "message_update" }), false);
    assert.equal(c.handle({ type: "message_end", message: { role: "user", content: "hi" } }), false);
  });
});

// ---------------------------------------------------------------------------
// Settings and model tiers
// ---------------------------------------------------------------------------

describe("settings", () => {
  it("default to no tiers, 4 concurrent, 8 tasks, 60 minutes, 14 days", () => {
    assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  });

  it("keep valid fields and drop malformed ones", () => {
    const s = normalizeSettings({ tiers: { cheap: " a/b ", mid: 3, top: "" , bogus: "x" }, concurrency: 0, timeoutMinutes: 0, maxParallelTasks: "9" });
    assert.deepEqual(s.tiers, { cheap: "a/b" });
    assert.equal(s.concurrency, 4);
    assert.equal(s.timeoutMinutes, 0, "0 disables the timeout");
    assert.equal(s.maxParallelTasks, 8);
  });

  it("load from a file, report a broken file, and treat a missing one as defaults", () => {
    const good = join(scratch, "good.json");
    writeFileSync(good, JSON.stringify({ tiers: { top: "x/y" }, concurrency: 1 }));
    assert.deepEqual(loadSettings(good).settings.tiers, { top: "x/y" });
    assert.equal(loadSettings(good).settings.concurrency, 1);

    const bad = join(scratch, "bad.json");
    writeFileSync(bad, "{ nope");
    const r = loadSettings(bad);
    assert.ok(r.error);
    assert.deepEqual(r.settings, DEFAULT_SETTINGS);

    assert.deepEqual(loadSettings(join(scratch, "missing.json")), { settings: DEFAULT_SETTINGS });
  });

  it("the tier names are cheap, mid, top", () => {
    assert.deepEqual([...TIERS], ["cheap", "mid", "top"]);
  });
});

describe("resolveModelChoice", () => {
  const parent = { parentModel: "ollama/big", parentThinking: "medium", tiers: { cheap: "ollama/small", top: "ollama/best" } };

  it("inherits the parent model and its thinking level by default", () => {
    assert.deepEqual(resolveModelChoice(parent), { model: "ollama/big", thinking: "medium", source: "parent" });
  });

  it("maps a dispatch tier to its model, without the parent's thinking level", () => {
    assert.deepEqual(resolveModelChoice({ ...parent, requested: "cheap" }), { model: "ollama/small", thinking: undefined, source: "dispatch" });
  });

  it("an explicit provider/id passes through", () => {
    assert.equal(resolveModelChoice({ ...parent, requested: "other/model" }).model, "other/model");
  });

  it("an unset tier falls back to the parent model and says so", () => {
    const c = resolveModelChoice({ ...parent, requested: "mid" });
    assert.equal(c.model, "ollama/big");
    assert.equal(c.thinking, "medium", "it is the parent's model, so the parent's level applies");
    assert.match(c.note, /tier "mid" is not configured/);
  });

  it("dispatch beats agent; agent beats parent; explicit thinking always wins", () => {
    assert.equal(resolveModelChoice({ ...parent, requested: "top", agentModel: "cheap" }).model, "ollama/best");
    assert.equal(resolveModelChoice({ ...parent, agentModel: "cheap" }).model, "ollama/small");
    assert.equal(resolveModelChoice({ ...parent, agentModel: "cheap", agentThinking: "low" }).thinking, "low");
    assert.equal(resolveModelChoice({ ...parent, requestedThinking: "high", agentThinking: "low" }).thinking, "high");
  });

  it("lean mode without an explicit choice lets the child pick from settings.json", () => {
    assert.deepEqual(resolveModelChoice({ ...parent, lean: true }), { source: "child-default", thinking: undefined });
    assert.equal(resolveModelChoice({ ...parent, lean: true, requested: "top" }).model, "ollama/best");
  });

  it("with no parent model and nothing chosen, the child uses its default", () => {
    assert.equal(resolveModelChoice({ tiers: {} }).model, undefined);
    assert.equal(resolveModelChoice({ tiers: {} }).source, "child-default");
  });
});

// ---------------------------------------------------------------------------
// Runner, against a fake `pi`
// ---------------------------------------------------------------------------

function runFake(mode, over = {}) {
  const events = [];
  const promise = runChildProcess({
    command: process.execPath,
    args: [FAKE_PI, "--session-id", "fake-1", ...(over.args ?? [])],
    cwd: over.cwd ?? scratch,
    env: { ...process.env, FAKE_PI_MODE: mode, PI_SUPERPOWERS_CHILD: "1" },
    stdin: over.stdin ?? "Task: hello",
    signal: over.signal,
    timeoutMs: over.timeoutMs,
    killGraceMs: over.killGraceMs ?? 200,
    onEvent: (e) => events.push(e),
  });
  return promise.then((outcome) => {
    const c = new ChildEventCollector();
    for (const e of events) c.handle(e);
    return { outcome, events, c };
  });
}

describe("runChildProcess", () => {
  it("delivers the task on stdin and reads the JSON event stream", async () => {
    const { outcome, c } = await runFake("ok");
    assert.equal(outcome.exitCode, 0);
    assert.equal(c.sessionId, "fake-1");
    const report = JSON.parse(c.output);
    assert.equal(report.stdinHead, "Task: hello");
    assert.equal(report.child, "1", "children are marked so they skip the bootstrap");
    assert.equal(c.usage.turns, 2);
    assert.deepEqual(c.items[0], { type: "toolCall", name: "read", args: { path: "/x" } });
  });

  it("passes a task far larger than the 128 KiB argv limit", async () => {
    const big = `Task: ${"z".repeat(600 * 1024)}`;
    const { outcome, c } = await runFake("ok", { stdin: big });
    assert.equal(outcome.exitCode, 0);
    assert.equal(JSON.parse(c.output).stdinLength, big.length);
  });

  it("runs in the requested cwd", async () => {
    const dir = mkdtempSync(join(scratch, "cwd-"));
    const { c } = await runFake("ok", { cwd: dir });
    assert.equal(JSON.parse(c.output).cwd, dir);
  });

  it("returns every text part of a multi-part final message", async () => {
    const { c } = await runFake("multi-text");
    assert.equal(c.output, "part one\n\npart two");
  });

  it("does not split records on U+2028 / U+2029", async () => {
    const { c } = await runFake("unicode-sep");
    assert.equal(c.output, "line sep end");
  });

  it("reassembles records and multi-byte characters split across chunks", async () => {
    const { c } = await runFake("split-writes");
    assert.equal(c.output, "héllo wörld");
  });

  it("reports a model error through the stop reason (JSON mode still exits 0)", async () => {
    const { outcome, c } = await runFake("model-error");
    assert.equal(outcome.exitCode, 0);
    assert.equal(c.stopReason, "error");
    assert.equal(c.errorMessage, "provider exploded");
  });

  it("labels tool output when the child never answered", async () => {
    const { c } = await runFake("no-answer");
    assert.match(c.output, /ended without a final answer[\s\S]*tool says hi/);
  });

  it("keeps the exit code and stderr of a failing child", async () => {
    const { outcome } = await runFake("exit-code");
    assert.equal(outcome.exitCode, 3);
    assert.match(outcome.stderr, /boom on stderr/);
  });

  it("reports a spawn failure instead of swallowing it", async () => {
    const outcome = await runChildProcess({
      command: join(scratch, "no-such-binary"),
      args: [],
      cwd: scratch,
      env: process.env,
      stdin: "x",
      onEvent: () => {},
    });
    assert.match(outcome.spawnError, /ENOENT/);
  });

  it("times out a hung child", async () => {
    const { outcome } = await runFake("hang", { timeoutMs: 300 });
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.exitSignal, "SIGTERM");
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const { outcome } = await runFake("ignore-term", { timeoutMs: 300, killGraceMs: 300 });
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.exitSignal, "SIGKILL");
  });

  it("stops the child on abort", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const { outcome } = await runFake("hang", { signal: ac.signal });
    assert.equal(outcome.aborted, true);
    assert.notEqual(outcome.exitSignal, null);
  });
});

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

describe("child session store", () => {
  const root = join(scratch, "sessions");

  it("keeps one directory per parent session, with safe names", () => {
    assert.equal(childSessionDir(root, "abc-123"), join(root, "abc-123"));
    assert.equal(childSessionDir(root, "../evil"), join(root, ".._evil"));
    assert.equal(childSessionDir(root, undefined), join(root, "no-parent-session"));
  });

  it("finds a child in the current parent's directory first, then in any other", () => {
    const mine = childSessionDir(root, "parent-a");
    const other = childSessionDir(root, "parent-b");
    writeChildMeta(mine, { id: "impl-1", agent: "implementer", cwd: "/w", createdAt: "t" });
    writeChildMeta(other, { id: "impl-2", agent: "reviewer", cwd: "/w", createdAt: "t" });
    assert.equal(findChildSession(root, mine, "impl-1").meta.agent, "implementer");
    const found = findChildSession(root, mine, "impl-2");
    assert.equal(found.dir, other);
    assert.equal(found.meta.agent, "reviewer");
    assert.equal(findChildSession(root, mine, "nope-1"), null);
    assert.equal(findChildSession(root, mine, "../parent-b/impl-2"), null, "ids cannot traverse directories");
  });

  it("locates the child's transcript file", () => {
    const dir = childSessionDir(root, "parent-a");
    writeFileSync(join(dir, "2026-10-10T10-00-00-000Z_impl-1.jsonl"), "");
    assert.equal(findChildSessionFile(dir, "impl-1"), join(dir, "2026-10-10T10-00-00-000Z_impl-1.jsonl"));
    assert.equal(findChildSessionFile(dir, "impl-9"), undefined);
  });

  it("prunes parent directories older than the retention period", () => {
    const pruneRoot = join(scratch, "prune");
    const oldDir = join(pruneRoot, "old");
    const newDir = join(pruneRoot, "new");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    const now = Date.now();
    const twentyDaysAgo = (now - 20 * 86400000) / 1000;
    utimesSync(oldDir, twentyDaysAgo, twentyDaysAgo);
    assert.equal(pruneChildSessions(pruneRoot, 0, now), 0, "0 keeps everything");
    assert.equal(pruneChildSessions(pruneRoot, 14, now), 1);
    assert.deepEqual(readdirSync(pruneRoot), ["new"]);
  });

  it("a resume touches the parent directory, so a child in regular use is not pruned", () => {
    const pruneRoot = join(scratch, "prune-touch");
    const dir = join(pruneRoot, "parent");
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const old = (now - 20 * 86400000) / 1000;
    utimesSync(dir, old, old);
    touchDir(dir, new Date(now));
    assert.equal(pruneChildSessions(pruneRoot, 14, now), 0);
  });
});

describe("path helpers", () => {
  it("isPathInside: the directory itself and descendants, not siblings or parents", () => {
    assert.equal(isPathInside("/w/app", "/w/app"), true);
    assert.equal(isPathInside("/w/app/src/x", "/w/app"), true);
    assert.equal(isPathInside("/w/app-other", "/w/app"), false);
    assert.equal(isPathInside("/w", "/w/app"), false);
    assert.equal(isPathInside("/w/app/../elsewhere", "/w/app"), false);
  });

  it("isDirectory: false for files and missing paths", () => {
    assert.equal(isDirectory(scratch), true);
    const f = join(scratch, "plain-file");
    writeFileSync(f, "x");
    assert.equal(isDirectory(f), false);
    assert.equal(isDirectory(join(scratch, "missing")), false);
  });
});
