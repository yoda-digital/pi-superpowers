/**
 * Tests for how the subagent tool builds and reads child `pi` processes
 * (extensions/lib/subagent-child.ts — the code extensions/subagent/index.ts runs).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CHILD_ISOLATION_FLAGS,
  PROMPT_MODE_ENV,
  buildChildArgs,
  childModelLabel,
  childNeedsWebTools,
  getFinalOutput,
  resolvePromptMode,
  shouldAppendSystemPrompt,
} from "../extensions/lib/subagent-child.ts";

const agent = (over = {}) => ({
  name: "scout",
  description: "Fast recon",
  tools: ["read", "grep"],
  model: undefined,
  systemPrompt: "You are a codebase scout.\n\n## Output format\n...",
  ...over,
});
const parent = { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "high" };

/** Value following a flag, or undefined when the flag is absent. */
const flag = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

// ---------------------------------------------------------------------------

describe("resolvePromptMode", () => {
  it('defaults to "full"', () => {
    assert.equal(resolvePromptMode({}), "full");
    assert.equal(resolvePromptMode({ [PROMPT_MODE_ENV]: "" }), "full");
    assert.equal(resolvePromptMode({ [PROMPT_MODE_ENV]: "something-else" }), "full");
  });

  it(`is "lean" only when ${PROMPT_MODE_ENV}=lean (case/space-insensitive)`, () => {
    assert.equal(resolvePromptMode({ [PROMPT_MODE_ENV]: "lean" }), "lean");
    assert.equal(resolvePromptMode({ [PROMPT_MODE_ENV]: " LEAN " }), "lean");
  });
});

describe("full mode (default)", () => {
  it("appends the agent's full system prompt from a file", () => {
    assert.equal(shouldAppendSystemPrompt(agent(), "full"), true);
    const { args } = buildChildArgs({ agent: agent(), task: "map it", dispatchDefaults: parent, promptMode: "full", systemPromptFile: "/tmp/p.md" });
    assert.equal(flag(args, "--append-system-prompt"), "/tmp/p.md");
  });

  it("does not append anything for an empty body", () => {
    assert.equal(shouldAppendSystemPrompt(agent({ systemPrompt: "  \n" }), "full"), false);
    const { args } = buildChildArgs({ agent: agent({ systemPrompt: "" }), task: "t", dispatchDefaults: parent, promptMode: "full" });
    assert.ok(!args.includes("--append-system-prompt"));
  });

  it("refuses to build a full-mode invocation that would silently drop the body", () => {
    assert.throws(
      () => buildChildArgs({ agent: agent(), task: "t", dispatchDefaults: parent, promptMode: "full" }),
      /systemPromptFile/,
    );
  });

  it("passes the task as the last argument", () => {
    const { args } = buildChildArgs({ agent: agent(), task: "map it", dispatchDefaults: parent, promptMode: "full", systemPromptFile: "/f" });
    assert.equal(args.at(-1), "Task: map it");
  });

  it("inherits the parent model and thinking level when the agent pins no model", () => {
    const r = buildChildArgs({ agent: agent(), task: "t", dispatchDefaults: parent, promptMode: "full", systemPromptFile: "/f" });
    assert.equal(flag(r.args, "--model"), "anthropic/claude-sonnet-4-5");
    assert.equal(flag(r.args, "--thinking"), "high");
    assert.equal(r.model, "anthropic/claude-sonnet-4-5", "displayed model is the one passed to the child");
  });

  it("uses the agent's own model, without the parent's thinking level, when it pins one", () => {
    const r = buildChildArgs({ agent: agent({ model: "openai/gpt-x" }), task: "t", dispatchDefaults: parent, promptMode: "full", systemPromptFile: "/f" });
    assert.equal(flag(r.args, "--model"), "openai/gpt-x");
    assert.equal(flag(r.args, "--thinking"), undefined);
    assert.equal(r.model, "openai/gpt-x");
  });

  it("passes no --model when neither agent nor parent has one", () => {
    const r = buildChildArgs({ agent: agent(), task: "t", dispatchDefaults: {}, promptMode: "full", systemPromptFile: "/f" });
    assert.ok(!r.args.includes("--model"));
    assert.equal(r.model, undefined);
  });
});

describe("lean mode (opt-in)", () => {
  const lean = buildChildArgs({ agent: agent({ model: "openai/gpt-x" }), task: "map it", dispatchDefaults: parent, promptMode: "lean" });

  it("sends only a one-line role prefix plus the task", () => {
    assert.equal(shouldAppendSystemPrompt(agent(), "lean"), false);
    assert.ok(!lean.args.includes("--append-system-prompt"));
    assert.equal(lean.args.at(-1), "[Role: scout — Fast recon] Task: map it");
  });

  it("lets the child resolve its model and thinking from settings.json", () => {
    assert.ok(!lean.args.includes("--model"));
    assert.ok(!lean.args.includes("--thinking"));
    assert.equal(lean.model, undefined, "the real model is read from the child's messages instead");
  });

  it("omits the role prefix for an agent without description", () => {
    const r = buildChildArgs({ agent: agent({ description: "" }), task: "t", dispatchDefaults: parent, promptMode: "lean" });
    assert.equal(r.args.at(-1), "Task: t");
  });
});

describe("both modes", () => {
  for (const promptMode of ["full", "lean"]) {
    it(`${promptMode}: isolates the child and restricts its tools`, () => {
      const { args } = buildChildArgs({ agent: agent(), task: "t", dispatchDefaults: parent, promptMode, systemPromptFile: "/f" });
      assert.deepEqual(args.slice(0, CHILD_ISOLATION_FLAGS.length), [...CHILD_ISOLATION_FLAGS]);
      for (const f of ["--no-extensions", "--no-skills", "--no-context-files", "--no-session"]) assert.ok(args.includes(f), f);
      assert.equal(flag(args, "--tools"), "read,grep");
    });
  }

  it("omits --tools when the agent allows all tools", () => {
    const { args } = buildChildArgs({ agent: agent({ tools: undefined }), task: "t", dispatchDefaults: parent, promptMode: "lean" });
    assert.ok(!args.includes("--tools"));
  });
});

describe("web tools in children", () => {
  const WEB = "/pkg/extensions/web.ts";

  it("are needed when the agent lists a web_* tool or allows all tools", () => {
    assert.equal(childNeedsWebTools(agent({ tools: ["read", "web_search"] })), true);
    assert.equal(childNeedsWebTools(agent({ tools: ["read", "web_*"] })), true);
    assert.equal(childNeedsWebTools(agent({ tools: undefined })), true);
    assert.equal(childNeedsWebTools(agent({ tools: ["read", "grep"] })), false);
  });

  for (const promptMode of ["full", "lean"]) {
    it(`${promptMode}: load the web extension explicitly (children run with --no-extensions)`, () => {
      const { args } = buildChildArgs({ agent: agent({ tools: ["read", "web_search"] }), task: "t", dispatchDefaults: parent, promptMode, systemPromptFile: "/f", webExtensionPath: WEB });
      assert.equal(flag(args, "-e"), WEB);
      assert.ok(args.indexOf("-e") > args.indexOf("--no-extensions"));
    });
  }

  it("are not loaded for agents that do not use them, or when no path is given", () => {
    const a = buildChildArgs({ agent: agent(), task: "t", dispatchDefaults: parent, promptMode: "lean", webExtensionPath: WEB });
    assert.ok(!a.args.includes("-e"));
    const b = buildChildArgs({ agent: agent({ tools: ["web_search"] }), task: "t", dispatchDefaults: parent, promptMode: "lean" });
    assert.ok(!b.args.includes("-e"));
  });
});

describe("childModelLabel", () => {
  it("formats provider/model from a child assistant message", () => {
    assert.equal(childModelLabel({ role: "assistant", provider: "nalyk-ollama", model: "qwen" }), "nalyk-ollama/qwen");
    assert.equal(childModelLabel({ role: "assistant", model: "qwen" }), "qwen");
    assert.equal(childModelLabel({ role: "assistant" }), undefined);
  });
});

describe("getFinalOutput", () => {
  const text = (t) => ({ type: "text", text: t });

  it("returns the last non-empty assistant text", () => {
    const msgs = [
      { role: "assistant", content: [text("first")] },
      { role: "toolResult", content: [text("tool out")] },
      { role: "assistant", content: [text("final answer")] },
      { role: "assistant", content: [text("   ")] },
    ];
    assert.equal(getFinalOutput(msgs), "final answer");
  });

  it("falls back to tool results when the model never wrote text", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] },
      { role: "toolResult", content: [text(" a ")] },
      { role: "toolResult", content: [text("b")] },
    ];
    assert.equal(getFinalOutput(msgs), "a\n\nb");
  });

  it("returns an empty string when there is nothing", () => {
    assert.equal(getFinalOutput([]), "");
  });
});
