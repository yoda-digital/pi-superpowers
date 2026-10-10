/**
 * Tests for the ask_user card (extensions/lib/ask-view.ts): key handling,
 * layout at different widths, mouse hit rows, and the result the model gets.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_OPTIONS,
  MIN_BOXED_WIDTH,
  askResult,
  initialAskState,
  keyHints,
  normalizeAskParams,
  reduceAsk,
  renderAsk,
} from "../extensions/lib/ask-view.ts";

// Plain-text stand-ins for Pi's theme and width helpers. Styles become visible
// markers so tests can see what is highlighted without parsing ANSI.
const theme = {
  fg: (_token, s) => s,
  bg: (_token, s) => `\u0001${s}\u0002`, // highlight markers, zero width below
  bold: (s) => s,
};
const strip = (s) => s.replace(/[\u0001\u0002]/g, "");
const kit = {
  width: (s) => [...strip(s)].length,
  truncate: (s, w) => [...strip(s)].slice(0, w).join(""),
  wrap: (s, w) => {
    const words = s.split(" ");
    const out = [];
    let line = "";
    for (const word of words) {
      if (line && (line + " " + word).length > w) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
    return out.flatMap((l) => (l.length > w ? l.match(new RegExp(`.{1,${w}}`, "g")) : [l]));
  },
};

const spec = (over = {}) =>
  normalizeAskParams({
    question: "How do you want to finish this branch?",
    context: "Tests pass; the branch is 3 commits ahead of main.",
    options: [
      { label: "Merge into main", description: "Fast-forward main, then delete the branch." },
      "Open a pull request",
      "Keep the branch",
    ],
    recommended: 1,
    ...over,
  });

const run = (s, actions, state = initialAskState(s)) => {
  let outcome;
  for (const a of actions) {
    const r = reduceAsk(s, state, a);
    state = r.state;
    if (r.outcome) {
      outcome = r.outcome;
      break;
    }
  }
  return { state, outcome };
};

describe("normalizeAskParams", () => {
  it("accepts string and {label, description} options, converts recommended to 0-based", () => {
    const s = spec();
    assert.deepEqual(s.options[1], { label: "Open a pull request" });
    assert.equal(s.options[0].description, "Fast-forward main, then delete the branch.");
    assert.equal(s.recommended, 0);
    assert.equal(s.multiple, false);
  });

  it("drops an out-of-range recommendation, empty labels, and options past the digit keys", () => {
    assert.equal(spec({ recommended: 7 }).recommended, undefined);
    assert.equal(spec({ options: ["a", " ", "b"] }).options.length, 2);
    assert.equal(spec({ options: Array.from({ length: 12 }, (_, i) => `o${i}`) }).options.length, MAX_OPTIONS);
  });
});

describe("keys", () => {
  it("starts on the recommended option, so Enter accepts it", () => {
    const s = spec({ recommended: 2 });
    assert.equal(initialAskState(s).cursor, 1);
    assert.deepEqual(run(s, [{ type: "enter" }]).outcome, { kind: "chosen", indices: [1] });
  });

  it("a digit answers instantly; digits past the options do nothing", () => {
    assert.deepEqual(run(spec(), [{ type: "digit", n: 3 }]).outcome, { kind: "chosen", indices: [2] });
    assert.equal(run(spec(), [{ type: "digit", n: 4 }]).outcome, undefined);
  });

  it("arrows wrap around through the Something else row", () => {
    const s = spec();
    assert.equal(run(s, [{ type: "up" }]).state.cursor, 3, "up from the first row lands on Something else");
    assert.equal(run(s, [{ type: "up" }, { type: "down" }]).state.cursor, 0);
    assert.equal(run(s, [{ type: "last" }, { type: "first" }]).state.cursor, 0);
  });

  it("Something else opens the inline editor; its text is the answer; empty text goes back", () => {
    const s = spec();
    const opened = run(s, [{ type: "last" }, { type: "enter" }]);
    assert.equal(opened.state.mode, "other");
    assert.deepEqual(run(s, [{ type: "submitText", text: "  squash first " }], opened.state).outcome, { kind: "custom", text: "squash first" });
    assert.equal(run(s, [{ type: "submitText", text: "  " }], opened.state).state.mode, "choose");
  });

  it("tab attaches a note to the pick under the cursor", () => {
    const s = spec();
    const r = run(s, [{ type: "down" }, { type: "note" }, { type: "submitText", text: "draft PR please" }]);
    assert.deepEqual(r.outcome, { kind: "chosen", indices: [1], note: "draft PR please" });
  });

  it("while typing, keys belong to the editor and Esc goes back instead of dismissing", () => {
    const s = spec();
    const typing = run(s, [{ type: "note" }]).state;
    assert.equal(run(s, [{ type: "digit", n: 2 }, { type: "down" }], typing).outcome, undefined);
    const back = run(s, [{ type: "cancel" }], typing);
    assert.equal(back.state.mode, "choose");
    assert.equal(back.outcome, undefined);
  });

  it("Esc in the list dismisses", () => {
    assert.deepEqual(run(spec(), [{ type: "cancel" }]).outcome, { kind: "dismissed" });
  });

  it("multiple: digits and space toggle, Enter submits the checked set (or the cursor when none)", () => {
    const s = spec({ multiple: true });
    const r = run(s, [{ type: "digit", n: 3 }, { type: "digit", n: 1 }, { type: "digit", n: 3 }, { type: "up" }, { type: "toggle" }, { type: "enter" }]);
    assert.deepEqual(r.outcome, { kind: "chosen", indices: [0, 1] });
    assert.deepEqual(run(s, [{ type: "enter" }]).outcome, { kind: "chosen", indices: [0] });
  });

  it("mouse: hover moves the cursor, click picks (single) or toggles (multiple)", () => {
    assert.equal(run(spec(), [{ type: "hover", row: 2 }]).state.cursor, 2);
    assert.deepEqual(run(spec(), [{ type: "click", row: 1 }]).outcome, { kind: "chosen", indices: [1] });
    const m = spec({ multiple: true });
    assert.deepEqual(run(m, [{ type: "click", row: 2 }]).state.checked, [2]);
    assert.equal(run(m, [{ type: "click", row: 3 }]).state.mode, "other");
    assert.equal(run(spec(), [{ type: "click", row: 9 }]).outcome, undefined);
  });
});

describe("renderAsk", () => {
  const frame = (s = spec(), state = initialAskState(s), width = 60, editor) => renderAsk(s, state, width, theme, kit, editor);

  it("draws a bordered card with the question, context, numbered options and key hints", () => {
    const { lines } = frame();
    const text = lines.map(strip);
    assert.match(text[0], /^╭─ \? Question ─+╮$/);
    assert.match(text.at(-1), /^╰─+╯$/);
    assert.ok(text.some((l) => l.includes("How do you want to finish this branch?")));
    assert.ok(text.some((l) => l.includes("3 commits ahead")));
    assert.ok(text.some((l) => /▌1 {2}Merge into main +★ recommended │$/.test(l)), "recommended badge right-aligned on the cursor row");
    assert.ok(text.some((l) => l.includes(" 2  Open a pull request")));
    assert.ok(text.some((l) => l.includes("✎  Something else…")));
    assert.ok(text.some((l) => l.includes("1-3 pick") && l.includes("tab note") && l.includes("esc skip")));
  });

  it("every line fits the width exactly when boxed, and never exceeds it", () => {
    for (const width of [MIN_BOXED_WIDTH, 40, 60, 100]) {
      const { lines } = frame(spec(), undefined, width);
      for (const l of lines) assert.equal(kit.width(l), width, `width ${width}: "${strip(l)}"`);
    }
    for (const width of [12, 20, MIN_BOXED_WIDTH - 1]) {
      const { lines } = frame(spec(), undefined, width);
      for (const l of lines) assert.ok(kit.width(l) <= width, `width ${width}: "${strip(l)}"`);
      assert.ok(!lines.some((l) => l.includes("╭")), "no border when narrow");
    }
  });

  it("highlights the whole cursor row, including its description", () => {
    const { lines } = frame();
    const highlighted = lines.filter((l) => l.includes("\u0001")).map(strip);
    assert.equal(highlighted.length, 2);
    assert.match(highlighted[0], /Merge into main/);
    assert.match(highlighted[1], /Fast-forward main/);
  });

  it("maps each line to its option for mouse clicks", () => {
    const { lines, rowAt } = frame();
    assert.equal(lines.length, rowAt.length);
    const rowOf = (needle) => rowAt[lines.findIndex((l) => strip(l).includes(needle))];
    assert.equal(rowOf("Merge into main"), 0);
    assert.equal(rowOf("Fast-forward main"), 0);
    assert.equal(rowOf("Open a pull request"), 1);
    assert.equal(rowOf("Something else"), 3);
    assert.equal(rowOf("How do you want"), undefined);
  });

  it("multiple: checkboxes, and hints for toggling", () => {
    const s = spec({ multiple: true });
    const { lines } = frame(s, { cursor: 0, checked: [1], mode: "choose" });
    const text = lines.map(strip);
    assert.match(text[0], /Pick any that apply/);
    assert.ok(text.some((l) => l.includes("○ Merge into main")));
    assert.ok(text.some((l) => l.includes("● Open a pull request")));
    assert.ok(text.some((l) => l.includes("space/1-3 toggle")));
  });

  it("shows the inline editor under the row being answered, with editor hints", () => {
    const s = spec();
    const other = frame(s, { cursor: 3, checked: [], mode: "other" }, 60, ["[editor line]"]).lines.map(strip);
    const iOther = other.findIndex((l) => l.includes("Something else"));
    assert.match(other[iOther + 1], /Your answer/);
    assert.match(other[iOther + 2], /\[editor line\]/);
    assert.ok(other.some((l) => l.includes("⏎ send · esc back")));

    const note = frame(s, { cursor: 1, checked: [], mode: "note" }, 60, ["[note]"]).lines.map(strip);
    const iNote = note.findIndex((l) => l.includes("Open a pull request"));
    assert.match(note[iNote + 1], /Note for your pick/);
  });

  it("long labels and questions wrap or truncate instead of overflowing", () => {
    const s = spec({ question: "word ".repeat(40).trim(), options: ["x".repeat(200), "short"] });
    const { lines } = frame(s, undefined, 50);
    for (const l of lines) assert.equal(kit.width(l), 50);
    assert.ok(lines.filter((l) => strip(l).includes("word")).length > 1, "question wraps");
  });
});

describe("askResult", () => {
  it("tells the model what was chosen, typed, noted or dismissed", () => {
    const s = spec();
    assert.equal(askResult(s, { kind: "chosen", indices: [1] }).text, 'The user chose "Open a pull request".');
    assert.equal(
      askResult(s, { kind: "chosen", indices: [0, 2], note: "squash" }).text,
      'The user chose "Merge into main", "Keep the branch". Their note: squash',
    );
    assert.equal(askResult(s, { kind: "custom", text: "rebase first" }).text, "The user answered in their own words: rebase first");
    assert.match(askResult(s, { kind: "dismissed" }).text, /dismissed.*ask in your reply/);
  });

  it("returns typed data for codemode scripts", () => {
    const s = spec();
    assert.deepEqual(askResult(s, { kind: "chosen", indices: [1], note: "n" }).structured, { status: "answered", choices: ["Open a pull request"], note: "n" });
    assert.deepEqual(askResult(s, { kind: "custom", text: "t" }).structured, { status: "answered", choices: [], custom: "t" });
    assert.deepEqual(askResult(s, { kind: "dismissed" }).structured, { status: "dismissed", choices: [] });
  });
});

describe("keyHints", () => {
  it("adapts to the option count and mode", () => {
    assert.match(keyHints(spec({ options: ["a", "b"] }), initialAskState(spec())), /1-2 pick/);
    assert.equal(keyHints(spec(), { cursor: 0, checked: [], mode: "note" }), "⏎ send with note · esc back");
  });
});
