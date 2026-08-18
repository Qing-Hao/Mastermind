// Stylesheet checks: the things a redesign gets wrong silently.
//
//   node scripts\css_check.js
//
// The frontend has no test suite. `wire_check.js` names ids the JS asks for and
// index.html lacks; `map_sweep.js` measures the map's geometry. Neither reads
// style.css, and CSS fails quietly by design -- an unknown property, a typo'd
// custom property and a rule that never matches all look identical to a clean
// stylesheet.
//
// Every check here is present because it had already fired once. Ported from the
// `ui-redesign` branch, where the first three were written, and each was verified
// to fail on an injected fault -- against a copy, never the real files -- before
// being trusted.
//
// 1. THE [hidden] TRAP. A class that sets `display` has the same specificity as
//    the UA sheet's `[hidden] { display: none }`, and the author sheet wins on
//    origin -- so the element never hides, and nothing anywhere fails. CLAUDE.md
//    recorded this as having cost six features. This check found three more, all
//    predating any redesign, and found them twice independently: `.undo-bar` (an
//    empty ruled strip sat on Portfolio permanently), `.window-bar` (the date
//    controls stayed up in Weeks mode) and `.mode-switch` (the Rendered|Raw
//    switch stayed up with no sprint file open).
//
// 2. CUSTOM PROPERTIES THAT RESOLVE TO NOTHING. `var(--rule-hairline)` where the
//    token is called `--rule-hair` yields nothing and inherits instead. Every
//    colour in the chrome comes from a token, so one typo is one invisible
//    component. **A `var()` with a fallback is fine undefined** -- nine of them
//    are set inline by app.js on the element (`--week-px`, `--lane-hue`,
//    `--track-dot` ...) and the fallback is the value the rule had before that
//    feature existed. So the rule is: no fallback *and* no definition is a fault.
//    That needs no list of script-set names, which is the point -- a list would
//    go stale the next time one is added.
//
// 3. RULES FOR IDS THAT NO LONGER EXIST. The CSS twin of `wire_check.js`, which
//    only looks the other way. A rule for `#project-select` after the picker
//    became a list is dead weight that reads as live styling.
//
// 4. BRACE BALANCE. One unclosed rule silently swallows the rest of the file.
//
// **There is no theme-parity check**, which the branch version had as its third:
// that one compared the two dark-palette blocks, and this app has one theme. If a
// dark mode is ever added, that check is worth porting too -- a palette stated
// twice drifts.

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const raw = read("app/static/style.css");
// Comments first: several of them discuss `display`, `[hidden]` and token names.
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
const html = read("app/static/index.html");
// Kept apart rather than concatenated: the local-variable heuristic below matches
// on a name, and both files happen to call a thing `bar`.
const jsFiles = ["app/static/app.js", "app/static/editor.js"].map(read);

const problems = [];
const note = (line) => console.log(line);

// --- 4. braces ---------------------------------------------------------------

{
  let depth = 0;
  let line = 1;
  let stray = null;
  for (const ch of css) {
    if (ch === "\n") line += 1;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth < 0 && stray === null) stray = line;
    }
  }
  if (depth !== 0 || stray !== null) {
    problems.push(`braces unbalanced: depth ${depth}`
      + (stray === null ? "" : `, first stray } near line ${stray}`));
  } else {
    note("braces balanced");
  }
}

// --- 2. custom properties ----------------------------------------------------

{
  const defined = new Set(
    [...css.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]));

  // The capture after the name is a comma when a fallback follows. A property
  // that is neither defined here nor given a fallback resolves to nothing, and
  // the declaration is simply dropped -- no warning, no visible cause.
  const naked = new Set();
  const used = new Set();
  for (const m of css.matchAll(/var\(\s*(--[A-Za-z0-9-]+)\s*(,?)/g)) {
    used.add(m[1]);
    if (!m[2] && !defined.has(m[1])) naked.add(m[1]);
  }

  if (naked.size) {
    problems.push("custom properties with no definition and no fallback: "
      + `${[...naked].join(", ")} — each renders as nothing`);
  } else {
    note(`custom properties: ${defined.size} defined, ${used.size} referenced, `
      + "every undefined one carries a fallback");
  }
}

// --- 3. rules for ids that are not in the page -------------------------------

{
  const known = new Set(
    [...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  // **The page is not the only place an id comes from.** `renderMap` builds an
  // SVG `<marker id="map-arrow">`, which `#map-arrow path` styles -- so an id the
  // JS creates counts as defined. Any quoted occurrence is enough: this is asking
  // "does this name appear anywhere as an id", and a false *negative* here costs
  // only a rule nobody flagged, while a false positive would send a reader
  // looking for a bug that is not there.
  for (const js of jsFiles) {
    for (const m of js.matchAll(/["'`]([A-Za-z0-9_-]+)["'`]/g)) known.add(m[1]);
  }
  // Every id the stylesheet selects on, however deep in a compound selector.
  const styled = new Set();
  for (const match of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const id of match[1].matchAll(/#([A-Za-z0-9_-]+)/g)) styled.add(id[1]);
  }
  const dead = [...styled].filter((id) => !known.has(id)).sort();
  if (dead.length) {
    problems.push("styled ids that neither index.html nor the JS ever names: "
      + dead.join(", "));
  } else {
    note(`styled ids: ${styled.size} selected, all accounted for`);
  }
}

// --- 1. the [hidden] trap ----------------------------------------------------

{
  const setsDisplay = new Set();
  const guarded = new Set();

  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((s) => s.trim()).filter(Boolean);
    const body = match[2];
    const declaresDisplay = /(^|[;{\s])display\s*:/.test(body);

    for (const selector of selectors) {
      const guard = selector.match(/^\.([A-Za-z0-9_-]+)\[hidden\]$/);
      if (guard && /display\s*:\s*none/.test(body)) {
        guarded.add(guard[1]);
        continue;
      }
      if (!declaresDisplay) continue;
      // Only a bare leading class can collide with [hidden] at equal
      // specificity. An id outranks it; a compound selector is a different
      // question this cannot answer.
      const simple = selector.match(/^\.([A-Za-z0-9_-]+)$/);
      if (simple) setsDisplay.add(simple[1]);
    }
  }

  const toggled = new Set();
  for (const js of jsFiles) {
    for (const m of js.matchAll(/\$\("([A-Za-z0-9_-]+)"\)\.hidden\s*=/g)) {
      toggled.add(m[1]);
    }
    // `const bar = $("place-undo") ... bar.hidden = !last` -- the same write, one
    // line apart, which the pattern above cannot see.
    //
    // **Searched only as far as the next top-level function**, not across the
    // whole file, and that is not tidiness: `renderLaneControls` and
    // `renderPlacementUndo` both call their local `bar`, and only the second one
    // hides it. Testing the file reported `#lane-controls` -- which nothing ever
    // hides -- as permanently unhideable, which is the worst kind of check
    // output: a real-looking bug in code that is fine.
    for (const m of js.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*\$\("([A-Za-z0-9_-]+)"\)/g)) {
      const rest = js.slice(m.index);
      const end = rest.search(/\n(?:function|const|let|class)\s/);
      const scope = end === -1 ? rest : rest.slice(0, end);
      if (new RegExp(`\\b${m[1]}\\.hidden\\s*=`).test(scope)) toggled.add(m[2]);
    }
  }
  for (const m of html.matchAll(/id="([A-Za-z0-9_-]+)"[^>]*\shidden/g)) {
    toggled.add(m[1]);
  }

  const classesOfId = new Map();
  for (const m of html.matchAll(/<[^>]*id="([A-Za-z0-9_-]+)"[^>]*>/g)) {
    const cls = m[0].match(/class="([^"]*)"/);
    classesOfId.set(m[1], cls ? cls[1].split(/\s+/).filter(Boolean) : []);
  }

  const unhideable = [];
  for (const id of [...toggled].sort()) {
    for (const cls of classesOfId.get(id) || []) {
      if (setsDisplay.has(cls) && !guarded.has(cls)) unhideable.push({ id, cls });
    }
  }

  if (unhideable.length) {
    problems.push("these elements can never hide:\n" + unhideable.map(({ id, cls }) =>
      `      #${id} carries .${cls} — add  .${cls}[hidden] { display: none; }`).join("\n"));
  } else {
    note(`[hidden]: ${toggled.size} elements toggled, ${guarded.size} guards, `
      + "none missing");
  }
}

// --- verdict -----------------------------------------------------------------

if (!problems.length) {
  console.log("\ncss_check clean");
  process.exit(0);
}
console.log("\ncss_check FAILED\n");
for (const problem of problems) console.log(`  - ${problem}`);
process.exit(1);
