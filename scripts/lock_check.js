// Does a held block refuse a keystroke, and does a cell write name the right cells?
//
//   node scripts/lock_check.js        # exit 1 if anything is wrong
//
// The third of the frontend's three readings, beside `wire_check.js` and
// `css_check.js`, and for the same reason they exist: the Python tests are
// API-level and never load the page, so nothing else here executes a line of
// this. What it covers is the half of two-people-in-one-file that lives in the
// browser -- which node a hold names, what a locked one refuses, and what a save
// owes as cells rather than as blocks.
//
// It loads the real `editor.js` and `app.js` behind a stub DOM, in **one** run so
// the two share a lexical scope: `state` is a `const` in app.js and every
// function in editor.js reads it.
//
// What it cannot tell you: whether any of it looks right. An eyeball is still
// the last step.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC_DIR = path.join(__dirname, "..", "app", "static");
const read = (name) => fs.readFileSync(path.join(STATIC_DIR, name), "utf8");

// --- a DOM, only as far as the locks reach ------------------------------------

// Enough of an element for `matches`, `closest` and `dataset`, which is all the
// lock path asks of one. Deliberately not a DOM: a fuller stub would start
// reporting its own gaps as findings.
class FakeNode {
  constructor(selector, parent = null) {
    this.selector = selector;              // e.g. ".sprint-row"
    this.parent = parent;
    this.dataset = {};
    this.classes = new Set();
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
  }

  child(selector) {
    return new FakeNode(selector, this);
  }

  matches(query) {
    return query.split(",").some((one) => {
      const wanted = one.trim();
      if (wanted.startsWith("[data-locked")) return this.dataset.locked === "1";
      return wanted === this.selector;
    });
  }

  closest(query) {
    let node = this;
    while (node) {
      if (node.matches(query)) return node;
      node = node.parent;
    }
    return null;
  }

  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parent;
    }
    return false;
  }
}

function stubNode() {
  const node = new Proxy(function () {}, {
    get: (target, key) => {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === "then") return undefined;
      if (key === "length") return 0;
      return node;
    },
    set: () => true,
    apply: () => node,
    construct: () => node,
  });
  return node;
}

function load() {
  const node = stubNode();
  const listeners = [];

  const context = {
    document: {
      createElement: () => node,
      createElementNS: () => node,
      createTextNode: () => node,
      addEventListener: (type, handler) => listeners.push({ type, handler }),
      body: node,
      documentElement: node,
      get activeElement() { return null; },
      querySelector: () => node,
      querySelectorAll: () => [],
      getElementById: () => node,
    },
    window: { addEventListener: () => {}, matchMedia: () => node },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: () => 0,
    fetch: () => Promise.reject(new Error("lock_check makes no requests")),
    alert: () => {}, confirm: () => false, prompt: () => null,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type) { this.type = type; } },
    Blob: class {}, FormData: class {},
    URL: { createObjectURL: () => "", revokeObjectURL: () => {} },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    WebSocket: class { constructor() { this.readyState = 3; } },
    CSS: { escape: (value) => value },
  };
  context.globalThis = context;
  vm.createContext(context);

  const app = read("app.js");
  const boot = app.lastIndexOf("loadProjects();");
  if (boot === -1) throw new Error("lock_check: no loadProjects() boot call found");

  // What the checks below reach for. Everything here is a top-level `function` or
  // `const` of one of the two files, so this is a handle rather than a copy.
  const probe = `globalThis.probe = {
    state, sprintCellField, sprintLocked, sprintTableHeld, setSprintLocked,
    lockField, releaseField, copyGrid, diskBlocks, sameGridShape, changedCells,
    sprintCellWrites, sprintSplices, currentPlace, SPRINT_UNSAVED,
    applyRemoteSprintCells, refuseSprintWrite, SPRINT_REFUSAL_LIMIT,
  };`;

  vm.runInContext(
    [read("editor.js"), app.slice(0, boot), probe].join("\n"),
    context,
    { filename: "sprint-frontend.js" },
  );
  return { probe: context.probe, listeners };
}

// --- the checks ---------------------------------------------------------------

let failures = 0;

function check(name, condition, detail) {
  if (condition) return;
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
}

const CAPACITY = {
  head: ["Person", "Days", "Notes"],
  align: ["", "right", ""],
  rows: [["@qh", "10", "on leave"], ["@sam", "8", ""]],
};

function run() {
  const { probe, listeners } = load();
  const { state } = probe;
  state.sprint.number = 7;

  // --- what a hold names ------------------------------------------------------

  check("a block key is the file and the position",
    probe.sprintCellField(12, -1, 0) === "sprint:7:12:cell:-1:0",
    probe.sprintCellField(12, -1, 0));
  check("a cell key is the block key plus its coordinates",
    probe.sprintCellField(12, 3, 1) === "sprint:7:12:cell:3:1");

  // --- what a lock does to a node ---------------------------------------------

  const row = new FakeNode(".sprint-row");
  probe.lockField(row);
  check("locking a sprint row flags it", row.dataset.locked === "1");
  check("locking a sprint row marks it held", row.classes.has("presence-locked"));
  probe.releaseField(row);
  check("releasing a sprint row unflags it", row.dataset.locked === undefined);

  const host = new FakeNode(".sprint-cell-host");
  probe.lockField(host);
  check("locking a cell flags the cell", host.dataset.locked === "1");

  const inside = host.child(".sprint-cell-view");
  check("a node inside a locked cell reads as locked", probe.sprintLocked(inside));
  check("a node outside every lock does not",
    !probe.sprintLocked(new FakeNode(".sprint-block")));

  // --- what a locked node refuses ---------------------------------------------

  const refused = listeners.filter((one) =>
    ["mousedown", "click", "keydown", "dragstart", "paste", "beforeinput"].includes(one.type));
  check("the lock guard is armed on every gesture that edits", refused.length >= 6,
    `${refused.length} listeners`);

  const fired = (target, type) => {
    let prevented = false;
    const event = {
      type,
      target,
      preventDefault: () => { prevented = true; },
      stopPropagation: () => {},
    };
    for (const one of refused) if (one.type === type) one.handler(event);
    return prevented;
  };

  check("a keystroke inside a locked cell is refused", fired(inside, "beforeinput"));
  check("a press inside a locked cell is refused", fired(inside, "mousedown"));
  check("a link inside a locked cell is still followed",
    !fired(inside.child("a"), "click"));
  const open = new FakeNode(".sprint-cell-host").child(".sprint-cell");
  check("a keystroke in a cell nobody holds is untouched", !fired(open, "beforeinput"));

  // --- structure waits for the cells somebody is in ---------------------------

  state.presence.me = 1;
  state.presence.users = [
    { id: 1, holding: "sprint:7:4:cell:0:0" },
    { id: 2, holding: "sprint:7:4:cell:1:2" },
  ];
  check("a table with somebody else in a cell holds its structure",
    probe.sprintTableHeld(4));
  check("a table only this page is in does not", !probe.sprintTableHeld(9));
  state.presence.users = [{ id: 1, holding: "sprint:7:4:cell:0:0" }];
  check("your own hold never blocks your own structural edit",
    !probe.sprintTableHeld(4));

  // --- the disk snapshot ------------------------------------------------------

  const live = [{ raw: "| a |", gap: "\n\n", table: CAPACITY }];
  const disk = probe.diskBlocks(live);
  live[0].table.rows[0][1] = "12";
  check("the disk snapshot keeps the grid the file had",
    disk[0].table.rows[0][1] === "10", disk[0].table.rows[0][1]);
  check("the disk snapshot carries no table for a block that is not one",
    probe.diskBlocks([{ raw: "text", gap: "\n\n" }])[0].table === null);

  // --- what a save owes as cells ---------------------------------------------

  const was = probe.copyGrid(CAPACITY);
  const now = probe.copyGrid(CAPACITY);
  now.rows[1][2] = "back Tue";
  check("one edited cell is one cell write",
    JSON.stringify(probe.changedCells(was, now))
      === JSON.stringify([{ r: 1, c: 2, expect: "", text: "back Tue" }]));

  const spelled = probe.copyGrid(CAPACITY);
  spelled.rows[0][2] = "on<br>leave";
  const typed = probe.copyGrid(CAPACITY);
  typed.rows[0][2] = "on\nleave";
  check("a break spelled two ways is not a change",
    probe.changedCells(spelled, typed).length === 0);

  check("a row arriving is not a cell write",
    !probe.sameGridShape(was, { ...now, rows: [...now.rows, ["", "", ""]] }));
  check("an alignment change is not a cell write",
    !probe.sameGridShape(was, { ...now, align: ["", "", "right"] }));

  const writes = probe.sprintCellWrites(
    [{ raw: "| a |", gap: "\n", table: was }],
    [{ raw: "| a |", gap: "\n", table: now }],
  );
  check("a cell write names the table by its header",
    writes.length === 1 && writes[0].at === 0
    && writes[0].head.join("|") === "Person|Days|Notes",
    JSON.stringify(writes));
  check("a table nobody touched owes nothing",
    probe.sprintCellWrites(
      [{ raw: "| a |", gap: "\n", table: was }],
      [{ raw: "| a |", gap: "\n", table: probe.copyGrid(was) }],
    ).length === 0);

  // --- somebody else's cell, arriving -----------------------------------------
  //
  // The case the cell door was cut for: their cell and this page's in one grid,
  // which the splice path has to refuse because the block it replaces is a block
  // this page is inside.

  const grid = probe.copyGrid(CAPACITY);
  state.sprint.blocks = [{ index: 0, type: "table", raw: "| old |", gap: "\n\n", table: grid }];
  state.sprint.disk = probe.diskBlocks(state.sprint.blocks);
  state.sprint.mtime = 1;
  grid.rows[0][2] = "mine, unsaved";

  const landed = probe.copyGrid(CAPACITY);
  landed.rows[1][1] = "6";
  const applied = probe.applyRemoteSprintCells({
    key: 7,
    mtime: 2,
    splice: {
      at: 0,
      expect: ["| old |"],
      blocks: [{ raw: "| new |", html: "", table: landed }],
      cells: [{ r: 1, c: 1, expect: "8", text: "6" }],
    },
  });
  check("a remote cell write merges into a grid this page is editing", applied);
  check("their cell lands", grid.rows[1][1] === "6", grid.rows[1][1]);
  check("the cell this page is typing in is left alone",
    grid.rows[0][2] === "mine, unsaved", grid.rows[0][2]);
  check("the disk snapshot moves to what the file now says",
    state.sprint.disk[0].raw === "| new |");
  check("and so does the mtime, so the echo of it is ignored", state.sprint.mtime === 2);
  check("the table is no longer flagged for re-serialising",
    state.sprint.blocks[0].tableEdited === false);
  check("what this page still owes is still owed",
    probe.sprintCellWrites(state.sprint.disk, state.sprint.blocks).length === 1);

  const elsewhere = probe.applyRemoteSprintCells({
    key: 9,
    mtime: 3,
    splice: { at: 0, expect: ["| old |"], blocks: [{ raw: "x", table: landed }], cells: [] },
  });
  check("a cell write for another file is not applied here", !elsewhere);

  // --- the wall is gone -------------------------------------------------------

  check("a refused write is no longer a state the editor sits in",
    !probe.SPRINT_UNSAVED.has("conflict"));

  // A refusal takes the file as it stands and keeps saving. What stops it is a
  // run of them: a splice two places in the file answer word for word is refused
  // however often it is asked, and a timer retrying that would ask forever.
  const refusal = (text) => ({
    status: 409,
    message: text,
    detail: { current: { mtime: 9, blocks: [{ index: 0, type: "paragraph", raw: "theirs", gap: "\n\n" }] } },
  });

  // Nobody has a caret anywhere, so every block takes the file's version -- the
  // answer a project field gives, and the reason nothing is left owed after it.
  state.sprint.editing = null;
  state.sprint.blocks = [{ index: 0, type: "paragraph", raw: "mine", gap: "\n\n" }];
  state.sprint.disk = probe.diskBlocks([{ raw: "was", gap: "\n\n" }]);
  state.sprint.refusals = 0;
  probe.refuseSprintWrite(refusal("Somebody got there first."));
  check("a refusal takes the file as it stands", state.sprint.mtime === 9);
  check("a block nobody is in takes their version",
    state.sprint.blocks[0].raw === "theirs", state.sprint.blocks[0].raw);
  check("so nothing is left owed", state.sprint.status === "saved", state.sprint.status);
  check("and the run is cleared", state.sprint.refusals === 0);

  // A block with a caret in it keeps what is being typed, so this page still
  // owes a write -- and if that write keeps being refused, the retrying stops.
  state.sprint.refusals = 0;
  state.sprint.editing = 0;
  for (let attempt = 1; attempt <= probe.SPRINT_REFUSAL_LIMIT; attempt += 1) {
    state.sprint.blocks = [{ index: 0, type: "paragraph", raw: "still mine", gap: "\n\n" }];
    state.sprint.disk = probe.diskBlocks([{ raw: "theirs", gap: "\n\n" }]);
    probe.refuseSprintWrite(refusal("Somebody got there first."));
    if (attempt === 1) {
      check("the block being typed in keeps what is in it",
        state.sprint.blocks[0].raw === "still mine", state.sprint.blocks[0].raw);
    }
    if (attempt < probe.SPRINT_REFUSAL_LIMIT) {
      check(`refusal ${attempt} keeps saving`, state.sprint.status === "dirty",
        state.sprint.status);
    }
  }
  check("a run of refusals stops retrying and says so",
    state.sprint.status === "failed", state.sprint.status);
  check("and the message is the one the server gave",
    state.sprint.error === "Somebody got there first.", state.sprint.error);
}

try {
  run();
} catch (failure) {
  console.error(`threw while checking: ${failure.stack}`);
  process.exit(1);
}

if (failures === 0) {
  console.log("locks clean: holds name the right nodes, locked nodes refuse edits, "
    + "cell writes name the right cells");
  process.exit(0);
}

console.log("");
console.log(`${failures} check${failures === 1 ? "" : "s"} failed.`);
process.exit(1);
