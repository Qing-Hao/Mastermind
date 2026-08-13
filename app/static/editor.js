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
  const text = joinSprintBlocks(sprint.blocks);
  sprint.status = "saving";
  renderSprintStatus();

  try {
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
