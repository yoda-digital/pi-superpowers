/**
 * Tests for the superpowers bootstrap.
 *
 * Imports the real code: the pure helpers from extensions/lib/bootstrap.ts and
 * the extension itself (extensions/superpowers.ts), which only has type-level
 * imports from Pi and therefore loads under Node's built-in type stripping.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EXTREMELY_IMPORTANT_TAG,
  INLINE_TOOL_MAPPING,
  buildBootstrapContent,
  firstNonCompactionSummaryIndex,
  messageContainsBootstrap,
  stripFrontmatter,
} from "../extensions/lib/bootstrap.ts";
import superpowersExtension from "../extensions/superpowers.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = join(projectRoot, "skills", "using-superpowers", "SKILL.md");
const piToolsPath = join(projectRoot, "references", "pi-tools.md");

// ---------------------------------------------------------------------------
// Fake Pi host: records handlers so the real extension can be driven.
// ---------------------------------------------------------------------------

function loadExtension() {
  const handlers = new Map();
  superpowersExtension({
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
  });
  const fire = async (event, payload = {}) => {
    let last;
    for (const h of handlers.get(event) ?? []) last = await h(payload, {});
    return last;
  };
  return { handlers, fire };
}

const userMsg = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

// ---------------------------------------------------------------------------

describe("stripFrontmatter", () => {
  it("removes YAML frontmatter delimited by ---", () => {
    assert.equal(stripFrontmatter("---\nname: x\n---\nBody"), "Body");
  });

  it("returns content unchanged (trimmed) when there is no frontmatter", () => {
    assert.equal(stripFrontmatter("  plain\n"), "plain");
  });

  it("only strips the first block", () => {
    assert.equal(stripFrontmatter("---\na: 1\n---\nA\n---\nb: 2\n---\nB"), "A\n---\nb: 2\n---\nB");
  });
});

describe("messageContainsBootstrap", () => {
  it("detects the tag in string content", () => {
    assert.equal(messageContainsBootstrap({ content: `x ${EXTREMELY_IMPORTANT_TAG} y` }), true);
  });

  it("detects the tag in a text part", () => {
    assert.equal(messageContainsBootstrap(userMsg(EXTREMELY_IMPORTANT_TAG)), true);
  });

  it("ignores non-text parts and malformed messages", () => {
    assert.equal(messageContainsBootstrap({ content: [{ type: "image", text: EXTREMELY_IMPORTANT_TAG }] }), false);
    assert.equal(messageContainsBootstrap(undefined), false);
    assert.equal(messageContainsBootstrap({ content: 42 }), false);
    assert.equal(messageContainsBootstrap(userMsg("hello")), false);
  });
});

describe("firstNonCompactionSummaryIndex", () => {
  it("skips leading compaction summaries only", () => {
    const msgs = [{ role: "compactionSummary" }, { role: "compactionSummary" }, { role: "user" }, { role: "compactionSummary" }];
    assert.equal(firstNonCompactionSummaryIndex(msgs), 2);
    assert.equal(firstNonCompactionSummaryIndex([]), 0);
    assert.equal(firstNonCompactionSummaryIndex([{ role: "user" }]), 0);
  });
});

describe("buildBootstrapContent", () => {
  it("assembles the shipped SKILL.md body and the shipped tool mapping", () => {
    const out = buildBootstrapContent(skillPath, piToolsPath);
    const skillBody = stripFrontmatter(readFileSync(skillPath, "utf8"));
    assert.ok(out.startsWith(EXTREMELY_IMPORTANT_TAG));
    assert.ok(out.trimEnd().endsWith("</EXTREMELY_IMPORTANT>"));
    assert.ok(out.includes(skillBody), "must embed the skill body");
    assert.ok(out.includes("# Pi Tool Mapping"), "must embed references/pi-tools.md");
    assert.ok(!out.includes("name: using-superpowers"), "frontmatter must be stripped");
  });

  it("falls back to the inline mapping when the reference file is missing", () => {
    const out = buildBootstrapContent(skillPath, join(projectRoot, "does-not-exist.md"));
    assert.ok(out.includes(INLINE_TOOL_MAPPING));
  });

  it("returns null when the skill file is missing", () => {
    assert.equal(buildBootstrapContent(join(projectRoot, "nope", "SKILL.md"), piToolsPath), null);
  });

  it("re-reads the skill from disk on every call", () => {
    const dir = mkdtempSync(join(tmpdir(), "sp-boot-"));
    try {
      const p = join(dir, "SKILL.md");
      writeFileSync(p, "---\nname: t\n---\nversion one");
      assert.ok(buildBootstrapContent(p, piToolsPath).includes("version one"));
      writeFileSync(p, "---\nname: t\n---\nversion two");
      assert.ok(buildBootstrapContent(p, piToolsPath).includes("version two"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("inline fallback mapping", () => {
  it("does not claim Pi ships worktree tools", () => {
    assert.ok(!/Pi ships `?EnterWorktree/.test(INLINE_TOOL_MAPPING));
    assert.match(INLINE_TOOL_MAPPING, /git worktree/);
  });

  it("points at this package's own subagent and todo tools", () => {
    assert.match(INLINE_TOOL_MAPPING, /`subagent`/);
    assert.match(INLINE_TOOL_MAPPING, /`todo`/);
  });
});

// ---------------------------------------------------------------------------
// The real extension, driven through a fake Pi host
// ---------------------------------------------------------------------------

describe("superpowers extension", () => {
  it("registers the package skills directory", async () => {
    const { fire } = loadExtension();
    const res = await fire("resources_discover");
    assert.deepEqual(res, { skillPaths: [join(projectRoot, "skills")] });
  });

  it("injects the bootstrap once, before the first user message", async () => {
    const { fire } = loadExtension();
    await fire("session_start");
    const res = await fire("context", { messages: [userMsg("Let's make a react todo list")] });
    assert.ok(res, "context handler must return modified messages");
    assert.equal(res.messages.length, 2);
    assert.ok(messageContainsBootstrap(res.messages[0]));
    assert.equal(res.messages[1].content[0].text, "Let's make a react todo list");
  });

  it("does not inject twice when the tag is already present", async () => {
    const { fire } = loadExtension();
    await fire("session_start");
    const res = await fire("context", { messages: [userMsg(EXTREMELY_IMPORTANT_TAG), userMsg("hi")] });
    assert.equal(res, undefined);
  });

  it("stops injecting after the first agent turn and resumes after compaction", async () => {
    const { fire } = loadExtension();
    await fire("session_start");
    await fire("agent_end");
    assert.equal(await fire("context", { messages: [userMsg("later")] }), undefined);

    await fire("session_compact");
    const res = await fire("context", {
      messages: [{ role: "compactionSummary", summary: "s" }, userMsg("after compaction")],
    });
    assert.equal(res.messages[0].role, "compactionSummary", "summary stays first");
    assert.ok(messageContainsBootstrap(res.messages[1]), "bootstrap goes right after the summary");
  });
});
