// Roadmap Planner frontend. Vanilla JS, no build step.
// camelCase here because that is the JS ecosystem standard; the Python side
// uses snake_case. API payload keys stay snake_case end to end.

// The week is the unit the eye reads, so the column width is the real constant
// and the per-day figure is derived from it.
const PX_PER_WEEK = 42;
const PX_PER_DAY = PX_PER_WEEK / 7;
const MS_PER_DAY = 86400000;

let state = {
  view: "project",
  projects: [],
  currentProjectId: null,
  plan: null,
  portfolio: null,
  settings: null,
  expandedPhases: new Set(),
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
const round2 = (value) => Math.round(value * 100) / 100;

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

// Sizes `chart`, gives it a ruler, and returns the grid origin plus the element
// bars belong in. Bars must be positioned against the returned origin, which is
// the Monday on or before `earliest` -- not `earliest` itself.
function weekGrid(chart, earliest, latest, gutter) {
  const origin = weekStart(earliest);
  const weeks = Math.max(Math.ceil((daysBetween(origin, latest) + 1) / 7), 1);
  chart.style.width = `${weeks * PX_PER_WEEK + gutter}px`;
  chart.appendChild(weekRuler(origin, weeks));

  const body = element("div", "grid-body");
  body.style.width = `${weeks * PX_PER_WEEK}px`;
  chart.appendChild(body);
  return { origin, body };
}

function weekRuler(origin, weeks) {
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
    block.style.width = `${blockWeeks * PX_PER_WEEK}px`;

    const cell = element("div", "week", String(monday.getDate()));
    cell.title = `Week of ${formatDate(monday)}`;
    weekRow.appendChild(cell);
  }

  ruler.append(monthRow, weekRow);
  return ruler;
}

// --- loading ----------------------------------------------------------------

async function loadProjects() {
  state.projects = await api("/api/projects");
  const select = $("project-select");
  select.innerHTML = "";
  for (const project of state.projects) {
    const option = element("option", null, project.name);
    option.value = project.id;
    select.appendChild(option);
  }

  if (state.projects.length === 0) {
    state.currentProjectId = null;
    state.plan = null;
    $("workspace").hidden = true;
    $("portfolio-view").hidden = true;
    $("empty-state").hidden = false;
    return;
  }
  if (!state.projects.some((p) => p.id === state.currentProjectId)) {
    state.currentProjectId = state.projects[0].id;
  }
  select.value = state.currentProjectId;
  $("empty-state").hidden = true;
  await refreshView();
}

async function refreshView() {
  const isProject = state.view === "project";
  $("workspace").hidden = !isProject || !state.currentProjectId;
  $("portfolio-view").hidden = isProject;
  $("tab-project").classList.toggle("active", isProject);
  $("tab-portfolio").classList.toggle("active", !isProject);
  if (isProject) {
    await loadPlan();
  } else {
    await loadPortfolio();
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
  $("project-velocity").value = project.velocity_override ?? "";
}

function renderSettingsFields() {
  $("setting-velocity").value = state.settings.default_velocity_points_per_sprint;
  $("setting-sprint-days").value = state.settings.sprint_length_days;
  $("setting-tolerance").value = state.settings.v1_tolerance_pct;
  $("setting-rollup-tolerance").value = state.settings.v5_tolerance_pct;
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

function renderTimeline() {
  const timeline = $("timeline");
  timeline.innerHTML = "";
  timeline.style.width = "";
  const phases = state.plan.phases.filter(isScheduled);
  if (phases.length === 0) {
    timeline.appendChild(element("p", "muted",
      state.plan.phases.length === 0
        ? "Add a phase to see the timeline."
        : "No phase has a start date yet. Estimate first, then lay them out."));
    return;
  }

  const starts = phases.map((p) => parseDate(p.start_date));
  if (state.plan.project.start_date) {
    starts.push(parseDate(state.plan.project.start_date));
  }
  const earliest = new Date(Math.min(...starts));
  const latest = new Date(Math.max(...phases.map((p) => parseDate(p.end_date))));
  const { origin, body } = weekGrid(timeline, earliest, latest, 200);

  const warned = warnedPhaseIds();
  for (const phase of phases) {
    body.appendChild(phaseBar(phase, origin, warned.has(phase.id)));
  }
}

function phaseBar(phase, origin, isWarned) {
  const offset = daysBetween(origin, parseDate(phase.start_date));
  const span = Math.max(
    daysBetween(parseDate(phase.start_date), parseDate(phase.end_date)), 1
  );
  const bar = element("div", `bar status-${phase.status}${isWarned ? " bar-warn" : ""}`);
  bar.style.marginLeft = `${offset * PX_PER_DAY}px`;
  bar.style.width = `${span * PX_PER_DAY}px`;
  bar.title = `${phase.name}: ${phase.start_date} to ${phase.end_date} `
    + `(${phase.duration_weeks}w, ${phase.effort_points} pts)`;
  bar.textContent = phase.name;
  return bar;
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

    const rollup = phase.rollup;
    row.appendChild(element("td", "muted rollup",
      rollup ? `${round2(rollup.duration_weeks)}w / ${rollup.effort_points}p` : "—"));

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
  cell.colSpan = 9;

  const table = element("table", "deliverables");
  const head = element("tr");
  for (const heading of ["Deliverable", "Weeks", "Points", ""]) {
    head.appendChild(element("th", null, heading));
  }
  table.appendChild(head);

  for (const deliverable of phase.deliverables) {
    const line = element("tr");
    line.appendChild(fieldCell(deliverable, "name", "text", saveDeliverable));
    line.appendChild(fieldCell(deliverable, "duration_weeks", "number", saveDeliverable,
      { step: "0.5", min: "0" }));
    line.appendChild(fieldCell(deliverable, "effort_points", "number", saveDeliverable,
      { step: "1", min: "0" }));

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

  if (phase.rollup) {
    const totals = element("tr", "rollup-row");
    totals.appendChild(element("td", null, `Rollup of ${phase.rollup.count}`));
    totals.appendChild(element("td", null, `${round2(phase.rollup.duration_weeks)}w`));
    totals.appendChild(element("td", null, `${phase.rollup.effort_points}p`));
    totals.appendChild(element("td", null,
      `vs ${phase.duration_weeks}w / ${phase.effort_points}p entered`));
    table.appendChild(totals);
  }

  const adder = element("tr");
  const nameCell = element("td");
  const nameInput = element("input");
  nameInput.placeholder = "New deliverable";
  nameCell.appendChild(nameInput);

  const weeksCell = element("td");
  const weeksInput = element("input");
  weeksInput.type = "number";
  weeksInput.step = "0.5";
  weeksInput.min = "0";
  weeksInput.value = "1";
  weeksCell.appendChild(weeksInput);

  const pointsCell = element("td");
  const pointsInput = element("input");
  pointsInput.type = "number";
  pointsInput.min = "0";
  pointsInput.value = "10";
  pointsCell.appendChild(pointsInput);

  const buttonCell = element("td");
  const add = element("button", null, "Add");
  add.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    await api(`/api/phases/${phase.id}/deliverables`, {
      method: "POST",
      body: JSON.stringify({
        name,
        duration_weeks: Number(weeksInput.value),
        effort_points: Number(pointsInput.value),
      }),
    });
    await loadPlan();
  };
  nameInput.onkeydown = (event) => { if (event.key === "Enter") add.click(); };
  buttonCell.appendChild(add);

  adder.append(nameCell, weeksCell, pointsCell, buttonCell);
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

function renderDependencies() {
  const list = $("dependency-list");
  const nameOf = Object.fromEntries(state.plan.phases.map((p) => [p.id, p.name]));
  list.innerHTML = "";

  if (state.plan.dependencies.length === 0) {
    list.appendChild(element("li", "muted", "No dependencies."));
  }
  for (const dep of state.plan.dependencies) {
    const item = element("li", null,
      `${nameOf[dep.predecessor_phase_id]} → ${nameOf[dep.successor_phase_id]}`);
    const remove = element("button", null, "Unlink");
    remove.onclick = async () => {
      await api(`/api/dependencies/${dep.id}`, { method: "DELETE" });
      await loadPlan();
    };
    item.appendChild(remove);
    list.appendChild(item);
  }

  for (const selectId of ["dep-predecessor", "dep-successor"]) {
    const select = $(selectId);
    const previous = select.value;
    select.innerHTML = "";
    for (const phase of state.plan.phases) {
      const option = element("option", null, phase.name);
      option.value = phase.id;
      select.appendChild(option);
    }
    select.value = previous;
  }
}

// --- portfolio view ---------------------------------------------------------

function renderPortfolio() {
  const chart = $("portfolio-chart");
  chart.innerHTML = "";
  chart.style.width = "";
  const { projects, phases, unscheduled_count: unscheduled } = state.portfolio;

  if (phases.length === 0) {
    chart.appendChild(element("p", "muted",
      unscheduled
        ? `Nothing is scheduled yet. ${unscheduled} phase(s) are estimated but undated.`
        : "Nothing planned yet."));
    return;
  }
  if (unscheduled) {
    chart.appendChild(element("p", "muted",
      `${unscheduled} phase(s) not shown — no start date yet.`));
  }

  const earliest = new Date(Math.min(...phases.map((p) => parseDate(p.start_date))));
  const latest = new Date(Math.max(...phases.map((p) => parseDate(p.end_date))));
  const { origin, body } = weekGrid(chart, earliest, latest, 240);

  for (const project of projects) {
    const own = phases.filter((phase) => phase.project_id === project.id);
    if (own.length === 0) continue;

    const lane = element("div", "lane");
    lane.appendChild(element("div", "lane-title", project.name));
    for (const phase of own) {
      const bar = phaseBar(phase, origin, false);
      bar.classList.add("draggable");
      bar.title += "  (drag to move; hold Alt for day steps)";
      makeDraggable(bar, phase, origin);
      lane.appendChild(bar);
    }
    body.appendChild(lane);
  }
}

function makeDraggable(bar, phase, origin) {
  bar.onmousedown = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startOffset = daysBetween(origin, parseDate(phase.start_date));
    const label = bar.textContent;
    let dayDelta = 0;
    bar.classList.add("dragging");

    const onMove = (moveEvent) => {
      const rawDelta = (moveEvent.clientX - startX) / PX_PER_DAY;
      // Land on a column edge so the drop point is readable off the grid.
      // Alt drops back to whole days for a phase that must start mid-week.
      dayDelta = moveEvent.altKey
        ? Math.round(rawDelta)
        : Math.round((startOffset + rawDelta) / 7) * 7 - startOffset;
      bar.style.marginLeft = `${(startOffset + dayDelta) * PX_PER_DAY}px`;
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

  $("project-select").onchange = async (event) => {
    state.currentProjectId = Number(event.target.value);
    state.expandedPhases.clear();
    await loadPlan();
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
        velocity_override: velocity === "" ? null : Number(velocity),
      }),
    });
    await loadProjects();
  };
  for (const id of ["project-name", "project-goal", "project-start", "project-velocity"]) {
    $(id).onchange = saveProject;
  }

  const saveSettings = async () => {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        default_velocity_points_per_sprint: Number($("setting-velocity").value),
        sprint_length_days: Number($("setting-sprint-days").value),
        v1_tolerance_pct: Number($("setting-tolerance").value),
        v5_tolerance_pct: Number($("setting-rollup-tolerance").value),
      }),
    });
    await loadPlan();
  };
  for (const id of ["setting-velocity", "setting-sprint-days",
                    "setting-tolerance", "setting-rollup-tolerance"]) {
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
    const predecessor = Number($("dep-predecessor").value);
    const successor = Number($("dep-successor").value);
    if (!predecessor || !successor) return;
    try {
      await api("/api/dependencies", {
        method: "POST",
        body: JSON.stringify({
          predecessor_phase_id: predecessor,
          successor_phase_id: successor,
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

// Column width lives in JS; the stylesheet reads it so the gridlines and the
// ruler cells can never drift apart from where the bars are drawn.
document.documentElement.style.setProperty("--week-px", `${PX_PER_WEEK}px`);

bindEvents();
loadProjects();
