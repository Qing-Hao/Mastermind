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

// Where the caret goes on the next render, when the end of the box is the wrong
// answer -- splitting a line puts it at the head of the new one, merging two puts
// it at the join. Read and cleared by `renderSprintDocument`, so it is a request
// for one render and never a setting.
let sprintCaret = null;

// The two shapes an open editor can be: a `contenteditable` for prose, a textarea
// where the source is the content. Named once because three things ask "what is
// open" -- the blur guard, the focus pass and a row's own click.
const SPRINT_EDITING = ".sprint-raw, .sprint-inline";

// The one openable file that is not a sprint: `templates/sprint.md`, which every
// sprint file is a copy of. It stands where a number stands, because the editor
// only ever needed a *key* to say which file is open -- a string cannot collide
// with one, and it survives `select.value` and the width store untranslated.
//
// **It is not in `sprint.files`**, deliberately: that list is what the picker,
// the overlap check and `latestSprintHandover` read, and the template has no
// fortnight to contribute to any of them.
const TEMPLATE_KEY = "template";
const TEMPLATE_LABEL = "templates/sprint.md · the template a new sprint copies";

const isTemplate = (key) => key === TEMPLATE_KEY;

// Where a key reads and writes. The template has its own pair of routes rather
// than a number, since it lives outside `sprints/` and has none.
const sprintEndpoint = (key) =>
  (isTemplate(key) ? "/api/template" : `/api/sprints/${key}`);

// A `<select>` hands back strings. Everything else here compares a key with
// `===`, so a sprint number has to come back a number.
const sprintFileKey = (value) => (isTemplate(value) ? TEMPLATE_KEY : Number(value));

// --- loading ----------------------------------------------------------------

// Refresh the picker, and open a file only if none is open. A tab switch must
// not re-read the document: an edit committed a moment ago may still be in the
// debounce window, and re-reading would throw it away.
async function loadSprints() {
  const sprint = state.sprint;
  sprint.files = (await api("/api/sprints")).slice().reverse();  // newest first

  // The template is open on its own account and is in no listing, so a refresh
  // must not decide nothing is open and pull a sprint file over the top of it.
  const open = isTemplate(sprint.number)
    || sprint.files.some((file) => file.number === sprint.number);
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
  const payload = await api(sprintEndpoint(number));
  clearTimeout(sprintSaveTimer);
  Object.assign(state.sprint, {
    // The template answers with no number of its own -- it has none -- so the key
    // asked for is the key kept.
    number: isTemplate(number) ? TEMPLATE_KEY : payload.number,
    name: payload.name,
    blocks: payload.blocks,
    mtime: payload.mtime,
    status: "clean",
    error: "",
    editing: null,
    editingLine: null,
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
    status: "clean", error: "", editing: null, editingLine: null, draft: null,
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
  // The panel beside the document. It lives in app.js because it reads the
  // **roadmap** -- this file still knows nothing about one, and nothing about a
  // sprint beyond its number and the dates in its first line.
  renderSprintScope();
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

  // Last, and always: the template is not a fortnight, so it belongs after every
  // file rather than in the newest-first order they are sorted by. It is a row
  // here as well as a button so that leaving it is the same gesture as reaching
  // any other file -- and so `select.value` has something to be while it is open.
  const template = element("option", null, TEMPLATE_LABEL);
  template.value = TEMPLATE_KEY;
  select.appendChild(template);

  if (sprint.number !== null) select.value = sprint.number;

  // The list is never empty now, so what hides it is having no *sprint* to pick:
  // the button beside it is the way to the template in that state.
  const none = sprint.files.length === 0;
  select.hidden = none;
  $("sprint-empty").hidden = !none;
  // The two views are of whatever is open, which may be the template with no
  // sprint file on disk at all.
  $("sprint-view-switch").hidden = sprint.number === null;
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
//
// The date box is **prefilled from the newest file's end date** -- see
// `latestSprintHandover`. That is the file listing, not the roadmap, so the first
// rule above still holds.
function renderSprintNew() {
  const input = $("sprint-new-start");
  // Only when it is empty: this runs on every render, and rewriting the box would
  // undo a fortnight you had just picked. `createSprintFile` empties it on a
  // landed create, which is what re-offers the *new* handover day.
  if (!input.value) {
    input.value = latestSprintHandover() ?? formatDate(new Date());
  }
}

// The day the sprint on disk hands over, which is the day the next one starts --
// `sprint_window` ends a sprint on its successor's first day. So the newest file's
// end date is the offer, and pressing the button continues the cadence.
//
// `null` when there is nothing to read: a heading edited into something with no
// window has no cadence to continue, and guessing one is what
// `sprint_window_from_heading` refuses to do on the server for the same reason.
function latestSprintHandover() {
  // `files` is newest first, so [0] is the highest number on disk -- the same
  // reading `next_sprint_number` uses to decide what the next file is called.
  const latest = state.sprint.files[0];
  return latest?.window?.end ?? null;
}

// The window start the drawer files its own creations under, worked out here
// rather than read back off the response because it has to be known *before* the
// post to know not to post. **Nothing is snapped** -- the server takes the date
// as given, so this is the date as given.
function sprintFortnightStart(value) {
  return value || formatDate(new Date());
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
    // Emptied so the next render offers the handover day of the file just made,
    // rather than leaving the date you already used sitting in the box.
    input.value = "";
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
  // Nothing open, rather than no sprint files: the template opens with none.
  const none = sprint.number === null;

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
  sprint.editingLine = null;
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
  const leaving = doc.querySelector(SPRINT_EDITING);
  if (leaving) leaving.onblur = null;
  doc.innerHTML = "";

  sprint.blocks.forEach((block, index) => {
    const row = element("div", "sprint-row");
    row.appendChild(sprintRail(block, index, row));

    // A table is edited as a grid and never as raw pipes, so it has no reveal
    // gesture at all -- the cells *are* the editor. A list and a quote are the same
    // answer to the same problem one dimension down: their marker is on every line,
    // and a checkbox is an element, so the line it sits on cannot be a box.
    // Everything else is one surface: prose drawn as itself, source where the
    // source is the content.
    if (block.type === "table" && block.table) {
      row.appendChild(sprintTable(block, index));
    } else if (block.type === "list" || block.type === "quote") {
      row.appendChild(sprintList(block, index));
    } else {
      row.appendChild(index === sprint.editing
        ? sprintEditor(block, index)
        : sprintBlock(block, index));
    }
    doc.appendChild(row);
  });

  // The foot of the document, and the only way to start a block at the end of a
  // file. It used to appear at `blocks.length === 0` alone, which left **a file
  // ending in a table with no gesture anywhere that adds a block after it**: a
  // table has no textarea, so the `Enter` that opens the next block cannot
  // happen, and `Tab` off the last cell grows a row instead of leaving. Fixing
  // the class rather than the instance -- the target is always there, and it
  // never learns what a table is.
  if (sprint.number !== null) {
    const empty = sprint.blocks.length === 0;
    const foot = element("p", `sprint-placeholder${empty ? "" : " sprint-foot"}`,
      empty ? "Empty file — click to start typing." : "+ Start a block");
    foot.title = "Add a block at the end of the file";
    foot.tabIndex = 0;
    foot.onclick = () => (empty ? startSprintBlock() : appendSprintBlock());
    foot.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (empty) startSprintBlock(); else appendSprintBlock();
    };
    doc.appendChild(foot);
  }

  // An input outside the document cannot take focus, so this happens after the
  // append rather than inside `sprintEditor` -- the same order `renderPhases`
  // needs for the deliverable adder.
  // Read and cleared whether or not there is a box to put it in: a caret asked
  // for by an edit belongs to that edit's render and to no later one.
  const wanted = sprintCaret;
  sprintCaret = null;

  // The end of the surface, unless an edit asked for somewhere else -- a merged line
  // wants the caret at the join, not past what the join produced.
  const area = doc.querySelector(SPRINT_EDITING);
  if (area && area.value === undefined) {
    area.focus();
    setInlineCaret(area, wanted === null ? Infinity : Math.max(0, wanted));
  } else if (area) {
    area.focus();
    const at = wanted === null
      ? area.value.length
      : Math.max(0, Math.min(wanted, area.value.length));
    area.setSelectionRange(at, at);
    autosizeSprintArea(area);
  }

  // Cells need no measuring pass: a fresh render draws every one of them as a
  // view, which is an ordinary block element that sizes itself. Only the cell you
  // are actually in is a textarea, and `editSprintCell` measures it once it is in
  // the document.

  // Also after the append, and for the same reason: a diagram is measured text,
  // and a detached node has no measurements.
  drawSprintDiagrams(doc);
}

function sprintBlock(block, index) {
  const node = element("div", `sprint-block sprint-${block.type}`);
  node.innerHTML = block.html;
  node.tabIndex = 0;
  // Not "to edit the markdown" any more: a heading opens as its own text at its
  // own size, and only the types with nothing to hoist show their source.
  node.title = "Click to edit";
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

// --- inline, drawn as itself --------------------------------------------------

// **The surface you type prose into draws its own markdown.** `**bold**` becomes
// bold as the closing marker lands, `Ctrl`+`B` wraps a selection, and neither the
// asterisks nor the tags are ever in the box.
//
// This is the half of one-way editing a textarea cannot do at all: a textarea's
// content is characters, so nothing can be *drawn* inside it. The surface is a
// `contenteditable`, and that brings one obligation with it -- **the DOM has to be
// writable back to markdown**, which is what `inlineMarkdown` is.
//
// The discipline that keeps that honest is the grid's, already stated in
// `renderCellInline`: **the inventory of what can be drawn is the inventory of what
// can be written back.** `inlineMarkdown` is that renderer's inverse and must stay
// its inverse -- a construct added to one goes into the other in the same commit.
//
// What this costs, stated plainly because it is the one thing here that widens a
// documented invariant: `markdown.py` promises prose is never rewritten, with a
// table's grid as the single exception. A block you **type in** now joins that
// exception -- its inline source is written back from the DOM, so `<b>x</b>` typed
// by `Ctrl`+`B` comes back `**x**`. Blocks you never touch are untouched, and the
// splitter's own round trip is unaffected.
//
// What does **not** change, and is the reason the cost is narrow: anything this
// renderer does not know stays a plain text node and is written back character for
// character. `_em_`, an image, a footnote, a raw `<span>` -- all pass straight
// through. Only constructs it actually draws can be respelled, and it draws each of
// them in the same spelling it reads.

// The tags that can be re-derived from the DOM, and the markdown to wrap them in.
// `b`/`i`/`u`/`strike` are here because that is what `execCommand` produces; the
// file gets one spelling of each either way.
const INLINE_WRAP = {
  STRONG: "**", B: "**",
  EM: "*", I: "*",
  DEL: "~~", S: "~~", STRIKE: "~~",
};

// Underline has no markdown, so it is written as the HTML the file already relies
// on -- `templates/sprint.md` puts `<u>` around deliverable headings, which is why
// `markdown.py` renders with `html=True`. See the note there before "fixing" it.
const INLINE_UNDERLINE = ["<u>", "</u>"];

// Every tag `inlineMarkdown` knows how to write. A node with a tag outside this
// set is a rule's own widget: it cannot be re-derived, so it carries its source.
const INLINE_KNOWN = new Set(
  [...Object.keys(INLINE_WRAP), "U", "CODE", "A", "BR"]);

// A node whose insides cannot be re-derived carries the markdown it was built
// from, and is not editable. The deliverable chip is the case: one span holding a
// tick, an arrow and a label, none of which is the `D-42` that produced it.
//
// **Structural constructs are deliberately left unmarked.** A `<strong>` is
// re-derived from its tag, so it stays editable -- recording `**bold**` on it would
// mean typing inside the bold run left the old source behind, and the file would
// keep the word you had just deleted.
function markInlineSource(node, source) {
  if (node.nodeType !== 1 || INLINE_KNOWN.has(node.tagName)) return;
  node.dataset.md = source;
  node.contentEditable = "false";
}

// What a run of text is worth in the file. Two characters the surface puts there
// itself never reach it: the non-breaking space a `contenteditable` writes when you
// type two spaces -- which is not the character you typed -- and the caret anchor
// below. Nothing else is touched, and in particular nothing is escaped: what is in
// the file is what is on the screen.
const inlineText = (value) => String(value)
  .replace(/\u00a0/g, " ")
  .replace(/\u200b/g, "");

// The DOM back to markdown. Takes anything with `childNodes`, so a cloned range
// works as well as an element.
function inlineMarkdown(host) {
  let out = "";
  for (const child of host.childNodes) out += inlineNodeMarkdown(child);
  return out;
}

function inlineNodeMarkdown(node) {
  if (node.nodeType === 3) return inlineText(node.nodeValue);
  if (node.nodeType !== 1) return "";

  // A widget's recorded source wins over anything structural: it is the only thing
  // that knows what those children were written as.
  const recorded = node.dataset && node.dataset.md;
  if (recorded !== undefined && recorded !== null) return recorded;

  const tag = node.tagName;
  if (tag === "BR") return "\n";
  // A fence cannot live inline, so the content of a `code` is literal by
  // definition -- `textContent`, not a recursion.
  if (tag === "CODE") return `\`${inlineText(node.textContent)}\``;
  if (tag === "U") return `${INLINE_UNDERLINE[0]}${inlineMarkdown(node)}${INLINE_UNDERLINE[1]}`;
  if (tag === "A") {
    const label = inlineMarkdown(node);
    const href = node.getAttribute("href") || "";
    // `[](url)` renders its own url as the label, so an unfilled link written by
    // the menu round-trips as what it was rather than gaining a label.
    return label === href ? `[](${href})` : `[${label}](${href})`;
  }

  const wrap = INLINE_WRAP[tag];
  const inner = inlineMarkdown(node);
  // An unknown tag with no recorded source keeps its text and loses its tag. That
  // is the safe direction: a `<div>` Chrome slipped in is not content.
  return wrap ? `${wrap}${inner}${wrap}` : inner;
}

// Markdown typed into an inline surface, applied as its closing marker lands.
// Every rule is anchored at the caret and mirrors one `CELL_INLINE` rule.
//
// Order matters twice over. Code first, because whatever is inside backticks is
// literal. Bold before italic, because `**x*` must not italicise mid-word -- and
// `keep` is the second half of that guard: the character before the opening `*` is
// matched so it can be checked, then left where it was.
const INLINE_TYPED = [
  { mark: /`([^`\n]+)`$/, render: (found) => cellCode(found[1]) },
  { mark: /\*\*([^\s*](?:[^*]*[^\s*])?)\*\*$/, render: (found) => cellSpan("strong", found[1]) },
  { mark: /~~([^\s~](?:[^~]*[^\s~])?)~~$/, render: (found) => cellSpan("del", found[1]) },
  {
    mark: /(^|[^*])\*([^\s*](?:[^*]*[^\s*])?)\*$/,
    render: (found) => cellSpan("em", found[2]),
    keep: 1,
  },
  { mark: /\[([^\]\n]*)\]\(([^()\s]+)\)$/, render: (found) => cellLinkNode(found[1], found[2]) },
];

// **Chrome takes the style of what you type next from what is behind the caret**,
// so a caret parked straight after a fresh `<strong>` keeps typing bold -- the
// construct you just closed swallows the rest of the sentence, which is exactly what
// `say **this** now` coming out as `say **this now**` was. The fix is a zero-width
// space outside the element for the caret to sit in.
//
// Nothing downstream ever sees it: `inlineNodeMarkdown` strips it on the way to the
// file, the surface is rebuilt from markdown the moment it is left, and a Backspace
// aimed at it takes it out first so the key never feels dead.
const INLINE_ANCHOR = "\u200b";

// Fired from `input`. Only the caret's own text node can hold a construct that has
// just completed, and only the part of it before the caret -- so that is all this
// reads, and a surface with a hundred words in it costs nothing per keystroke.
function applyInlineTyped(host) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return false;
  const caret = selection.getRangeAt(0);
  const node = caret.endContainer;
  if (node.nodeType !== 3 || !host.contains(node)) return false;

  const at = caret.endOffset;
  const before = node.nodeValue.slice(0, at);
  for (const rule of INLINE_TYPED) {
    const found = rule.mark.exec(before);
    if (!found) continue;
    const built = rule.render(found);
    if (!built) continue;

    // Split the text node at the construct, drop the characters, put the element
    // where they were, and leave the caret in an anchor of its own after it.
    const from = found.index + (rule.keep ? found[rule.keep].length : 0);
    const tail = node.splitText(from);
    tail.nodeValue = tail.nodeValue.slice(at - from);
    const anchor = document.createTextNode(INLINE_ANCHOR);
    node.parentNode.insertBefore(built, tail);
    node.parentNode.insertBefore(anchor, tail);

    const after = document.createRange();
    after.setStart(anchor, INLINE_ANCHOR.length);
    after.collapse(true);
    selection.removeAllRanges();
    selection.addRange(after);
    return true;
  }
  return false;
}

// The caret as a count of characters from the start of the surface -- **rendered**
// characters, not markdown ones, because what a person sees is what the count is
// of. Survives the surface being rebuilt around it, which a node and an offset do
// not.
function inlineCaret(host) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return 0;
  const caret = selection.getRangeAt(0);
  if (!host.contains(caret.endContainer)) return 0;
  const upto = document.createRange();
  upto.setStart(host, 0);
  upto.setEnd(caret.endContainer, caret.endOffset);
  return upto.toString().length;
}

// The count lands **between** two nodes as often as inside one, and which side of
// them the caret goes is not a detail: in front of a `<strong>` and inside it are
// the same place on screen and two different things to type into. Two rules settle
// it, and the elements are walked as well as the text so they can be applied.
//
//   - A tie goes to the node already passed, which keeps a caret at the end of a
//     word out of the emphasis that starts after it.
//   - Unless what stands between is drawn but holds no text of its own -- a line's
//     marker in a cell. That belongs on the far side of the caret, or typing at the
//     head of a list line would put the character in front of its own bullet.
function setInlineCaret(host, at) {
  const selection = window.getSelection();
  const place = (node, offset) => {
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let seen = 0;
  let ended = null;    // the text node the count ended exactly at, if any
  let marker = false;  // ...and whether something drawn stands after it

  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    if (node.nodeType === 1) {
      if (ended && !node.textContent) marker = true;
      continue;
    }
    if (seen === at && ended && !marker) {
      place(ended, ended.nodeValue.length);
      return;
    }
    if (seen + node.nodeValue.length > at) {
      place(node, at - seen);
      return;
    }
    seen += node.nodeValue.length;
    if (seen === at && !ended) ended = node;
  }
  if (ended && !marker) {
    place(ended, ended.nodeValue.length);
    return;
  }
  // Past the end, or a marker was the last thing drawn: the end of the surface.
  const range = document.createRange();
  range.selectNodeContents(host);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

// The surface's markdown either side of the caret. **Cloned rather than sliced**,
// because a caret inside a bold run has to leave both halves bold -- which a range
// does for free and a string split cannot do at all.
function inlineHalves(host) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return { before: inlineMarkdown(host), after: "" };
  const caret = selection.getRangeAt(0);
  if (!host.contains(caret.endContainer)) return { before: inlineMarkdown(host), after: "" };

  const before = document.createRange();
  before.setStart(host, 0);
  before.setEnd(caret.endContainer, caret.endOffset);
  const after = document.createRange();
  after.setStart(caret.endContainer, caret.endOffset);
  after.setEnd(host, host.childNodes.length);
  return {
    before: inlineMarkdown(before.cloneContents()),
    after: inlineMarkdown(after.cloneContents()),
  };
}

// --- a surface as markdown, with a place in it -------------------------------

// Some rules are easier to state about the **string** than about the DOM: "continue
// the list on this line", "indent from here", "put `**` where the `/bold` was". They
// were written against a textarea's `value` and `selectionStart`, and they are still
// the clearest way to say what they say.
//
// So an inline surface can be read as one: `inlineSurface` gives its markdown and
// where the caret is **in that markdown**, and `writeInlineSurface` puts a new string
// back with the caret at an offset into it. Between those two, a rule can go on doing
// string surgery and know nothing about ranges.

// A character no file can contain, stood at the caret so its position can be read
// off the serialised text. `data-md` is copied verbatim by `inlineNodeMarkdown`,
// which is what makes the flag survive serialisation without being interpreted.
const INLINE_FLAG = "\u0000";

// Where the caret is in the surface's markdown. Found by standing a flag there and
// serialising rather than by counting characters, so it **cannot disagree** with
// `inlineMarkdown` -- it is `inlineMarkdown`. The opening marker of a construct the
// caret sits inside is therefore counted and its closing one is not, which is
// exactly where a typed character would land.
function inlineCaretInMarkdown(host) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return -1;
  const caret = selection.getRangeAt(0).cloneRange();
  if (!host.contains(caret.endContainer)) return -1;

  const flag = element("span");
  flag.dataset.md = INLINE_FLAG;
  caret.collapse(false);
  caret.insertNode(flag);
  const text = inlineMarkdown(host);
  flag.remove();
  // `insertNode` splits the text node it landed in; joining them back leaves the
  // surface exactly as it was found.
  host.normalize();
  return text.indexOf(INLINE_FLAG);
}

// The surface as a rule wants to see it: its markdown, and the caret's place in it.
function inlineSurface(host) {
  const at = inlineCaretInMarkdown(host);
  const text = inlineMarkdown(host);
  return { text, at: at < 0 ? text.length : at };
}

// The other direction: draw this markdown and put the caret at this offset into it.
// The offset is a **markdown** one, converted here, so a caller never has to know
// that `**bold**` is eight characters in the file and four on the screen.
function writeInlineSurface(host, text, at) {
  const draw = host.inlineRender || renderCellInline;
  host.innerHTML = "";
  draw(host, text);
  setInlineCaret(host, inlineLength(text.slice(0, Math.max(0, at)), draw));
}

// Everything in the surface, selected -- what `textarea.select()` was.
function selectInline(host) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(host);
  selection.removeAllRanges();
  selection.addRange(range);
}

// The shortcuts, and why `execCommand`: it is deprecated, and it is also the only
// thing that wraps a selection spanning element boundaries correctly. This is a
// localhost tool driven in one browser, so the trade is worth making. `styleWithCSS`
// off is load-bearing -- with it on the browser writes `<span style>`, which is not
// markdown and would be serialised away as plain text.
const INLINE_COMMAND = { b: "bold", i: "italic", u: "underline" };
let inlineCommandsReady = false;

function inlineCommandKey(event) {
  if (!(event.ctrlKey || event.metaKey)) return false;
  const key = event.key.toLowerCase();
  const command = event.shiftKey ? (key === "x" ? "strikeThrough" : null) : INLINE_COMMAND[key];
  if (!command) return false;

  event.preventDefault();
  if (!inlineCommandsReady) {
    document.execCommand("styleWithCSS", false, false);
    inlineCommandsReady = true;
  }
  document.execCommand(command);
  return true;
}

// Take the caret anchor out from behind the caret, so the browser's own Backspace
// then deletes the character the person actually meant. Without it the first
// Backspace after typing `**bold**` appears to do nothing at all.
function dropInlineAnchor(host) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || !selection.isCollapsed) return;
  const caret = selection.getRangeAt(0);
  const node = caret.endContainer;
  if (node.nodeType !== 3 || !host.contains(node)) return;

  const at = caret.endOffset;
  if (at === 0 || node.nodeValue[at - 1] !== INLINE_ANCHOR) return;
  node.nodeValue = node.nodeValue.slice(0, at - 1) + node.nodeValue.slice(at);

  const back = document.createRange();
  back.setStart(node, at - 1);
  back.collapse(true);
  selection.removeAllRanges();
  selection.addRange(back);
}

// How long a piece of markdown is once drawn -- what a caret offset into it counts.
// Measured by rendering it rather than by subtracting markers, so it cannot drift
// from what the surface actually shows. `draw` is the surface's own renderer, so a
// cell -- which draws its line markers as chrome and therefore as no characters at
// all -- is measured the way it is drawn.
function inlineLength(markdown, draw = renderCellInline) {
  const measure = element("span");
  draw(measure, markdown);
  return measure.textContent.length;
}

// One inline surface. The caller wires its own keys and its own commit; what is
// shared is the element, the typing rules, and a paste that cannot smuggle markup
// in -- a paste from a browser carries `<span style>` and `<div>`, and none of that
// is markdown.
// `draw` lets a surface bring its own renderer. Only a cell does: its lines carry
// markers, and a marker in a box you type in is the thing this editor exists to
// stop showing. Everything the surface does afterwards -- measuring a caret,
// rewriting itself -- goes through the same renderer, so the two cannot disagree.
function inlineEditable(className, markdown, onInput, draw = renderCellInline) {
  const host = element("div", `sprint-inline ${className}`);
  host.contentEditable = "true";
  host.spellcheck = false;
  host.inlineRender = draw;
  draw(host, markdown ?? "");

  host.oninput = (event) => {
    applyInlineTyped(host);
    // The event goes through because what was typed decides some rules -- a cell
    // promotes a marker on the space that finishes it, and on nothing else.
    if (onInput) onInput(event);
  };
  host.onpaste = (event) => {
    event.preventDefault();
    const text = (event.clipboardData || window.clipboardData).getData("text");
    // Through `execCommand` so the browser's own undo still knows about it.
    if (text) document.execCommand("insertText", false, text);
  };
  // A listener rather than `onkeydown`, because the caller owns that property. It is
  // registered here and therefore runs first, which is what lets the caller's own
  // "Backspace at the head of the line" see the caret where the person sees it.
  host.addEventListener("keydown", (event) => {
    if (event.key === "Backspace") dropInlineAnchor(host);
  });
  return host;
}

// --- one way: a marker is chrome, never text ---------------------------------

// **A block's own markers never appear in a box you type in.** Typing `## ` at the
// head of one converts it there and then; clicking back into the heading gives you
// its text at its own size with no `##` in front of it. A list is the same
// promise: `- ` draws a bullet, `- [ ] ` draws a real checkbox, and the characters
// are gone from the editing surface the moment they are recognised.
//
// Three things make that work for a **block's** marker, and none of them needs the
// DOM: the marker is a prefix of the raw text and is treated as one.
//
//   1. **Hoisting.** The marker is split off `raw` and drawn as chrome; the box
//      holds the rest. A commit puts the two back together, so a marker nobody
//      typed over is written back exactly as it was found -- `*` stays `*`, `1)`
//      stays `1)`, an underlined heading keeps its underline.
//   2. **Promotion.** A marker typed at the head of a box is read on every
//      keystroke and applied at once. This is the one place the editor rewrites a
//      marker, and it earns that by you having just typed one.
//   3. **A list is edited a line at a time** -- see the section below.
//
// Inline markdown is one way too, and could not be done this way at all: a marker
// in the middle of a line is not a prefix to hoist, and drawing an element where it
// stood needs a surface that can hold elements. That is the `inlineEditable`
// section above, and its cost -- a block you type in has its inline source written
// back from the DOM -- is stated there. A table cell is the same surface with its
// own renderer: see `renderCellSurface`, where a line's marker is a widget rather
// than a prefix, because a cell is one box holding several lines.

// The head of an ATX heading, and the underline of a setext one. The gap after the
// hashes is optional because `##` alone is still a heading to the splitter -- and
// it gains a space on the way back, since `##text` is not a heading at all. An
// underlined heading keeps its underline rather than being rewritten as `## `:
// changing prose the edit did not ask about is what invariant 1 forbids.
const ATX_HEAD = /^([ \t]{0,3})(#{1,6})([ \t]+|$)/;
const SETEXT_TAIL = /\r?\n[ \t]{0,3}(=+|-+)[ \t]*$/;

// A heading split into what is drawn and what is typed, or null when the text is
// not one.
function hoistHeading(raw) {
  const atx = ATX_HEAD.exec(raw);
  if (atx) {
    return {
      prefix: `${atx[1]}${atx[2]}${atx[3] || " "}`,
      body: raw.slice(atx[0].length),
      suffix: "",
      level: atx[2].length,
    };
  }
  const setext = SETEXT_TAIL.exec(raw);
  if (setext) {
    return {
      prefix: "",
      body: raw.slice(0, setext.index),
      suffix: setext[0],
      level: setext[1].startsWith("=") ? 1 : 2,
    };
  }
  return null;
}

// What the box shows and how what you type gets back into the file. A heading is
// the one whole-block type with a marker worth hoisting: a quote's `>` is on every
// line, a fence's backticks *are* its content, and a paragraph has none.
function hoistBlock(block, text) {
  const raw = text ?? block.raw;
  const heading = block.type === "heading" ? hoistHeading(raw) : null;
  return heading || { prefix: "", body: raw, suffix: "", level: 0 };
}

// A marker at the head of a box, complete the moment its space is typed.
//
// Three things are deliberately not in it. A fence's content **is** source, so
// there is nothing to hoist. `---` has no space to complete. And `> ` is left out
// because a quote is the one marker on **every** line of its block: promoting it
// would re-render the document only to hand back a box with `> ` still in it,
// which is the promise broken rather than kept. A quote therefore stays what every
// block was before this: rendered at rest, its own markdown while you are in it.
const PROMOTE = /^([ \t]{0,3})(#{1,6}|[-*+]|\d{1,9}[.)])[ \t]+/;

// Apply a marker as it is typed, and land the caret in whatever the block became.
//
// The marker **replaces** what was hoisted rather than stacking in front of it, so
// `### ` typed into an `h2` means "make this an h3" -- which is what typing it
// says. Guarded on the text actually changing: a block whose marker is not hoisted
// holds its own `> ` in the box, and committing that unchanged would close the
// editor under the cursor on the first keystroke.
function promoteSprintBlock(index, typed) {
  const block = state.sprint.blocks[index];
  const found = PROMOTE.exec(typed);
  if (!block || !found) return false;

  const text = `${found[1]}${found[2]} ${typed.slice(found[0].length)}`;
  if (text === block.raw) return false;
  applySprintPromotion(index, text);
  return true;
}

// Split by the server like any other edit -- the promotion decided the marker, not
// the block type -- then reopen the box the conversion moved the typing into. A
// list is edited by the line, so that box is its first line.
async function applySprintPromotion(index, text) {
  const number = state.sprint.number;
  await commitSprintBlock(index, text);
  if (state.sprint.number !== number) return;
  const fresh = state.sprint.blocks[index];
  if (fresh) editSprintBlock(index, fresh.type === "list" ? 0 : null);
}

// Backspace at the head of an emptied hoisted block takes the *marker* off rather
// than the block out: a `## ` you have just cleared is a heading you changed your
// mind about, not a line you want gone. Local, because there is nothing for the
// splitter to say about an empty block -- and the empty paragraph it leaves is
// discarded by its own commit if you click away without typing.
function demoteSprintBlock(index) {
  const block = state.sprint.blocks[index];
  if (!block) return;
  Object.assign(block, { type: "paragraph", raw: "", html: "" });
  state.sprint.draft = null;
  renderSprintDocument();
  scheduleSprintSave();
}

// Which whole-block types are **inline content**, and so are edited as themselves.
// A fence and an HTML island are the opposite: their markup *is* the content, so
// drawing it would be deleting it, and they keep the box that shows source. A rule
// has no text at all. A list, a quote and a table are edited a line or a cell at a
// time and never reach here.
const INLINE_BLOCKS = new Set(["paragraph", "heading"]);

function sprintEditor(block, index) {
  const hoist = hoistBlock(block, state.sprint.draft);
  return INLINE_BLOCKS.has(block.type)
    ? sprintProseEditor(block, index, hoist)
    : sprintSourceEditor(block, index, hoist);
}

// A paragraph or a heading, drawn as itself while you type it. The marker is
// hoisted (see above) and the inline markdown is rendered (see `inlineEditable`),
// so **nothing in this box is a character you did not mean to read**.
function sprintProseEditor(block, index, hoist) {
  // The heading wears its own size, so clicking into one does not resize the line
  // you are reading. Sizes are `.sprint-head-raw` in style.css.
  const dressing = hoist.level ? `sprint-head-raw level-${hoist.level}` : "sprint-prose";
  const host = inlineEditable(dressing, hoist.body, () => {
    // Converted and reopened: nothing below runs against a box that is going.
    if (promoteSprintBlock(index, inlineMarkdown(host))) return;
    maybeOpenSprintMenu(host, index);
  });

  const written = () => hoist.prefix + inlineMarkdown(host) + hoist.suffix;

  host.onblur = () => {
    closeSprintMenu();
    commitSprintBlock(index, written());
  };

  host.onkeydown = (event) => {
    if (sprintMenu.open && sprintMenuKey(event)) return;
    if (inlineCommandKey(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      host.blur();
      return;
    }
    // Enter with nothing after the caret ends this block and opens an empty one
    // below -- **the only thing that makes the insert menu reachable**, since `/`
    // needs an empty block to be typed into. With text after the caret it is a line
    // break within the block instead, and `insertLineBreak` is how that stays a
    // `<br>`: left to itself a `contenteditable` would put a `<div>` in, which is
    // not inline content and would be serialised away.
    if (event.key === "Enter") {
      event.preventDefault();
      const halves = inlineHalves(host);
      if (event.shiftKey || halves.after.trim() || !halves.before.trim()) {
        document.execCommand("insertLineBreak");
        return;
      }
      insertSprintBlockAfter(index, hoist.prefix + halves.before + hoist.suffix);
      return;
    }
    // Backspace in a block you have emptied removes it, rather than leaving a blank
    // one behind for the commit to tidy up invisibly -- unless it is wearing a
    // hoisted marker, where the marker is what you are backing over.
    if (event.key === "Backspace" && !host.textContent) {
      if (hoist.prefix || hoist.suffix) {
        event.preventDefault();
        demoteSprintBlock(index);
        return;
      }
      if (state.sprint.blocks.length > 1) {
        event.preventDefault();
        removeSprintBlock(index);
      }
    }
  };
  return host;
}

// A fence, an HTML island or a rule: the block whose source is its content. This is
// the editor every block used to have, kept for the three types where showing the
// markdown is the point rather than the problem.
function sprintSourceEditor(block, index, hoist) {
  const area = element("textarea", "sprint-raw");
  area.value = hoist.body;
  // One row before the autosize, so the box is the height of its text: a textarea's
  // default is two, and a box opening twice as tall as the line it replaces moves
  // the document under you.
  area.rows = 1;
  area.spellcheck = false;
  area.oninput = () => {
    autosizeSprintArea(area);
    // Converted and reopened: nothing below runs against a box that is going.
    if (promoteSprintBlock(index, area.value)) return;
    maybeOpenSprintMenu(area, index);
  };
  area.onblur = () => {
    // Blurring past an open menu picks nothing: what was typed is what commits,
    // which for `/tab` is a paragraph reading `/tab`. Visible and one edit away
    // from gone, where a swallowed blur leaves a box that has stopped
    // responding to anything.
    closeSprintMenu();
    commitSprintBlock(index, hoist.prefix + area.value + hoist.suffix);
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
    // below -- and **not in a fence or an island**, where a newline is a newline you
    // meant. So this is only ever a rule in practice, and it is kept because `/` on
    // the empty block it makes is how anything else gets inserted.
    if (event.key === "Enter" && !event.shiftKey
      && block.type !== "code" && block.type !== "html"
      && area.value.trim() && !area.value.slice(area.selectionEnd).trim()) {
      event.preventDefault();
      insertSprintBlockAfter(index,
        hoist.prefix + area.value.slice(0, area.selectionEnd) + hoist.suffix);
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
  sprint.editingLine = null;
  sprint.draft = null;
  renderSprintDocument();
}

// An abandoned empty block, taken back out with the file left exactly as it was
// -- which is the point, so clicking the foot target and changing your mind is
// not an edit. `appendSprintBlock` handed the file's trailing newline to the new
// block; this hands it back to whatever ends up last. A block from the middle of
// the document takes its own separator with it and nothing else moves.
function discardEmptySprintBlock(index) {
  const blocks = state.sprint.blocks;
  const gone = blocks.splice(index, 1)[0];
  if (blocks.length && index === blocks.length) blocks[blocks.length - 1].gap = gone.gap;
  blocks.forEach((block, position) => { block.index = position; });
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
  sprint.editingLine = null;
  sprint.draft = null;
  renderSprintDocument();
  scheduleSprintSave();
}

// --- a list or a quote, a line at a time -------------------------------------

// The block types whose marker is on **every line**, so hoisting it is a per-line
// job. A list was the type that could not be one way inside a textarea at all: a
// checkbox is an element and a textarea's content is text, so a box drawn in one
// cannot be hit.
// That is the wall the grid hit, and this is the same answer one dimension down --
// **every line is a view that can hold a real control, and only the line you are
// in is a box** -- with the line's own head (indent, marker, checkbox) hoisted out
// of that box.
//
// **A line's text is written straight into `block.raw` and never re-split.** That
// is the stance the grid takes about `block.table`, reached here for the grid's
// reason: a tick lands on a line whose editor is blurring, and an `await` in the
// middle of that is where a keystroke goes missing. The file stays right because
// `raw` is what a save writes; what a re-split would refresh is `html`, and a list
// draws from `raw` now, so nothing reads it.
//
// One consequence to expect, and it is the benign kind `markdown.py` describes:
// typing something into a line that would end the list -- a fence, a table -- leaves
// it inside this block until the file is reopened. What is on disk is what you
// typed either way.
//
// The inline rendering is `renderCellInline`, the grid's, deliberately: one local
// renderer, one inventory of constructs, and the same discipline that it renders
// only what a menu can insert. The file is rendered by `app/markdown.py`; where the
// two disagree the file is right and the raw pane is how you see it.

// A list line's own head: indent, marker, the gap after it, and a task box. Every
// part is kept exactly as written, so a line nobody edited is written back byte for
// byte -- `*` stays `*`, `1)` stays `1)`, two spaces stay two spaces.
const LIST_HEAD = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(?:\[([ xX])\]([ \t]+))?/;

// A quote's own `>`, read **before** the list head so `> - [ ] x` is a task inside
// a quote rather than a line of text beginning with a bracket. One level only: a
// `>>` keeps its second marker as text, which is honest about what this draws.
const QUOTE_HEAD = /^([ \t]{0,3}>[ \t]?)/;

// `[ ] ` typed at the head of a line, which is the gesture that makes it a task.
// `[]` counts: it is what typing the pair and then a space produces.
const LINE_BOX = /^\[([ xX]?)\][ \t]+/;

// A marker typed at the head of a line that has none -- inside a quote, or on a
// continuation line. The line-level twin of `PROMOTE`.
const LINE_MARKER = /^([-*+]|\d{1,9}[.)])([ \t]+)/;

// The block's lines, split into what is drawn and what is typed. A line with no
// marker of its own is a continuation of the item above it and keeps its indent.
// The line ending rides on the line, so a CRLF file stays a CRLF file.
function sprintListLines(raw, quoted) {
  return raw.split("\n").map((whole) => {
    const end = whole.endsWith("\r") ? "\r" : "";
    const bare = end ? whole.slice(0, -1) : whole;
    const quote = quoted ? (QUOTE_HEAD.exec(bare) || [""])[0] : "";
    const line = bare.slice(quote.length);

    const found = LIST_HEAD.exec(line);
    if (!found) {
      const indent = /^[ \t]*/.exec(line)[0];
      return {
        quote, indent, marker: "", gap: "", box: null, boxGap: " ",
        text: line.slice(indent.length), end,
      };
    }
    return {
      quote,
      indent: found[1],
      marker: found[2],
      gap: found[3],
      box: found[4] === undefined ? null : found[4],
      boxGap: found[5] || " ",
      text: line.slice(found[0].length),
      end,
    };
  });
}

// One line back to markdown, head and all.
function listLineText(line) {
  const marker = line.marker ? `${line.marker}${line.gap}` : "";
  const box = line.box === null ? "" : `[${line.box}]${line.boxGap}`;
  return `${line.quote || ""}${line.indent}${marker}${box}${line.text}${line.end}`;
}

const joinListLines = (lines) => lines.map(listLineText).join("\n");

// Every list edit lands here: the lines become the block's markdown and a save is
// scheduled. Nothing is re-split and nothing is rendered -- the caller knows
// whether what it changed is visible.
function writeSprintList(block, lines) {
  block.raw = joinListLines(lines);
  scheduleSprintSave();
}

const isQuoteBlock = (block) => block.type === "quote";

function sprintList(block, index) {
  const sprint = state.sprint;
  const node = element("div", "sprint-block sprint-list-block");
  // The draft is what a failed commit kept, so it is what the lines come off.
  const lines = sprintListLines(sprint.draft ?? block.raw, isQuoteBlock(block));

  lines.forEach((_, position) => {
    const editing = sprint.editing === index && sprint.editingLine === position;
    node.appendChild(sprintListRow(block, index, lines, position, editing));
  });
  return node;
}

// What the marker is drawn as. A bullet becomes a glyph by depth, the way a cell
// line's does; a number is drawn as it is written, because `1.` and `1)` are a
// choice the file made and a ramp of glyphs has nothing to say about it.
function listMarkerGlyph(line) {
  if (/^\d/.test(line.marker)) return line.marker;
  return CELL_BULLETS[Math.min(cellDepth(line.indent), CELL_BULLETS.length - 1)];
}

// --- what else a line can belong to -----------------------------------------

// **Two seams, and the same argument as `registerCellInline`:** a task line may
// be a unit of work that something outside this file already records, and this
// file must not learn what that something is. So it asks, per line, and takes
// what it is handed.
//
// An **owner** answers "this box is really about something else": it supplies the
// state to draw and takes the new one when the box is pressed. The marker in the
// file is still written -- the line keeps saying what you ticked -- but what the
// box *shows* is the owner's, because two things claiming one tick is how they
// come to disagree.
//
// An **action** is the way to give a line an owner in the first place. It is
// drawn as a press at the end of the line and is handed the line's text and a
// way to write it back; what it puts there is its own business.
//
// Both are offered a line's text and nothing else. A provider that has nothing to
// say returns null, and the line is an ordinary line.
//
// A **cell-line action** is the same seam inside a table: a cell may hold a
// checklist, and each of its lines is a unit of work in its own right. It is
// offered that one line's text and hands back that one line's text -- the cell
// around it, and the row around that, are none of its business.
const LINE_OWNERS = [];
const LINE_ACTIONS = [];
const CELL_LINE_ACTIONS = [];

function registerLineOwner(provider) {
  LINE_OWNERS.push(provider);
}

function registerLineAction(provider) {
  LINE_ACTIONS.push(provider);
}

function registerCellLineAction(provider) {
  CELL_LINE_ACTIONS.push(provider);
}

function firstOf(providers, text) {
  for (const provide of providers) {
    const found = provide(text);
    if (found) return found;
  }
  return null;
}

function sprintListRow(block, index, lines, position, editing) {
  const line = lines[position];
  const row = element("div", `sprint-line${line.quote ? " sprint-line-quote" : ""}`);
  // Indent as padding, so wrapped text hangs under the text and not under the
  // glyph -- `.sprint-cell-line`'s trick, and the same custom property shape.
  row.style.setProperty("--line-depth", cellDepth(line.indent));

  // Only a line with a box: a bullet is a note, not a unit of work, and there is
  // no tick on it for anything to own.
  const owner = line.box === null ? null : firstOf(LINE_OWNERS, line.text);

  if (line.box !== null) {
    const box = element("input", "sprint-line-todo");
    box.type = "checkbox";
    box.checked = owner ? owner.done : line.box.toLowerCase() === "x";
    box.title = owner ? owner.title : "Tick this line";
    // The one thing in a list block that is not "click here to type". The default
    // is **not** prevented, so the box you clicked is already showing its new
    // state -- there is nothing to re-render, and re-rendering here is what would
    // pull the row out from under the click that caused it.
    box.onclick = (event) => {
      event.stopPropagation();
      toggleSprintListLine(block, lines, position, box.checked, owner);
    };
    row.appendChild(box);
  } else if (line.marker) {
    row.appendChild(element("span", "sprint-line-marker", listMarkerGlyph(line)));
  }

  if (editing) {
    row.appendChild(sprintLineEditor(block, index, lines, position));
  } else {
    const label = element("span", "sprint-line-label");
    // A line with a box of its own draws no second one inside the text: the box
    // at the front is the tick, whatever the text turns out to refer to.
    renderCellInline(label, line.text, { ownTick: line.box === null });
    row.appendChild(label);
  }

  const action = line.box === null ? null : firstOf(LINE_ACTIONS, line.text);
  if (action) row.appendChild(sprintLineAction(block, index, lines, position, action));

  row.onclick = (event) => {
    // A link is there to be followed and a control to be operated, the same two
    // exceptions a cell makes.
    if (event.target.closest("a") || event.target.closest("input")
      || event.target.closest("button")) return;
    const area = row.querySelector(".sprint-line-raw");
    // Already editing: a press in the margin around the box puts you in it, and a
    // press inside it is the browser's to place the caret with.
    if (area) {
      if (event.target !== area) area.focus();
      return;
    }
    editSprintBlock(index, position);
  };
  return row;
}

// A tick is a rewrite of that line's own marker -- the stance `toggleSprintTask`
// takes, minus the round trip and minus the counting: the line is the unit here,
// so there is no nth-checkbox to find.
//
// `done` is the box's new state rather than the marker flipped, because with an
// owner the two can start out disagreeing: the marker says what the file last
// recorded and the box draws what the owner says now. Pressing it settles both on
// the same answer, which is the useful thing for a press to do.
function toggleSprintListLine(block, lines, position, done, owner) {
  lines[position].box = done ? "x" : " ";
  writeSprintList(block, lines);
  if (owner) owner.toggle(done);
}

// The press that gives a line an owner. Chrome at the end of the line, the way a
// block's grip is: `mousedown` is refused so the press does not take the caret
// out of a line you are typing in, and the write goes through `writeSprintList`
// like every other list edit.
function sprintLineAction(block, index, lines, position, action) {
  const press = element("button", "sprint-line-act");
  press.type = "button";
  press.title = action.title;
  press.textContent = action.label;
  press.onmousedown = (event) => event.preventDefault();
  press.onclick = (event) => {
    event.stopPropagation();
    action.run(press, lines[position].text, (text) => {
      lines[position].text = text;
      writeSprintList(block, lines);
      // The whole document, because what the action wrote may draw as anything --
      // this file has no idea what changed about the line beyond its text.
      renderSprintDocument();
    });
  };
  return press;
}

// The one line you are in, and it draws its own inline markdown: the difference
// between this and the label it replaces is a caret and nothing else. One line of
// the block rather than the block, because the control beside it has to stay
// clickable and a box cannot hold one.
function sprintLineEditor(block, index, lines, position) {
  // The surface brings the label's own renderer, box and all: a line whose tick is
  // drawn at the front must not grow a second one the moment you click into it.
  const draw = (node, text) =>
    renderCellInline(node, text, { ownTick: lines[position].box === null });
  const host = inlineEditable("sprint-line-raw", lines[position].text, () => {
    lines[position].text = inlineMarkdown(host);
    // A box or a bullet has to appear, which is the one thing a line edit cannot do
    // in place.
    if (promoteSprintLine(block, lines, position)) return;
    writeSprintList(block, lines);
  }, draw);

  // Back to the label, so the box beside it is clickable again. The child is
  // swapped rather than the document re-rendered: a click on another row is in
  // flight during this blur, and rebuilding the document under it is how that
  // click gets lost.
  host.onblur = () => {
    const sprint = state.sprint;
    if (sprint.editing === index && sprint.editingLine === position) {
      sprint.editing = null;
      sprint.editingLine = null;
    }
    if (!host.isConnected) return;
    const label = element("span", "sprint-line-label");
    renderCellInline(label, lines[position].text, { ownTick: lines[position].box === null });
    host.replaceWith(label);
  };

  host.onkeydown = (event) => {
    if (inlineCommandKey(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      host.blur();
      return;
    }

    // Tab nests, which is what the key means on a list line. Two spaces, the
    // step `CELL_INDENT` already chose, so a file does not end up mixing both.
    if (event.key === "Tab") {
      event.preventDefault();
      indentSprintLine(block, lines, position, event.shiftKey ? -1 : 1, host);
      return;
    }

    // Enter carries the list on: a new line below, same indent and marker,
    // unticked. On a line you have not typed into it ends the list instead --
    // the way out, and without it the only exit is deleting what Enter wrote.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (lines[position].text.trim()) splitSprintLine(block, index, lines, position, host);
      else endSprintList(block, index, lines, position);
      return;
    }

    // Backspace at the head of a line joins it to the one above, which is what
    // the key does in every editor. The first line has nothing above it: emptied,
    // it takes the block with it; typed in, it stays put.
    if (event.key === "Backspace" && inlineCaret(host) === 0
      && window.getSelection().isCollapsed) {
      if (position > 0) {
        event.preventDefault();
        mergeSprintLine(block, index, lines, position);
        return;
      }
      if (lines.length === 1 && !lines[0].text && state.sprint.blocks.length > 1) {
        event.preventDefault();
        removeSprintBlock(index);
      }
    }
  };

  return host;
}

// A marker typed at the head of a line, applied there and then -- `[ ] ` for a task
// and `- ` for a bullet, which is `PROMOTE`'s job one level down. A box only goes on
// a line that is already an item: a continuation line is not one, and a line that
// already has a box is a line you are typing text into.
function promoteSprintLine(block, lines, position) {
  const line = lines[position];
  const box = line.box === null && line.marker ? LINE_BOX.exec(line.text) : null;
  const marker = !line.marker ? LINE_MARKER.exec(line.text) : null;
  if (!box && !marker) return false;

  if (box) {
    line.box = box[1].toLowerCase() === "x" ? "x" : " ";
    line.boxGap = " ";
    line.text = line.text.slice(box[0].length);
  } else {
    [, line.marker, line.gap] = marker;
    line.text = line.text.slice(marker[0].length);
  }
  writeSprintList(block, lines);
  // The editing line has not moved, so the render reopens this same box -- with a
  // checkbox now sitting beside it and the caret back at the head of the text.
  sprintCaret = 0;
  renderSprintDocument();
  return true;
}

function indentSprintLine(block, lines, position, direction, host) {
  const line = lines[position];
  // The first line carries the block's own identity: indent it four spaces and the
  // list stops being a list. Nesting the first item means nothing anyway.
  if (direction > 0 && position === 0) return;
  if (direction > 0) line.indent += CELL_INDENT;
  else line.indent = line.indent.replace(/(?:\t| {1,2})$/, "");

  writeSprintList(block, lines);
  // Redrawn because the glyph is chosen by depth, so the bullet changes with the
  // indent. The caret keeps its place in the line rather than jumping to the end.
  sprintCaret = inlineCaret(host);
  renderSprintDocument();
}

// Enter mid-item: what is after the caret becomes the next line, carrying this
// one's indent and marker. A task carries the box across unticked -- the new item
// is not done because the one it came from was.
//
// The split is `inlineHalves`, not a string slice: a caret inside a bold run has to
// leave both halves bold, and the range knows what the string cannot.
function splitSprintLine(block, index, lines, position, host) {
  const line = lines[position];
  const halves = inlineHalves(host);
  line.text = halves.before;
  lines.splice(position + 1, 0, {
    ...line,
    box: line.box === null ? null : " ",
    text: halves.after,
  });

  writeSprintList(block, lines);
  sprintCaret = 0;
  editSprintBlock(index, position + 1);
}

// Enter on an item you have not typed into: the empty item goes, and an empty
// paragraph opens after the list for whatever comes next. The mirror of Enter
// carrying the list on, and the only way out of one that is not a mouse.
function endSprintList(block, index, lines, position) {
  lines.splice(position, 1);
  if (!lines.length) {
    // The list was that one item, so what is left is the empty paragraph itself.
    Object.assign(block, { type: "paragraph", raw: "", html: "" });
    scheduleSprintSave();
    editSprintBlock(index, null);
    return;
  }
  writeSprintList(block, lines);
  openParagraphAfter(index);
}

// Join a line to the one above it and put the caret at the join. Only ever called
// with a line above to join to.
//
// The caret is counted in **rendered** characters, because that is what
// `sprintCaret` means to an inline surface: `**bold**` is four characters on screen
// and eight in the file, and the join is where the words meet.
function mergeSprintLine(block, index, lines, position) {
  const above = lines[position - 1];
  const joined = inlineLength(above.text);
  above.text += lines[position].text;
  lines.splice(position, 1);

  writeSprintList(block, lines);
  sprintCaret = joined;
  editSprintBlock(index, position - 1);
}

// An empty paragraph after this block, opened for typing. `insertSprintBlockAfter`
// commits a box on the way; this one has nothing to commit -- the block it is
// leaving has already been written. The gaps are `appendSprintBlock`'s rule: the
// block gains a separator and the new one inherits what used to follow it.
function openParagraphAfter(index) {
  const sprint = state.sprint;
  const blocks = sprint.blocks;
  const owner = blocks[index];
  if (!owner) return;

  const at = index + 1;
  const tail = owner.gap;
  owner.gap = sprintBlankLine(blocks);
  blocks.splice(at, 0, { index: at, type: "paragraph", raw: "", gap: tail, html: "" });
  blocks.forEach((block, position) => { block.index = position; });

  sprint.editing = at;
  sprint.editingLine = null;
  sprint.draft = null;
  renderSprintDocument();
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

// --- a tickable line inside a cell ------------------------------------------

// **The one place the grid shows something other than the cell's own source.**
// It lives up here, above the table code that uses it most, because the cell
// menu below offers the marker and a `const` is not readable before it is
// initialised -- which cost one silent blank Sprint tab to find.
//
// Two spellings are recognised, and **`- [ ]` is the one that gets written** --
// the requester's call, on the ground that both draw the same box so the file may
// as well hold one thing. The glyphs are still read, because files already contain
// them and rewriting a line nobody touched is not this editor's business.
//
//   - [ ]   written and read. What a person types, and what works everywhere else
//           in a markdown file. Worth knowing rather than arguing with: **inside a
//           cell GFM treats it as literal text** — a cell is inline content and the
//           tasklists plugin only rewrites list items — so GitHub, an IDE preview
//           and `sprint_review.py`'s model all see the characters, not a box. The
//           box is this grid's affordance over ordinary text.
//   ☐ / ☑   read only. A tick on one of these keeps it a glyph: the spelling is
//           the line's, not the editor's.
//
// A tick is a rewrite of the cell's own text and nothing else. It cannot live in
// `block.raw`, the way `toggleSprintTask` writes a task list: `raw` is
// regenerated from the grid by `serialise_table` on every save, so a tick written
// there would be overwritten by the next debounce.
const TODO_OFF = "☐";
const TODO_ON = "☑";
const TODO_WRITE = "- [ ] ";
const CELL_TODO = /^([ \t]*)(☐|☑|-[ \t]+\[[ xX]\])([ \t]+|$)/;

// --- the three things a cell line can be drawn as ----------------------------

// A bullet, an indent and a highlight are the same trick the checkbox already
// is, and the trick is worth naming once: **the file holds characters and the
// grid draws an affordance over them.** `- x` in a cell is literal text to GFM
// -- a cell is inline content, so the tasklists plugin never touches it -- which
// is exactly why a bullet here costs the file nothing. Outside this grid all
// three read as what they are: a hyphen, two spaces and a coloured square.
//
// Consumed in the **view** and left alone in the textarea, which is the two-state
// contract the whole editor keeps: rendered when you are not in it, source when
// you are. So every marker stays reachable by typing.

// One level of indent. Two spaces rather than a tab: `serialise_table` pads the
// file by character count, and a tab makes the column it is in unreadable there.
const CELL_INDENT = "  ";

// •, then ◦, then ▪, by depth. The last one repeats rather than the ramp
// running out -- a fourth level is still a bullet, just not a new glyph.
const CELL_BULLETS = ["•", "◦", "▪"];
const CELL_BULLET = /^([ \t]*)([-*+])([ \t]+)/;

// **A highlight is a marker at the head of the cell**, not a property of it: one
// glyph, drawn as a tinted cell here and as a coloured square everywhere else.
// Four, because they have to be told apart at a glance and the fifth colour is
// where that stops being true.
const CELL_HIGHLIGHTS = [
  { key: "amber", label: "Highlight amber", highlight: "🟨" },
  { key: "red", label: "Highlight red", highlight: "🟥" },
  { key: "green", label: "Highlight green", highlight: "🟩" },
  { key: "blue", label: "Highlight blue", highlight: "🟦" },
];
const CELL_TINTS = new Map(CELL_HIGHLIGHTS.map((item) => [item.highlight, item.key]));
const CELL_HIGHLIGHT = new RegExp(`^(${CELL_HIGHLIGHTS.map((i) => i.highlight).join("|")})[ \\t]*`, "u");
const CELL_TINT_CLASSES = CELL_HIGHLIGHTS.map((item) => `cell-tint-${item.key}`);

// The marker at the head of a cell, or null. Read off the whole cell rather than
// per line: the tint is the cell's, and a cell is one box however many lines it
// holds.
function cellTint(text) {
  const found = CELL_HIGHLIGHT.exec(text);
  return found ? { key: CELL_TINTS.get(found[1]), length: found[0].length } : null;
}

// How deep a line's leading whitespace puts it. A tab counts as one level, since
// that is what a hand-editor's tab key put there.
const cellDepth = (indent) =>
  Math.floor(indent.replace(/\t/g, CELL_INDENT).length / CELL_INDENT.length);

// The tint rides on the `<td>` rather than on either state's element, so it
// survives the swap between them and fills the cell even when a taller cell
// beside it sets the row's height. Repainted on input, so typing the marker
// shows the colour without leaving the cell.
function paintCellHost(host, grid, r, column) {
  if (!host) return;
  host.classList.remove(...CELL_TINT_CLASSES);
  const tint = cellTint(cellText(cellValue(grid, r, column)));
  if (tint) host.classList.add(`cell-tint-${tint.key}`);
}

// --- inline markdown inside a cell ------------------------------------------

// **The second thing rendered in the browser rather than in Python**, and the
// reason is the same shape as mermaid's without being the same reason: the grid is
// a *live* client-side surface. `block.table` is the client's copy and a keystroke
// changes it, so anything drawn from it has to be drawn locally or it is stale the
// moment you type. Asking the server to render a cell would be a request per blur
// to redraw text the client already holds.
//
// It exists because the cell menu offers bold, italic, code and a link. A menu
// that inserts `**bold**` into a surface that then shows `**bold**` is a menu that
// does nothing you can see. So the view renders exactly what the menu can insert
// and **nothing else**, which is the whole discipline here: this is not a markdown
// renderer and must not grow into one. `app/markdown.py` renders the file.
//
// Deliberately not handled, and each one is a decision rather than an omission:
//
//   `_x_`      no underscore emphasis. `sprint_length_days` and
//              `default_velocity_points_per_sprint` are words this project's own
//              files are full of, and CommonMark's intraword rule is subtle enough
//              that getting it slightly wrong mangles them. Under-rendering is the
//              safe direction; markdown-it will still italicise it in the file.
//   `<u>x</u>` raw HTML stays text. The file is rendered with `html=True`, so this
//              *is* a divergence -- accepted, because a grid that executes markup
//              from a cell is a different and worse thing.
//   bare URLs  linkify is deliberately off in this app; nothing here adds it.
//
// Where the two renderings disagree, **the file is right and the raw view is how
// you see it.** That is the cost of the feature and it is worth stating out loud.
const CELL_INLINE = [
  // Code first: whatever is inside backticks is literal, so it must win before
  // anything else claims a `*` in it.
  { mark: /`([^`\n]+)`/, render: (m) => cellCode(m[1]) },
  { mark: /\*\*([^\s*](?:[^*]*[^\s*])?)\*\*/, render: (m) => cellSpan("strong", m[1]) },
  { mark: /\*([^\s*](?:[^*]*[^\s*])?)\*/, render: (m) => cellSpan("em", m[1]) },
  { mark: /\[([^\]\n]*)\]\(([^()\s]+)\)/, render: (m) => cellLinkNode(m[1], m[2]) },
];

// **The seam in the list above**, and the one thing here a caller may add to.
// `app.js` registers the deliverable chip through it, because that rule has to
// read a deliverable's tick and this file must not learn what a deliverable is.
// The rule-parity discipline is kept rather than broken by it: `registerCellMenu`
// lands beside this one, so what a caller can render it can also insert.
//
// Appended rather than inserted. `firstCellInline` gives a tie to the earlier
// rule, so a reference written inside a link stays the link it was written as.
function registerCellInline(rule) {
  CELL_INLINE.push(rule);
}

// Anything with a scheme that is not one of these is left as text rather than
// turned into a link -- `javascript:` being the reason to have the rule at all.
const CELL_URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const CELL_URL_ALLOWED = ["http", "https", "mailto"];

function cellCode(text) {
  const node = element("code");
  node.textContent = text;
  return node;
}

function cellSpan(tag, text) {
  const node = element(tag);
  renderCellInline(node, text);
  return node;
}

function cellLinkNode(label, url) {
  const scheme = CELL_URL_SCHEME.exec(url);
  if (scheme && !CELL_URL_ALLOWED.includes(scheme[1].toLowerCase())) return null;
  const node = element("a");
  node.href = url;
  renderCellInline(node, label || url);
  return node;
}

// Text in, nodes out. `textContent` for every run that is not a construct, and a
// real element for every one that is -- never `innerHTML`, so a cell holding
// `<script>` is a cell holding the characters `<script>`.
// `where` is passed through to the rules untouched, and this file never reads it:
// it is how a surface says something about itself that only the rule cares about.
// The one thing said through it so far is whether a construct drawn here has to
// carry its own checkbox, which a line with a box of its own does not.
function renderCellInline(parent, text, where) {
  let rest = String(text ?? "");
  while (rest) {
    const found = firstCellInline(rest, where);
    if (!found) break;
    if (found.at) parent.appendChild(document.createTextNode(rest.slice(0, found.at)));
    parent.appendChild(found.node);
    rest = rest.slice(found.at + found.length);
  }
  if (rest) parent.appendChild(document.createTextNode(rest));
}

// The earliest construct in the string, ties going to the earlier rule -- which is
// what puts code ahead of emphasis when both start at the same character. A rule
// that matches but declines to build a node (an unsafe URL) is skipped and the
// text it matched is left alone.
//
// Every node built here is stamped with the text it was built from, because this
// renderer also draws the surface you type into and `inlineMarkdown` has to write
// that surface back. Without the stamp a widget is written back as whatever its
// children happen to be -- the deliverable chip came back `D-42[↗](#)`, its own
// jump arrow re-derived as a markdown link, so the cell grew a second link on
// every keystroke. `markInlineSource` leaves the structural tags alone, so
// `<strong>` and a real `<a>` stay re-derived and stay editable.
function firstCellInline(text, where) {
  let best = null;
  for (const rule of CELL_INLINE) {
    const found = rule.mark.exec(text);
    if (!found || (best && found.index >= best.at)) continue;
    const node = rule.render(found, where);
    if (node) {
      markInlineSource(node, found[0]);
      best = { at: found.index, length: found[0].length, node };
    }
  }
  return best;
}

// Flip the marker on one line, in whichever spelling that line already uses. A
// line with no marker gains one, which is what makes the keyboard toggle able to
// *start* a checklist rather than only maintain one.
function flipCellTodo(line) {
  const found = CELL_TODO.exec(line);
  if (!found) return `${TODO_WRITE}${line}`;
  const [, indent, marker, trailing] = found;
  const ticked = marker === TODO_ON || /\[[xX]\]/.test(marker);
  const flipped = marker === TODO_OFF || marker === TODO_ON
    ? (ticked ? TODO_OFF : TODO_ON)
    : marker.replace(/\[[ xX]\]/, ticked ? "[ ]" : "[x]");
  return `${indent}${flipped}${trailing || " "}${line.slice(found[0].length)}`;
}

// --- a cell's own surface: a marker is chrome there too ----------------------

// **The surface you type a cell into draws its line markers instead of spelling
// them.** `- [ ] Ship` is a real checkbox and a label while your caret is in the
// cell, not six characters to be read as markdown -- the promise the document's
// list blocks make, kept in the one place that was still an exception.
//
// It is still **one surface**, not a surface per line, and that is the whole
// design: `Tab` walking the grid, a range paste filling it and the `/` menu
// finding the caret are the grid's job and each is written about one string. So
// the marker is a **widget** rather than a row -- a node carrying its own source
// in `data-md` and holding no text of its own. `inlineMarkdown` already writes
// such a node back verbatim, and having no text is what keeps a caret from
// landing inside it and keeps it worth nothing when a markdown offset is turned
// into a place on the screen.
//
// The one thing this cannot draw that the resting view can: wrapped text hanging
// under the text rather than under the glyph. The indent is a margin on the marker
// here, so a wrapped second line comes back to the left.
function renderCellSurface(parent, text) {
  String(text ?? "").split("\n").forEach((line, position) => {
    // A real newline, not a `<br>`: the surface is `pre-wrap`, so the character
    // draws the break and stays one character to every offset that counts it.
    if (position) parent.appendChild(document.createTextNode("\n"));
    const todo = CELL_TODO.exec(line);
    const marker = todo || CELL_BULLET.exec(line);
    if (marker) parent.appendChild(cellMarkerNode(marker[0], !!todo));
    renderCellInline(parent, marker ? line.slice(marker[0].length) : line);
  });
}

// One marker, drawn. The glyph is a CSS `content` rather than a text node for the
// reason above -- what is on screen is a bullet, what is in the file is `- `, and
// nothing in between may count characters twice.
function cellMarkerNode(source, todo) {
  const node = element("span", "sprint-cell-mark");
  node.dataset.md = source;
  node.contentEditable = "false";
  const depth = cellDepth(/^[ \t]*/.exec(source)[0]);
  node.style.setProperty("--cell-depth", depth);

  if (todo) {
    const box = element("input", "sprint-cell-todo");
    box.type = "checkbox";
    box.checked = /☑|\[[xX]\]/.test(source);
    box.title = "Tick this line";
    // The press must not take the caret out of the cell, or the tick would also
    // mean "done editing here" -- which is not what ticking a box says.
    box.onmousedown = (event) => event.preventDefault();
    box.onclick = (event) => {
      event.stopPropagation();
      toggleCellMarker(node);
    };
    node.appendChild(box);
  } else {
    node.classList.add("sprint-cell-mark-bullet");
    node.dataset.glyph = CELL_BULLETS[Math.min(depth, CELL_BULLETS.length - 1)];
  }
  return node;
}

// Ticking a box while you are typing in the cell. The widget's `data-md` is what
// reaches the file, so the click rewrites *that* and redraws the widget from it --
// setting `checked` alone would be a tick nothing outside the screen ever saw.
function toggleCellMarker(node) {
  const cell = node.closest(".sprint-cell");
  if (!cell) return;
  node.replaceWith(cellMarkerNode(flipCellTodo(node.dataset.md), true));
  // The cell's own `input` handler is what writes a keystroke back; a tick is a
  // change of the same kind, so it goes the same way rather than a second one.
  cell.dispatchEvent(new Event("input"));
}

// A marker typed at the head of a line becomes chrome there and then -- the cell's
// half of `promoteSprintBlock`. Only called when the character just typed was the
// marker's own gap, so the redraw happens once per marker and not once per key.
function promoteCellLine(cell) {
  const { start, line, text, at } = caretLine(cell);
  const found = CELL_TODO.exec(line) || CELL_BULLET.exec(line);
  // The caret has to be sitting at the end of the marker: further along the line
  // and this is a space in a sentence, not a marker that has just landed.
  if (!found || at !== start + found[0].length) return false;
  writeInlineSurface(cell, text, at);
  return true;
}

// `Backspace` against a marker takes the marker off. There is no character in
// front of the caret to delete -- the marker is chrome -- so without this the key
// would either do nothing or hand the browser a non-editable node to argue with.
function dropCellMarker(cell, block, r, column) {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed) return false;
  const { start, line, text, at } = caretLine(cell);
  const found = CELL_TODO.exec(line) || CELL_BULLET.exec(line);
  if (!found || at !== start + found[0].length) return false;

  const mine = text.slice(0, start) + text.slice(start + found[0].length);
  writeCell(block.table, r, column, mine);
  writeInlineSurface(cell, mine, start);
  tableEdited(block);
  return true;
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

// Inside a cell the same gesture cannot mean the same thing. Six of the nine
// entries above are **block** constructs, and `pickSprintMenuItem` inserts one by
// replacing the whole block and re-splitting it -- fired from a cell that would
// replace the table itself with `- [ ] `. So a cell gets its own inventory, and
// every entry is **inline**, which is all a GFM cell can hold.
//
// `break` is the odd one out and it is the whole reason this exists in a cell: a
// line break in a cell is `CELL_BREAK` in the file, so "put the next thing on its
// own line" is a real construct here rather than a keystroke. `caret` is where the
// cursor lands, counted from the start of the snippet.
//
// The highlights are the odd entries: every other one inserts at the caret, and a
// tint is the *cell's* rather than the caret's, so it is written at the head of
// the cell wherever the menu was opened from. `insertIntoCell` is where the two
// meanings part company -- one menu, still one pick.
const CELL_MENU = [
  { key: "todo", label: "Checkbox", markdown: TODO_WRITE },
  { key: "bullet", label: "Bullet", markdown: "- " },
  { key: "break", label: "Line break", markdown: "\n" },
  { key: "bold", label: "Bold", markdown: "****", caret: 2 },
  { key: "italic", label: "Italic", markdown: "**", caret: 1 },
  { key: "code", label: "Code", markdown: "``", caret: 1 },
  { key: "link", label: "Link", markdown: "[](url)", caret: 1 },
  ...CELL_HIGHLIGHTS,
  { key: "clear", label: "Clear highlight", highlight: "" },
];

// Entries the menu grows at open time. The seam that pairs with
// `registerCellInline`: `app.js` offers the roadmap's deliverables here, and this
// file offers none, knows of none and never asks for one.
//
// A provider is handed the text typed after the slash and is expected to return
// **nothing for an empty one**, so `/` on its own is still the fixed inventory
// above rather than every deliverable in the roadmap unrolled into a menu. The
// generic filter in `openSprintMenu` then applies to what comes back, the same
// way it applies to the entries above.
//
// An entry may carry `lineUnique`, a **non-global** regex: at most one of them per
// line, so picking a second time on a line replaces the one that line already has
// rather than adding another. Stated as a regex and enforced by `insertIntoCell`
// so this file keeps knowing nothing about what the entry means — it looks for a
// match on the line, and that is the whole of it. The rule exists because a reader
// downstream may take only the line's first one, in which case a second is not a
// second link but a decoration that lies.
//
// The line and not the row: a cell holding a checklist plans one thing per line,
// and each line is read on its own downstream.
const CELL_MENU_PROVIDERS = [];

function registerCellMenu(provider) {
  CELL_MENU_PROVIDERS.push(provider);
}

const cellMenuEntries = (filter) => CELL_MENU.concat(
  ...CELL_MENU_PROVIDERS.map((provide) => provide(filter)));

// `pick` is what the chosen entry does, set by whichever surface opened the menu:
// a block replaces itself and re-splits, a cell inserts text at the caret. The
// rendering, the filtering and the keyboard are the same either way, which is the
// only reason a second menu is cheap.
const sprintMenu = {
  open: false, node: null, items: [], selected: 0, area: null, index: 0, pick: null,
};

// `area` is a textarea for a fence and a `contenteditable` for prose, so what was
// typed is read off whichever one it is. The menu itself needs no more than that
// and a box to position against.
function maybeOpenSprintMenu(area, index) {
  const text = area.value === undefined ? area.textContent : area.value;
  // A slash first and nothing but the filter after it. Any whitespace closes the
  // menu, so a line that genuinely starts with a slash is only a menu until you
  // type the next character.
  if (text.startsWith("/") && !/\s/.test(text)) {
    openSprintMenu(area, index, text.slice(1), SPRINT_MENU, insertSprintMenuBlock);
  } else closeSprintMenu();
}

// The same gesture read **per line**, because a cell is one box holding several
// lines. A slash opens the menu at the start of the caret's line **or after a
// space**, with only the filter between it and the caret. The word boundary is
// what keeps an ordinary cell value ordinary: `1/2` and `n/a` have no space in
// front of the slash and never open anything. `Source expansion / Metrics` does
// open one for as long as the slash is the last thing typed, and the next
// character closes it again — the same way `/` alone has always behaved.
//
// A slash mid-line means the menu can be open with text on both sides of it, so
// what an insert replaces is the `/filter` span rather than the head of the line.
// `from` is where that span starts, and it is handed to the insert rather than
// re-derived there: only this function knows which slash opened the menu.
const CELL_MENU_TRIGGER = /(?:^|\s)\/(\S*)$/;

function maybeOpenCellMenu(cell, block, index, r, column) {
  const { text, at } = inlineSurface(cell);
  const line = text.slice(0, at).split("\n").pop();
  const found = CELL_MENU_TRIGGER.exec(line);
  if (found) {
    const filter = found[1];
    const from = at - filter.length - 1;
    openSprintMenu(cell, index, filter, cellMenuEntries(filter),
      (item) => insertIntoCell(item, cell, block, index, r, column, from));
  } else closeSprintMenu();
}

function openSprintMenu(area, index, filter, entries, pick) {
  const wanted = filter.toLowerCase();
  sprintMenu.area = area;
  sprintMenu.index = index;
  sprintMenu.pick = pick;
  sprintMenu.items = entries.filter((item) => !wanted
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

function pickSprintMenuItem(position) {
  const item = sprintMenu.items[position];
  const pick = sprintMenu.pick;
  const index = sprintMenu.index;
  closeSprintMenu();
  if (item && pick) pick(item, index);
}

// The span of `text` holding the line offset `at` sits on, as `[from, to)`. A cell
// is one string with newlines in it, and a `lineUnique` entry is kept unique
// within the line the caret is on rather than across the cell or the row: each
// line of a cell's checklist is read on its own downstream.
function cellLineSpan(text, at) {
  const from = text.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
  const to = text.indexOf("\n", at);
  return [from, to === -1 ? text.length : to];
}

// One line of the cell had `/filter` typed into it; the snippet takes its place
// and the caret lands where the entry says. The grid is written from the textarea
// as usual, so a save writes `CELL_BREAK` for the line break like any other.
//
// `from` is where the `/filter` starts — see `maybeOpenCellMenu`. Everything here
// replaces that span and nothing wider, because a slash may now sit mid-line with
// text on both sides of it.
function insertIntoCell(item, cell, block, index, r, column, from) {
  // The cell read as a string with a place in it, which is what every branch below
  // was written against. Both offsets are markdown ones -- see `inlineSurface`.
  const { text, at } = inlineSurface(cell);
  const start = from;
  const rest = text.slice(at);
  const unique = item.highlight === undefined ? item.lineUnique : null;
  let mine;
  let caret;

  if (item.highlight !== undefined) {
    // Drop the `/filter` that opened the menu, then re-mark the head of the cell:
    // one marker at a time, and an empty one is what clears it.
    const dropped = text.slice(0, start) + rest;
    const tint = cellTint(dropped);
    const bare = tint ? dropped.slice(tint.length) : dropped;
    const mark = item.highlight ? `${item.highlight} ` : "";
    mine = mark + bare;
    caret = Math.max(0, start - (tint ? tint.length : 0) + mark.length);
  } else if (unique) {
    // Take the `/filter` back out first, then look at the line it was typed on: if
    // that line already carries one of these, the mark is swapped where it sits
    // rather than a second one inserted beside it — so picking the same one twice
    // changes nothing, which is the honest answer to that gesture.
    const wanted = item.markdown.trim();
    mine = text.slice(0, start) + rest;
    caret = Math.min(start, mine.length);

    const [head, tail] = cellLineSpan(mine, caret);
    const found = unique.exec(mine.slice(head, tail));
    if (found) {
      const at = head + found.index;
      mine = mine.slice(0, at) + wanted + mine.slice(at + found[0].length);
      caret = Math.min(caret, mine.length);
    } else {
      // Nothing on this line yet — an ordinary insert at the caret. Also the way
      // out when the only match was inside the `/filter` that has just been
      // dropped: unreachable through the deliverable picker, whose keys never
      // match its own mark, but the rule is generic and so is the guard.
      mine = mine.slice(0, start) + item.markdown + mine.slice(start);
      caret = start + item.markdown.length;
    }
  } else {
    mine = text.slice(0, start) + item.markdown + rest;
    caret = start + (item.caret ?? item.markdown.length);
  }

  writeCell(block.table, r, column, mine);
  // Redrawn from the string, so a `**bold**` the insert completed is drawn as bold
  // rather than sitting there as four asterisks until the cell is left.
  writeInlineSurface(cell, mine, caret);
  cell.focus();
  paintCellHost(cellHost(cell), block.table, r, column);
  tableEdited(block);
}

async function insertSprintMenuBlock(item, index) {
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

// `line` is which line of a list block to open, and null for every other type --
// they are edited whole.
function editSprintBlock(index, line = null) {
  const sprint = state.sprint;
  if (sprint.editing === index && sprint.editingLine === line) return;
  sprint.editing = index;
  sprint.editingLine = line;
  sprint.draft = null;
  renderSprintDocument();
}

// Show an empty paragraph in edit mode, so an empty file is not a dead end.
function startSprintBlock() {
  const sprint = state.sprint;
  sprint.blocks = [{ index: 0, type: "paragraph", raw: "", gap: "\n", html: "" }];
  sprint.editing = 0;
  sprint.editingLine = null;
  sprint.draft = null;
  renderSprintDocument();
}

// An empty block at the end of the file, opened for typing. The gaps are the
// whole care here, and the rule is `removeSprintBlock`'s in reverse: **the last
// block owns the file's trailing newline**, so the new block inherits it and
// what used to be last is given a separator instead. It has to be a blank line
// -- handing on a single newline would re-read the two paragraphs as one.
//
// No save is scheduled: an empty block is not part of the file until something
// is typed into it, the same contract `insertSprintBlockAfter` has.
function appendSprintBlock() {
  const sprint = state.sprint;
  const blocks = sprint.blocks;
  if (!blocks.length) {
    startSprintBlock();
    return;
  }

  const last = blocks[blocks.length - 1];
  const tail = last.gap;
  last.gap = sprintBlankLine(blocks);
  blocks.push({
    index: blocks.length, type: "paragraph", raw: "", gap: tail, html: "",
  });

  sprint.editing = blocks.length - 1;
  sprint.editingLine = null;
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

// A pipe inside a cell is stored escaped, and a line break is stored as `<br>`,
// because that is what the file needs: GFM has no block content in a cell, and a
// real newline in a pipe row is a new row. The grid shows the character itself
// both times; `_escape_cell` writes both back, which is why it unescapes before
// it escapes. Read leniently — `<br/>`, `<br />` and any case are the same break,
// because a file you hand-edit will hold whichever one you typed — and written in
// exactly one spelling, `markdown.CELL_BREAK`.
const cellText = (value) => String(value ?? "")
  .replace(/\\\|/g, "|")
  .replace(/<br\s*\/?>/gi, "\n");

const cellValue = (grid, r, column) => (r === -1 ? grid.head[column] : grid.rows[r][column]);

function writeCell(grid, r, column, value) {
  if (r === -1) grid.head[column] = value;
  else grid.rows[r][column] = value;
}

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
  // One `<col>` per column plus the gutter's, so a width can be set in one place
  // rather than on every cell in the column. Always present, even before anything
  // has been resized: it is what the first drag seeds.
  const cols = element("colgroup");
  cols.appendChild(element("col", "sprint-col-gutter"));
  grid.head.forEach(() => cols.appendChild(element("col")));
  table.appendChild(cols);

  const grips = element("tr", "sprint-colgrips");
  grips.appendChild(element("th", "sprint-corner"));
  grid.head.forEach((_, column) => {
    const cell = element("th", "sprint-colgrip");
    cell.append(
      gridGrip(block, index, "column", column, cell),
      columnResizer(block, column, table),
    );
    grips.appendChild(cell);
  });
  thead.appendChild(grips);

  const head = element("tr");
  // The header row gets no grip: GFM has no table without a header row, so it can
  // neither be moved nor removed. Its cells are reordered by moving the columns.
  head.appendChild(element("th", "sprint-gutter"));
  grid.head.forEach((_, column) => {
    head.appendChild(sprintCellHost(block, index, -1, column));
  });
  thead.appendChild(head);
  table.appendChild(thead);

  const body = element("tbody");
  grid.rows.forEach((row, r) => {
    const tr = element("tr");
    const gutter = element("td", "sprint-gutter");
    gutter.appendChild(gridGrip(block, index, "row", r, tr));
    tr.appendChild(gutter);
    row.forEach((_, column) => {
      tr.appendChild(sprintCellHost(block, index, r, column));
    });
    body.appendChild(tr);
  });
  table.appendChild(body);

  scroller.appendChild(table);
  applyColumnWidths(table, storedWidths(block));
  node.append(scroller, sprintTableTools(block, index));
  return node;
}

// --- column widths -----------------------------------------------------------

// **A width is a way of looking, not content**, so none of this reaches the file:
// markdown has no column width, and inventing a syntax for one would put a second
// record beside the file the whole editor exists to leave alone. It lives in
// `localStorage` instead, the same standing as `state.mapTiers` -- except that a
// width is worth keeping across a reload, which is the one thing that state is
// not, and the cost of being wrong is a column you drag again.
//
// Keyed on the **header row's text** rather than the block's index, so a width
// survives the block being reordered and the file being reopened. Renaming a
// header loses that table's widths, and two tables with identical headers share
// them -- both accepted: the first is rare and re-draggable, the second gives two
// tables of the same shape the same shape.
const SPRINT_WIDTHS_KEY = "roadmap.sprint-widths";

// Narrow enough for a tally column, wide enough that a column cannot be dragged
// to nothing and lost.
const MIN_COLUMN_PX = 44;

// The row-grip gutter's width once the table is sized. It is not in the stored
// array -- it is furniture, not a column of the table -- but it still has to be
// stated, because under fixed layout a column with no width of its own takes
// whatever is left over between the columns and the table.
const GUTTER_COLUMN_PX = 18;

// What a column inserted into an already-sized table gets. Only reached when the
// table has widths at all -- an auto-sized one stays auto-sized.
const NEW_COLUMN_PX = 120;

const tableWidthKey = (block) =>
  block.table.head.map((cell) => cellText(cell).trim()).join(" | ");

// Every stored width for the open file. `localStorage` throws when it is disabled
// rather than being absent, so both directions are guarded and a failure means
// widths do not persist -- never that the editor stops working.
function widthStore() {
  try {
    return JSON.parse(localStorage.getItem(`${SPRINT_WIDTHS_KEY}:${state.sprint.number}`)) || {};
  } catch (_) {
    return {};
  }
}

function storedWidths(block) {
  const found = widthStore()[tableWidthKey(block)];
  return Array.isArray(found) && found.length === block.table.head.length ? found : null;
}

// Read the widths out and drop the entry they were under, so a structural edit
// can write them back beside the new header row. Returns null when the table is
// auto-sized, which is what keeps every caller's "if widths" honest.
function takeWidths(block) {
  const widths = storedWidths(block);
  if (widths) writeWidths(block, null);
  return widths;
}

function writeWidths(block, widths) {
  const store = widthStore();
  if (widths) store[tableWidthKey(block)] = widths;
  else delete store[tableWidthKey(block)];
  try {
    localStorage.setItem(`${SPRINT_WIDTHS_KEY}:${state.sprint.number}`, JSON.stringify(store));
  } catch (_) { /* no storage: the drag still worked, it just will not be kept */ }
}

// Auto-sized until you touch it. A sized table switches to `table-layout: fixed`,
// which is what makes a drag land exactly where it was let go -- with auto layout
// the browser treats a width as a suggestion and re-fits it to the content.
//
// **The table's own width is set here, and it is what makes `table-layout: fixed`
// run at all.** `width: auto` means the *automatic* algorithm whatever
// `table-layout` says (CSS 2.1 17.5.2.1), so a sized table with no width was still
// laid out automatically: every `<col>` stayed a suggestion, and dragging a column
// to 263px drew it at 130 while the columns beside it moved instead -- the exact
// failure the sized state exists to prevent. A definite width is the sum of the
// columns, so the table is as wide as its columns make it and `.sprint-grid`
// scrolls whatever does not fit.
//
// One consequence to expect: the first drag narrows the table by whatever slack
// auto layout had parked in the gutter, which can be 60px. The columns keep the
// widths they were measured at; only the empty gutter gives its share back.
function applyColumnWidths(table, widths) {
  const cols = table.querySelectorAll("col");
  table.classList.toggle("sized", Boolean(widths));
  cols.forEach((col, position) => {
    // Position 0 is the gutter -- sized too, or fixed layout hands it the whole
    // difference between the columns and the table.
    if (position === 0) col.style.width = widths ? `${GUTTER_COLUMN_PX}px` : "";
    else col.style.width = widths ? `${widths[position - 1]}px` : "";
  });
  table.style.width = widths
    ? `${GUTTER_COLUMN_PX + widths.reduce((total, width) => total + width, 0)}px`
    : "";
}

// The widths a drag starts from: what is stored, or what the columns are actually
// occupying right now. Seeding **every** column from the measurement is what keeps
// the first drag from resizing the whole table -- under fixed layout a column with
// no width of its own would take whatever was left over.
function seedColumnWidths(block, table) {
  const stored = storedWidths(block);
  if (stored) return stored.slice();
  const header = table.tHead.rows[1];
  return block.table.head.map((_, column) => {
    const cell = header.cells[column + 1];
    return Math.max(MIN_COLUMN_PX, Math.round(cell ? cell.getBoundingClientRect().width : MIN_COLUMN_PX));
  });
}

// The handle on a column's right edge. It sits in the grip strip above the header
// rather than in the header cell itself: a header cell's whole area is "click here
// to type", and a 6px strip taken out of it would be 6px you cannot put a cursor
// in.
function columnResizer(block, column, table) {
  const grip = element("span", "col-resize");
  grip.title = "Drag to set this column's width · double-click to size every column to its content again";

  grip.onmousedown = (event) => {
    // Both stopped: the block around this table has drag handlers of its own, and
    // a press here must not start selecting text across the document either.
    event.preventDefault();
    event.stopPropagation();

    const widths = seedColumnWidths(block, table);
    const from = event.clientX;
    const was = widths[column];

    const move = (moved) => {
      widths[column] = Math.max(MIN_COLUMN_PX, Math.round(was + moved.clientX - from));
      applyColumnWidths(table, widths);
    };
    // Written on release rather than per frame: a drag is one decision.
    const drop = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", drop);
      document.body.classList.remove("resizing-column");
      writeWidths(block, widths);
    };
    document.body.classList.add("resizing-column");
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", drop);
  };

  // Resets the **table**, not the column. One auto column among fixed ones has no
  // width to fall back to under fixed layout -- it would collapse rather than fit
  // its content -- so the honest reset is all of them at once.
  grip.ondblclick = (event) => {
    event.stopPropagation();
    writeWidths(block, null);
    applyColumnWidths(table, null);
  };
  return grip;
}

// **A cell has two states, and this is the one reveal gesture the grid has.**
// Everywhere else in the editor a block swaps between rendered HTML and its
// markdown; a table swapped to cells instead, and for a long time that was the
// whole story — "the cells are the editor". A checkbox broke it, because a
// `<textarea>` has no insides to click: its content is plain text with no child
// elements, so a box drawn in one cannot be hit. So an unfocused cell is a view
// that can hold real controls, and focusing it swaps in the textarea.
//
// What the view does **not** do is render the cell's markdown. `**Total**` still
// reads as `**Total**` in the grid, exactly as before: the checkbox is the single
// deliberate exception, because it is the one construct you need to *operate*
// rather than read. Rendering the rest would make the grid a markdown renderer
// and the file's inline source unreachable without the raw view.
//
// The swap is local — the `<td>` exchanges its one child — and never a document
// re-render: `Tab` walks cells, and rebuilding every block per keypress in a file
// with 200-odd cells is not affordable.
// **The whole cell is the target, which means the handler is on the host and not
// on either state inside it.** A `<td>` is `vertical-align: middle`, so a
// one-line cell in a row made tall by the cell beside it draws its view 30px high
// in the middle of 263px -- and it was the view that carried the click, so 234px
// of that cell did nothing. Measured, not guessed: `elementFromPoint` at the top
// and bottom of such a cell returned the bare `TD`.
//
// The host survives the view/textarea swap -- the swap replaces the host's one
// child -- so binding here also means the dead space is live *while you are
// typing*, where the textarea is its text's height and centred the same way.
function sprintCellHost(block, index, r, column) {
  // The class is what tells the cursor apart from the gutter and grip cells,
  // which are the same two tags and are not "click here to type".
  const host = element(r === -1 ? "th" : "td", "sprint-cell-host");
  host.title = "Click to edit";
  host.onclick = (event) => {
    // A table lives inside a `.sprint-row` with drag handlers of its own.
    event.stopPropagation();
    // A link in a cell is there to be followed, the same conclusion `sprintBlock`
    // reached for a link in a paragraph. The checkbox stops its own click.
    if (event.target.closest("a")) return;
    const editor = host.querySelector(".sprint-cell");
    // Already editing: a press in the margin around the textarea puts you in it,
    // and a press inside it is the browser's to place the caret with.
    if (editor) {
      if (event.target !== editor) editor.focus();
      return;
    }
    editSprintCell(host, block, index, r, column);
  };
  showSprintCell(host, block, index, r, column);
  return host;
}

function showSprintCell(host, block, index, r, column) {
  host.innerHTML = "";
  host.appendChild(sprintCellView(block, index, r, column));
  paintCellHost(host, block.table, r, column);
}

// The press a cell-line action is drawn as, at the end of the line it belongs to.
// Chrome, like a list line's: `mousedown` is refused so the press does not take
// the caret out of a cell you are typing in, and it stops its own click so the
// cell under it does not open the editor over the press you just made.
//
// Drawn in the resting view only. Focusing the cell swaps in the surface, where
// the line is text with a caret in it and its markdown is reachable directly --
// the same trade a checkbox in a cell already makes.
function cellLineAction(block, index, r, column, position, text) {
  const action = firstOf(CELL_LINE_ACTIONS, text);
  if (!action) return null;

  const press = element("button", "sprint-cell-act");
  press.type = "button";
  press.title = action.title;
  press.textContent = action.label;
  press.onmousedown = (event) => event.preventDefault();
  press.onclick = (event) => {
    event.stopPropagation();
    action.run(press, text, (written) => {
      writeCellLine(block, r, column, position, written);
      tableEdited(block);
      // The whole document, for `sprintLineAction`'s reason: what the action wrote
      // may draw as anything, and this file has no idea what changed beyond text.
      renderSprintDocument();
    });
  };
  return press;
}

// One line of a cell rewritten, the rest of the cell left exactly as it is. The
// marker stays on the front: an action is handed the line's *body* and gives a
// body back, the same contract a list line's action has.
function writeCellLine(block, r, column, position, body) {
  const grid = block.table;
  const lines = cellText(cellValue(grid, r, column)).split("\n");
  if (position >= lines.length) return;
  const found = CELL_TODO.exec(lines[position]);
  // A bare `☐` matched with no gap after it, so one is put back: without it the
  // marker and the first word of the body become one word.
  const head = found ? (found[3] ? found[0] : `${found[0]} `) : "";
  lines[position] = `${head}${body}`;
  writeCell(grid, r, column, lines.join("\n"));
}

// The resting state. One `<div>` per line so a line can carry a checkbox beside
// its text, and `textContent` for the text itself -- never `innerHTML`, because
// the cell holds file content and nothing here is entitled to run it as markup.
function sprintCellView(block, index, r, column) {
  const grid = block.table;
  const view = element("div", "sprint-cell-view");
  view.dataset.r = r;
  view.dataset.c = column;
  view.style.textAlign = CELL_ALIGN[grid.align[column]] || "";

  // The tint is the cell's, so its marker is taken off the front of the whole
  // cell before the lines are read -- otherwise it would draw as text on line one.
  const raw = cellText(cellValue(grid, r, column));
  const tint = cellTint(raw);
  const lines = (tint ? raw.slice(tint.length) : raw).split("\n");

  lines.forEach((line, position) => {
    const row = element("div", "sprint-cell-line");
    const found = CELL_TODO.exec(line);
    const bullet = found ? null : CELL_BULLET.exec(line);
    // Indent is drawn as padding rather than left as spaces, so a nested line
    // hangs under its parent's text instead of under its glyph.
    if (found || bullet) {
      row.style.setProperty("--cell-depth", cellDepth((found || bullet)[1]));
    }
    if (found) {
      const box = element("input", "sprint-cell-todo");
      box.type = "checkbox";
      box.checked = found[2] === TODO_ON || /\[[xX]\]/.test(found[2]);
      box.title = "Tick this line";
      // The box is the only thing in a cell that is not "click here to type", so
      // it stops the click that would otherwise open the editor over it.
      box.onclick = (event) => {
        event.stopPropagation();
        toggleCellTodo(cellHost(view), block, index, r, column, position);
      };
      const label = element("span", "sprint-cell-label");
      const body = line.slice(found[0].length);
      renderCellInline(label, body);
      row.append(box, label);
      // A checkbox line in a cell is a unit of work, so it gets the press a task
      // line outside the table has. Only a checkbox line: a bullet is a note and a
      // plain line is prose, neither of which anything downstream reads as work.
      const press = cellLineAction(block, index, r, column, position, body);
      if (press) row.appendChild(press);
    } else if (bullet) {
      const depth = cellDepth(bullet[1]);
      const glyph = element("span", "sprint-cell-bullet",
        CELL_BULLETS[Math.min(depth, CELL_BULLETS.length - 1)]);
      const label = element("span", "sprint-cell-label");
      renderCellInline(label, line.slice(bullet[0].length));
      row.append(glyph, label);
    } else {
      renderCellInline(row, line);
    }
    view.appendChild(row);
  });

  // No click handler here: the whole `<td>` carries it, so the dead margin a
  // short cell leaves in a tall row is live too. See `sprintCellHost`.
  return view;
}

// The `<td>` a view or an editor is sitting in. The swap is always "replace the
// host's one child", so the host is the only thing either state needs to know.
const cellHost = (node) => node.parentElement;

// Swap the view for the editor and put the caret in it. No measuring pass: the
// surface is an ordinary block element and sizes itself, which is one thing the
// inline surfaces gave back.
function editSprintCell(host, block, index, r, column, select) {
  if (!host) return null;
  const area = sprintCell(block, index, r, column);
  host.innerHTML = "";
  host.appendChild(area);
  paintCellHost(host, block.table, r, column);
  area.focus();
  if (select) selectInline(area);
  return area;
}

// The same flip, from the keyboard, on the line the caret is in. Stays in the
// textarea rather than swapping back to the view: you are mid-edit, and a toggle
// should not also mean "done here". The caret keeps its offset within the line,
// clamped, because the marker it just gained or lost changed the line's length.
function toggleCellTodoAtCaret(cell, block, index, r, column) {
  const grid = block.table;
  const { text, at } = inlineSurface(cell);
  const before = text.slice(0, at);
  const position = before.split("\n").length - 1;
  const offset = before.length - (before.lastIndexOf("\n") + 1);

  const lines = text.split("\n");
  const was = lines[position].length;
  lines[position] = flipCellTodo(lines[position]);
  const moved = lines[position].length - was;

  const mine = lines.join("\n");
  const start = before.length - offset
    + Math.max(0, Math.min(offset + moved, lines[position].length));

  writeCell(grid, r, column, mine);
  writeInlineSurface(cell, mine, start);
  tableEdited(block);
}

function toggleCellTodo(host, block, index, r, column, position) {
  const grid = block.table;
  const lines = cellText(cellValue(grid, r, column)).split("\n");
  if (position >= lines.length) return;

  lines[position] = flipCellTodo(lines[position]);
  // Written back with real newlines, the same shape typing produces -- the server
  // turns either spelling into `CELL_BREAK` on the way to the file.
  writeCell(grid, r, column, lines.join("\n"));
  tableEdited(block);
  showSprintCell(host, block, index, r, column);
}

// **An inline surface, not a textarea**, for the reason every prose surface here is
// one: `**Total**` typed into a cell has to draw as bold rather than sit there as
// asterisks. A cell can still hold a second line -- the text keeps its newlines and
// the surface wraps -- and the keyboard rules below are still read **per line**,
// because a tab on a checklist line and a tab on a word are not the same request.
//
// A line's own marker is chrome here too: `- [ ] Ship` is a checkbox and a label
// while you type, never those six characters. It is drawn by `renderCellSurface`
// as a widget inside this one surface rather than by splitting the cell into a
// surface per line -- see that function for why the grid's rules make that the
// only shape available.
function sprintCell(block, index, r, column) {
  const grid = block.table;
  const cell = inlineEditable("sprint-cell", cellText(cellValue(grid, r, column)), (event) => {
    writeCell(grid, r, column, inlineMarkdown(cell));
    // The gap is what finishes a marker, so it is the only key worth redrawing on.
    const typed = event && event.data;
    if (typed && /[ \t]$/.test(typed)) promoteCellLine(cell);
    paintCellHost(cellHost(cell), grid, r, column);
    maybeOpenCellMenu(cell, block, index, r, column);
    tableEdited(block);
  }, renderCellSurface);
  cell.dataset.r = r;
  cell.dataset.c = column;
  // Alignment is the column's, so the grid reads the way the rendered table does.
  cell.style.textAlign = CELL_ALIGN[grid.align[column]] || "";

  // Back to the view, so the checkboxes in this cell become clickable again. The
  // grid already holds every keystroke, so there is nothing to commit here --
  // unlike a block, where the blur *is* the save.
  cell.onblur = () => {
    closeSprintMenu();
    const host = cellHost(cell);
    // A document re-render can pull a focused cell out from under itself, and
    // Chrome fires blur when it does. Painting into a detached `<td>` is harmless
    // but pointless, and the render has already drawn the view.
    if (host && host.isConnected) showSprintCell(host, block, index, r, column);
  };

  cell.onkeydown = (event) => {
    // While the menu is up it owns the arrows, Enter and Esc.
    if (sprintMenu.open && sprintMenuKey(event)) return;
    // Bold, italic, underline and strikethrough, the same four keys every other
    // inline surface answers to.
    if (inlineCommandKey(event)) return;

    // The keyboard equivalent of clicking a box, and the reason the feature is not
    // mouse-only. On a line with no marker it adds one, so this also starts a
    // checklist rather than only maintaining one.
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      toggleCellTodoAtCaret(cell, block, index, r, column);
      return;
    }

    // **`Tab` indents on a list line and walks the grid everywhere else.** Which
    // is the honest reading of the key: indenting a paragraph inside a table cell
    // means nothing, and a cell holding one word is the common case -- taking
    // `Tab` from it would cost the gesture that fills a table in. So the line the
    // caret is on decides, and the two meanings never both apply.
    if (event.key === "Tab" && cellLineMarker(caretLine(cell).line)) {
      event.preventDefault();
      indentCellLine(cell, block, r, column, event.shiftKey ? -1 : 1);
      return;
    }

    // A list carries on by itself: `Enter` on an item opens the next one with the
    // same marker at the same depth, and on an empty item takes the marker away
    // rather than laying out a third. That second half is the way out of a list,
    // and without it the only exit is deleting what the first half just wrote.
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey
        && continueCellList(cell, block, r, column)) {
      event.preventDefault();
      return;
    }

    // Every other `Enter` puts a newline in as a **character**, rather than letting
    // the browser split the surface: left alone, Chrome wraps what it splits in a
    // `<div>` of its own, and a marker widget inside one is a line the renderer no
    // longer owns. The surface is `pre-wrap`, so the character is the break.
    if (event.key === "Enter") {
      event.preventDefault();
      const { text, at } = inlineSurface(cell);
      const mine = `${text.slice(0, at)}\n${text.slice(at)}`;
      writeCell(block.table, r, column, mine);
      writeInlineSurface(cell, mine, at + 1);
      tableEdited(block);
      return;
    }

    // `Backspace` where the marker is: there is no character in front of the caret
    // to delete, so the marker comes off instead -- one press, and the line keeps
    // its text. Anywhere else the browser's own Backspace is right.
    if (event.key === "Backspace" && dropCellMarker(cell, block, r, column)) {
      event.preventDefault();
      return;
    }

    // The way out, and it only exists because `Tab` no longer is one: without it
    // a keyboard has no way to leave the grid at all. It commits nothing, unlike
    // `Esc` on a block -- the grid already holds every keystroke.
    if (event.key === "Escape") {
      event.preventDefault();
      cell.blur();
      return;
    }

    // `Tab` anywhere but a list line still walks the grid, exactly as it always
    // has -- including growing a row off the end. `Ctrl`+arrow walks from
    // anywhere, which is what a list line has instead.
    if (event.key === "Tab") {
      event.preventDefault();
      stepSprintCell(block, index, r, column, [0, event.shiftKey ? -1 : 1]);
      return;
    }

    const step = CELL_STEP[event.key];
    if (!step || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    stepSprintCell(block, index, r, column, step);
  };

  // Replaces `inlineEditable`'s own paste handler, so the plain-text half of it is
  // repeated here: a surface that let a browser's HTML in would be a surface whose
  // markdown nobody can write back.
  cell.onpaste = (event) => {
    const text = (event.clipboardData || window.clipboardData).getData("text");
    // One value is an ordinary paste; a range is a grid, and that is the point.
    // Deliberately unchanged by multi-line cells: a one-column range is still
    // rows, and `Enter` is how a second line goes into a single cell.
    if (!text || !/[\t\n]/.test(text)) {
      event.preventDefault();
      if (text) document.execCommand("insertText", false, text);
      return;
    }
    event.preventDefault();
    pasteIntoTable(block, r, column, text);
    renderSprintDocument();
    focusSprintCell(index, r, column);
  };

  return cell;
}

// The line the caret is on, and where it starts in the cell's markdown -- plus that
// markdown and the caret's place in it, since every caller needs all four and
// reading them twice would mean reading them from a surface that had moved on.
// Every keyboard rule below is per line rather than per cell, because a cell holds
// several -- the same reading `maybeOpenCellMenu` does for `/`.
function caretLine(cell) {
  const { text, at } = inlineSurface(cell);
  const upto = text.slice(0, at);
  const start = upto.length - upto.split("\n").pop().length;
  return { start, line: text.slice(start).split("\n")[0], text, at };
}

// What a line is, for the two rules that care: a checkbox, a bullet, or neither.
// `write` is what continuing it looks like, in the **spelling this line already
// uses** -- `☐` carries on as `☐`, `- [x]` carries on as an unticked `- [ ]`, and
// `*` stays `*`. The marker belongs to the line, which is the same stance
// `flipCellTodo` takes about ticking one.
function cellLineMarker(line) {
  const todo = CELL_TODO.exec(line);
  if (todo) {
    const glyph = todo[2] === TODO_ON || todo[2] === TODO_OFF;
    return { indent: todo[1], length: todo[0].length, write: glyph ? `${TODO_OFF} ` : TODO_WRITE };
  }
  const bullet = CELL_BULLET.exec(line);
  if (bullet) return { indent: bullet[1], length: bullet[0].length, write: `${bullet[2]} ` };
  return null;
}

// `Enter` on a list line. Returns whether it handled the key -- on an ordinary
// line it does not, and the surface takes the newline itself as before.
function continueCellList(cell, block, r, column) {
  const { start, line, text, at } = caretLine(cell);
  const marker = cellLineMarker(line);
  if (!marker) return false;

  let mine;
  let caret;

  if (line.slice(marker.length).trim()) {
    const carry = `\n${marker.indent}${marker.write}`;
    mine = text.slice(0, at) + carry + text.slice(at);
    caret = at + carry.length;
  } else {
    // An empty item ends the list rather than laying out another empty one. The
    // indent goes with the marker: what is left is a blank line, not a stray two
    // spaces that the next save would strip anyway.
    mine = text.slice(0, start) + text.slice(start + marker.length);
    caret = start;
  }

  writeCell(block.table, r, column, mine);
  writeInlineSurface(cell, mine, caret);
  tableEdited(block);
  return true;
}

// Where `Ctrl`+arrow goes, as `[down, across]`. Modifiers are nearly all spoken
// for -- `Ctrl+Tab` is the browser's, `Alt+Tab` is the window manager's -- so the
// arrows are what is left, and they are the spreadsheet gesture anyway.
const CELL_STEP = {
  ArrowRight: [0, 1],
  ArrowLeft: [0, -1],
  ArrowDown: [1, 0],
  ArrowUp: [-1, 0],
};

// One step through the grid, wrapping at the ends of a row the way `Tab` did.
function stepSprintCell(block, index, r, column, [down, across]) {
  const grid = block.table;
  const columns = grid.head.length;
  let row = r + down;
  let next = column + across;
  if (next >= columns) { next = 0; row += 1; }
  if (next < 0) { next = columns - 1; row -= 1; }

  // Off the end grows the table rather than leaving it -- `Tab`'s old job,
  // carried over so nothing was lost when the key changed.
  if (row > grid.rows.length - 1) {
    insertGridRow(block, grid.rows.length);
    applyGridChange(block, index, grid.rows.length - 1, next);
    return;
  }
  if (row < -1) return;   // up out of the header row stays put
  focusSprintCell(index, row, next);
}

// Indent or outdent every line the selection touches, and nothing else: this
// writes spaces into the cell's text, so it is the same kind of edit as typing.
//
// **A cell's first line cannot hold an indent**, and that is the file's rule
// rather than this function's: `_split_row` strips each cell, so leading
// whitespace on line one is gone by the next save. Lines two and after keep it,
// which is where nesting belongs anyway -- a list starts at the left.
function indentCellLine(cell, block, r, column, direction) {
  const { text: value, at } = inlineSurface(cell);
  // One line: the caret's. A range spanning several was what a textarea's two
  // offsets could say and an inline caret cannot, so the loop below now runs once
  // -- kept as a loop because that is what makes the arithmetic below readable.
  const was = { start: at, end: at };
  const from = value.lastIndexOf("\n", Math.max(0, was.start - 1)) + 1;
  const found = value.indexOf("\n", was.end);
  const to = found === -1 ? value.length : found;

  let first = 0;
  let total = 0;
  const lines = value.slice(from, to).split("\n").map((line, position) => {
    const taken = direction > 0 ? "" : (/^(\t| {1,2})/.exec(line) || [""])[0];
    const moved = direction > 0 ? CELL_INDENT.length : -taken.length;
    if (position === 0) first = moved;
    total += moved;
    return direction > 0 ? CELL_INDENT + line : line.slice(taken.length);
  });

  const mine = value.slice(0, from) + lines.join("\n") + value.slice(to);
  // The caret moves by what was added or taken *before* it, so it keeps its place
  // in the line rather than jumping to the end of the box.
  writeCell(block.table, r, column, mine);
  writeInlineSurface(cell, mine, Math.max(from, was.start + first));
  tableEdited(block);
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
// ...and its **width**, for the same reason, with one wrinkle `align` does not
// have: widths are keyed on the header row's text, which is the very thing these
// three edits change. So the entry is read and dropped before the grid moves, and
// written back under the new key after -- `takeWidths` is that half of it.
function insertGridColumn(block, at) {
  const grid = block.table;
  const widths = takeWidths(block);
  squareGrid(grid);
  grid.head.splice(at, 0, "");
  grid.align.splice(at, 0, "");
  for (const row of grid.rows) row.splice(at, 0, "");
  if (widths) {
    widths.splice(at, 0, NEW_COLUMN_PX);
    writeWidths(block, widths);
  }
}

function deleteGridColumn(block, at) {
  const grid = block.table;
  const widths = takeWidths(block);
  squareGrid(grid);
  grid.head.splice(at, 1);
  grid.align.splice(at, 1);
  for (const row of grid.rows) row.splice(at, 1);
  if (widths) {
    widths.splice(at, 1);
    writeWidths(block, widths);
  }
}

function moveGridColumn(block, from, to) {
  const grid = block.table;
  const widths = takeWidths(block);
  squareGrid(grid);
  grid.head.splice(to, 0, grid.head.splice(from, 1)[0]);
  grid.align.splice(to, 0, grid.align.splice(from, 1)[0]);
  for (const row of grid.rows) row.splice(to, 0, row.splice(from, 1)[0]);
  if (widths) {
    widths.splice(to, 0, widths.splice(from, 1)[0]);
    writeWidths(block, widths);
  }
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
      "Tab moves, or indents a list line · Enter continues a list · / inserts · "
      + "paste fills the grid · ⠿ moves a row or column · drag a column edge"),
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

// Put the caret in one cell, whichever state it is currently in -- so `Tab`, a
// paste and a structural edit all reach it the same way. The coordinates are on
// both the view and the editor, and nothing else in a table block carries them,
// which is why the selector asks for the pair rather than for a class.
function focusSprintCell(index, r, column) {
  const doc = $("sprint-document");
  const block = doc.children[index];
  const cell = block && block.querySelector(`[data-r="${r}"][data-c="${column}"]`);
  if (!cell) return;

  if (cell.classList.contains("sprint-cell")) {
    cell.focus();
    selectInline(cell);
    return;
  }
  const grid = state.sprint.blocks[index];
  if (grid) editSprintCell(cellHost(cell), grid, index, r, column, true);
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
  sprint.editingLine = null;
  sprint.draft = null;

  if (!original || text === original.raw) {
    // An empty block committed empty was never in the file: only the foot target
    // and the `Enter` above make one, and the splitter never returns an empty
    // block. So it goes, rather than lingering as a blank paragraph that the next
    // save would write out as a stray blank line. Nothing is scheduled, because
    // the file on disk never held it.
    if (original && !text && !original.raw && sprint.blocks.length > 1) {
      discardEmptySprintBlock(index);
      return;
    }
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
    sprint.editingLine = null;
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
    const saved = await api(sprintEndpoint(number), {
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
  // Same reason, second consequence: the heading is where this file's fortnight
  // is written down, so retyping its dates re-aims the scope panel beside it.
  renderSprintScope();
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
