// Does the frontend reach for an element index.html does not define?
//
//   node scripts/wire_check.js        # exit 1 if anything is missing
//
// `bindEvents()` wires roughly a hundred handlers by id, and a `$()` that finds
// nothing returns **null** -- so the next property access throws, and everything
// wired after that line silently never happens. The boot call `loadProjects()`
// is the last statement in app.js, so a throw anywhere in the wiring also means
// no project is ever loaded and the Project tab comes up empty.
//
// That is not hypothetical. Deleting the drafting switch left its id in the
// array of fields that get an `onchange`, which cost the whole Project tab plus
// both track pickers, export, import, and the milestone and Promote handlers.
//
// Nothing else here can catch it. The tests are API-level and never load the
// page; pyright does not read JavaScript; and `map_sweep.js` -- which loads the
// same app.js -- cannot, by construction: it cuts `bindEvents()` off on purpose
// and its stub `getElementById` mints a fresh node for *any* id, so a null never
// arises there.
//
// What it cannot tell you: whether a handler does the right thing, or whether
// the element it found is the one intended. Only that every id has an element.
// An eyeball is still the last step.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC_DIR = path.join(__dirname, "..", "app", "static");

const read = (name) => fs.readFileSync(path.join(STATIC_DIR, name), "utf8");

// Every id the page actually defines. The frontend addresses elements by id and
// nothing else, so this is the whole contract being checked.
function pageIds() {
  const html = read("index.html");
  return new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
}

// Permissive on purpose: every property is another node and every node is
// callable, so the harness cannot fail for a reason that is not the question.
// A stricter stub would report its own gaps as if they were the app's.
function stubNode() {
  const node = new Proxy(function () {}, {
    get: (target, key) => {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === "then") return undefined;   // must not look like a promise
      if (key === "length") return 0;         // and must not loop forever
      return node;
    },
    set: () => true,
    apply: () => node,
    construct: () => node,
  });
  return node;
}

function run() {
  const ids = pageIds();
  const missing = new Set();
  const node = stubNode();

  const context = {
    document: {
      createElement: () => node,
      createElementNS: () => node,
      createTextNode: () => node,
      addEventListener: () => {},
      body: node,
      documentElement: node,
      get activeElement() { return null; },
      querySelector: () => node,
      querySelectorAll: () => [],
      getElementById: (id) => {
        // The whole point. A browser hands back null here; recording it and
        // carrying on finds every missing id in one run instead of the first.
        if (!ids.has(id)) missing.add(id);
        return node;
      },
    },
    window: { addEventListener: () => {}, matchMedia: () => node },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: () => 0,
    fetch: () => Promise.reject(new Error("wire_check makes no requests")),
    alert: () => {}, confirm: () => false, prompt: () => null,
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type) { this.type = type; } },
    Blob: class {}, FormData: class {},
    URL: { createObjectURL: () => "", revokeObjectURL: () => {} },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
  };
  context.globalThis = context;
  vm.createContext(context);

  // index.html loads editor.js first and app.js second, and the order is
  // load-bearing here too: bindEvents() wires handlers that live in editor.js.
  const editor = read("editor.js");

  // Keep bindEvents(); drop the boot call after it, which would hit the network.
  // The wiring is the question, not what the app does once it has data.
  const source = read("app.js");
  const boot = source.lastIndexOf("loadProjects();");
  if (boot === -1) throw new Error("wire_check: no loadProjects() boot call found");

  vm.runInContext(editor, context, { filename: "editor.js" });
  vm.runInContext(source.slice(0, boot), context, { filename: "app.js" });

  return missing;
}

let missing;
try {
  missing = run();
} catch (failure) {
  // A throw is a finding too -- the wiring did not survive its own execution.
  console.error(`threw while wiring: ${failure.message}`);
  process.exit(1);
}

if (missing.size === 0) {
  console.log("wiring clean: every id the frontend asks for exists in index.html");
  process.exit(0);
}

console.log(`ids with no element in index.html (${missing.size}):`);
for (const id of [...missing].sort()) console.log(`  ${id}`);
console.log("");
console.log("In a browser each of these is null, and the next property access "
  + "throws -- taking every handler wired after it with it.");
process.exit(1);
