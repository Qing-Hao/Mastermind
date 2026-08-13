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
  renderSprintStatus();
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
  $("sprint-document").hidden = none;
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
    // A table is edited as a grid and never as raw pipes, so it has no reveal
    // gesture at all -- the cells *are* the editor. Everything else swaps
    // between rendered HTML and its own markdown.
    if (block.type === "table" && block.table) {
      doc.appendChild(sprintTable(block, index));
      return;
    }
    doc.appendChild(index === sprint.editing
      ? sprintEditor(block, index)
      : sprintBlock(block, index));
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
}

function sprintBlock(block, index) {
  const node = element("div", `sprint-block sprint-${block.type}`);
  node.innerHTML = block.html;
  node.tabIndex = 0;
  node.title = "Click to edit the markdown";
  node.onclick = (event) => {
    // A link in a sprint file is there to be followed, not to open an editor.
    if (event.target.closest("a")) return;
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
  area.oninput = () => autosizeSprintArea(area);
  area.onblur = () => commitSprintBlock(index, area.value);
  area.onkeydown = (event) => {
    // Esc commits like clicking away does. There is no cancel here: the file is
    // the record and the save is automatic, so "undo" is typing it back.
    if (event.key === "Escape") {
      event.preventDefault();
      area.blur();
    }
  };
  return area;
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
// happen in exactly one place and the frontend never writes a pipe.
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

  const head = element("tr");
  grid.head.forEach((cell, column) => {
    const th = element("th");
    th.appendChild(sprintCell(block, index, -1, column, cell));
    head.appendChild(th);
  });
  table.appendChild(element("thead")).appendChild(head);

  const body = element("tbody");
  grid.rows.forEach((row, r) => {
    const tr = element("tr");
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
      grid.rows.push(new Array(columns).fill(""));
      tableEdited(block);
      renderSprintDocument();
      focusSprintCell(index, grid.rows.length - 1, 0);
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

function sprintTableTools(block, index) {
  const grid = block.table;
  const tools = element("div", "sprint-table-tools");

  const change = (apply) => () => {
    apply();
    tableEdited(block);
    renderSprintDocument();
  };

  tools.append(
    gridButton("+ Row", change(() => grid.rows.push(new Array(grid.head.length).fill("")))),
    gridButton("+ Column", change(() => {
      grid.head.push("");
      grid.align.push("");
      grid.rows.forEach((row) => row.push(""));
    })),
    gridButton("− Row", change(() => grid.rows.pop()), grid.rows.length === 0),
    // A table with no columns is not a table, so the last one cannot go.
    gridButton("− Column", change(() => {
      grid.head.pop();
      grid.align.pop();
      grid.rows.forEach((row) => row.pop());
    }), grid.head.length <= 1),
    element("span", "sprint-table-note", "Tab moves · paste from a spreadsheet fills the grid"),
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
