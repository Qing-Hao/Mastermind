// Sprint editor: the Sprint tab, editing `sprints/NN.md` as a block document.
//
// Its own file rather than more of app.js, which is already 2,800 lines. Loaded
// before app.js, so everything here is defined by the time app.js boots; it
// reads `state`, `api`, `$` and `element` from there, and touches none of them
// until something calls in.
//
// Three things about it are load-bearing:
//
//   1. **The markdown file is the record.** No table, no column, no export bump.
//      Every block carries its own raw markdown and a `gap`, and the whole file
//      is reassembled from them on save, so what goes back to disk is what came
//      off it except where you actually typed.
//   2. **It knows nothing about sprints.** Any pipe table is a table; no section
//      is recognised, no point is counted, no category is validated. That is the
//      condition the sprint-4 gate override rests on -- an editor that has not
//      learnt what a capacity table is cannot commit the storage question early.
//   3. **It never overwrites a file that changed on disk.** Saving quotes the
//      mtime it read back; a 409 stops autosaving and offers a reload. The AI
//      review script reads these files and you will edit them by hand.
//
// Rendering happens server-side (`app/markdown.py`): a block arrives with its
// `html` already built, and nothing is ever parsed back out of it.

// Long enough that typing through a blur does not fire a save per block, short
// enough that a lost keystroke is never more than the last thing you typed.
const SPRINT_SAVE_DEBOUNCE_MS = 600;

// What the indicator says, and how it reads. Failure has to be visible: a
// silently failed autosave loses a retro.
const SPRINT_STATUS_TEXT = {
  clean: "",
  dirty: "Unsaved…",
  saving: "Saving…",
  saved: "Saved",
  failed: "Save failed",
  conflict: "Changed on disk",
};

// A save is only worth blocking a page unload for while it has not landed.
const SPRINT_UNSAVED = new Set(["dirty", "saving", "failed", "conflict"]);

let sprintSaveTimer = null;

// --- loading ----------------------------------------------------------------

// Refresh the picker, and open a file only if none is open. A tab switch must
// not re-read the document: an edit committed a moment ago may still be in the
// debounce window, and re-reading would throw it away.
async function loadSprints() {
  const sprint = state.sprint;
  sprint.files = (await api("/api/sprints")).slice().reverse();  // newest first

  const open = sprint.files.some((file) => file.number === sprint.number);
  if (!open) {
    const first = sprint.files[0];
    if (first) await loadSprintFile(first.number);
    else resetSprint();
  }
  renderSprintView();
}

// Every field is assigned **onto** the existing object rather than replacing it.
// A commit or a save that is mid-flight holds a reference to `state.sprint`, and
// swapping in a fresh object would leave it writing an edit into a dead one --
// the block splices and never appears, and no error says so.
async function loadSprintFile(number) {
  const payload = await api(`/api/sprints/${number}`);
  clearTimeout(sprintSaveTimer);
  Object.assign(state.sprint, {
    number: payload.number,
    name: payload.name,
    blocks: payload.blocks,
    mtime: payload.mtime,
    status: "clean",
    error: "",
    editing: null,
    draft: null,
  });
}

// Leaving a file flushes what it owes first, and refuses to leave if the write
// did not land: an unsaved edit is not something to lose to a dropdown.
async function switchSprintFile(number) {
  if (sprintHasUnsavedWork()) await saveSprint();
  if (sprintHasUnsavedWork()) {
    $("sprint-select").value = state.sprint.number;
    return;
  }
  await loadSprintFile(number);
  renderSprintView();
}

// Show the Sprint tab with one particular file open, whatever was open before.
// The drawer's `Plan this fortnight →` is the caller: it creates a file and then
// hands you to it.
//
// `refreshView` re-reads the picker, and opens a file itself only when none is
// open, so the second half is what makes this land on the *asked-for* number
// rather than whichever one was already showing. It goes through
// `switchSprintFile`, so unsaved work in the file being left is flushed first and
// a write that will not land still refuses to move.
async function revealSprintFile(number) {
  state.view = "sprint";
  await refreshView();
  if (state.sprint.number !== number) await switchSprintFile(number);
}

function resetSprint() {
  clearTimeout(sprintSaveTimer);
  Object.assign(state.sprint, {
    number: null, name: "", blocks: [], mtime: null,
    status: "clean", error: "", editing: null, draft: null,
  });
}

// --- the document -----------------------------------------------------------

function renderSprintView() {
  renderSprintPicker();
  renderSprintOverlaps();
  renderSprintNew();
  renderSprintStatus();
  renderSprintMode();
  renderSprintDocument();
}

function renderSprintPicker() {
  const sprint = state.sprint;
  const select = $("sprint-select");
  select.innerHTML = "";
  for (const file of sprint.files) {
    // A file with nothing in it yet has no first line to name it by, and a
    // dangling separator reads as something missing rather than something empty.
    const option = element("option", null,
      file.heading ? `${file.name} · ${file.heading}` : file.name);
    option.value = file.number;
    select.appendChild(option);
  }
  if (sprint.number !== null) select.value = sprint.number;

  const none = sprint.files.length === 0;
  select.hidden = none;
  $("sprint-empty").hidden = !none;
  $("sprint-view-switch").hidden = none;
}

// --- starting one ------------------------------------------------------------

// The tab that owns sprints could not make one: the only path was Portfolio, a
// week number nothing marks as clickable, the fortnight drawer, and a button at the
// bottom of it -- which also does not exist for a fortnight outside the chart's
// window. This is that button, on the tab you would look for it on.
//
// Three things it deliberately does not do:
//
//   * **It does not read the roadmap.** No prefilled dates from a project, no
//     phases, no deliverables. The drawer is the roadmap-aware path and it already
//     exists; duplicating it here would put roadmap knowledge in a tab that has
//     none, which is worth more than the convenience.
//   * **It does not pick the number.** That comes off the directory, server-side,
//     as it does for the drawer -- so the script, the button and the picker cannot
//     disagree about which file is sprint 4.
//   * **It never overwrites.** A 409 is reported and the picker re-read, so the
//     file that already exists is there to open. `POST` has no force.
function renderSprintNew() {
  const input = $("sprint-new-start");
  // Only when it is empty: this runs on every render, and rewriting the box would
  // undo a fortnight you had just picked.
  if (!input.value) input.value = formatDate(weekStart(new Date()));
}

// The Monday the server will snap this date back to, which is the key the drawer
// files its own creations under. Worked out here rather than read back off the
// response, because it has to be known *before* the post to know not to post.
function sprintFortnightStart(value) {
  const asked = value ? parseDate(value) : new Date();
  return formatDate(weekStart(asked));
}

async function createSprintFile() {
  const input = $("sprint-new-start");
  const button = $("sprint-new");
  const note = $("sprint-new-note");
  const start = sprintFortnightStart(input.value);

  note.className = "muted";
  button.disabled = true;
  try {
    // A fortnight this session already made a file for opens it instead of making
    // a second one with the same heading and the next number. Shared with the
    // drawer, so pressing both does not make two files for one fortnight; in
    // memory, so after a reload the file on disk is the only record -- which is
    // why the 409 below still has to be handled.
    const made = state.plannedSprints.get(start);
    if (made) {
      note.textContent = `${made.name} already covers the fortnight from ${start}.`;
      await revealSprintFile(made.number);
      return;
    }

    const created = await api("/api/sprints", {
      method: "POST",
      body: JSON.stringify({ start }),
    });
    state.plannedSprints.set(created.window.start, created);
    note.textContent = `Started ${created.path}, `
      + `${created.window.start} → ${created.window.end}.`;
    await revealSprintFile(created.number);
  } catch (failure) {
    note.className = "error";
    // Two different 409s reach here -- a name already on disk, and a fortnight that
    // overlaps a sprint already running -- and the server's message names which.
    // Re-reading the picker is what turns either into something you can act on: the
    // file it is talking about is then in the list, whatever number it carries.
    note.textContent = failure.status === 409
      ? `${failure.message} Pick it from File above to open it.`
      : failure.message;
    if (failure.status === 409) await refreshSprintFiles();
  } finally {
    button.disabled = false;
  }
}

// One team runs one sprint at a time, so two files covering the same day is a
// mistake. The server refuses to *create* one, which leaves exactly one way in: the
// dates edited by hand in a heading afterwards. So this reports rather than
// repairs -- the heading is yours, and nothing here rewrites one.
//
// Which pairs overlap is `GET /api/sprints`'s answer, not this file's. The editor
// still reads no sprint dates: it prints the numbers it was handed.
function renderSprintOverlaps() {
  const node = $("sprint-overlap");
  const named = new Map(state.sprint.files.map((file) => [file.number, file]));
  const pairs = [];

  for (const file of state.sprint.files) {
    for (const other of file.overlaps || []) {
      // Both ends of an overlap report it, so a pair is named once -- from the
      // lower number, which is also the order they were run in.
      if (other <= file.number) continue;
      const window = file.window ? ` (${file.window.start} → ${file.window.end})` : "";
      pairs.push(`${file.name}${window} and ${named.get(other)?.name ?? `sprint ${other}`}`);
    }
  }

  node.hidden = pairs.length === 0;
  node.textContent = pairs.length === 0 ? "" : `⚠ ${pairs.join("; ")} cover `
    + "overlapping days. One team runs one sprint at a time — fix the dates in a "
    + "heading, or delete the file that should not exist.";
}

// --- rendered or raw ---------------------------------------------------------

// Two views of one file. The document is the editor; the raw pane is the escape
// hatch for the things a block cannot express -- a table's alignment markers, or
// turning a table back into prose. Both write the same file the same way.
function renderSprintMode() {
  const sprint = state.sprint;
  const raw = sprint.view === "raw";
  const none = sprint.files.length === 0;

  $("sprint-view-doc").classList.toggle("active", !raw);
  $("sprint-view-raw").classList.toggle("active", raw);
  $("sprint-document").hidden = none || raw;
  $("sprint-raw-pane").hidden = none || !raw;

  if (!raw) return;
  const area = $("sprint-raw-file");
  // Not while it is being typed in: this runs on every re-render, and replacing
  // the text under the cursor would undo the edit in progress.
  if (document.activeElement !== area) area.value = joinSprintBlocks(sprint.blocks);
}

function setSprintView(view) {
  const sprint = state.sprint;
  if (sprint.view === view) return;
  sprint.view = view;
  sprint.editing = null;
  sprint.draft = null;
  closeSprintMenu();
  renderSprintMode();
  renderSprintDocument();
}

// The whole file re-split in one go. `/split` is the same splitter that read the
// file, so what comes back is what a reload would have shown -- which is the
// only reason it is safe to replace every block at once.
async function commitSprintRawFile(text) {
  const sprint = state.sprint;
  const number = sprint.number;
  if (number === null || text === joinSprintBlocks(sprint.blocks)) return;

  let blocks;
  try {
    blocks = (await api("/api/sprints/split", {
      method: "POST",
      body: JSON.stringify({ text }),
    })).blocks;
  } catch (failure) {
    sprint.status = "failed";
    sprint.error = failure.message;
    renderSprintStatus();
    return;
  }
  if (sprint.number !== number) return;

  sprint.blocks = blocks;
  renderSprintDocument();
  scheduleSprintSave();
}

function renderSprintDocument() {
  const sprint = state.sprint;
  const doc = $("sprint-document");

  // Chrome fires blur when a focused element is removed from the document, so a
  // re-render that happens *while* a block is open would commit the box it is
  // about to destroy -- with whatever text that box held, over whatever the
  // render is about to draw. A node on its way out has no opinion about
  // committing, so its handler goes first. Found by instrumenting a tab switch
  // mid-edit: the commit arrived before the mousedown that caused it.
  const leaving = doc.querySelector(".sprint-raw");
  if (leaving) leaving.onblur = null;
  doc.innerHTML = "";

  sprint.blocks.forEach((block, index) => {
    const row = element("div", "sprint-row");
    row.appendChild(sprintRail(block, index, row));

    // A table is edited as a grid and never as raw pipes, so it has no reveal
    // gesture at all -- the cells *are* the editor. Everything else swaps
    // between rendered HTML and its own markdown.
    if (block.type === "table" && block.table) {
      row.appendChild(sprintTable(block, index));
    } else {
      row.appendChild(index === sprint.editing
        ? sprintEditor(block, index)
        : sprintBlock(block, index));
    }
    doc.appendChild(row);
  });

  // A document edited down to nothing would otherwise have no way back in.
  if (sprint.blocks.length === 0 && sprint.number !== null) {
    const empty = element("p", "sprint-placeholder", "Empty file — click to start typing.");
    empty.onclick = () => startSprintBlock();
    doc.appendChild(empty);
  }

  // An input outside the document cannot take focus, so this happens after the
  // append rather than inside `sprintEditor` -- the same order `renderPhases`
  // needs for the deliverable adder.
  const area = doc.querySelector(".sprint-raw");
  if (area) {
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    autosizeSprintArea(area);
  }

  // Also after the append, and for the same reason: a diagram is measured text,
  // and a detached node has no measurements.
  drawSprintDiagrams(doc);
}

function sprintBlock(block, index) {
  const node = element("div", `sprint-block sprint-${block.type}`);
  node.innerHTML = block.html;
  node.tabIndex = 0;
  node.title = "Click to edit the markdown";
  node.onclick = (event) => {
    // A link in a sprint file is there to be followed, not to open an editor.
    if (event.target.closest("a")) return;
    // Nor is a checkbox: ticking one is an edit in its own right, and opening
    // the markdown instead would make the tick unreachable.
    const box = event.target.closest('input[type="checkbox"]');
    if (box) {
      toggleSprintTask(index, box, node);
      return;
    }
    editSprintBlock(index);
  };
  node.onkeydown = (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    editSprintBlock(index);
  };
  return node;
}

function sprintEditor(block, index) {
  const sprint = state.sprint;
  const area = element("textarea", "sprint-raw");
  area.value = sprint.draft ?? block.raw;
  area.spellcheck = false;
  area.oninput = () => {
    autosizeSprintArea(area);
    maybeOpenSprintMenu(area, index);
  };
  area.onblur = () => {
    // Blurring past an open menu picks nothing: what was typed is what commits,
    // which for `/tab` is a paragraph reading `/tab`. Visible and one edit away
    // from gone, where a swallowed blur leaves a box that has stopped
    // responding to anything.
    closeSprintMenu();
    commitSprintBlock(index, area.value);
  };
  area.onkeydown = (event) => {
    // While the menu is up it owns the arrows, Enter and Esc.
    if (sprintMenu.open && sprintMenuKey(event)) return;
    // Esc commits like clicking away does. There is no cancel here: the file is
    // the record and the save is automatic, so "undo" is typing it back.
    if (event.key === "Escape") {
      event.preventDefault();
      area.blur();
      return;
    }
    // Enter with nothing after the cursor ends this block and opens an empty one
    // below. **This is what makes the insert menu reachable at all** -- `/` needs
    // an empty block to be typed into, and nothing else in the editor makes one.
    // Not in a list or a fence, where a newline is a newline you meant.
    if (event.key === "Enter" && !event.shiftKey
      && block.type !== "list" && block.type !== "code" && block.type !== "html"
      && area.value.trim() && !area.value.slice(area.selectionEnd).trim()) {
      event.preventDefault();
      insertSprintBlockAfter(index, area.value.slice(0, area.selectionEnd));
      return;
    }
    // Backspace in a block you have emptied removes it, rather than leaving a
    // blank one behind for the commit to tidy up invisibly.
    if (event.key === "Backspace" && !area.value && state.sprint.blocks.length > 1) {
      event.preventDefault();
      removeSprintBlock(index);
    }
  };
  return area;
}

// Commit what was typed, then open an empty paragraph after whatever that became
// -- one box can have split into three, so the insertion point is counted rather
// than assumed. No save is scheduled for the empty block itself: it is not part
// of the file until something is typed into it, and committing it empty removes
// it again.
async function insertSprintBlockAfter(index, text) {
  const sprint = state.sprint;
  const number = sprint.number;
  const before = sprint.blocks.length;

  await commitSprintBlock(index, text);
  if (sprint.number !== number) return;

  const at = index + Math.max(1, sprint.blocks.length - before + 1);
  sprint.blocks.splice(at, 0, {
    index: at, type: "paragraph", raw: "", gap: sprintBlankLine(sprint.blocks), html: "",
  });
  sprint.blocks.forEach((block, position) => { block.index = position; });
  sprint.editing = at;
  sprint.draft = null;
  renderSprintDocument();
}

// The last block owns the file's trailing newline, so removing it hands that on
// rather than losing it.
function removeSprintBlock(index) {
  const sprint = state.sprint;
  const blocks = sprint.blocks;
  const tail = blocks[blocks.length - 1].gap;

  blocks.splice(index, 1);
  if (blocks.length) blocks[blocks.length - 1].gap = tail;
  blocks.forEach((block, position) => { block.index = position; });

  sprint.editing = Math.max(0, index - 1);
  sprint.draft = null;
  renderSprintDocument();
  scheduleSprintSave();
}

// --- mermaid ----------------------------------------------------------------

// A mermaid fence arrives from the server as `<pre class="mermaid-source">`
// holding its own source, because drawing one needs a DOM and text measurement.
// It is the only rendering in the editor that does not happen in Python, and the
// class name is the whole contract between the two files -- `app/markdown.py`
// names the same string.
//
// The library is **vendored, not fetched**. This is a localhost tool that works
// offline, and a diagram that needs the internet would be the first thing here
// that does; 3.4MB in the repo is the price of that. It loads once per page life
// and only when a diagram is actually on screen, so a sprint file without one
// costs nothing at all.
const MERMAID_SOURCE_CLASS = "mermaid-source";
const MERMAID_SRC = "/static/vendor/mermaid.min.js";

// Source text -> `{ svg }` or `{ error }`, so a re-render that changed nothing
// draws nothing: reordering a block, ticking a task, a landed save and a tab
// switch are all cache hits. A hit is applied **synchronously**, which is what
// keeps the picture from flickering through its own source on every render.
//
// A failure is cached too, keyed by the same text. Fixing the diagram changes
// the key, so nothing has to be invalidated -- and a broken diagram stops being
// re-parsed on every render of the document it sits in.
const mermaidDrawn = new Map();
let mermaidLoad = null;
let mermaidSeq = 0;

function loadMermaid() {
  if (mermaidLoad) return mermaidLoad;
  mermaidLoad = new Promise((resolve, reject) => {
    const script = element("script");
    script.src = MERMAID_SRC;
    script.onload = () => {
      window.mermaid.initialize({
        startOnLoad: false,     // the document says when, not the page load
        securityLevel: "strict",
        theme: "neutral",       // the app is plain and light; the default theme is not
      });
      resolve(window.mermaid);
    };
    // Missing or unservable: every diagram falls back to showing its source,
    // which is exactly what the tab did before this existed.
    script.onerror = () => reject(new Error("mermaid could not be loaded"));
    document.head.appendChild(script);
  });
  return mermaidLoad;
}

function drawSprintDiagrams(doc) {
  const sources = doc.querySelectorAll(`pre.${MERMAID_SOURCE_CLASS}`);
  if (!sources.length) return;      // nothing on screen, so nothing is loaded

  sources.forEach((pre) => {
    // The DOM has already unescaped the fence's contents, so nothing here reads
    // markdown or strips backticks.
    const text = pre.textContent;
    const drawn = mermaidDrawn.get(text);
    if (drawn !== undefined) applyMermaidResult(pre, drawn);
    else drawOneDiagram(pre, text);
  });
}

async function drawOneDiagram(pre, text) {
  const id = `mermaid-${mermaidSeq += 1}`;
  let result;
  try {
    const mermaid = await loadMermaid();
    result = { svg: (await mermaid.render(id, text)).svg };
  } catch (failure) {
    // Mermaid renders through a scratch element of its own and tidies it up,
    // but a throw is the path least likely to have run that tidying, so the
    // sweep is here rather than trusted.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
    // Mermaid's messages run to several lines of parser detail. The first line
    // is the part that says which line of the diagram is wrong.
    const said = String(failure && failure.message ? failure.message : failure);
    result = { error: said.split("\n")[0] };
  }
  mermaidDrawn.set(text, result);
  // The document may have re-rendered while this was in flight -- the same check
  // the save path makes against `sprint.number`, for the same reason.
  if (pre.isConnected) applyMermaidResult(pre, result);
}

function applyMermaidResult(pre, result) {
  // A diagram that will not parse keeps its source: the `<pre>` is already where
  // the markdown is, so the failure state costs nothing to draw and stays one
  // keystroke away from a picture.
  if (result.error !== undefined) markMermaidFailure(pre, result.error);
  else swapMermaidFigure(pre, result.svg);
}

// The `<pre>` is **replaced, never hidden**. A class that sets `display`
// outranks `[hidden]`, which `.sprint-view`, `.fortnight-drawer`,
// `.track-crumb` and `.direction-link-form` have each had to learn the hard way;
// swapping nodes has no such trap. Nothing is lost by it either: the next render
// rebuilds the block from `block.html`, so the source comes back on its own.
function swapMermaidFigure(pre, svg) {
  const figure = element("div", "mermaid-figure");
  figure.innerHTML = svg;
  pre.replaceWith(figure);
}

function markMermaidFailure(pre, said) {
  const next = pre.nextElementSibling;
  if (next && next.classList.contains("mermaid-error")) return;
  pre.after(element("p", "mermaid-error", `Diagram not drawn — ${said}`));
}

// --- the gutter rail --------------------------------------------------------

// What a block is, in the margin. Short because it sits in a 46px gutter, and
// worth having because a paragraph that looks like a heading is exactly the thing
// you want to know before dragging it somewhere.
const SPRINT_TAG = {
  heading: "h", paragraph: "p", list: "list", table: "table",
  code: "code", quote: "quote", rule: "rule", html: "html",
};

// The server types every fence `code`, so a diagram would otherwise be labelled
// by what it is written in rather than by what it is. Read off the class the
// renderer already marked it with: the rail's job is to say what you are about
// to drag.
//
// `mmd` rather than `mermaid` because the gutter is 46px and the full word
// measures 41 of them -- at any window width the tag would start off the left
// edge of the page. It is the extension mermaid files carry, and it sits in a
// column of `list` and `table` where an abbreviation reads as one.
function sprintTag(block) {
  if (block.html && block.html.includes(MERMAID_SOURCE_CLASS)) return "mmd";
  return SPRINT_TAG[block.type] || block.type;
}

function sprintRail(block, index, row) {
  const rail = element("div", "sprint-rail");
  rail.appendChild(element("span", "sprint-tag", sprintTag(block)));

  const grip = element("button", "grip-handle", "⠿");
  grip.type = "button";
  grip.title = "Drag to reorder";
  grip.setAttribute("aria-label", "Move this block");
  rail.appendChild(grip);

  // `draggable` is armed from the grip and disarmed after the drop, so a press
  // anywhere else in the block still places a cursor. That is the same reasoning
  // as the deliverable list's grip column, reached by a different route: there
  // the drag is hand-rolled because the row itself had to stay clickable, here
  // HTML5 drag-and-drop is free because nothing but the handle is ever draggable.
  grip.onmousedown = () => { row.draggable = true; };

  row.ondragstart = (event) => {
    state.sprint.dragIndex = index;
    row.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    // Firefox starts no drag at all unless the transfer carries something.
    event.dataTransfer.setData("text/plain", String(index));
  };
  row.ondragend = () => {
    row.draggable = false;
    row.classList.remove("dragging");
    state.sprint.dragIndex = null;
    clearSprintDropMarks();
  };
  row.ondragover = (event) => {
    const from = state.sprint.dragIndex;
    if (from === null || from === index) return;
    event.preventDefault();
    clearSprintDropMarks();
    // Which edge it will actually land on. Dropping onto a block puts the
    // dragged one where that block is, which is above it coming down the
    // document and below it going up.
    row.classList.add(from > index ? "drop-above" : "drop-below");
  };
  row.ondragleave = () => clearSprintDropMarks();
  row.ondrop = (event) => {
    event.preventDefault();
    const from = state.sprint.dragIndex;
    clearSprintDropMarks();
    state.sprint.dragIndex = null;
    if (from === null || from === index) return;
    reorderSprintBlocks(from, index);
  };

  return rail;
}

function clearSprintDropMarks() {
  for (const row of $("sprint-document").querySelectorAll(".drop-above, .drop-below")) {
    row.classList.remove("drop-above", "drop-below");
  }
}

// True when a gap holds a blank line, which separates any two blocks safely.
const gapSeparates = (gap) => ((gap || "").match(/\n/g) || []).length >= 2;

// A CRLF file keeps its CRLF: the round trip is byte for byte, so a separator
// this code invents has to match the ones already in the file.
function sprintBlankLine(blocks) {
  const crlf = blocks.some((block) => /\r\n/.test(block.gap || "") || /\r\n/.test(block.raw || ""));
  return crlf ? "\r\n\r\n" : "\n\n";
}

// Moving a block moves its `raw`; its `gap` has to be reasoned about instead of
// carried along, because a gap is what separates *this* block from the *next*
// one and a move changes which separators sit where.
//
// A gap holding a blank line separates any two blocks safely. A single newline
// does not: two paragraphs joined by one newline re-read as **one** paragraph, so
// a reorder that created that adjacency would merge two blocks rather than move
// one. So the adjacencies the move actually changed get a blank line where they
// do not already have one, and **every other separator in the file is left
// exactly as it was** — which is what keeps this inside invariant 2. Whichever
// block ends up last inherits what used to end the file, so the trailing newline
// is neither lost nor doubled.
function reorderSprintBlocks(from, to) {
  const blocks = state.sprint.blocks;
  if (from === to || !blocks[from] || !blocks[to]) return;

  const tail = blocks[blocks.length - 1].gap;
  const followed = new Map(blocks.map((block, index) => [block, blocks[index + 1] || null]));
  const blankLine = sprintBlankLine(blocks);

  blocks.splice(to, 0, blocks.splice(from, 1)[0]);

  blocks.forEach((block, index) => {
    block.index = index;
    const next = blocks[index + 1] || null;
    if (next === followed.get(block)) return;      // this adjacency did not change
    if (next === null) block.gap = tail;           // this block ends the file now
    else if (!gapSeparates(block.gap)) block.gap = blankLine;
  });

  renderSprintDocument();
  scheduleSprintSave();
}

// --- the insert menu --------------------------------------------------------

// `/` on an otherwise empty block. Nine ways in, and **not one of them is a
// sprint concept**: the table is an empty two-by-two, not a capacity table, and
// the task list is one empty task rather than a filled-in line. Deliberate — see
// point 2 in the header. The snippets are plain markdown and go through the same
// `/split` every other edit does, so nothing here builds a block by hand.
const SPRINT_MENU = [
  { key: "h2", label: "Heading", markdown: "## " },
  { key: "h3", label: "Subheading", markdown: "### " },
  { key: "table", label: "Table", markdown: "|  |  |\n| --- | --- |\n|  |  |" },
  { key: "task", label: "Task list", markdown: "- [ ] " },
  { key: "list", label: "Bullet list", markdown: "- " },
  { key: "quote", label: "Quote", markdown: "> " },
  {
    key: "mermaid",
    label: "Mermaid diagram",
    markdown: "```mermaid\nflowchart LR\n  A[Start] --> B[Finish]\n```",
  },
  { key: "code", label: "Code block", markdown: "```\n\n```" },
  { key: "rule", label: "Divider", markdown: "---" },
];

const sprintMenu = { open: false, node: null, items: [], selected: 0, area: null, index: 0 };

function maybeOpenSprintMenu(area, index) {
  const text = area.value;
  // A slash first and nothing but the filter after it. Any whitespace closes the
  // menu, so a line that genuinely starts with a slash is only a menu until you
  // type the next character.
  if (text.startsWith("/") && !/\s/.test(text)) openSprintMenu(area, index, text.slice(1));
  else closeSprintMenu();
}

function openSprintMenu(area, index, filter) {
  const wanted = filter.toLowerCase();
  sprintMenu.area = area;
  sprintMenu.index = index;
  sprintMenu.items = SPRINT_MENU.filter((item) => !wanted
    || item.label.toLowerCase().startsWith(wanted)
    || item.key.startsWith(wanted));
  sprintMenu.selected = 0;
  sprintMenu.open = true;
  renderSprintMenu();
}

function renderSprintMenu() {
  if (!sprintMenu.node) {
    // On `body` rather than in the document: the block it belongs to is inside a
    // column that scrolls and clips, and a menu that gets cut off is worse than
    // one positioned by hand.
    sprintMenu.node = element("div", "sprint-menu");
    document.body.appendChild(sprintMenu.node);
  }
  const node = sprintMenu.node;
  node.innerHTML = "";

  if (sprintMenu.items.length === 0) {
    node.appendChild(element("div", "sprint-menu-empty", "Nothing matches"));
  }
  sprintMenu.items.forEach((item, position) => {
    const row = element("div", "sprint-menu-item");
    row.setAttribute("aria-selected", position === sprintMenu.selected ? "true" : "false");
    row.append(element("span", null, item.label), element("span", "sprint-menu-key", `/${item.key}`));
    // `mousedown` with the default prevented, so the textarea never loses focus
    // and its blur handler never commits the `/table` you were typing.
    row.onmousedown = (event) => {
      event.preventDefault();
      pickSprintMenuItem(position);
    };
    node.appendChild(row);
  });

  const box = sprintMenu.area.getBoundingClientRect();
  node.style.left = `${box.left + window.scrollX}px`;
  node.style.top = `${box.bottom + window.scrollY + 4}px`;
  node.hidden = false;
}

function sprintMenuKey(event) {
  const count = sprintMenu.items.length;
  if (event.key === "ArrowDown" && count) {
    event.preventDefault();
    sprintMenu.selected = (sprintMenu.selected + 1) % count;
    renderSprintMenu();
    return true;
  }
  if (event.key === "ArrowUp" && count) {
    event.preventDefault();
    sprintMenu.selected = (sprintMenu.selected - 1 + count) % count;
    renderSprintMenu();
    return true;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    pickSprintMenuItem(sprintMenu.selected);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeSprintMenu();
    return true;
  }
  return false;
}

function closeSprintMenu() {
  sprintMenu.open = false;
  if (sprintMenu.node) sprintMenu.node.hidden = true;
}

async function pickSprintMenuItem(position) {
  const item = sprintMenu.items[position];
  const index = sprintMenu.index;
  closeSprintMenu();
  if (!item) return;

  await commitSprintBlock(index, item.markdown);

  // Land where the typing goes next. A table has no markdown editor at all, so
  // the cursor belongs in its first cell; everything else reopens as raw, since
  // an empty `## ` exists to be typed into.
  const fresh = state.sprint.blocks[index];
  if (!fresh) return;
  if (fresh.type === "table") focusSprintCell(index, -1, 0);
  else editSprintBlock(index);
}

// --- ticking a task ---------------------------------------------------------

// A tick is an edit to the block's own markdown and nothing more: the nth `[ ]`
// in this block becomes `[x]`, the block re-splits, the file is saved. Nothing
// derives from it, here or anywhere — a sprint file's ticks are not roadmap
// state, and no rule reads them.
function toggleSprintTask(index, box, node) {
  const block = state.sprint.blocks[index];
  if (!block) return;

  const boxes = Array.from(node.querySelectorAll('input[type="checkbox"]'));
  const nth = boxes.indexOf(box);
  if (nth < 0) return;

  let seen = -1;
  const lines = block.raw.split("\n").map((line) => {
    // The marker only, so a `[x]` written mid-sentence is left alone.
    const marker = line.match(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/);
    if (!marker) return line;
    seen += 1;
    if (seen !== nth) return line;
    const head = marker[1];
    return head + (marker[2].toLowerCase() === "x" ? " " : "x") + line.slice(head.length + 1);
  });

  commitSprintBlock(index, lines.join("\n"));
}

function autosizeSprintArea(area) {
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight + 2}px`;
}

function editSprintBlock(index) {
  const sprint = state.sprint;
  if (sprint.editing === index) return;
  sprint.editing = index;
  sprint.draft = null;
  renderSprintDocument();
}

// Show an empty paragraph in edit mode, so an empty file is not a dead end.
function startSprintBlock() {
  const sprint = state.sprint;
  sprint.blocks = [{ index: 0, type: "paragraph", raw: "", gap: "\n", html: "" }];
  sprint.editing = 0;
  sprint.draft = null;
  renderSprintDocument();
}

// --- tables -----------------------------------------------------------------

// The grid is the reason the editor exists: the capacity and unplanned-work
// tables get filled in every fortnight, and typing pipes by hand is the part
// that makes people not bother.
//
// `block.table` is authoritative while the grid is on screen -- a cell edit
// changes it and nothing else. `raw` is regenerated from it **server-side** by
// `serialise_table` when the file is saved, so column padding and alignment
// happen in exactly one place and the frontend never writes a pipe. That is also
// why inserting, deleting and reordering rows and columns needs no endpoint: they
// rearrange the grid, and the file is written from the grid either way.
//
// Nothing here knows what a capacity table is. Any pipe table in any sprint file
// gets this same grid, which is the condition the sprint-4 gate override rests on.

const CELL_ALIGN = { right: "right", center: "center" };

// A pipe inside a cell is stored escaped, because that is what the file needs.
// The grid shows the character itself; the server escapes it again on the way
// back, which is why `_escape_cell` unescapes before it escapes.
const cellText = (value) => String(value ?? "").replace(/\\\|/g, "|");

function sprintTable(block, index) {
  const node = element("div", "sprint-block sprint-table-block");
  const scroller = element("div", "sprint-grid");
  const table = element("table", "sprint-table");
  const grid = block.table;
  const thead = element("thead");

  // A strip of column grips above the header, and one gutter cell per row down
  // the left. Both are their own cells rather than marks inside the header: a
  // header cell is an `<input>`, and a handle drawn over one would cost the click
  // that places a cursor in it.
  const grips = element("tr", "sprint-colgrips");
  grips.appendChild(element("th", "sprint-corner"));
  grid.head.forEach((_, column) => {
    const cell = element("th", "sprint-colgrip");
    cell.appendChild(gridGrip(block, index, "column", column, cell));
    grips.appendChild(cell);
  });
  thead.appendChild(grips);

  const head = element("tr");
  // The header row gets no grip: GFM has no table without a header row, so it can
  // neither be moved nor removed. Its cells are reordered by moving the columns.
  head.appendChild(element("th", "sprint-gutter"));
  grid.head.forEach((cell, column) => {
    const th = element("th");
    th.appendChild(sprintCell(block, index, -1, column, cell));
    head.appendChild(th);
  });
  thead.appendChild(head);
  table.appendChild(thead);

  const body = element("tbody");
  grid.rows.forEach((row, r) => {
    const tr = element("tr");
    const gutter = element("td", "sprint-gutter");
    gutter.appendChild(gridGrip(block, index, "row", r, tr));
    tr.appendChild(gutter);
    row.forEach((cell, column) => {
      tr.appendChild(element("td")).appendChild(sprintCell(block, index, r, column, cell));
    });
    body.appendChild(tr);
  });
  table.appendChild(body);

  scroller.appendChild(table);
  node.append(scroller, sprintTableTools(block, index));
  return node;
}

function sprintCell(block, index, r, column, value) {
  const grid = block.table;
  const cell = element("input", "sprint-cell");
  cell.type = "text";
  cell.value = cellText(value);
  cell.dataset.r = r;
  cell.dataset.c = column;
  cell.spellcheck = false;
  // Alignment is the column's, so the grid reads the way the rendered table does.
  cell.style.textAlign = CELL_ALIGN[grid.align[column]] || "";

  cell.oninput = () => {
    if (r === -1) grid.head[column] = cell.value;
    else grid.rows[r][column] = cell.value;
    tableEdited(block);
  };

  cell.onkeydown = (event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const columns = grid.head.length;
    let row = r;
    let next = column + (event.shiftKey ? -1 : 1);
    if (next >= columns) { next = 0; row = r + 1; }
    if (next < 0) { next = columns - 1; row = r - 1; }
    // Tab off the last cell grows the table rather than leaving it.
    if (row > grid.rows.length - 1) {
      insertGridRow(block, grid.rows.length);
      applyGridChange(block, index, grid.rows.length - 1, 0);
      return;
    }
    if (row < -1) return;   // Shift+Tab out of the first header cell stays put
    focusSprintCell(index, row, next);
  };

  cell.onpaste = (event) => {
    const text = (event.clipboardData || window.clipboardData).getData("text");
    // One value is an ordinary paste; a range is a grid, and that is the point.
    if (!text || !/[\t\n]/.test(text)) return;
    event.preventDefault();
    pasteIntoTable(block, r, column, text);
    renderSprintDocument();
    focusSprintCell(index, r, column);
  };

  return cell;
}

// Fills from the anchor cell, growing the table to fit what was pasted. A
// spreadsheet range arrives as tab-separated lines, which is what makes the
// capacity table a paste rather than an afternoon.
function pasteIntoTable(block, r, column, text) {
  const grid = block.table;
  const rows = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");

  rows.forEach((line, downwards) => {
    line.split("\t").forEach((value, across) => {
      const targetRow = r + downwards;
      const targetColumn = column + across;
      while (grid.head.length <= targetColumn) {
        grid.head.push("");
        grid.align.push("");
        grid.rows.forEach((row) => row.push(""));
      }
      while (grid.rows.length <= targetRow) {
        grid.rows.push(new Array(grid.head.length).fill(""));
      }
      if (targetRow === -1) grid.head[targetColumn] = value.trim();
      else grid.rows[targetRow][targetColumn] = value.trim();
    });
  });
  tableEdited(block);
}

// --- rows and columns, where they actually are -------------------------------

// The grid used to grow and shrink from the end only, so a row that turned out to
// belong third, or a column typed in the wrong order, cost a retype of everything
// below or to the right of it -- in the one table the editor exists to make easy
// to fill in. These are the operations that fix that, and every one of them is
// generic: a row, a column, a position. Nothing here knows what a capacity table
// is, which is the condition the sprint-4 gate override rests on.

// `serialise_table` pads a ragged table out to a rectangle on the way to the file
// anyway, so squaring it up before a structural edit writes nothing the save would
// not have written. It is also what makes "column 3" name the same cell on every
// row, which every operation below assumes.
function squareGrid(grid) {
  const columns = Math.max(grid.head.length, ...grid.rows.map((row) => row.length), 1);
  while (grid.head.length < columns) grid.head.push("");
  while (grid.align.length < columns) grid.align.push("");
  for (const row of grid.rows) while (row.length < columns) row.push("");
  return columns;
}

function insertGridRow(block, at) {
  const grid = block.table;
  const columns = squareGrid(grid);
  grid.rows.splice(at, 0, new Array(columns).fill(""));
}

function deleteGridRow(block, at) {
  squareGrid(block.table);
  block.table.rows.splice(at, 1);
}

function moveGridRow(block, from, to) {
  const rows = block.table.rows;
  squareGrid(block.table);
  rows.splice(to, 0, rows.splice(from, 1)[0]);
}

// **A column is its cells and its alignment marker.** `align` is a parallel array,
// so anything that inserts, removes or moves a column has to do the same to the
// marker in the same breath. Miss it and a right-aligned column of numbers quietly
// lines up under a different heading -- which the round-trip test cannot catch,
// because the file it writes still round-trips perfectly.
function insertGridColumn(block, at) {
  const grid = block.table;
  squareGrid(grid);
  grid.head.splice(at, 0, "");
  grid.align.splice(at, 0, "");
  for (const row of grid.rows) row.splice(at, 0, "");
}

function deleteGridColumn(block, at) {
  const grid = block.table;
  squareGrid(grid);
  grid.head.splice(at, 1);
  grid.align.splice(at, 1);
  for (const row of grid.rows) row.splice(at, 1);
}

function moveGridColumn(block, from, to) {
  const grid = block.table;
  squareGrid(grid);
  grid.head.splice(to, 0, grid.head.splice(from, 1)[0]);
  grid.align.splice(to, 0, grid.align.splice(from, 1)[0]);
  for (const row of grid.rows) row.splice(to, 0, row.splice(from, 1)[0]);
}

// Flag, redraw, and put the cursor back in the grid: a structural edit that leaves
// focus on a button you have to click away from is a step you have to undo.
function applyGridChange(block, index, r, column) {
  tableEdited(block);
  renderSprintDocument();
  focusSprintCell(index, r, column);
}

// Which row or column is being dragged. Transient, so it lives here rather than in
// `state`: nothing re-renders between the dragstart and the drop.
const gridDrag = { block: null, kind: null, position: null };

// One handle, two gestures. Drag it to move this row or column; click it for what
// a drag cannot say -- insert on either side, or delete this one. The drag is armed
// from the handle alone, so a press in a cell still places a cursor in it: the same
// conclusion the deliverable list and the block rail both reached.
function gridGrip(block, index, kind, position, target) {
  const what = kind === "row" ? "row" : "column";
  const grip = element("button", "grip-handle", "⠿");
  grip.type = "button";
  grip.title = `Drag to move this ${what} · click to insert or delete`;
  grip.setAttribute("aria-label", `This ${what}`);
  grip.onmousedown = () => { target.draggable = true; };
  grip.onclick = () => {
    // Disarmed again, because a click is not a drag: a completed drag ends in
    // `ondragend`, but a click that only opened the menu would leave the row
    // draggable, and the next press *in one of its cells* would drag it instead of
    // placing a cursor -- the thing arming from the grip alone exists to prevent.
    target.draggable = false;
    openGridMenu(block, index, kind, position, grip);
  };

  // Every handler below stops the event, because a table lives inside a
  // `.sprint-row` that has drag handlers of its own and these events bubble.
  // Without it, dragging a row arms the block reorder and moves the whole block.
  target.ondragstart = (event) => {
    event.stopPropagation();
    Object.assign(gridDrag, { block, kind, position });
    target.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    // Firefox starts no drag at all unless the transfer carries something.
    event.dataTransfer.setData("text/plain", `${kind}:${position}`);
  };
  target.ondragend = (event) => {
    event.stopPropagation();
    target.draggable = false;
    target.classList.remove("dragging");
    gridDrag.kind = null;
    clearGridDropMarks();
  };
  target.ondragover = (event) => {
    if (!gridDragging(block, kind, position)) return;
    event.preventDefault();
    event.stopPropagation();
    clearGridDropMarks();
    // Which edge it lands on. Dropping onto a row or column puts the dragged one
    // where that one is, which is before it moving up the grid and after it
    // moving down -- the same reading the block reorder uses.
    target.classList.add(gridDrag.position > position ? "drop-before" : "drop-after");
  };
  target.ondragleave = (event) => {
    event.stopPropagation();
    clearGridDropMarks();
  };
  target.ondrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const from = gridDrag.position;
    const moving = gridDragging(block, kind, position);
    clearGridDropMarks();
    gridDrag.kind = null;
    if (!moving) return;
    if (kind === "row") {
      moveGridRow(block, from, position);
      applyGridChange(block, index, position, 0);
    } else {
      moveGridColumn(block, from, position);
      applyGridChange(block, index, -1, position);
    }
  };

  return grip;
}

// A drag only means something within one axis of one table: a row cannot be
// dropped on a column, and neither can cross into another block's grid.
function gridDragging(block, kind, position) {
  return gridDrag.kind === kind && gridDrag.block === block && gridDrag.position !== position;
}

function clearGridDropMarks() {
  for (const node of $("sprint-document").querySelectorAll(".drop-before, .drop-after")) {
    node.classList.remove("drop-before", "drop-after");
  }
}

// --- the row and column menu -------------------------------------------------

// The insert menu's smaller sibling, and deliberately the same furniture: the
// `.sprint-menu` classes, arrows to move, Enter to pick, Esc to close having done
// nothing. Its own state because the two are never open at once and this one is
// anchored to a button rather than to a textarea's caret.
const gridMenu = {
  node: null, items: [], selected: 0, open: false, block: null, index: 0, anchor: null,
};

// Each entry reports where the cursor belongs afterwards, worked out **after** the
// mutation: `rows.length` below is the length once the row is gone.
function gridMenuItems(block, kind, position) {
  const grid = block.table;
  if (kind === "row") {
    return [
      { label: "Insert row above", run: () => { insertGridRow(block, position); return [position, 0]; } },
      { label: "Insert row below", run: () => { insertGridRow(block, position + 1); return [position + 1, 0]; } },
      {
        label: "Delete row",
        run: () => {
          deleteGridRow(block, position);
          // Nothing left to land in puts the cursor in the header, which is the
          // one row a table always has.
          return [Math.min(position, grid.rows.length - 1), 0];
        },
      },
    ];
  }
  return [
    { label: "Insert column left", run: () => { insertGridColumn(block, position); return [-1, position]; } },
    { label: "Insert column right", run: () => { insertGridColumn(block, position + 1); return [-1, position + 1]; } },
    {
      label: "Delete column",
      // A table with no columns is not a table, so the last one cannot go.
      disabled: grid.head.length <= 1,
      run: () => {
        deleteGridColumn(block, position);
        return [-1, Math.min(position, grid.head.length - 1)];
      },
    },
  ];
}

function openGridMenu(block, index, kind, position, anchor) {
  closeSprintMenu();
  Object.assign(gridMenu, {
    items: gridMenuItems(block, kind, position),
    selected: 0,
    open: true,
    block,
    index,
    anchor,
  });
  renderGridMenu();
  // While it is up it owns the keyboard. Capturing, so Esc closes the menu rather
  // than reaching the handler that closes the fortnight drawer behind it.
  document.addEventListener("keydown", gridMenuKey, true);
  document.addEventListener("mousedown", gridMenuOutside, true);
}

function renderGridMenu() {
  if (!gridMenu.node) {
    // On `body`, like the insert menu: the block it belongs to sits in a column
    // that scrolls and clips, and a menu cut off by its own table is worse than
    // one positioned by hand.
    gridMenu.node = element("div", "sprint-menu grid-menu");
    document.body.appendChild(gridMenu.node);
  }
  const node = gridMenu.node;
  node.innerHTML = "";

  gridMenu.items.forEach((item, position) => {
    const row = element("div", "sprint-menu-item", item.label);
    row.setAttribute("aria-selected", position === gridMenu.selected ? "true" : "false");
    if (item.disabled) row.setAttribute("aria-disabled", "true");
    // `mousedown` with the default prevented, so the click never blurs its way
    // through the outside-click listener before it is handled.
    row.onmousedown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      pickGridMenuItem(position);
    };
    node.appendChild(row);
  });

  // Against the grip, every time: the arrow keys re-render, and measuring the menu
  // instead would walk it down the page one press at a time.
  const box = gridMenu.anchor.getBoundingClientRect();
  node.style.left = `${box.left + window.scrollX}px`;
  node.style.top = `${box.bottom + window.scrollY + 4}px`;
  node.hidden = false;
}

function gridMenuKey(event) {
  const count = gridMenu.items.length;
  const move = (step) => {
    gridMenu.selected = (gridMenu.selected + step + count) % count;
    renderGridMenu();
  };
  if (event.key === "ArrowDown") move(1);
  else if (event.key === "ArrowUp") move(-1);
  else if (event.key === "Enter") pickGridMenuItem(gridMenu.selected);
  else if (event.key === "Escape") closeGridMenu();
  else return;
  event.preventDefault();
  event.stopPropagation();
}

function gridMenuOutside(event) {
  if (!gridMenu.node.contains(event.target)) closeGridMenu();
}

function closeGridMenu() {
  gridMenu.open = false;
  if (gridMenu.node) gridMenu.node.hidden = true;
  document.removeEventListener("keydown", gridMenuKey, true);
  document.removeEventListener("mousedown", gridMenuOutside, true);
}

function pickGridMenuItem(at) {
  const item = gridMenu.items[at];
  const { block, index } = gridMenu;
  closeGridMenu();
  if (!item || item.disabled) return;
  const [r, column] = item.run();
  applyGridChange(block, index, r, column);
}

function sprintTableTools(block, index) {
  const grid = block.table;
  const tools = element("div", "sprint-table-tools");

  const change = (apply) => () => {
    apply();
    tableEdited(block);
    renderSprintDocument();
  };

  // Append only. `− Row` and `− Column` used to sit here and popped the last one;
  // deleting is a grip-menu job now, where you can say *which*. Adding at the end
  // stays because it is the common case and because an empty table has no row grip
  // to open a menu on.
  tools.append(
    gridButton("+ Row", change(() => insertGridRow(block, grid.rows.length))),
    gridButton("+ Column", change(() => insertGridColumn(block, grid.head.length))),
    element("span", "sprint-table-note",
      "Tab moves · paste from a spreadsheet fills the grid · ⠿ moves a row or column"),
  );
  return tools;
}

function gridButton(label, onclick, disabled = false) {
  const button = element("button", "grid-btn", label);
  button.type = "button";
  button.disabled = disabled;
  button.onclick = onclick;
  return button;
}

function focusSprintCell(index, r, column) {
  const doc = $("sprint-document");
  const block = doc.children[index];
  const cell = block && block.querySelector(`input[data-r="${r}"][data-c="${column}"]`);
  if (cell) {
    cell.focus();
    cell.select();
  }
}

// A grid edit leaves `raw` stale until the save regenerates it, so the block is
// flagged rather than re-serialised here -- there is no markdown in this file.
function tableEdited(block) {
  block.tableEdited = true;
  scheduleSprintSave();
}

// Every flagged table becomes markdown again before the file is joined. Done at
// save time rather than on each keystroke: one request per debounce, not per
// character, and the file can never be written with a stale table in it.
async function serialiseEditedTables() {
  for (const block of state.sprint.blocks) {
    if (!block.tableEdited) continue;
    const fresh = (await api("/api/sprints/table", {
      method: "POST",
      body: JSON.stringify(block.table),
    })).blocks[0];
    if (!fresh) continue;
    // `raw` and `html` come from the server; `table` stays the live grid, so a
    // cell being typed into is not overwritten underneath the cursor.
    block.raw = fresh.raw;
    block.html = fresh.html;
    block.tableEdited = false;
  }
}

// One edited box can become several blocks (paste three paragraphs), change type
// (type `## ` in front), or none at all (delete the lot). The server re-splits
// it, because the splitter is the same one that read the file.
async function commitSprintBlock(index, text) {
  const sprint = state.sprint;
  const original = sprint.blocks[index];
  const number = sprint.number;
  closeSprintMenu();
  sprint.editing = null;
  sprint.draft = null;

  if (!original || text === original.raw) {
    renderSprintDocument();
    return;
  }

  let fresh;
  try {
    fresh = (await api("/api/sprints/split", {
      method: "POST",
      body: JSON.stringify({ text }),
    })).blocks;
  } catch (failure) {
    // Keep what was typed on screen and say why it did not take. Throwing the
    // text away because a localhost fetch failed would be the worse bug.
    sprint.editing = index;
    sprint.draft = text;
    sprint.status = "failed";
    sprint.error = failure.message;
    renderSprintStatus();
    renderSprintDocument();
    return;
  }

  // A different file was opened while the split was in flight, so this edit
  // belongs to a document that is no longer on screen.
  if (sprint.number !== number) return;

  // `gap` is document structure, not block content: whatever the edit turned
  // into, what separated this block from the next one still separates them.
  if (fresh.length) fresh[fresh.length - 1].gap = original.gap;
  sprint.blocks.splice(index, 1, ...fresh);
  sprint.blocks.forEach((block, position) => { block.index = position; });

  renderSprintDocument();
  scheduleSprintSave();
}

// --- saving -----------------------------------------------------------------

// The mirror of `markdown.join_blocks`, and the reason a save is exact rather
// than nearly exact: the separator is the one the file already had, not "\n\n".
function joinSprintBlocks(blocks) {
  return blocks.map((block) => block.raw + (block.gap ?? "\n\n")).join("");
}

function scheduleSprintSave() {
  const sprint = state.sprint;
  // Nothing is written over a file that changed on disk, including by a timer.
  if (sprint.status === "conflict" || sprint.number === null) return;
  clearTimeout(sprintSaveTimer);
  sprint.status = "dirty";
  renderSprintStatus();
  sprintSaveTimer = setTimeout(saveSprint, SPRINT_SAVE_DEBOUNCE_MS);
}

async function saveSprint() {
  const sprint = state.sprint;
  if (sprint.number === null || sprint.status === "conflict") return;
  clearTimeout(sprintSaveTimer);

  const number = sprint.number;
  sprint.status = "saving";
  renderSprintStatus();

  try {
    // Grids become markdown first, so what is joined below is never stale.
    await serialiseEditedTables();
    if (sprint.number !== number) return;
    const text = joinSprintBlocks(sprint.blocks);
    const saved = await api(`/api/sprints/${number}`, {
      method: "PUT",
      body: JSON.stringify({ text, mtime: sprint.mtime }),
    });
    // The file may have been switched while the write was in flight.
    if (sprint.number !== number) return;
    sprint.mtime = saved.mtime;
    sprint.status = "saved";
    sprint.error = "";
  } catch (failure) {
    if (sprint.number !== number) return;
    // 409: someone else -- you, in an editor -- wrote the file since it was
    // read. Autosaving stops here and the mtime is deliberately **not** updated
    // to the disk value: doing that would arm the next save to overwrite the
    // very change this refused to.
    sprint.status = failure.status === 409 ? "conflict" : "failed";
    sprint.error = failure.message;
  }
  renderSprintStatus();
  if (sprint.status === "saved") await refreshSprintFiles();
}

// The picker names every file by its **first line**, so renaming a sprint's
// heading left the File list showing the old name until you left the tab and came
// back -- `loadSprints` was the only thing that re-read it. One localhost query per
// landed save, which is the same trade `loadPlan` makes to retag a project badge.
//
// **Only the picker is redrawn.** Re-rendering the document here would rebuild a
// block you may still be typing in, and Chrome fires `blur` on a focused element
// that gets removed -- the trap `renderSprintDocument` documents. Nor is
// `sprint.mtime` touched: the save guard is the value the `PUT` quoted back, and
// adopting the one off this listing would arm the next save against a different
// read of the file.
async function refreshSprintFiles() {
  const number = state.sprint.number;
  let files;
  try {
    files = (await api("/api/sprints")).slice().reverse();   // newest first
  } catch (failure) {
    return;   // The save landed. A label one edit out of date is not a failure.
  }
  if (state.sprint.number !== number) return;
  state.sprint.files = files;
  renderSprintPicker();
  // Editing the dates in a heading is the one way an overlap can still arrive, and
  // this is the moment it lands on disk -- so the warning appears with the save
  // that caused it rather than the next time the tab is opened.
  renderSprintOverlaps();
}

function renderSprintStatus() {
  const sprint = state.sprint;
  const bar = $("sprint-status");
  bar.innerHTML = "";
  bar.className = `save-state save-${sprint.status}`;
  bar.appendChild(element("span", null, SPRINT_STATUS_TEXT[sprint.status] || ""));

  if (sprint.status === "failed") {
    const retry = element("button", "save-action", "Retry");
    retry.onclick = saveSprint;
    bar.append(element("span", "muted", sprint.error), retry);
  }

  if (sprint.status === "conflict") {
    const reload = element("button", "save-action", "Reload from disk");
    reload.onclick = async () => {
      if (!confirm(`${sprint.name} changed on disk. Reload it and lose the edits `
        + "this page has not saved?")) return;
      await loadSprintFile(sprint.number);
      renderSprintView();
    };
    bar.append(element("span", "muted", sprint.error), reload);
  }
}

function sprintHasUnsavedWork() {
  return SPRINT_UNSAVED.has(state.sprint.status);
}

// Autosave makes this rare, and rare is exactly when it matters: a failed save
// or a conflict is unsaved work that no timer is going to clear.
window.addEventListener("beforeunload", (event) => {
  if (!sprintHasUnsavedWork()) return;
  event.preventDefault();
  event.returnValue = "";
});
