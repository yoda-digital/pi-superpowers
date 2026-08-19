/**
 * Tests for the superpowers bootstrap extension (extensions/superpowers.ts).
 *
 * Since the extension imports from @earendil-works/pi-coding-agent, we cannot
 * import it directly. Instead we test the pure logic by:
 *   1. Reading the source as text and verifying structural invariants.
 *   2. Re-implementing the pure functions (stripFrontmatter,
 *      messageContainsBootstrap, firstNonCompactionSummaryIndex,
 *      buildBootstrapContent) from the source and testing them in isolation.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const extensionPath = resolve(projectRoot, "extensions", "superpowers.ts");
const extensionSource = readFileSync(extensionPath, "utf8");

// Re-implement pure functions from the source for isolated testing.

function stripFrontmatter(content) {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return (match ? match[1] : content).trim();
}

const EXTREMELY_IMPORTANT_TAG = "<EXTREMELY_IMPORTANT>";

function messageContainsBootstrap(message) {
  const content = message?.content;
  if (typeof content === "string") return content.includes(EXTREMELY_IMPORTANT_TAG);
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    return (
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.includes(EXTREMELY_IMPORTANT_TAG)
    );
  });
}

function firstNonCompactionSummaryIndex(messages) {
  let index = 0;
  while (index < messages.length && messages[index]?.role === "compactionSummary") {
    index += 1;
  }
  return index;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("superpowers extension source structure", () => {
  it("extension source file exists and is non-empty", () => {
    assert.ok(existsSync(extensionPath), "superpowers.ts should exist");
    assert.ok(extensionSource.length > 0, "superpowers.ts should be non-empty");
  });

  it("defines the EXTREMELY_IMPORTANT tag constant", () => {
    assert.ok(
      extensionSource.includes('EXTREMELY_IMPORTANT_TAG = "<EXTREMELY_IMPORTANT>"'),
      "source should define the EXTREMELY_IMPORTANT_TAG constant"
    );
  });

  it("buildBootstrapContent wraps output with the EXTREMELY_IMPORTANT tag", () => {
    assert.ok(
      extensionSource.includes("${EXTREMELY_IMPORTANT_TAG}"),
      "buildBootstrapContent should interpolate the tag"
    );
    assert.ok(
      extensionSource.includes("</EXTREMELY_IMPORTANT>"),
      "buildBootstrapContent should include the closing tag"
    );
  });

  it("references the pi-tools.md file for tool mapping", () => {
    assert.ok(
      extensionSource.includes("pi-tools.md"),
      "source should reference pi-tools.md"
    );
  });

  it("references the using-superpowers SKILL.md for bootstrap content", () => {
    assert.ok(
      extensionSource.includes("using-superpowers"),
      "source should reference the using-superpowers skill"
    );
    assert.ok(
      extensionSource.includes("SKILL.md"),
      "source should reference SKILL.md"
    );
  });

  it("includes inline fallback tool mapping", () => {
    assert.ok(
      extensionSource.includes("inlineToolMapping"),
      "source should define inlineToolMapping fallback"
    );
  });

  it("registers session_start, session_compact, agent_end, context events", () => {
    assert.ok(extensionSource.includes('"session_start"'), "should listen to session_start");
    assert.ok(extensionSource.includes('"session_compact"'), "should listen to session_compact");
    assert.ok(extensionSource.includes('"agent_end"'), "should listen to agent_end");
    assert.ok(extensionSource.includes('"context"'), "should listen to context");
  });

  it("registers resources_discover for skills", () => {
    assert.ok(
      extensionSource.includes('"resources_discover"'),
      "should register resources_discover"
    );
    assert.ok(
      extensionSource.includes("skillPaths"),
      "should expose skillPaths"
    );
  });
});

describe("stripFrontmatter", () => {
  it("removes YAML frontmatter delimited by ---", () => {
    const input = "---\nname: test\ndescription: foo\n---\nBody content here";
    assert.equal(stripFrontmatter(input), "Body content here");
  });

  it("handles multiline frontmatter", () => {
    const input = "---\nname: test\ndescription: foo\ntools: read, bash\nmodel: gpt-4\n---\nLine 1\nLine 2";
    assert.equal(stripFrontmatter(input), "Line 1\nLine 2");
  });

  it("returns the content unchanged if no frontmatter", () => {
    const input = "No frontmatter here.\nJust regular content.";
    assert.equal(stripFrontmatter(input), input.trim());
  });

  it("returns empty string for frontmatter-only content", () => {
    const input = "---\nname: test\n---\n";
    assert.equal(stripFrontmatter(input), "");
  });

  it("preserves content after frontmatter with leading whitespace", () => {
    const input = "---\nname: test\n---\n\n  Indented content\n  More content";
    assert.equal(stripFrontmatter(input), "Indented content\n  More content");
  });

  it("does not strip a second --- block as frontmatter", () => {
    const input = "---\nname: test\n---\nBody\n---\nThis is not frontmatter\n---";
    const result = stripFrontmatter(input);
    assert.ok(result.includes("Body"), "body should be preserved");
    assert.ok(result.includes("This is not frontmatter"), "later --- blocks should stay");
  });
});

describe("messageContainsBootstrap", () => {
  it("detects the tag in a plain string content", () => {
    const msg = { content: `before ${EXTREMELY_IMPORTANT_TAG} after` };
    assert.ok(messageContainsBootstrap(msg));
  });

  it("detects the tag in an array of content parts", () => {
    const msg = {
      content: [
        { type: "text", text: "no tag here" },
        { type: "text", text: `something ${EXTREMELY_IMPORTANT_TAG} something` },
      ],
    };
    assert.ok(messageContainsBootstrap(msg));
  });

  it("returns false when no tag present in string content", () => {
    const msg = { content: "This is a regular message." };
    assert.ok(!messageContainsBootstrap(msg));
  });

  it("returns false when no tag present in array content", () => {
    const msg = {
      content: [
        { type: "text", text: "no tag" },
        { type: "text", text: "also no tag" },
      ],
    };
    assert.ok(!messageContainsBootstrap(msg));
  });

  it("returns false for null/undefined message", () => {
    assert.ok(!messageContainsBootstrap(null));
    assert.ok(!messageContainsBootstrap(undefined));
  });

  it("returns false for empty content array", () => {
    const msg = { content: [] };
    assert.ok(!messageContainsBootstrap(msg));
  });

  it("returns false when content is a number or other non-string/non-array", () => {
    assert.ok(!messageContainsBootstrap({ content: 42 }));
    assert.ok(!messageContainsBootstrap({ content: true }));
    assert.ok(!messageContainsBootstrap({ content: {} }));
  });

  it("ignores non-text content parts", () => {
    const msg = {
      content: [
        { type: "image", data: EXTREMELY_IMPORTANT_TAG },
        { type: "text", text: "no tag" },
      ],
    };
    assert.ok(!messageContainsBootstrap(msg));
  });

  it("handles content parts with missing text field", () => {
    const msg = { content: [{ type: "text" }] };
    assert.ok(!messageContainsBootstrap(msg));
  });
});

describe("firstNonCompactionSummaryIndex", () => {
  it("returns 0 when first message is not compactionSummary", () => {
    const messages = [{ role: "user" }, { role: "assistant" }];
    assert.equal(firstNonCompactionSummaryIndex(messages), 0);
  });

  it("skips leading compactionSummary messages", () => {
    const messages = [
      { role: "compactionSummary" },
      { role: "compactionSummary" },
      { role: "user" },
      { role: "assistant" },
    ];
    assert.equal(firstNonCompactionSummaryIndex(messages), 2);
  });

  it("returns 0 for empty message array", () => {
    assert.equal(firstNonCompactionSummaryIndex([]), 0);
  });

  it("returns messages.length when all are compactionSummary", () => {
    const messages = [
      { role: "compactionSummary" },
      { role: "compactionSummary" },
      { role: "compactionSummary" },
    ];
    assert.equal(firstNonCompactionSummaryIndex(messages), 3);
  });

  it("returns 1 when only the first message is compactionSummary", () => {
    const messages = [{ role: "compactionSummary" }, { role: "user" }];
    assert.equal(firstNonCompactionSummaryIndex(messages), 1);
  });
});

describe("bootstrap content assembly", () => {
  const skillPath = resolve(
    projectRoot,
    "upstream-superpowers",
    "skills",
    "using-superpowers",
    "SKILL.md"
  );
  const piToolsPath = resolve(projectRoot, "references", "pi-tools.md");

  it("SKILL.md file exists and is readable", () => {
    assert.ok(existsSync(skillPath), "using-superpowers/SKILL.md should exist");
    const content = readFileSync(skillPath, "utf8");
    assert.ok(content.length > 0, "SKILL.md should be non-empty");
  });

  it("pi-tools.md file exists and is readable", () => {
    assert.ok(existsSync(piToolsPath), "references/pi-tools.md should exist");
    const content = readFileSync(piToolsPath, "utf8");
    assert.ok(content.length > 0, "pi-tools.md should be non-empty");
  });

  it("SKILL.md has frontmatter that stripFrontmatter can remove", () => {
    const raw = readFileSync(skillPath, "utf8");
    assert.ok(raw.startsWith("---"), "SKILL.md should start with frontmatter delimiter");
    const body = stripFrontmatter(raw);
    assert.ok(body.length > 0, "stripped body should be non-empty");
    assert.ok(!body.startsWith("---"), "stripped body should not start with ---");
  });

  it("simulated buildBootstrapContent produces valid output", () => {
    const raw = readFileSync(skillPath, "utf8");
    const skillBody = stripFrontmatter(raw);
    const toolMapping = readFileSync(piToolsPath, "utf8").trim();

    const bootstrap = `${EXTREMELY_IMPORTANT_TAG}\n\nYou have superpowers.\n\nThe using-superpowers skill content is included below and is already loaded for this Pi session. Follow it now. Do not try to load using-superpowers again.\n\n${skillBody}\n\n${toolMapping}\n</EXTREMELY_IMPORTANT>`;

    assert.ok(bootstrap.includes(EXTREMELY_IMPORTANT_TAG), "should include opening tag");
    assert.ok(bootstrap.includes("</EXTREMELY_IMPORTANT>"), "should include closing tag");
    assert.ok(bootstrap.includes("You have superpowers"), "should include superpowers declaration");
    assert.ok(bootstrap.includes(skillBody), "should include skill body");
    assert.ok(bootstrap.includes("Pi Tool Mapping"), "should include tool mapping content");
  });
});
