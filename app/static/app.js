// Roadmap Planner frontend. Vanilla JS, no build step.
// camelCase here because that is the JS ecosystem standard; the Python side
// uses snake_case. API payload keys stay snake_case end to end.

const PX_PER_DAY = 5;
const MS_PER_DAY = 86400000;

let state = {
  projects: [],
  currentProjectId: null,
  plan: null,
  settings: null,
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
const toISO = (date) => date.toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((b - a) / MS_PER_DAY);

function todayISO() {
  return toISO(new Date());
}

// --- loading ----------------------------------------------------------------

async function loadProjects() {
  state.projects = await api("/api/projects");
  const select = $("project-select");
  select.innerHTML = "";
  for (const project of state.projects) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    select.appendChild(option);
  }
  if (state.projects.length === 0) {
    state.currentProjectId = null;
    $("workspace").hidden = true;
    $("empty-state").hidden = false;
    return;
  }
  if (!state.projects.some((p) => p.id === state.currentProjectId)) {
    state.currentProjectId = state.projects[0].id;
  }
  select.value = state.currentProjectId;
  $("empty-state").hidden = true;
  $("workspace").hidden = false;
  await loadPlan();
}

async function loadPlan() {
  if (!state.currentProjectId) return;
  state.plan = await api(`/api/projects/${state.currentProjectId}`);
  state.settings = state.plan.settings;
  renderAll();
}

// --- rendering --------------------------------------------------------------

function renderAll() {
  renderProjectFields();
  renderSettingsFields();
  renderWarnings();
  renderTimeline();
  renderPhases();
  renderDependencies();
}

function renderProjectFields() {
  const project = state.plan.project;
  $("project-name").value = project.name;
  $("project-start").value = project.start_date;
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
    const item = document.createElement("li");
    item.className = "ok";
    item.textContent = "No problems detected.";
    list.appendChild(item);
    return;
  }
  for (const warning of warnings) {
    const item = document.createElement("li");
    item.innerHTML = `<span class="rule">${warning.rule}</span> ${warning.message}`;
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
  const phases = state.plan.phases;
  if (phases.length === 0) {
    timeline.innerHTML = '<p class="muted">Add a phase to see the timeline.</p>';
    return;
  }

  const starts = phases.map((p) => parseDate(p.start_date));
  starts.push(parseDate(state.plan.project.start_date));
  const ends = phases.map((p) => parseDate(p.end_date));
  const origin = new Date(Math.min(...starts));
  const finish = new Date(Math.max(...ends));
  const totalDays = Math.max(daysBetween(origin, finish), 1);

  timeline.style.width = `${totalDays * PX_PER_DAY + 200}px`;

  const warned = warnedPhaseIds();
  for (const phase of phases) {
    const offset = daysBetween(origin, parseDate(phase.start_date));
    const span = Math.max(daysBetween(parseDate(phase.start_date), parseDate(phase.end_date)), 1);
    const bar = document.createElement("div");
    bar.className = `bar status-${phase.status}${warned.has(phase.id) ? " bar-warn" : ""}`;
    bar.style.marginLeft = `${offset * PX_PER_DAY}px`;
    bar.style.width = `${span * PX_PER_DAY}px`;
    bar.title = `${phase.name}: ${phase.start_date} to ${phase.end_date} `
      + `(${phase.duration_weeks}w, ${phase.effort_points} pts)`;
    bar.textContent = phase.name;
    timeline.appendChild(bar);
  }
}

function renderPhases() {
  const body = $("phase-table").querySelector("tbody");
  const warned = warnedPhaseIds();
  body.innerHTML = "";

  for (const phase of state.plan.phases) {
    const row = document.createElement("tr");
    if (warned.has(phase.id)) row.className = "row-warn";

    row.appendChild(fieldCell(phase, "name", "text"));
    row.appendChild(fieldCell(phase, "start_date", "date"));
    row.appendChild(fieldCell(phase, "duration_weeks", "number", { step: "0.5", min: "0.5" }));
    row.appendChild(fieldCell(phase, "effort_points", "number", { step: "1", min: "0" }));

    const statusCell = document.createElement("td");
    const select = document.createElement("select");
    for (const status of ["planned", "in_progress", "done"]) {
      const option = document.createElement("option");
      option.value = status;
      option.textContent = status;
      select.appendChild(option);
    }
    select.value = phase.status;
    select.onchange = () => savePhase(phase.id, { status: select.value });
    statusCell.appendChild(select);
    row.appendChild(statusCell);

    const endCell = document.createElement("td");
    endCell.className = "muted";
    endCell.textContent = phase.end_date;
    row.appendChild(endCell);

    const actionCell = document.createElement("td");
    const remove = document.createElement("button");
    remove.textContent = "Delete";
    remove.onclick = async () => {
      if (!confirm(`Delete phase "${phase.name}"?`)) return;
      await api(`/api/phases/${phase.id}`, { method: "DELETE" });
      await loadPlan();
    };
    actionCell.appendChild(remove);
    row.appendChild(actionCell);

    body.appendChild(row);
  }
}

function fieldCell(phase, key, type, attributes = {}) {
  const cell = document.createElement("td");
  const input = document.createElement("input");
  input.type = type;
  input.value = phase[key];
  Object.assign(input, attributes);
  input.onchange = () => {
    const value = type === "number" ? Number(input.value) : input.value;
    savePhase(phase.id, { [key]: value });
  };
  cell.appendChild(input);
  return cell;
}

async function savePhase(phaseId, fields) {
  await api(`/api/phases/${phaseId}`, { method: "PUT", body: JSON.stringify(fields) });
  await loadPlan();
}

function renderDependencies() {
  const list = $("dependency-list");
  const nameOf = Object.fromEntries(state.plan.phases.map((p) => [p.id, p.name]));
  list.innerHTML = "";

  for (const dep of state.plan.dependencies) {
    const item = document.createElement("li");
    item.textContent = `${nameOf[dep.predecessor_phase_id]} -> ${nameOf[dep.successor_phase_id]}`;
    const remove = document.createElement("button");
    remove.textContent = "Unlink";
    remove.onclick = async () => {
      await api(`/api/dependencies/${dep.id}`, { method: "DELETE" });
      await loadPlan();
    };
    item.appendChild(remove);
    list.appendChild(item);
  }
  if (state.plan.dependencies.length === 0) {
    list.innerHTML = '<li class="muted">No dependencies.</li>';
  }

  for (const selectId of ["dep-predecessor", "dep-successor"]) {
    const select = $(selectId);
    const previous = select.value;
    select.innerHTML = "";
    for (const phase of state.plan.phases) {
      const option = document.createElement("option");
      option.value = phase.id;
      option.textContent = phase.name;
      select.appendChild(option);
    }
    select.value = previous;
  }
}

// --- events -----------------------------------------------------------------

function bindEvents() {
  $("project-select").onchange = async (event) => {
    state.currentProjectId = Number(event.target.value);
    await loadPlan();
  };

  $("new-project").onclick = async () => {
    const name = prompt("Project name?");
    if (!name) return;
    const project = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, start_date: todayISO() }),
    });
    state.currentProjectId = project.id;
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
        start_date: $("project-start").value,
        velocity_override: velocity === "" ? null : Number(velocity),
      }),
    });
    await loadProjects();
  };
  $("project-name").onchange = saveProject;
  $("project-start").onchange = saveProject;
  $("project-velocity").onchange = saveProject;

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
  $("setting-velocity").onchange = saveSettings;
  $("setting-sprint-days").onchange = saveSettings;
  $("setting-tolerance").onchange = saveSettings;

  $("add-phase").onclick = async () => {
    const name = $("new-phase-name").value.trim();
    if (!name) return;
    await api(`/api/projects/${state.currentProjectId}/phases`, {
      method: "POST",
      body: JSON.stringify({
        name,
        start_date: $("new-phase-start").value || state.plan.project.start_date,
        duration_weeks: Number($("new-phase-weeks").value),
        effort_points: Number($("new-phase-points").value),
      }),
    });
    $("new-phase-name").value = "";
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
    const link = document.createElement("a");
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
    await loadProjects();
  };
}

bindEvents();
$("new-phase-start").value = todayISO();
loadProjects();
