// Roadmap Planner frontend. Vanilla JS, no build step.
// camelCase here because that is the JS ecosystem standard; the Python side
// uses snake_case. API payload keys stay snake_case end to end.

// The week is the unit the eye reads, so the column is the unit of layout. Its
// width is fitted to the space the chart actually has at render time rather
// than fixed, so a full window fills the page instead of scrolling off it. The
// per-day figure is derived from it and travels on the view object.
const MIN_WEEK_PX = 22;   // narrower than this and the week labels stop reading
const MAX_WEEK_PX = 64;   // wider than this a short window just looks stretched
const FALLBACK_WEEK_PX = 42;  // only used before the chart has been laid out
const MS_PER_DAY = 86400000;

// Six months of week columns is about as much as a page-wide chart can hold
// before the columns get too narrow to read.
// The cap applies to a custom range too, which is clamped rather than refused.
//
// Presets are sized in whole weeks, not months, so every page of a given preset
// is the same width. That is what makes the back and forward arrows exact
// inverses -- month-derived widths vary between 13 and 14 weeks, and stepping
// back by the current width would then drift.
const MAX_WINDOW_WEEKS = 26;
const WINDOW_PRESETS = [
  { label: "1 month", weeks: 4 },
  { label: "2 months", weeks: 9 },
  { label: "3 months", weeks: 13 },
  { label: "6 months", weeks: MAX_WINDOW_WEEKS },
];

let state = {
  view: "project",
  projects: [],
  currentProjectId: null,
  plan: null,
  portfolio: null,
  graph: null,
  settings: null,
  expandedPhases: new Set(),
  // Which timeline the project view draws. null means "decide from the data":
  // a project with nothing scheduled opens on weeks, anything else on dates.
  // Clicking the switch pins it until you change project.
  timelineMode: null,
  // Both charts share one viewport, so switching tabs keeps your place.
  // `start` is an ISO date, or null meaning "the week containing today".
  // `weeks` is null while a custom range is set, in which case `customEnd` holds it.
  window: { start: null, weeks: MAX_WINDOW_WEEKS, customEnd: null },
  // The last tray placement, kept so it can be reversed exactly: the project's
  // previous start date and the phases that drop dated. In memory only -- a
  // reload loses it, and the offer says so rather than pretending otherwise.
  lastPlacement: null,
};

// --- api --------------------------------------------------------------------

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      detail = (await response.json()).detail || detail;
    } catch (_) { /* body was not json */ }
    throw new Error(detail);
  }
  return response.status === 204 ? null : response.json();
}

// --- helpers ----------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const parseDate = (iso) => new Date(`${iso}T00:00:00`);
const daysBetween = (a, b) => Math.round((b - a) / MS_PER_DAY);

// Built from local parts on purpose: toISOString() would shift the date across
// timezones and silently move phases by a day.
function formatDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function shiftDate(iso, days) {
  const date = parseDate(iso);
  date.setDate(date.getDate() + days);
  return formatDate(date);
}

const todayISO = () => formatDate(new Date());

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// --- week grid (shared by both charts) --------------------------------------

// Charts are laid out in whole-week columns starting on a Monday so that bars,
// gridlines and the ruler all break on the same edges.
function weekStart(date) {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

const addDays = (date, days) => {
  const moved = new Date(date.getTime());
  moved.setDate(moved.getDate() + days);
  return moved;
};

// The visible viewport, in whole week columns. Everything else measures against
// this -- the grid is drawn for the full window even where nothing is planned.
function resolveWindow() {
  const origin = weekStart(
    state.window.start ? parseDate(state.window.start) : new Date());
  // A custom range is rounded out to whole weeks, since a week is the column.
  const requested = state.window.weeks === null
    ? Math.ceil((daysBetween(origin, parseDate(state.window.customEnd)) + 1) / 7)
    : state.window.weeks;

  // A cleared or reversed custom range would otherwise give NaN or a negative,
  // and a chart sized NaN renders as nothing at all.
  const weeks = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), MAX_WINDOW_WEEKS)
    : MAX_WINDOW_WEEKS;
  return { origin, weeks, totalDays: weeks * 7, clamped: requested > MAX_WINDOW_WEEKS };
}

// Sizes `chart` to the window, gives it a ruler, and returns the element bars
// belong in. The column width is fitted here and hung on `view`, so everything
// that draws against the grid afterwards measures with the same figure. Bars
// are positioned against the window origin, which is always the Monday on or
// before the window start.
//
// `ruler` is swappable because the relative timeline counts weeks from the
// start of the project instead of naming dates; everything below the ruler --
// the column width, the gridlines, the way a bar is placed -- is identical.
function weekGrid(chart, view, ruler = weekRuler) {
  // Cleared before measuring: a width left over from the previous render would
  // otherwise be what we measured, and the chart would never resize back down.
  chart.style.width = "";
  view.pxPerWeek = fitWeekPx(chart, view.weeks);
  view.pxPerDay = view.pxPerWeek / 7;

  // Set on the chart rather than the document, since each chart fits its own
  // container. The stylesheet reads it for the gridlines and the ruler cells,
  // which is what keeps them from drifting off where the bars are drawn.
  chart.style.setProperty("--week-px", `${view.pxPerWeek}px`);

  const width = view.weeks * view.pxPerWeek;
  chart.style.width = `${width}px`;
  chart.appendChild(ruler(view));

  const body = element("div", "grid-body");
  body.style.width = `${width}px`;
  chart.appendChild(body);
  return body;
}

// With its own width cleared the chart is a plain block, so it reports exactly
// the room its container gives it. Whole pixels only: a fractional column
// accumulates over 26 of them and pushes the last one past the edge, which is
// the horizontal scrollbar this is meant to avoid.
function fitWeekPx(chart, weeks) {
  const available = chart.clientWidth;
  if (!available) return FALLBACK_WEEK_PX;  // hidden or not yet laid out
  const fitted = Math.floor(available / weeks);
  return Math.min(Math.max(fitted, MIN_WEEK_PX), MAX_WEEK_PX);
}

function weekRuler({ origin, weeks, pxPerWeek }) {
  const ruler = element("div", "ruler");
  const monthRow = element("div", "ruler-row ruler-months");
  const weekRow = element("div", "ruler-row ruler-weeks");

  let block = null;
  let blockKey = null;
  let blockWeeks = 0;

  for (let index = 0; index < weeks; index += 1) {
    const monday = addDays(origin, index * 7);

    // A week belongs to the month its Monday falls in, so month dividers always
    // land on a column edge instead of cutting a week in half.
    const key = `${monday.getFullYear()}-${monday.getMonth()}`;
    if (key !== blockKey) {
      blockKey = key;
      blockWeeks = 0;
      block = element("div", "month",
        monday.toLocaleString(undefined, { month: "short", year: "2-digit" }));
      monthRow.appendChild(block);
    }
    blockWeeks += 1;
    block.style.width = `${blockWeeks * pxPerWeek}px`;

    const cell = element("div", "week", String(monday.getDate()));
    cell.title = `Week of ${formatDate(monday)}`;
    weekRow.appendChild(cell);
  }

  ruler.append(monthRow, weekRow);
  return ruler;
}

// --- window controls --------------------------------------------------------

// Moving the viewport changes nothing on the server, so redraw from the data
// already in hand rather than refetching the plan on every click.
function redraw() {
  if (state.view === "project") {
    if (state.plan) renderProjectView();
  } else if (state.view === "map") {
    if (state.graph) renderMap();
  } else if (state.portfolio) {
    renderPortfolio();
  }
}

// Rebuilt from scratch on every render. Both views call this with their own
// container, and both drive the same state.window, so the two stay in step.
function renderWindowBar(container) {
  container.innerHTML = "";
  const { origin, weeks, clamped } = resolveWindow();
  const custom = state.window.weeks === null;

  const step = (direction) => {
    // Page by exactly the span on screen, so consecutive windows tile with no
    // gap or overlap and stay Monday-aligned.
    const shift = direction * weeks * 7;
    state.window.start = formatDate(addDays(origin, shift));
    if (custom) {
      state.window.customEnd = formatDate(
        addDays(parseDate(state.window.customEnd), shift));
    }
    redraw();
  };

  const back = element("button", "nav", "‹");
  back.title = "Previous period";
  back.onclick = () => step(-1);

  const today = element("button", null, "Today");
  today.title = "Jump back to the period starting this week";
  today.onclick = () => {
    state.window.start = formatDate(weekStart(new Date()));
    if (custom) {
      state.window.customEnd = formatDate(addDays(weekStart(new Date()), weeks * 7 - 1));
    }
    redraw();
  };

  const forward = element("button", "nav", "›");
  forward.title = "Next period";
  forward.onclick = () => step(1);

  const select = element("select");
  for (const preset of WINDOW_PRESETS) {
    const option = element("option", null, preset.label);
    option.value = String(preset.weeks);
    select.appendChild(option);
  }
  const customOption = element("option", null, "Custom…");
  customOption.value = "custom";
  select.appendChild(customOption);
  select.value = custom ? "custom" : String(state.window.weeks);

  select.onchange = () => {
    if (select.value === "custom") {
      state.window.weeks = null;
      // Seed the range from whatever was on screen, so nothing jumps.
      state.window.customEnd = formatDate(addDays(origin, weeks * 7 - 1));
    } else {
      state.window.weeks = Number(select.value);
      state.window.customEnd = null;
    }
    redraw();
  };

  container.append(back, today, forward, select);

  if (custom) {
    const from = element("input");
    from.type = "date";
    from.value = formatDate(origin);
    from.onchange = () => {
      if (from.value) state.window.start = from.value;
      redraw();
    };

    const to = element("input");
    to.type = "date";
    to.value = state.window.customEnd;
    to.onchange = () => {
      if (to.value) state.window.customEnd = to.value;
      redraw();
    };

    container.append(element("span", "window-sep", "from"), from,
                     element("span", "window-sep", "to"), to);
  }

  const last = addDays(origin, weeks * 7 - 1);
  const range = element("span", "window-range",
    `${origin.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`
    + ` – ${last.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`
    + ` (${weeks} weeks)`);
  container.appendChild(range);

  if (clamped) {
    container.appendChild(element("span", "error",
      `Capped at ${MAX_WINDOW_WEEKS} weeks (about 6 months).`));
  }
}

// --- loading ----------------------------------------------------------------

async function loadProjects() {
  state.projects = await api("/api/projects");
  const select = $("project-select");
  select.innerHTML = "";
  for (const project of state.projects) {
    // Ideas stay selectable so you can open one and write its goal; the ring
    // marks them as uncommitted so they cannot be mistaken for real work.
    const label = project.stage === "idea" ? `◌ ${project.name}` : project.name;
    const option = element("option", null, label);
    option.value = project.id;
    select.appendChild(option);
  }

  if (state.projects.length === 0) {
    state.currentProjectId = null;
    state.plan = null;
  } else {
    if (!state.projects.some((p) => p.id === state.currentProjectId)) {
      state.currentProjectId = state.projects[0].id;
    }
    select.value = state.currentProjectId;
  }
  await refreshView();
}

async function refreshView() {
  const isProject = state.view === "project";
  const isPortfolio = state.view === "portfolio";
  const isMap = state.view === "map";
  // The map is still worth showing with nothing planned -- it is where the
  // first future direction gets captured.
  const noProjects = state.projects.length === 0;

  $("empty-state").hidden = !(isProject && noProjects);
  $("workspace").hidden = !isProject || noProjects;
  $("portfolio-view").hidden = !isPortfolio;
  $("map-view").hidden = !isMap;
  $("tab-project").classList.toggle("active", isProject);
  $("tab-portfolio").classList.toggle("active", isPortfolio);
  $("tab-map").classList.toggle("active", isMap);

  if (isProject) {
    if (!noProjects) await loadPlan();
  } else if (isPortfolio) {
    await loadPortfolio();
  } else {
    await loadGraph();
  }
}

async function loadPlan() {
  if (!state.currentProjectId) return;
  state.plan = await api(`/api/projects/${state.currentProjectId}`);
  state.settings = state.plan.settings;
  renderProjectView();
}

async function loadPortfolio() {
  state.portfolio = await api("/api/portfolio");
  renderPortfolio();
}

async function loadGraph() {
  state.graph = await api("/api/graph");
  renderMap();
  renderDirections();
}

// --- project view -----------------------------------------------------------

// A phase is scheduled once it has a real start date. Everything else is still
// just an estimate, and the server reports both dates as "" for those.
const isScheduled = (phase) => Boolean(phase.start_date && phase.end_date);

function renderProjectView() {
  renderProjectFields();
  renderSettingsFields();
  renderWarnings();
  renderUnscheduled();
  renderTimeline();
  renderPhases();
  renderDependencies();
}

function renderUnscheduled() {
  const pending = state.plan.phases.filter((phase) => !isScheduled(phase));
  const section = $("unscheduled-section");
  const list = $("unscheduled-list");

  section.hidden = pending.length === 0;
  $("unscheduled-count").textContent = pending.length;
  list.innerHTML = "";

  for (const phase of pending) {
    const item = element("li");
    item.appendChild(element("span", "unscheduled-name", phase.name));
    item.appendChild(element("span", "muted",
      `${phase.duration_weeks}w · ${phase.effort_points} pts`));
    list.appendChild(item);
  }
}

function renderProjectFields() {
  const project = state.plan.project;
  $("project-goal").value = project.goal || "";
  $("project-name").value = project.name;
  $("project-start").value = project.start_date;
  $("project-stage").value = project.stage;
  $("project-track").value = project.track || "";
  $("project-velocity").value = project.velocity_override ?? "";
}

function renderSettingsFields() {
  $("setting-velocity").value = state.settings.default_velocity_points_per_sprint;
  $("setting-sprint-days").value = state.settings.sprint_length_days;
  $("setting-tolerance").value = state.settings.v1_tolerance_pct;
}

function renderWarnings() {
  const list = $("warning-list");
  const warnings = state.plan.warnings;
  $("warning-count").textContent = warnings.length;
  $("warning-count").className = warnings.length ? "pill pill-warn" : "pill";
  list.innerHTML = "";

  if (warnings.length === 0) {
    list.appendChild(element("li", "ok", "No problems detected."));
    return;
  }
  for (const warning of warnings) {
    const item = element("li");
    item.appendChild(element("span", "rule", warning.rule));
    item.appendChild(document.createTextNode(` ${warning.message}`));
    list.appendChild(item);
  }
}

function warnedPhaseIds() {
  const ids = new Set();
  for (const warning of state.plan.warnings) {
    if (warning.phase_id) ids.add(warning.phase_id);
    if (warning.related_phase_id) ids.add(warning.related_phase_id);
  }
  return ids;
}

// The switch is pinned once you touch it; until then a project with no dates
// anywhere opens on the week grid, because the calendar has nothing to show it.
function timelineMode() {
  if (state.timelineMode) return state.timelineMode;
  return state.plan.phases.some(isScheduled) ? "dates" : "weeks";
}

function renderModeSwitch() {
  const mode = timelineMode();
  $("mode-dates").classList.toggle("active", mode === "dates");
  $("mode-weeks").classList.toggle("active", mode === "weeks");
  $("mode-hint").textContent = mode === "weeks"
    ? "Weeks from the start of the project, whoever that start turns out to be. "
      + "Every phase is here, stacked in order. Drag a bar to re-order them — "
      + "that changes the order only, never a date. Set the project start and "
      + "\"Lay out sequentially\" to turn this shape into real dates."
    : "Real dates. Only phases with a start date appear.";
}

function renderTimeline() {
  renderModeSwitch();
  if (timelineMode() === "weeks") {
    renderRelativeTimeline();
    return;
  }

  $("timeline-window").hidden = false;
  renderWindowBar($("timeline-window"));
  const timeline = $("timeline");
  timeline.innerHTML = "";
  timeline.style.width = "";
  const phases = state.plan.phases.filter(isScheduled);
  if (phases.length === 0) {
    timeline.appendChild(element("p", "muted",
      state.plan.phases.length === 0
        ? "Add a phase to see the timeline."
        : "No phase has a start date yet. Switch to Weeks to arrange them first."));
    return;
  }

  const view = resolveWindow();
  const visible = phases.filter((phase) => inWindow(phase, view));
  offWindowNote(timeline, phases.length - visible.length);

  const body = weekGrid(timeline, view);
  const warned = warnedPhaseIds();
  for (const phase of visible) {
    body.appendChild(phaseBar(phase, view, warned.has(phase.id)));
  }
}

// Half-open against the window: a phase touching the last day is still in.
function phaseSpan(phase, view) {
  return {
    from: daysBetween(view.origin, parseDate(phase.start_date)),
    to: daysBetween(view.origin, parseDate(phase.end_date)),
  };
}

function inWindow(phase, view) {
  const { from, to } = phaseSpan(phase, view);
  return to > 0 && from < view.totalDays;
}

function offWindowNote(chart, count) {
  if (count > 0) {
    chart.appendChild(element("p", "muted",
      `${count} scheduled phase(s) outside this window.`));
  }
}

// Positions a bar inside the window, trimming whatever falls off either end.
// The trimmed edge is marked so a clipped bar cannot be misread as a short one.
function placeBar(bar, from, to, view) {
  const left = Math.max(from, 0);
  const right = Math.min(to, view.totalDays);
  bar.style.marginLeft = `${left * view.pxPerDay}px`;
  bar.style.width = `${Math.max(right - left, 1) * view.pxPerDay}px`;
  bar.classList.toggle("clip-start", from < 0);
  bar.classList.toggle("clip-end", to > view.totalDays);
}

function phaseBar(phase, view, isWarned) {
  const { from, to } = phaseSpan(phase, view);
  const bar = element("div", `bar status-${phase.status}${isWarned ? " bar-warn" : ""}`);
  placeBar(bar, from, to, view);
  bar.title = `${phase.name}: ${phase.start_date} to ${phase.end_date} `
    + `(${phase.duration_weeks}w, ${phase.effort_points} pts)`;
  bar.textContent = phase.name;
  return bar;
}

// --- relative timeline (W1, W2, ...) ----------------------------------------

// The same grid with the calendar taken out: column one is the first week of
// the project, whenever that turns out to be. Phases stack back to back in
// sort order and every one of them is drawn, dated or not -- this view is for
// arranging the shape of the work before committing to when it happens, so a
// date on a phase is simply not what it is measuring.

const phaseWeeks = (phase) => Number(phase.duration_weeks) || 0;

// The saved offsets arrive on each phase as `offset_weeks`; this is the same
// arithmetic client-side, used only to preview an order mid-drag that has not
// been saved yet. A dropped bar reloads and goes back to the server's numbers.
function stackOffsets(phases) {
  const offsets = [];
  let cursor = 0;
  for (const phase of phases) {
    offsets.push(cursor);
    cursor += phaseWeeks(phase);
  }
  return offsets;
}

function renderRelativeTimeline() {
  // Nothing to page through without dates, so the window controls go away.
  $("timeline-window").hidden = true;
  const timeline = $("timeline");
  timeline.innerHTML = "";
  timeline.style.width = "";

  const phases = state.plan.phases;
  if (phases.length === 0) {
    timeline.appendChild(element("p", "muted", "Add a phase to see the timeline."));
    return;
  }

  // Sized to the whole plan rather than a six-month window: there is no date to
  // scroll to, so a plan longer than the page just scrolls sideways.
  const total = phases.reduce((sum, phase) => sum + phaseWeeks(phase), 0);
  const view = { weeks: Math.max(Math.ceil(total), 1) };
  view.totalDays = view.weeks * 7;

  const body = weekGrid(timeline, view, relativeRuler);
  const warned = warnedPhaseIds();

  phases.forEach((phase, index) => {
    body.appendChild(relativeBar(phase, index, phase.offset_weeks, view, warned));
  });
}

function relativeRuler({ weeks }) {
  const ruler = element("div", "ruler");
  const weekRow = element("div", "ruler-row ruler-weeks");
  for (let index = 0; index < weeks; index += 1) {
    const cell = element("div", "week", `W${index + 1}`);
    cell.title = `Week ${index + 1} of the project`;
    weekRow.appendChild(cell);
  }
  ruler.appendChild(weekRow);
  return ruler;
}

function relativeBar(phase, index, offset, view, warned) {
  const isWarned = warned.has(phase.id);
  const bar = element("div",
    `bar status-${phase.status}${isWarned ? " bar-warn" : ""} draggable`);
  placeRelativeBar(bar, offset, phaseWeeks(phase), view);
  const span = `W${Math.floor(offset) + 1}–W${Math.ceil(offset + phaseWeeks(phase))}`;
  bar.title = `${phase.name}: ${span} (${phase.duration_weeks}w, `
    + `${phase.effort_points} pts)  (drag to re-order)`;
  bar.textContent = phase.name;
  makeResequenceable(bar, phase, index, offset, view);
  return bar;
}

// A zero-week phase would otherwise be an invisible bar with nothing to grab,
// so it gets a sliver. Nothing here can fall outside the grid, since the grid
// is sized to the stack -- no clipping to do.
function placeRelativeBar(bar, offset, weeks, view) {
  bar.style.marginLeft = `${offset * view.pxPerWeek}px`;
  bar.style.width = `${Math.max(weeks, 0.25) * view.pxPerWeek}px`;
}

// Dragging re-sequences: it writes `sort_order` and nothing else. No date is
// created and none is moved, so the rule that the timeline never reschedules
// itself is untouched -- this is the ordering the layout button will later
// turn into dates, not a schedule.
function makeResequenceable(bar, phase, index, offset, view) {
  bar.onmousedown = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const body = bar.parentElement;
    const phases = state.plan.phases;
    const others = phases.filter((other) => other.id !== phase.id);
    const bars = new Map(phases.map((item, position) =>
      [item.id, body.children[position]]));
    let targetIndex = index;
    bar.classList.add("dragging");

    const onMove = (moveEvent) => {
      const held = offset + (moveEvent.clientX - startX) / view.pxPerWeek;
      targetIndex = insertionIndex(others, held + phaseWeeks(phase) / 2);

      // Reflow the rest around the gap this phase would leave, so the drop
      // point is read off the stack itself rather than guessed.
      const preview = others.slice();
      preview.splice(targetIndex, 0, phase);
      const offsets = stackOffsets(preview);
      preview.forEach((item, position) => {
        const node = bars.get(item.id);
        body.appendChild(node);
        if (item.id === phase.id) return;
        placeRelativeBar(node, offsets[position], phaseWeeks(item), view);
      });
      // The held bar follows the cursor instead of snapping, so it reads as
      // picked up; the drop lands it wherever the others have made room.
      bar.style.marginLeft = `${Math.max(held, 0) * view.pxPerWeek}px`;
    };

    const onUp = async () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      bar.classList.remove("dragging");
      if (targetIndex === index) {
        renderTimeline();  // put the previewed stack back where it was
        return;
      }
      const reordered = others.slice();
      reordered.splice(targetIndex, 0, phase);
      await saveOrder(reordered);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
}

// Where the held phase lands among the others: past the midpoint of a bar means
// past that bar, which is what makes a short drag feel like it took effect.
function insertionIndex(others, heldCentre) {
  let cursor = 0;
  let index = 0;
  for (const other of others) {
    if (heldCentre < cursor + phaseWeeks(other) / 2) break;
    cursor += phaseWeeks(other);
    index += 1;
  }
  return index;
}

// Renumbered from zero so the stored order matches what is on screen. Only the
// rows that actually moved are written.
async function saveOrder(phases) {
  for (let index = 0; index < phases.length; index += 1) {
    if (phases[index].sort_order === index) continue;
    await api(`/api/phases/${phases[index].id}`, {
      method: "PUT",
      body: JSON.stringify({ sort_order: index }),
    });
  }
  await loadPlan();
}

// --- phases and deliverables ------------------------------------------------

function renderPhases() {
  const body = $("phase-table").querySelector("tbody");
  const warned = warnedPhaseIds();
  body.innerHTML = "";

  for (const phase of state.plan.phases) {
    const row = element("tr", warned.has(phase.id) ? "row-warn" : null);
    const isOpen = state.expandedPhases.has(phase.id);

    const toggleCell = element("td");
    const toggle = element("button", "toggle", isOpen ? "▾" : "▸");
    toggle.title = "Show deliverables";
    toggle.onclick = () => {
      if (isOpen) state.expandedPhases.delete(phase.id);
      else state.expandedPhases.add(phase.id);
      renderPhases();
    };
    toggleCell.appendChild(toggle);
    // Ticked-off count, so a collapsed phase still says how far along it is.
    // Display only: it never feeds a warning and never sets phase.status.
    if (phase.deliverables.length > 0) {
      const doneCount = phase.deliverables.filter((d) => d.done).length;
      const tally = element("span", "done-count",
        `${doneCount}/${phase.deliverables.length}`);
      tally.title = `${doneCount} of ${phase.deliverables.length} deliverables done`;
      toggleCell.appendChild(tally);
    }
    row.appendChild(toggleCell);

    row.appendChild(fieldCell(phase, "name", "text", savePhase));
    row.appendChild(fieldCell(phase, "start_date", "date", savePhase));
    row.appendChild(fieldCell(phase, "duration_weeks", "number", savePhase,
      { step: "0.5", min: "0" }));
    row.appendChild(fieldCell(phase, "effort_points", "number", savePhase,
      { step: "1", min: "0" }));

    const statusCell = element("td");
    const select = element("select");
    for (const status of ["planned", "in_progress", "done"]) {
      const option = element("option", null, status);
      option.value = status;
      select.appendChild(option);
    }
    select.value = phase.status;
    select.onchange = () => savePhase(phase.id, { status: select.value });
    statusCell.appendChild(select);
    row.appendChild(statusCell);

    row.appendChild(element("td", "muted", phase.end_date || "unscheduled"));

    const actionCell = element("td");
    const remove = element("button", null, "Delete");
    remove.onclick = async () => {
      if (!confirm(`Delete phase "${phase.name}" and its deliverables?`)) return;
      await api(`/api/phases/${phase.id}`, { method: "DELETE" });
      state.expandedPhases.delete(phase.id);
      await loadPlan();
    };
    actionCell.appendChild(remove);
    row.appendChild(actionCell);

    body.appendChild(row);
    if (isOpen) body.appendChild(deliverableRow(phase));
  }
}

function deliverableRow(phase) {
  const row = element("tr", "deliverable-row");
  const cell = element("td");
  cell.colSpan = 8;

  const table = element("table", "deliverables");
  const head = element("tr");
  for (const heading of ["Done", "Deliverable", ""]) {
    head.appendChild(element("th", null, heading));
  }
  table.appendChild(head);

  for (const deliverable of phase.deliverables) {
    const line = element("tr", deliverable.done ? "done" : null);

    const tickCell = element("td", "tick");
    const tick = element("input");
    tick.type = "checkbox";
    tick.checked = Boolean(deliverable.done);
    tick.title = deliverable.done ? "Done" : "Still ongoing";
    tick.onchange = () => saveDeliverable(deliverable.id, { done: tick.checked });
    tickCell.appendChild(tick);
    line.appendChild(tickCell);

    line.appendChild(fieldCell(deliverable, "name", "text", saveDeliverable));

    const actionCell = element("td");
    const remove = element("button", null, "✕");
    remove.title = "Delete deliverable";
    remove.onclick = async () => {
      await api(`/api/deliverables/${deliverable.id}`, { method: "DELETE" });
      await loadPlan();
    };
    actionCell.appendChild(remove);
    line.appendChild(actionCell);
    table.appendChild(line);
  }

  const adder = element("tr");
  // Nothing to tick yet -- a new deliverable always starts ongoing.
  const spacerCell = element("td");
  const nameCell = element("td");
  const nameInput = element("input");
  nameInput.placeholder = "New deliverable";
  nameCell.appendChild(nameInput);

  const buttonCell = element("td");
  const add = element("button", null, "Add");
  add.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    await api(`/api/phases/${phase.id}/deliverables`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    await loadPlan();
  };
  nameInput.onkeydown = (event) => { if (event.key === "Enter") add.click(); };
  buttonCell.appendChild(add);

  adder.append(spacerCell, nameCell, buttonCell);
  table.appendChild(adder);

  cell.appendChild(table);
  row.appendChild(cell);
  return row;
}

function fieldCell(record, key, type, save, attributes = {}) {
  const cell = element("td");
  const input = element("input");
  input.type = type;
  input.value = record[key];
  Object.assign(input, attributes);
  input.onchange = () => {
    const value = type === "number" ? Number(input.value) : input.value;
    save(record.id, { [key]: value });
  };
  cell.appendChild(input);
  return cell;
}

async function savePhase(phaseId, fields) {
  await api(`/api/phases/${phaseId}`, { method: "PUT", body: JSON.stringify(fields) });
  await loadPlan();
}

async function saveDeliverable(deliverableId, fields) {
  await api(`/api/deliverables/${deliverableId}`, {
    method: "PUT",
    body: JSON.stringify(fields),
  });
  await loadPlan();
}

// Both directions are listed together: what this project waits on, and what
// waits on it. The server sends every link the project is an end of, with the
// other project's name already resolved.
function renderDependencies() {
  const list = $("dependency-list");
  const current = state.currentProjectId;
  list.innerHTML = "";

  if (state.plan.dependencies.length === 0) {
    list.appendChild(element("li", "muted", "No dependencies."));
  }
  for (const dep of state.plan.dependencies) {
    const waitsOnThis = dep.predecessor_project_id === current;
    const item = element("li", null, waitsOnThis
      ? `→ ${dep.successor_name} waits on this project`
      : `← waits on ${dep.predecessor_name}`);
    const remove = element("button", null, "Unlink");
    remove.onclick = async () => {
      await api(`/api/dependencies/${dep.id}`, { method: "DELETE" });
      await loadPlan();
    };
    item.appendChild(remove);
    list.appendChild(item);
  }

  const select = $("dep-other");
  const previous = select.value;
  select.innerHTML = "";
  // Every project but this one -- a project cannot depend on itself, and
  // offering it would only earn a 409.
  for (const project of state.projects.filter((p) => p.id !== current)) {
    const option = element("option", null,
      project.stage === "idea" ? `◌ ${project.name}` : project.name);
    option.value = project.id;
    select.appendChild(option);
  }
  select.value = previous;
}

// --- portfolio view ---------------------------------------------------------

function renderPortfolio() {
  renderWindowBar($("portfolio-window"));
  renderPortfolioDependencies();
  const chart = $("portfolio-chart");
  chart.innerHTML = "";
  chart.style.width = "";
  const { projects, phases, unscheduled } = state.portfolio;

  if (phases.length === 0) {
    chart.appendChild(element("p", "muted",
      unscheduled.length
        ? "Nothing is scheduled yet — drag a project from above onto a week."
        : "Nothing planned yet."));
  }

  const view = resolveWindow();
  const visible = phases.filter((phase) => inWindow(phase, view));
  offWindowNote(chart, phases.length - visible.length);

  // Drawn even with nothing on it: the empty grid is the drop target for the
  // tray, and a dataset where nothing is dated yet is exactly when you need it.
  const body = weekGrid(chart, view);

  for (const project of projects) {
    const own = visible.filter((phase) => phase.project_id === project.id);
    if (own.length === 0) continue;

    const lane = element("div", "lane");
    lane.appendChild(element("div", "lane-title", project.name));
    for (const phase of own) {
      const bar = phaseBar(phase, view, false);
      bar.classList.add("draggable");
      bar.title += "  (drag to move; hold Alt for day steps)";
      makeDraggable(bar, phase, view);
      lane.appendChild(bar);
    }
    body.appendChild(lane);
  }

  renderTray(body, view);
  renderPlacementUndo();
}

// Work that is estimated but undated, waiting to be dropped onto the grid. The
// project view is where a plan is shaped -- weeks, points, phase order -- and
// this is where that shape gets a date, without retyping any of it.
function renderTray(body, view) {
  const { unscheduled, unscheduled_count: pending } = state.portfolio;
  const tray = $("portfolio-tray");
  $("tray-section").hidden = unscheduled.length === 0;
  $("tray-count").textContent = `${pending} phase(s)`;
  tray.innerHTML = "";

  for (const entry of unscheduled) {
    const chip = element("div", "tray-chip");
    chip.appendChild(element("span", "tray-name", entry.project_name));
    chip.appendChild(element("span", "muted",
      `${entry.phases.length} phase(s) · ${entry.total_weeks}w · ${entry.total_points} pts`));
    // What the drop will and will not touch, spelled out before you commit to it.
    if (entry.scheduled_count) {
      chip.appendChild(element("span", "tray-note",
        `${entry.scheduled_count} dated phase(s) stay put`));
    }
    if (entry.start_date) {
      chip.appendChild(element("span", "tray-note",
        `starts ${entry.start_date} — dropping moves it`));
    }
    chip.title = `${entry.project_name}\n`
      + entry.phases.map((phase) =>
        `  ${phase.name} — ${phase.duration_weeks}w, ${phase.effort_points} pts`).join("\n")
      + "\n\nDrag onto a week to place. Hold Alt for single days.";
    makeTrayDraggable(chip, entry, body, view);
    tray.appendChild(chip);
  }
}

// How far the pointer has to travel before a press on a chip counts as a drag.
// A placement dates every undated phase in a project, so it has to come from a
// deliberate gesture: without this, a few pixels of hand shake during a click
// reads as a drag to the left edge and files the project at the start of the
// window. Bars do not need it -- their snap is relative to where they already
// are, so a twitch resolves to a zero-day move and writes nothing.
const DRAG_ARM_PX = 4;

// The portfolio-side twin of the project view's "Lay out" button: the drop
// writes the project start date you let go on, then asks the server to stack
// the undated phases from it. Still nothing automatic -- the date comes from
// the gesture, and only the phases with no date of their own move.
function makeTrayDraggable(chip, entry, body, view) {
  chip.onmousedown = (event) => {
    event.preventDefault();
    const from = { x: event.clientX, y: event.clientY };
    // Half a week minimum so a project of tiny phases is still grabbable.
    const span = Math.max(entry.total_weeks * 7, 3.5);
    let lane = null;
    let ghost = null;
    let dropDay = null;

    // A ghost lane rather than a floating element: the bar lands on the same
    // gridlines the real ones use, so the week you are about to pick is read
    // off the ruler instead of guessed. Built on arming, not on mousedown, so
    // an unarmed press leaves the chart untouched.
    const arm = () => {
      lane = element("div", "lane lane-ghost");
      lane.appendChild(element("div", "lane-title", entry.project_name));
      ghost = element("div", "bar tray-ghost");
      lane.appendChild(ghost);
      body.appendChild(lane);
      chip.classList.add("dragging");
    };

    const onMove = (moveEvent) => {
      if (!lane) {
        const travelled = Math.hypot(moveEvent.clientX - from.x, moveEvent.clientY - from.y);
        if (travelled < DRAG_ARM_PX) return;
        arm();
      }
      const rect = body.getBoundingClientRect();
      const raw = (moveEvent.clientX - rect.left) / view.pxPerDay;
      // Whole weeks by default, matching how bars are dragged; Alt for a
      // project that has to begin mid-week.
      const snapped = moveEvent.altKey ? Math.round(raw) : Math.round(raw / 7) * 7;
      dropDay = Math.min(Math.max(snapped, 0), view.totalDays - 1);
      placeBar(ghost, dropDay, dropDay + span, view);
      ghost.textContent = `${entry.project_name} → ${formatDate(addDays(view.origin, dropDay))}`;
    };

    const onUp = async () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      chip.classList.remove("dragging");
      if (lane) lane.remove();
      // A press that never armed is a click, and a click must not schedule
      // anything -- a date this consequential only comes from a real drag.
      if (dropDay === null) return;

      const startDate = formatDate(addDays(view.origin, dropDay));
      try {
        await api(`/api/projects/${entry.project_id}`, {
          method: "PUT",
          body: JSON.stringify({ start_date: startDate }),
        });
        // The layout call reports exactly which phases it dated, which together
        // with the project's previous start is the whole of what this drop
        // changed -- so the undo below is an exact inverse, not a guess.
        const result = await api(`/api/projects/${entry.project_id}/layout`,
          { method: "POST" });
        state.lastPlacement = {
          projectId: entry.project_id,
          projectName: entry.project_name,
          startDate,
          previousStart: entry.start_date,
          phaseIds: Object.keys(result.placements),
        };
      } catch (failure) {
        alert(`Could not place ${entry.project_name}: ${failure.message}`);
      }
      await loadPortfolio();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
}

// One drop writes a date to a whole run of phases, so undoing it by hand means
// clearing them one at a time in the project view. This offers the reversal
// while the client still remembers what the drop did.
function renderPlacementUndo() {
  const bar = $("place-undo");
  const last = state.lastPlacement;
  bar.innerHTML = "";
  bar.hidden = !last;
  if (!last) return;

  bar.appendChild(element("span", null,
    `Placed ${last.projectName} at ${last.startDate} — `
    + `${last.phaseIds.length} phase(s) dated.`));

  const undo = element("button", null, "Undo");
  undo.onclick = undoPlacement;
  bar.appendChild(undo);

  const dismiss = element("button", null, "Dismiss");
  dismiss.onclick = () => {
    state.lastPlacement = null;
    renderPlacementUndo();
  };
  bar.appendChild(dismiss);

  bar.appendChild(element("span", "muted", "Reloading the page loses this."));
}

// The exact inverse of the drop: blank the phases it dated -- and only those,
// so a half-placed project keeps the dates it already had -- then put the
// project's own start date back to whatever it was, empty included.
async function undoPlacement() {
  const last = state.lastPlacement;
  if (!last) return;
  try {
    for (const phaseId of last.phaseIds) {
      await api(`/api/phases/${phaseId}`, {
        method: "PUT",
        body: JSON.stringify({ start_date: "" }),
      });
    }
    await api(`/api/projects/${last.projectId}`, {
      method: "PUT",
      body: JSON.stringify({ start_date: last.previousStart }),
    });
  } catch (failure) {
    alert(`Could not undo: ${failure.message}`);
  }
  state.lastPlacement = null;
  await loadPortfolio();
}

// Dependencies are drawn as a list rather than arrows between swimlanes: a link
// can point at an idea, which has no bar to draw an arrow to. Ordered as linked,
// which is the order the server returns.
function renderPortfolioDependencies() {
  const list = $("portfolio-dep-list");
  const { dependencies, warnings } = state.portfolio;
  const count = $("portfolio-dep-count");
  list.innerHTML = "";

  const violated = new Map();
  for (const warning of warnings) {
    violated.set(`${warning.related_project_id}->${warning.project_id}`, warning);
  }
  count.textContent = dependencies.length;
  count.className = violated.size ? "pill pill-warn" : "pill";

  if (dependencies.length === 0) {
    list.appendChild(element("li", "muted", "No dependencies between projects."));
    return;
  }
  for (const dep of dependencies) {
    const item = element("li", null,
      `${dep.predecessor_name} → ${dep.successor_name}`);
    const warning = violated.get(
      `${dep.predecessor_project_id}->${dep.successor_project_id}`);
    if (warning) {
      item.appendChild(element("span", "rule", "V2"));
      item.appendChild(element("span", "muted", warning.message));
    }
    list.appendChild(item);
  }
}

function makeDraggable(bar, phase, view) {
  bar.onmousedown = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const { from, to } = phaseSpan(phase, view);
    const label = bar.textContent;
    let dayDelta = 0;
    bar.classList.add("dragging");

    const onMove = (moveEvent) => {
      const rawDelta = (moveEvent.clientX - startX) / view.pxPerDay;
      // Land on a column edge so the drop point is readable off the grid.
      // Alt drops back to whole days for a phase that must start mid-week.
      dayDelta = moveEvent.altKey
        ? Math.round(rawDelta)
        : Math.round((from + rawDelta) / 7) * 7 - from;
      // Re-clip as it moves, so dragging a bar off the edge of the window
      // shortens it against the boundary instead of overflowing the chart.
      placeBar(bar, from + dayDelta, to + dayDelta, view);
      bar.textContent = dayDelta === 0
        ? label
        : `${label} → ${shiftDate(phase.start_date, dayDelta)}`;
    };

    const onUp = async () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      bar.classList.remove("dragging");
      bar.textContent = label;
      if (dayDelta === 0) return;
      // Only this phase moves. Dependents stay put and start warning instead.
      await api(`/api/phases/${phase.id}`, {
        method: "PUT",
        body: JSON.stringify({ start_date: shiftDate(phase.start_date, dayDelta) }),
      });
      await loadPortfolio();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
}

// --- map view ---------------------------------------------------------------

// A hand-rolled radial layout rather than a force simulation: the same projects
// land in the same places every time the page opens, so the shape of the team's
// work is something you can learn to read rather than re-decipher.
const SVG_NS = "http://www.w3.org/2000/svg";
// The rings are ellipses (see below), and the gap between two of them is at its
// thinnest on the short vertical axis -- which is where the rings run out of
// room for the labels between them. The floor buys that gap back.
//
// The height is not fixed, because the width is not either: the map view is the
// one part of the page that is not capped at 1100px, so on a wide monitor a
// fixed height would stretch the rings flat and push every node out to the far
// left and right. It grows just enough to hold the ellipse under
// MAX_RING_ASPECT, then stops so the map still fits on a screen. At the width
// the old 1100px cap allowed, the floor wins and nothing moves.
const MIN_MAP_HEIGHT = 680;
const MAX_MAP_HEIGHT = 860;
const MAX_RING_ASPECT = 1.8;
// Rings are ellipses, not circles: a page-wide canvas is far wider than it is
// tall, and a circle sized to the height would leave the sides empty and crowd
// everything into the middle.
// The margins differ because a label is far wider than it is tall, and on the
// flanks -- the ends of the long axis -- it runs outwards rather than across.
// The x margin has to clear most of a label rather than half of one: on the
// flanks a label runs outwards from its node instead of straddling it. Sized
// against a typical name rather than the widest possible one -- 20 characters
// at 12px on a 38px node would want 186px, and buying that back off the rings
// crowds every label on the map to keep one hypothetical one off the edge.
const MAP_MARGIN_X = 170;
const MAP_MARGIN_Y = 92;
const HUB_RADIUS = 54;
const MIN_NODE_R = 16;
const MAX_NODE_R = 38;
// Ring positions as fractions of the usable radius. Ideas sit furthest out:
// distance from the centre reads as distance from being committed to.
// Pulled in towards the hub to open up the track-to-subtrack gap, which is the
// tightest one on the map: both rings carry a label and neither has a node big
// enough to need the room elsewhere.
const TRACK_RING = 0.36;
// Not the midpoint of track and project, and closer to its track than to the
// ring outside it: a subtrack with a single project sits at that project's own
// angle, and a 38px node on the 0.74 ring reaches a long way back towards it.
// Labels no longer reach radially -- they run along the arc -- but a circle
// still does, so the clearance is set by the node rather than by the text.
// Sitting nearer the track also reads correctly: a subtrack belongs to one.
const SUBTRACK_RING = 0.48;
const PROJECT_RING = 0.74;
const IDEA_RING = 1.0;
const TRACK_DOT = 6;
const SUBTRACK_DOT = 4;
// Line height of a label block, and the clear space between a circle's rim and
// the nearest edge of its label.
const LABEL_LINE = 13;
const LABEL_GAP = 8;
// Which way a label leans off its node -- see labelPlace.
const ALONG_RING = true;
const ACROSS_RING = false;
// A track splits into a subtrack on the first slash: "Source expansion /
// Metrics". Convention, not schema -- project.track stays one free-text column
// and a name without a slash is simply a track with no subtracks under it.
const SUBTRACK_SEPARATOR = "/";

function svgElement(tag, attributes = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, String(value));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

const truncate = (text, limit) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

const polar = (cx, cy, rings, fraction, angle) => ({
  x: cx + rings.x * fraction * Math.cos(angle),
  y: cy + rings.y * fraction * Math.sin(angle),
});

// Area carries the comparison, not radius -- twice the points should look twice
// as big, which is what the square root gives.
function nodeRadius(points, largest) {
  if (!largest) return MIN_NODE_R;
  return MIN_NODE_R + (MAX_NODE_R - MIN_NODE_R)
    * Math.sqrt(Math.max(points, 0) / largest);
}

// How tall the canvas has to be for a ring of this width to stay under
// MAX_RING_ASPECT. Inverts the `height / 2 - MAP_MARGIN_Y` that gives the
// vertical radius, so the two stay in step.
function mapHeight(ringX) {
  const wanted = 2 * (ringX / MAX_RING_ASPECT + MAP_MARGIN_Y);
  return Math.round(
    Math.min(Math.max(wanted, MIN_MAP_HEIGHT), MAX_MAP_HEIGHT));
}

// Equal angles are not equal distances on an ellipse: a radian near 3 o'clock
// buys `rings.y` pixels of travel where one near 12 buys `rings.x`, so evenly
// spaced angles bunch up the flanks -- exactly where a label needs the most
// room. Slots are spaced along the ring's arc length instead. The curve is
// sampled once per render and the mapping inverted by lookup; there is a closed
// form, but it is an elliptic integral and this is a chart. The project ring is
// the one measured, because it is the crowded one -- the inner rings only
// follow the angles it hands out.
function arcRuler(rings, fraction, samples = 720) {
  const rx = rings.x * fraction;
  const ry = rings.y * fraction;
  const step = (Math.PI * 2) / samples;
  const start = -Math.PI / 2;  // 12 o'clock, going clockwise
  const at = (index) => ({
    x: rx * Math.cos(start + index * step),
    y: ry * Math.sin(start + index * step),
  });

  const lengths = [0];
  let previous = at(0);
  for (let index = 1; index <= samples; index += 1) {
    const point = at(index);
    lengths.push(lengths[index - 1]
      + Math.hypot(point.x - previous.x, point.y - previous.y));
    previous = point;
  }

  const total = lengths[samples];
  return {
    total,
    // Distance travelled around the ring from 12 o'clock -> the angle you are
    // standing at, straddling the two samples it falls between.
    angleAt(distance) {
      const along = ((distance % total) + total) % total;
      let low = 0;
      let high = samples;
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (lengths[mid] <= along) low = mid;
        else high = mid;
      }
      const gap = lengths[high] - lengths[low] || 1;
      return start + (low + (along - lengths[low]) / gap) * step;
    },
  };
}

// Which side of its circle a node's label hangs on. The text itself always
// stays horizontal; only the side changes, and it is picked off the ellipse
// rather than off the screen -- "below the circle" is only away from the hub on
// the bottom half of the map, which is why hanging every label downwards put
// half of them on the ring inside.
//
// A project leans ACROSS_RING, straight out, into the empty space past the
// outermost ring. A track or subtrack leans ALONG_RING instead, following the
// arc it sits on: the gap between two rings is 40-55px where a label is up to
// 140px wide, so anything reaching outwards or inwards from an inner ring lands
// on the ring behind it. Along the ring there is nothing but empty arc, because
// an inner ring holds one node per group rather than one per project.
//
// Whichever way it leans, the bigger component of that direction picks the axis
// and its sign picks the side, so a label never straddles the thing it is
// trying to avoid.
function labelPlace(point, rings, angle, clearance, along) {
  const radial = {
    x: rings.x * Math.cos(angle), y: rings.y * Math.sin(angle),
  };
  const tangent = {
    x: -rings.x * Math.sin(angle), y: rings.y * Math.cos(angle),
  };
  const lean = along ? tangent : radial;

  if (Math.abs(lean.x) >= Math.abs(lean.y)) {
    const side = lean.x >= 0 ? 1 : -1;
    return {
      x: point.x + side * clearance, y: point.y,
      anchor: side > 0 ? "start" : "end", stack: 0,
    };
  }

  const side = lean.y >= 0 ? 1 : -1;
  return {
    x: point.x, y: point.y + side * clearance, anchor: "middle", stack: side,
  };
}

// A block of horizontal lines placed clear of a node's circle. `stack` says
// where the block sits relative to the attachment point: below it, above it, or
// straddling it. A tspan's `dy` only ever stacks downwards, so a block that
// hangs above its node has to start a whole block-height higher, and one
// alongside half of that.
function labelText(lines, place, className) {
  const attributes = { x: place.x, y: place.y, "text-anchor": place.anchor };
  if (className) attributes.class = className;
  const text = svgElement("text", attributes);

  const height = LABEL_LINE * (lines.length - 1);
  let first = 4 - height / 2;
  if (place.stack > 0) first = 9;
  if (place.stack < 0) first = -height - 3;

  lines.forEach((line, index) => {
    const span = { x: place.x, dy: index === 0 ? first : LABEL_LINE };
    if (line.className) span.class = line.className;
    text.appendChild(svgElement("tspan", span, line.text));
  });
  return text;
}

// "Source expansion / Metrics" -> track "Source expansion", sub "Metrics".
// Only the first slash splits, so a subtrack may contain one. A name with
// nothing before the slash is not half a hierarchy -- it is just a track.
function splitTrack(raw) {
  const text = (raw || "").trim();
  const cut = text.indexOf(SUBTRACK_SEPARATOR);
  if (cut === -1) return { track: text, sub: "" };

  const track = text.slice(0, cut).trim();
  const sub = text.slice(cut + 1).trim();
  return track ? { track, sub } : { track: sub, sub: "" };
}

// Tracks sorted by name, subtracks by name, projects by id, so nothing
// reshuffles between renders. Untracked projects come last and hang straight
// off the hub; within a track, projects with no subtrack come first and hang
// straight off the track.
function mapGroups(projects) {
  const byTrack = new Map();
  for (const project of projects) {
    const { track, sub } = splitTrack(project.track);
    if (!byTrack.has(track)) byTrack.set(track, new Map());
    const bySub = byTrack.get(track);
    if (!bySub.has(sub)) bySub.set(sub, []);
    bySub.get(sub).push(project);
  }

  const build = (track) => {
    const bySub = byTrack.get(track);
    const direct = bySub.get("") || [];
    const subs = [...bySub.keys()]
      .filter((name) => name !== "")
      .sort()
      .map((name) => ({ name, projects: bySub.get(name) }));

    for (const list of [direct, ...subs.map((sub) => sub.projects)]) {
      list.sort((a, b) => a.id - b.id);
    }
    const total = subs.reduce((count, sub) => count + sub.projects.length,
      direct.length);
    return { track: track || null, direct, subs, total };
  };

  const groups = [...byTrack.keys()]
    .filter((key) => key !== "")
    .sort()
    .map(build);
  if (byTrack.has("")) groups.push(build(""));
  return groups;
}

function renderMap() {
  const canvas = $("map-canvas");
  canvas.innerHTML = "";
  $("department-name").value = state.graph.department_name || "";

  const projects = state.graph.projects;
  if (projects.length === 0) {
    canvas.appendChild(element("p", "muted",
      "Nothing here yet. Capture a future direction below to start the map."));
    return;
  }

  const width = Math.max(canvas.clientWidth || 900, 480);
  // Width first, then the height that keeps the ellipse in shape, then the
  // vertical radius that falls out of it. Both radii are floored so a narrow
  // container still leaves the rings clear of the hub rather than collapsing
  // them onto it.
  const ringX = Math.max(width / 2 - MAP_MARGIN_X, HUB_RADIUS + MAX_NODE_R);
  const height = mapHeight(ringX);
  const cx = width / 2;
  const cy = height / 2;
  const rings = {
    x: ringX,
    y: Math.max(height / 2 - MAP_MARGIN_Y, HUB_RADIUS + MAX_NODE_R),
  };

  const svg = svgElement("svg", {
    class: "map", width, height,
    viewBox: `0 0 ${width} ${height}`,
  });
  svg.appendChild(arrowDefs());
  const edges = svgElement("g", { class: "map-edges" });
  // Between the two: a focus line should pass under the circles it joins, not
  // across their labels.
  const focusEdges = svgElement("g", { class: "map-focus-edges" });
  const nodes = svgElement("g", { class: "map-nodes" });
  svg.append(edges, focusEdges, nodes);
  const centres = new Map();

  const largest = Math.max(...projects.map((project) => project.effort_points), 0);
  const groups = mapGroups(projects);
  // A wedge per group, sized by how many projects it holds, so a busy track
  // gets the room it needs instead of every track getting an equal slice. The
  // size is a length of ring rather than an angle -- see arcRuler.
  const weight = groups.reduce(
    (total, group) => total + Math.max(group.total, 1), 0);
  const ruler = arcRuler(rings, PROJECT_RING);

  let travelled = 0;  // start at 12 o'clock and go clockwise
  for (const group of groups) {
    const span = (Math.max(group.total, 1) / weight) * ruler.total;

    let anchor = { x: cx, y: cy };
    if (group.track) {
      const trackAngle = ruler.angleAt(travelled + span / 2);
      anchor = polar(cx, cy, rings, TRACK_RING, trackAngle);
      edges.appendChild(svgElement("line", {
        class: "map-edge", x1: cx, y1: cy, x2: anchor.x, y2: anchor.y,
      }));
      nodes.appendChild(trackNode(group.track, anchor, labelPlace(
        anchor, rings, trackAngle, TRACK_DOT + LABEL_GAP, ALONG_RING)));
    }

    // Every project still gets one angular slot, subtracked ones after the
    // loose ones. A subtrack owns a contiguous run of those slots, which is
    // what lets its node sit at the middle of the slice its projects occupy.
    const slots = [
      ...group.direct.map((project) => ({ project, sub: null })),
      ...group.subs.flatMap(
        (sub) => sub.projects.map((project) => ({ project, sub }))),
    ];
    // Every slot owns an equal length of the group's ring, so two neighbours
    // are the same number of pixels apart wherever on the map they land.
    const step = span / (slots.length + 1);
    const distanceAt = (index) => travelled + step * (index + 1);

    // Anchors and edges now, but the nodes themselves go on after the projects:
    // a subtrack sits close enough to the ring outside it that a large circle
    // would otherwise paint over its label.
    const subAnchors = new Map();
    const subNodes = [];
    for (const sub of group.subs) {
      const owned = slots.reduce((found, slot, index) =>
        (slot.sub === sub ? [...found, index] : found), []);
      // The middle of the run measured in ring length, not in angle: the two
      // stopped being the same thing once the steps became unequal. Distances
      // also climb steadily where angles wrap, so there is no seam to handle.
      const middle = (distanceAt(owned[0])
        + distanceAt(owned[owned.length - 1])) / 2;
      const subAngle = ruler.angleAt(middle);
      const point = polar(cx, cy, rings, SUBTRACK_RING, subAngle);
      subAnchors.set(sub, point);

      edges.appendChild(svgElement("line", {
        class: "map-edge", x1: anchor.x, y1: anchor.y, x2: point.x, y2: point.y,
      }));
      subNodes.push(subtrackNode(sub.name, point, labelPlace(
        point, rings, subAngle, SUBTRACK_DOT + LABEL_GAP, ALONG_RING)));
    }

    slots.forEach((slot, index) => {
      const isIdea = slot.project.stage === "idea";
      const from = slot.sub ? subAnchors.get(slot.sub) : anchor;
      const angle = ruler.angleAt(distanceAt(index));
      const point = polar(cx, cy, rings, isIdea ? IDEA_RING : PROJECT_RING,
        angle);
      edges.appendChild(svgElement("line", {
        class: `map-edge${isIdea ? " map-edge-idea" : ""}`,
        x1: from.x, y1: from.y, x2: point.x, y2: point.y,
      }));
      const radius = nodeRadius(slot.project.effort_points, largest);
      centres.set(slot.project.id, { x: point.x, y: point.y, r: radius });
      nodes.appendChild(projectNode(slot.project, point, radius, labelPlace(
        point, rings, angle, radius + LABEL_GAP, ACROSS_RING)));
    });

    for (const node of subNodes) nodes.appendChild(node);
    travelled += span;
  }

  // Last, so the hub draws over any spoke that passes near the centre.
  nodes.appendChild(hubNode(state.graph.department_name, cx, cy));
  wireMapFocus(svg, focusEdges, centres);
  canvas.appendChild(svg);
}

function arrowDefs() {
  const defs = svgElement("defs");
  const marker = svgElement("marker", {
    id: "map-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5,
    markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse",
  });
  marker.appendChild(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z" }));
  defs.appendChild(marker);
  return defs;
}

// Pull a line's end back to the rim of the circle it points at, so the
// arrowhead lands where you can see it instead of under the node.
function trimToRim(from, to, clearance) {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return {
    x: from.x + ((to.x - from.x) / length) * clearance,
    y: from.y + ((to.y - from.y) / length) * clearance,
  };
}

// Pointing at a project dims the rest of the map and draws the dependencies it
// sits on. Drawing every link on every render was the alternative and it turns
// a radial layout into spaghetti; this way a correlation that crosses tracks is
// still one hover away. Hovering a project with no links does nothing -- there
// is no reason to grey out the map to say "nothing here".
function wireMapFocus(svg, focusEdges, centres) {
  const links = state.graph.dependencies || [];
  const neighbours = new Map();
  for (const link of links) {
    const ends = [link.predecessor_project_id, link.successor_project_id];
    for (const [end, other] of [ends, [...ends].reverse()]) {
      if (!neighbours.has(end)) neighbours.set(end, new Set());
      neighbours.get(end).add(other);
    }
  }

  const marked = () => svg.querySelectorAll(".focus-self, .focus-linked");
  const clear = () => {
    svg.classList.remove("map-focused");
    while (focusEdges.firstChild) focusEdges.removeChild(focusEdges.firstChild);
    for (const node of marked()) {
      node.classList.remove("focus-self", "focus-linked");
    }
  };

  const focus = (projectId) => {
    const linked = neighbours.get(projectId);
    if (!linked || linked.size === 0) return;

    clear();
    svg.classList.add("map-focused");
    for (const node of svg.querySelectorAll("[data-project-id]")) {
      const id = Number(node.dataset.projectId);
      if (id === projectId) node.classList.add("focus-self");
      else if (linked.has(id)) node.classList.add("focus-linked");
    }

    for (const link of links) {
      const from = centres.get(link.predecessor_project_id);
      const to = centres.get(link.successor_project_id);
      if (!from || !to) continue;
      if (link.predecessor_project_id !== projectId
        && link.successor_project_id !== projectId) continue;

      const start = trimToRim(from, to, from.r + 2);
      const end = trimToRim(to, from, to.r + 3);
      focusEdges.appendChild(svgElement("line", {
        class: "map-focus-edge", "marker-end": "url(#map-arrow)",
        x1: start.x, y1: start.y, x2: end.x, y2: end.y,
      }));
    }
  };

  for (const node of svg.querySelectorAll("[data-project-id]")) {
    const id = Number(node.dataset.projectId);
    node.addEventListener("mouseenter", () => focus(id));
    node.addEventListener("mouseleave", clear);
    // The nodes are already focusable for the click-to-open handler, so the
    // keyboard gets the same highlight for free.
    node.addEventListener("focus", () => focus(id));
    node.addEventListener("blur", clear);
  }
}

function hubNode(name, cx, cy) {
  const group = svgElement("g", { class: "map-hub" });
  group.appendChild(svgElement("circle", { cx, cy, r: HUB_RADIUS }));

  // "Platform Engineering | Product" reads as two lines; the pipe is the break.
  const parts = (name || "Your department")
    .split("|").map((part) => part.trim()).filter(Boolean);
  const text = svgElement("text", { x: cx, y: cy, "text-anchor": "middle" });
  parts.forEach((part, index) => {
    text.appendChild(svgElement("tspan", {
      x: cx,
      dy: index === 0 ? 4 - (parts.length - 1) * 7 : 14,
    }, truncate(part, 18)));
  });

  group.appendChild(text);
  return group;
}

const trackNode = (track, point, place) =>
  groupNode("map-track", track, point, TRACK_DOT, place, 22);

const subtrackNode = (name, point, place) =>
  groupNode("map-subtrack", name, point, SUBTRACK_DOT, place, 18);

// Both are placed ALONG_RING by their caller, so a subtrack's name runs into
// the empty arc beside it rather than onto the ring in front or behind.
function groupNode(className, label, point, radius, place, limit) {
  const group = svgElement("g", { class: className });
  group.appendChild(
    svgElement("circle", { cx: point.x, cy: point.y, r: radius }));
  group.appendChild(labelText([{ text: truncate(label, limit) }], place));
  return group;
}

function projectNode(project, point, radius, place) {
  const group = svgElement("g", {
    class: `map-node stage-${project.stage}`, tabindex: "0", role: "button",
    "data-project-id": project.id,
  });
  group.appendChild(svgElement("circle", { cx: point.x, cy: point.y, r: radius }));

  const meta = [];
  if (project.stage === "idea") {
    meta.push("future direction");
  } else if (project.phases_total > 0) {
    meta.push(`${project.phases_done}/${project.phases_total} phases`);
  } else {
    meta.push("no phases yet");
  }
  if (project.next_date) meta.push(`next ${project.next_date}`);

  group.appendChild(labelText([
    { text: truncate(project.name, 20), className: "map-name" },
    ...meta.map((line) => ({ text: line, className: "map-meta" })),
  ], place, "map-label"));

  // The full name and goal live in the tooltip, since the label is truncated.
  group.appendChild(svgElement("title", {}, [
    `${project.name} — ${project.stage}`,
    `${project.effort_points} pts`,
    project.phases_total ? `${project.phases_done}/${project.phases_total} phases done` : null,
    project.next_date ? `next ${project.next_date}` : null,
    project.goal || null,
  ].filter(Boolean).join("\n")));

  const open = async () => {
    state.currentProjectId = project.id;
    state.view = "project";
    state.expandedPhases.clear();
    state.timelineMode = null;
    $("project-select").value = project.id;
    await refreshView();
  };
  group.onclick = open;
  group.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };
  return group;
}

function renderDirections() {
  const list = $("direction-list");
  const ideas = state.graph.projects.filter((project) => project.stage === "idea");
  $("direction-count").textContent = ideas.length;
  list.innerHTML = "";

  if (ideas.length === 0) {
    list.appendChild(element("li", "muted", "No future directions captured yet."));
    return;
  }

  for (const idea of ideas) {
    const item = element("li");
    item.appendChild(element("span", "direction-name", idea.name));
    if (idea.track) item.appendChild(element("span", "muted", idea.track));

    const promote = element("button", null, "Promote to project");
    promote.title = "Make this active, keeping everything already written against it";
    promote.onclick = async () => {
      await api(`/api/projects/${idea.id}`, {
        method: "PUT",
        body: JSON.stringify({ stage: "active" }),
      });
      await loadProjects();
    };

    const remove = element("button", null, "✕");
    remove.title = "Delete this direction";
    remove.onclick = async () => {
      if (!confirm(`Delete the direction "${idea.name}"?`)) return;
      await api(`/api/projects/${idea.id}`, { method: "DELETE" });
      await loadProjects();
    };

    item.append(promote, remove);
    list.appendChild(item);
  }
}

// --- events -----------------------------------------------------------------

function bindEvents() {
  $("tab-project").onclick = async () => {
    state.view = "project";
    await refreshView();
  };
  $("tab-portfolio").onclick = async () => {
    state.view = "portfolio";
    await refreshView();
  };
  $("tab-map").onclick = async () => {
    state.view = "map";
    await refreshView();
  };

  $("project-select").onchange = async (event) => {
    state.currentProjectId = Number(event.target.value);
    state.expandedPhases.clear();
    // Unpinned, so the next project decides its own default rather than
    // inheriting a switch that was flipped for a different plan.
    state.timelineMode = null;
    await loadPlan();
  };

  $("mode-dates").onclick = () => {
    state.timelineMode = "dates";
    renderTimeline();
  };
  $("mode-weeks").onclick = () => {
    state.timelineMode = "weeks";
    renderTimeline();
  };

  $("new-project").onclick = async () => {
    const name = prompt("Project name?");
    if (!name) return;
    // No start date on purpose: plan and estimate first, commit dates later.
    const project = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, start_date: "" }),
    });
    state.currentProjectId = project.id;
    state.view = "project";
    state.timelineMode = null;
    await loadProjects();
  };

  $("delete-project").onclick = async () => {
    if (!state.currentProjectId) return;
    if (!confirm("Delete this project and all its phases?")) return;
    await api(`/api/projects/${state.currentProjectId}`, { method: "DELETE" });
    state.currentProjectId = null;
    await loadProjects();
  };

  const saveProject = async () => {
    const velocity = $("project-velocity").value;
    await api(`/api/projects/${state.currentProjectId}`, {
      method: "PUT",
      body: JSON.stringify({
        name: $("project-name").value,
        goal: $("project-goal").value,
        start_date: $("project-start").value,
        stage: $("project-stage").value,
        track: $("project-track").value,
        velocity_override: velocity === "" ? null : Number(velocity),
      }),
    });
    await loadProjects();
  };
  for (const id of ["project-name", "project-goal", "project-start",
                    "project-stage", "project-track", "project-velocity"]) {
    $(id).onchange = saveProject;
  }

  $("department-name").onchange = async () => {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ department_name: $("department-name").value }),
    });
    await loadGraph();
  };

  $("add-direction").onclick = async () => {
    const name = $("new-direction-name").value.trim();
    if (!name) return;
    // No start date and no phases: a direction is a note to yourself until the
    // day it gets promoted.
    await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name,
        start_date: "",
        stage: "idea",
        track: $("new-direction-track").value.trim(),
      }),
    });
    $("new-direction-name").value = "";
    $("new-direction-track").value = "";
    await loadProjects();
  };
  $("new-direction-name").onkeydown = (event) => {
    if (event.key === "Enter") $("add-direction").click();
  };

  const saveSettings = async () => {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        default_velocity_points_per_sprint: Number($("setting-velocity").value),
        sprint_length_days: Number($("setting-sprint-days").value),
        v1_tolerance_pct: Number($("setting-tolerance").value),
      }),
    });
    await loadPlan();
  };
  for (const id of ["setting-velocity", "setting-sprint-days", "setting-tolerance"]) {
    $(id).onchange = saveSettings;
  }

  $("add-phase").onclick = async () => {
    const name = $("new-phase-name").value.trim();
    if (!name) return;
    await api(`/api/projects/${state.currentProjectId}/phases`, {
      method: "POST",
      body: JSON.stringify({
        name,
        start_date: $("new-phase-start").value,
        duration_weeks: Number($("new-phase-weeks").value),
        effort_points: Number($("new-phase-points").value),
      }),
    });
    $("new-phase-name").value = "";
    await loadPlan();
  };

  $("layout-phases").onclick = async () => {
    if (!state.plan.project.start_date) {
      alert("Set the project start date first, then lay out.");
      return;
    }
    const pending = state.plan.phases.filter((phase) => !isScheduled(phase)).length;
    if (pending === 0) {
      alert("Every phase already has a start date.");
      return;
    }
    if (!confirm(`Give ${pending} undated phase(s) dates, back to back from `
      + `${state.plan.project.start_date}? Phases that already have dates keep them.`)) {
      return;
    }
    await api(`/api/projects/${state.currentProjectId}/layout`, { method: "POST" });
    await loadPlan();
  };

  $("add-dependency").onclick = async () => {
    const error = $("dep-error");
    error.hidden = true;
    const other = Number($("dep-other").value);
    const current = state.currentProjectId;
    if (!other || !current) return;
    // "incoming" reads as: the other project must finish before this one starts.
    const incoming = $("dep-direction").value === "incoming";
    try {
      await api("/api/dependencies", {
        method: "POST",
        body: JSON.stringify({
          predecessor_project_id: incoming ? other : current,
          successor_project_id: incoming ? current : other,
        }),
      });
      await loadPlan();
    } catch (failure) {
      // V3 rejections land here: the edit is refused, nothing was written.
      error.textContent = failure.message;
      error.hidden = false;
    }
  };

  $("export").onclick = async () => {
    const data = await api("/api/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const link = element("a");
    link.href = URL.createObjectURL(blob);
    link.download = `roadmap-${todayISO()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  $("import").onclick = () => $("import-file").click();
  $("import-file").onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (!confirm("Import replaces ALL current data. Continue?")) return;
    const payload = JSON.parse(await file.text());
    await api("/api/import", { method: "POST", body: JSON.stringify(payload) });
    event.target.value = "";
    state.currentProjectId = null;
    state.expandedPhases.clear();
    await loadProjects();
  };
}

// Column width is measured from the container, so a resized window has to
// redraw to stay fitted. Debounced because dragging a window edge fires this
// continuously and every render rebuilds a whole chart.
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(redraw, 150);
});

bindEvents();
loadProjects();
