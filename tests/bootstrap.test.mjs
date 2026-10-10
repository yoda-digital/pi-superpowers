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
  BOOTSTRAP_SECTION,
  CHILD_ENV,
  buildBootstrapContent,
  isSubagentChild,
  stripFrontmatter,
} from "../extensions/lib/bootstrap.ts";
import superpowersExtension from "../extensions/superpowers.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = join(projectRoot, "skills", "using-superpowers", "SKILL.md");
const piToolsPath = join(projectRoot, "references", "pi-tools.md");

// ---------------------------------------------------------------------------
// Fake Pi host. Like Pi's runner, every run gets fresh prompt options whose
// `sections` object handlers mutate in place.
// ---------------------------------------------------------------------------

function loadExtension() {
  const handlers = new Map();
  const commands = new Map();
  superpowersExtension({
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  });
  const startRun = async (prompt = "hi") => {
    const event = { type: "before_agent_start", prompt, systemPrompt: "", systemPromptOptions: { sections: {} } };
    for (const h of handlers.get("before_agent_start") ?? []) await h(event, {});
    return event.systemPromptOptions.sections;
  };
  return { handlers, commands, startRun };
}

// ---------------------------------------------------------------------------

describe("stripFrontmatter", () => {
  it("removes YAML frontmatter delimited by ---", () => {
    assert.equal(stripFrontmatter("---\nname: x\n---\nBody"), "Body");
  });

  it("handles CRLF line endings", () => {
    assert.equal(stripFrontmatter("---\r\nname: x\r\n---\r\nBody"), "Body");
  });

  it("returns content unchanged (trimmed) when there is no frontmatter", () => {
    assert.equal(stripFrontmatter("  plain\n"), "plain");
  });

  it("only strips the first block", () => {
    assert.equal(stripFrontmatter("---\na: 1\n---\nA\n---\nb: 2\n---\nB"), "A\n---\nb: 2\n---\nB");
  });
});

describe("buildBootstrapContent", () => {
  it("contains the using-superpowers body (no frontmatter) and the Pi tool mapping", () => {
    const content = buildBootstrapContent(skillPath, piToolsPath);
    assert.ok(content.startsWith("<EXTREMELY_IMPORTANT>\nYou have superpowers."));
    assert.ok(content.endsWith("</EXTREMELY_IMPORTANT>"));
    assert.ok(content.includes(stripFrontmatter(readFileSync(skillPath, "utf8"))));
    assert.ok(content.includes(readFileSync(piToolsPath, "utf8").trim()));
    assert.ok(!content.includes("name: using-superpowers"));
  });

  it("returns null when the skill cannot be read", () => {
    assert.equal(buildBootstrapContent("/nonexistent/SKILL.md", piToolsPath), null);
  });

  it("still bootstraps without the tool mapping", () => {
    const content = buildBootstrapContent(skillPath, "/nonexistent/pi-tools.md");
    assert.ok(content.includes("You have superpowers."));
    assert.ok(!content.includes("# Pi Tool Mapping"));
  });

  it("re-reads from disk on every call", () => {
    const dir = mkdtempSync(join(tmpdir(), "sp-boot-"));
    try {
      const p = join(dir, "SKILL.md");
      writeFileSync(p, "---\nname: x\n---\nfirst");
      assert.ok(buildBootstrapContent(p, piToolsPath).includes("first"));
      writeFileSync(p, "---\nname: x\n---\nsecond");
      assert.ok(buildBootstrapContent(p, piToolsPath).includes("second"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is deterministic, so an unchanged section keeps the prompt cache", () => {
    assert.equal(buildBootstrapContent(skillPath, piToolsPath), buildBootstrapContent(skillPath, piToolsPath));
  });
});

describe("isSubagentChild", () => {
  it(`is true only when ${CHILD_ENV}=1`, () => {
    assert.equal(isSubagentChild({ [CHILD_ENV]: "1" }), true);
    assert.equal(isSubagentChild({ [CHILD_ENV]: "0" }), false);
    assert.equal(isSubagentChild({}), false);
  });
});

describe("superpowers extension", () => {
  it("only hooks before_agent_start (no request-local context injection, no resources_discover)", () => {
    const { handlers } = loadExtension();
    assert.deepEqual([...handlers.keys()], ["before_agent_start"]);
  });

  it("registers the /superpowers status command", () => {
    const { commands } = loadExtension();
    assert.deepEqual([...commands.keys()], ["superpowers"]);
    assert.match(commands.get("superpowers").description, /status/);
  });

  it(`puts the bootstrap in the "${BOOTSTRAP_SECTION}" system prompt section`, async () => {
    const { startRun } = loadExtension();
    const sections = await startRun();
    assert.equal(sections[BOOTSTRAP_SECTION], buildBootstrapContent(skillPath, piToolsPath));
  });

  it("sets it on every run, not just the first (regression: the bootstrap used to vanish after one exchange)", async () => {
    const { startRun } = loadExtension();
    for (let i = 0; i < 3; i++) {
      const sections = await startRun(`prompt ${i}`);
      assert.ok(sections[BOOTSTRAP_SECTION]?.includes("You have superpowers."), `run ${i}`);
    }
  });

  it("leaves other sections alone", async () => {
    const { handlers } = loadExtension();
    const event = { systemPromptOptions: { sections: { tool_guidance: "keep me" } } };
    for (const h of handlers.get("before_agent_start")) await h(event, {});
    assert.equal(event.systemPromptOptions.sections.tool_guidance, "keep me");
  });

  it("registers nothing inside a subagent child", () => {
    const saved = process.env[CHILD_ENV];
    process.env[CHILD_ENV] = "1";
    try {
      const { handlers, commands } = loadExtension();
      assert.equal(handlers.size, 0);
      assert.equal(commands.size, 0);
    } finally {
      if (saved === undefined) delete process.env[CHILD_ENV];
      else process.env[CHILD_ENV] = saved;
    }
  });

  it("the section name is valid for Pi (lowercase, not preamble)", () => {
    assert.match(BOOTSTRAP_SECTION, /^[a-z][a-z0-9_-]*$/);
    assert.notEqual(BOOTSTRAP_SECTION, "preamble");
  });
});
