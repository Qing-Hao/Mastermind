// Mastermind frontend. Vanilla JS, no build step.
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

// Where a project stands, derived server-side by `validation.project_stage`.
// One mark per row, so the badges form a single column you scan.
//
// A coloured glyph rather than a CSS badge: an <option> holds no markup and
// cannot be styled portably, so a character in the label is the only badge a
// native <select> can carry. These are emoji so they render in colour from the
// system font instead of the text colour.
//
// The ramp is not decoration. The cool marks are plan-building, where nothing is
// real yet; colour warms only once the calendar takes over. Red appears exactly
// once in the whole vocabulary and only ever means the dates have passed you by,
// which is what keeps it worth noticing. An unknown value falls through to no
// badge at all.
const STAGE_BADGE = {
  idea: "💡",     // nobody has committed to it
  planning: "⚪",  // no phases, nothing named, or no checkpoint to aim at
  planned: "🟡",  // named and aimed at a checkpoint, waiting only for dates
  dated: "🔵",    // on the calendar, not started
  active: "🟢",   // today falls inside the span
  overdue: "🔴",  // the last phase end has passed, phases still open
  done: "✅",     // every checkpoint reached, or closed by hand
};

// Still used on its own by the dependency and Future directions pickers, which
// list projects rather than states: there the only distinction worth drawing is
// committed work against a direction nobody has taken up yet.
const IDEA_BADGE = STAGE_BADGE.idea;

// Priority, 1 highest. 0 is untiered -- not a fourth tier but the absence of a
// decision, which is why it sorts last and is named rather than numbered
// everywhere it shows. Ranking is what lets the map be thinned down to the work
// that matters; nothing else in the tool reads it.
const TIER_ORDER = [1, 2, 3, 0];
const TIER_LABEL = { 1: "T1", 2: "T2", 3: "T3", 0: "untiered" };
// What a node's label carries. Same as TIER_LABEL except for untiered, which is
// abbreviated: spelt out it is the longest marker on the map and it lands on
// every node at once before anything has been ranked, which measured one more
// overlapping label pair than the map already had. The word survives where
// there is room for it -- the filter chip and the tooltip -- and those are what
// make "T?" read as "no tier yet" rather than as a fourth tier.
const TIER_MARK = { ...TIER_LABEL, 0: "T?" };

// The rungs the map's Status chips switch, in the ladder's order.
//
// **Five of the seven, and the two that are missing are the decision here.**
// `planned` and `overdue` have no chip and are always drawn, because neither is
// ever the answer to "should I be looking at this?" being no. Overdue is the
// rung you most want to walk into without having asked for it -- a map that can
// hide late work is a map that will eventually hide it on the day it mattered --
// and `planned` is committed, shaped work waiting only for dates, which is the
// one thing the default view would look wrong without. Both are cheap to leave
// on: they are the two smallest rungs on the real file, 0 projects each today.
//
// The cost, stated rather than discovered: two rungs you cannot switch off, so
// the Status row is not the whole ladder. `renderMapLegend` still lists all
// seven, which is what keeps the picture explainable.
const MAP_STAGE_CHIPS = ["idea", "planning", "dated", "active", "done"];

// What each chip's tooltip calls its rung, since the chip itself has room for
// the ladder's one-word name and nothing else. The words are the data model's,
// cut to what reads after "Show" -- the legend under the canvas is where the
// fuller definition lives, and these must not drift from it.
const STAGE_SUBJECT = {
  idea: "future directions",
  planning: "projects still being shaped",
  dated: "projects on the calendar but not started",
  active: "projects running now",
  done: "finished projects",
};

// What the Status filter starts on, and the one filter in this app that does not
// start with everything showing.
//
// The rule everywhere else is that a filter hiding work by default loses it, and
// the tier chips obey it. This is the deliberate exception, and it rests on what
// the map is *for*: it answers "where is the team pointed **now**", and only one
// rung is an answer to that. On the real file the difference is 29 projects on
// the canvas against 6 -- and the outermost ring, where labels are widest and the
// arc between slots is thinnest, is where all 17 ideas were sitting.
//
// Nothing is lost by it. Every chip counts its rung while it is off, so the map
// says how much it is not showing; ideas are listed in full in **Future
// directions** directly under the canvas; and `planned` and `overdue` are not
// switchable at all, so no committed work can go missing without being asked to.
const MAP_STAGE_DEFAULT = ["active"];

let state = {
  view: "project",
  projects: [],
  // What the sidebar's project list is narrowed to. A way of looking, like
  // `mapTiers` and `timelineMode`: nothing is stored, the open project stays open
  // even while filtered out of the list, and a reload clears it.
  projectFilter: "",
  // Who Keycloak says you are, when the gate is armed. Read once at boot and
  // used as a label; nothing about a person is stored anywhere else, here or on
  // the server. Empty means the gate is off.
  signedInAs: "",
  // Who else is here. `me` is this page's connection id -- two tabs of one
  // browser are two ids, so it is the connection that is excluded from the
  // badges, not the person. `said` is the last place announced, so a focus
  // shuffle that changes nothing sends nothing.
  presence: { me: null, name: "", users: [], said: null },
  currentProjectId: null,
  plan: null,
  portfolio: null,
  graph: null,
  settings: null,
  expandedPhases: new Set(),
  // Which phase's deliverable adder should hold the cursor after the next
  // render. Adding a deliverable reloads the whole plan -- that is what retags
  // the picker badge -- so the box you were typing in is rebuilt underneath you.
  // A phase id here puts the cursor back, which is what makes a list typeable
  // straight through. Consumed by `renderPhases` and cleared as it is read.
  focusAdder: null,
  // The same idea for the milestone adder, which needs no id: there is one list
  // per project rather than one per phase.
  focusMilestoneAdder: false,
  // Which timeline the project view draws. null means "decide from the data":
  // a project with nothing scheduled opens on weeks, anything else on dates.
  // Clicking the switch pins it until you change project.
  timelineMode: null,
  // One viewport per chart. They were shared, on the grounds that switching
  // tabs should keep your place -- but the two charts answer different
  // questions and so want different framings: the portfolio opens on *now*,
  // with a run-up behind it, and the project page opens on *this project's
  // dates*. One viewport cannot be both, and holding it in step meant opening
  // a project always re-framed the portfolio you had just been reading.
  //
  // In each: `start` is an ISO date, or null meaning "the default framing for
  // this chart" (`defaultOrigin`). `weeks` is null while a custom range is set,
  // in which case `customEnd` holds it.
  windows: {
    project: { start: null, weeks: MAX_WINDOW_WEEKS, customEnd: null },
    portfolio: { start: null, weeks: MAX_WINDOW_WEEKS, customEnd: null },
  },
  // The project the project window was last fitted to. Fitting happens when you
  // *change* project, never on a reload -- every edit calls `loadPlan`, and
  // refitting there would yank the viewport back while you were paging it.
  windowFittedTo: null,
  // Which swimlanes are drawing every phase. **Empty means every lane is
  // collapsed**, which is the default and the point: a lane is one row per phase
  // plus one per dated checkpoint, so the real file drew 45 rows and the tab that
  // exists to show the whole department could not show it at once. Collapsed, a
  // project is one bar over its own span with one strip of checkpoints under it.
  //
  // A set of what is *open* rather than of what is closed, so a project created
  // while the tab is open lands collapsed like every other one. Same lifetime as
  // `mapTiers` and `timelineMode` -- a way of looking, kept across re-renders and
  // tab switches, gone on a reload.
  laneOpen: new Set(),
  // The last tray placement, kept so it can be reversed exactly: the project's
  // previous start date and the phases that drop dated. In memory only -- a
  // reload loses it, and the offer says so rather than pretending otherwise.
  lastPlacement: null,
  // Which tiers the map draws. Everything to start with -- a filter that hides
  // work by default would lose it. Survives re-renders and tab switches but not
  // a reload, same as the timeline mode: it is a way of looking, not a setting.
  mapTiers: new Set(TIER_ORDER),
  // Which rungs of the ladder the map draws, holding the ones **shown** exactly
  // as `mapTiers` does -- but starting on one rung rather than on all of them.
  // The argument for the exception is on `MAP_STAGE_DEFAULT`, and the reason
  // only five of the seven rungs can ever be in here is on `MAP_STAGE_CHIPS`.
  //
  // It replaced a pair of booleans, `mapIdeas` and `mapDone`, which was the
  // right shape while the filter was two ends of the ladder being switched off
  // and the wrong one the moment the middle of it became switchable too: five
  // flags to write, five to read, and a `mapDrawn` that named every rung twice.
  // A set says the same thing once and makes a sixth rung a one-line change.
  //
  // Same lifetime as the tiers and the tracks: a way of looking, kept across
  // re-renders and tab switches, gone on a reload.
  mapStages: new Set(MAP_STAGE_DEFAULT),
  // Which root tracks the map draws, and **empty means every one of them**.
  // That is the same stance `laneOpen` takes, for the same reason: a set of
  // what has been *picked* rather than of what has been hidden. It is what
  // makes the first click on a legend swatch mean "draw only this track" --
  // pre-filling the set with all eight would make it mean "hide this one",
  // which is a different control -- and it is what lets a track invented
  // tomorrow arrive drawn rather than arrive already filtered out.
  //
  // Holds the root of the path (`trackRoot`), since the legend lists roots.
  // Same lifetime as the three above: a way of looking, gone on a reload.
  mapTracks: new Set(),
  // The fortnight the drawer is open on: the Monday it starts, and the slice
  // the server computed for it. Same lifetime as the two above -- a way of
  // looking, kept across re-renders and tab switches, gone on reload. `start`
  // null means the drawer is closed.
  // `planFrom` is the day you picked off the ruler, which is a Monday when you
  // clicked the week itself and any weekday or weekend day when you picked one
  // off the hovered strip. It never moves `start` -- a chart window and a file
  // heading are different things, which is why `fortnight_window` snaps and
  // `sprint_window` does not.
  fortnight: { start: null, planFrom: null, slice: null },
  // Fortnights a sprint file has been started for, by window start, holding what
  // `POST /api/sprints` said it made. In memory only, like the two above, and it
  // exists to stop the drawer offering to start a *second* sprint for the same
  // fortnight -- pressing again would be sprint N+1 with the same heading. After
  // a reload the offer comes back; the file on disk is the real record.
  plannedSprints: new Map(),
  // The sprint file the Sprint tab has open, and the state of the edit in
  // flight. Declared here with the rest of the state; everything that reads or
  // writes it lives in editor.js. `mtime` is what a save quotes back to prove
  // the file has not changed underneath it, so it is never updated except from
  // a read or a successful write.
  sprint: {
    files: [], number: null, name: "", blocks: [], mtime: null,
    // What the server last said is on disk, as `{raw, gap}`. A save quotes its
    // blocks as the run it expects to replace, so it is never the live `blocks`
    // above: an inline surface respells the block it is typed in, and a write
    // naming what this page holds would be refused by the file it came from.
    disk: null,
    // clean | dirty | saving | saved | failed | conflict
    status: "clean", error: "",
    // Which block is being typed in, which line of it when that block is a list
    // -- null for every other type, which is edited whole -- and the text in that
    // box if a commit failed and it is being kept rather than thrown away.
    editing: null, editingLine: null, draft: null,
    // doc | raw -- the block document, or the whole file in one textarea. A way
    // of looking, so it is not pinned per file and a reload returns to doc.
    view: "doc",
    // Which block a gutter drag is carrying, by index. Null unless dragging.
    dragIndex: null,
  },
  // How many roadmap writes this page has made. Bumped by `api` on every
  // non-GET that is not a sprint file, and read by anything holding a **cached
  // read of the roadmap** -- which is the scope panel and, so far, only it.
  //
  // A counter rather than an invalidation call per edit: the panel is on a
  // different tab from every gesture that changes what it draws, so wiring each
  // one to it would mean remembering to, in about a dozen places, with nothing
  // failing loudly when somebody forgets. This cannot be forgotten -- a write is
  // an edition, and a cache carrying the edition it was read at can tell.
  roadmapRevision: 0,
  // The roadmap beside the sprint file: one fortnight of it, for the panel down
  // the right of the Sprint tab. `asked` is the **key** a fetch has already been
  // fired for -- success or failure -- so a render never re-asks the same
  // question, and a failure does not loop. See `scopeKey`: the key carries the
  // roadmap's edition as well as the fortnight, which is what lets adding a
  // deliverable on the Project tab reach this panel.
  // `key` is what the slice in hand was read at; `start` is the fortnight half of
  // it on its own, because a slice for the *same* fortnight at an older edition
  // is still worth drawing while the re-read is in flight.
  sprintScope: { asked: null, key: null, start: null, slice: null, error: "" },
  // `D-42` in a sprint row, read in both directions and cached differently on
  // purpose. `sprintLinks` is the open file's references with the deliverable
  // each one names, keyed by `roadmapRevision` like the scope panel: the tick a
  // chip draws is the deliverable's, so clearing it on the Project tab has to
  // reach the chip. `deliverableSprints` is the other way round -- which files
  // name each deliverable -- and is **not** keyed at all, because a sprint save
  // does not touch the roadmap and so cannot move its edition. It is re-read with
  // the plan instead.
  sprintLinks: { asked: null, byId: new Map(), error: "" },
  deliverableSprints: { byId: new Map() },
  // Every deliverable in the roadmap, for the cell picker. Read once per plan
  // load for the same reason: the picker offers across projects, and the open
  // project is not the whole roadmap.
  allDeliverables: [],
  // The socket that says somebody else wrote something. `opened` is what tells a
  // reconnect from the first connect: coming back means messages were missed, so
  // the view is reloaded whole; connecting for the first time does not, because
  // the page has only just read everything.
  live: {
    socket: null, opened: false, down: false, attempt: 0,
    pending: false, loading: false, watching: null,
    // The sprint file a held refresh still owes a re-read to, if any.
    sprintReload: null,
  },
};

// --- api --------------------------------------------------------------------

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      detail = (await response.json()).detail || detail;
    } catch (_) { /* body was not json */ }
    // A detail is usually a string, but it does not have to be: the sprint
    // editor's 409 carries the file's mtime beside its message. So the Error
    // keeps both -- `message` for the callers that only show it, `status` and
    // `detail` for the one that has to act on which failure this was.
    const error = new Error(
      typeof detail === "string" ? detail : detail.error || response.statusText);
    error.status = response.status;
    error.detail = detail;
    throw error;
  }
  // A landed write is a new edition of the roadmap, and the counter is bumped
  // here so no caller has to remember to. Sprint files are excluded on purpose:
  // they are not the roadmap, and the editor `PUT`s a whole file per autosave
  // debounce -- counting those would re-read `/api/fortnight` every time you
  // stopped typing, to draw a panel nothing had changed.
  if (method !== "GET" && !path.startsWith("/api/sprints")) {
    state.roadmapRevision += 1;
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

// Which chart's viewport is in play. The map has no window, and `redraw` only
// ever reaches a chart whose own view is current, so "not the project view"
// means the portfolio.
const activeWindow = () =>
  state.windows[state.view === "project" ? "project" : "portfolio"];

// How far the portfolio's default framing sits behind this week. Two weeks of
// run-up: the question that tab answers is "where are we", and where the work
// has just come from is part of the answer -- a window opening exactly on today
// puts the run-in off the left edge, which is the half you check against.
const PORTFOLIO_LOOKBACK_WEEKS = 2;

// The origin a chart falls back to with no start of its own. The project view
// is normally fitted to its project by `fitProjectWindow`, so this is what an
// undated project -- which has nothing to fit to -- opens on.
function defaultOrigin() {
  const monday = weekStart(new Date());
  return state.view === "project"
    ? monday
    : addDays(monday, -PORTFOLIO_LOOKBACK_WEEKS * 7);
}

// The dates the open plan occupies, which is what the project page frames
// itself to. Not `validation.project_span`, deliberately, and not named after
// it: that pair is the project's own start and end, while this is a *viewport*
// and so also counts a checkpoint dated past the last phase -- a window that
// opened with the thing the plan is aiming at off its right edge would be
// framing the work and hiding the target. Undated records are skipped, so a
// plan with nothing on the calendar has no range and nothing to fit to.
function planDateRange() {
  if (!state.plan) return null;
  const dated = state.plan.phases.filter(isScheduled);
  if (dated.length === 0) return null;

  const starts = dated.map((phase) => phase.start_date);
  const ends = dated.map((phase) => phase.end_date);
  // The project's own start when it is set: it is the date the plan is measured
  // from, so a window opening after it would cut off the run-in.
  if (state.plan.project.start_date) starts.push(state.plan.project.start_date);
  for (const milestone of state.plan.milestones || []) {
    if (milestone.target_date) ends.push(milestone.target_date);
  }

  // ISO dates, so string order is date order.
  return {
    start: starts.reduce((a, b) => (a < b ? a : b)),
    end: ends.reduce((a, b) => (a > b ? a : b)),
  };
}

// Frame the project window on the open plan. A custom range rather than a week
// count, because the span is whatever it is and the preset list holds five
// numbers; `resolveWindow` rounds it out to whole columns and caps it at
// MAX_WINDOW_WEEKS, which is where the "capped at 26 weeks" note comes from on
// a long plan.
function fitProjectWindow() {
  const range = planDateRange();
  if (!range) return;
  state.windows.project = {
    start: range.start,
    weeks: null,
    customEnd: range.end,
  };
}

// The visible viewport, in whole week columns. Everything else measures against
// this -- the grid is drawn for the full window even where nothing is planned.
function resolveWindow() {
  const win = activeWindow();
  const origin = win.start ? weekStart(parseDate(win.start)) : defaultOrigin();
  // A custom range is rounded out to whole weeks, since a week is the column.
  const requested = win.weeks === null
    ? Math.ceil((daysBetween(origin, parseDate(win.customEnd)) + 1) / 7)
    : win.weeks;

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
//
// `view.gutterPx` opens a column to the left of the calendar, and only the
// portfolio asks for one (its swimlane names live there). It is a *lane* feature
// paid for here because the ruler and the gridlines have to agree with it: the
// gutter comes off the width fitted to the columns, the ruler rows get a spacer
// in front of them, and the grid body keeps it clear as padding so the gridlines
// start where the calendar does. Everything with no gutter is untouched.
function weekGrid(chart, view, ruler = weekRuler) {
  // Cleared before measuring: a width left over from the previous render would
  // otherwise be what we measured, and the chart would never resize back down.
  chart.style.width = "";
  const gutter = view.gutterPx || 0;
  view.pxPerWeek = fitWeekPx(chart, view.weeks, gutter);
  view.pxPerDay = view.pxPerWeek / 7;

  // Set on the chart rather than the document, since each chart fits its own
  // container. The stylesheet reads it for the gridlines and the ruler cells,
  // which is what keeps them from drifting off where the bars are drawn. The
  // gutter rides along the same way, for the lane name column.
  chart.style.setProperty("--week-px", `${view.pxPerWeek}px`);
  chart.style.setProperty("--lane-name-px", `${gutter}px`);

  const weeksWidth = view.weeks * view.pxPerWeek;
  const width = gutter + weeksWidth;
  chart.style.width = `${width}px`;

  const head = ruler(view);
  // A spacer per ruler row rather than one above the whole ruler: the rows are
  // flex, so the months and the weeks each have to be pushed off the gutter to
  // stay over their own columns. Inserted out here so no ruler has to know about
  // it -- `portfolioRuler` has already indexed its `.week` cells by then, and a
  // spacer is not one.
  if (gutter) {
    for (const row of head.querySelectorAll(".ruler-row")) {
      const spacer = element("div", "ruler-gutter");
      spacer.style.width = `${gutter}px`;
      row.insertBefore(spacer, row.firstChild);
    }
  }
  chart.appendChild(head);

  const body = element("div", "grid-body");
  body.style.width = `${width}px`;
  chart.appendChild(body);
  return body;
}

// With its own width cleared the chart is a plain block, so it reports exactly
// the room its container gives it. Whole pixels only: a fractional column
// accumulates over 26 of them and pushes the last one past the edge, which is
// the horizontal scrollbar this is meant to avoid.
//
// The gutter is spent before the columns are fitted, so a name column narrows the
// weeks rather than widening the chart past its container.
function fitWeekPx(chart, weeks, gutter = 0) {
  const available = chart.clientWidth - gutter;
  if (available <= 0) return FALLBACK_WEEK_PX;  // hidden or not yet laid out
  const fitted = Math.floor(available / weeks);
  return Math.min(Math.max(fitted, MIN_WEEK_PX), MAX_WEEK_PX);
}

function weekRuler({ origin, weeks, pxPerWeek }) {
  const ruler = element("div", "ruler");
  const monthRow = element("div", "ruler-row ruler-months");
  const weekRow = element("div", "ruler-row ruler-weeks");
  // The column today falls in. This ruler names dates, so the week is a thing
  // it can point at; `relativeRuler` counts weeks from the project start and
  // has no calendar, which is why nothing here reaches it.
  const thisMonday = formatDate(weekStart(new Date()));

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
    if (formatDate(monday) === thisMonday) {
      cell.classList.add("week-now");
      cell.title += " — this week";
    }
    weekRow.appendChild(cell);
  }

  ruler.append(monthRow, weekRow);
  return ruler;
}

// The line marking today, for the body `weekGrid` returns. Both calendar charts
// draw it, off the same window arithmetic their bars use.
//
// Null when today is outside the window, so the line is **absent** rather than
// clamped to an edge -- a line at the edge reads as "today is here", which is
// the one thing it must never say. `sliceTodayLine` states the same rule for
// the fortnight strip; this is the third view of one marker.
//
// It takes no pointer events (see the CSS), which costs it the tooltip the
// strip's line carries. That is deliberate: this one sits over bars that are
// dragged, and a 2px column swallowing a mousedown would cost more than a
// tooltip buys. The ruler's `.week-now` cell does the naming instead. The
// drawer never had to decide this -- nothing on its strip is draggable.
// The gutter is inside the grid body, and an absolutely positioned child measures
// from the padding edge -- so the line has to step over the name column, which is
// the whole point of the column: today no longer runs through the names.
function todayLine(view) {
  const day = daysBetween(view.origin, parseDate(todayISO()));
  if (day < 0 || day >= view.totalDays) return null;
  const line = element("div", "today-line");
  line.style.left = `${(view.gutterPx || 0) + day * view.pxPerDay}px`;
  return line;
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
// container; each drives its own viewport, so paging one leaves the other where
// you left it.
function renderWindowBar(container) {
  container.innerHTML = "";
  const win = activeWindow();
  const { origin, weeks, clamped } = resolveWindow();
  const custom = win.weeks === null;

  const step = (direction) => {
    // Page by exactly the span on screen, so consecutive windows tile with no
    // gap or overlap and stay Monday-aligned.
    const shift = direction * weeks * 7;
    win.start = formatDate(addDays(origin, shift));
    if (custom) {
      win.customEnd = formatDate(addDays(parseDate(win.customEnd), shift));
    }
    redraw();
  };

  const back = element("button", "nav", "‹");
  back.title = "Previous period";
  back.onclick = () => step(-1);

  // Back to this chart's own default framing, which on the portfolio is two
  // weeks of run-up rather than a window starting today. Clearing `start`
  // rather than writing today's Monday is what keeps the button and the
  // default one thing: a button that framed the week differently from the way
  // the tab opens would be a second opinion about where "now" is.
  const today = element("button", null, "Today");
  today.title = state.view === "project"
    ? "Jump back to the period starting this week"
    : `Jump back to now, with ${PORTFOLIO_LOOKBACK_WEEKS} weeks of run-up`;
  today.onclick = () => {
    win.start = null;
    if (custom) {
      win.customEnd = formatDate(addDays(defaultOrigin(), weeks * 7 - 1));
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
  select.value = custom ? "custom" : String(win.weeks);

  select.onchange = () => {
    if (select.value === "custom") {
      win.weeks = null;
      // Seed the range from whatever was on screen, so nothing jumps.
      win.customEnd = formatDate(addDays(origin, weeks * 7 - 1));
    } else {
      win.weeks = Number(select.value);
      win.customEnd = null;
    }
    redraw();
  };

  container.append(back, today, forward, select);

  // The project page opens fitted to the project's own dates, so it needs a way
  // back to that framing once you have paged away -- `Today` is the portfolio's
  // answer to the same question and is the wrong one here. Offered only where
  // there is a span to fit to; an undated project has nothing to return to.
  if (state.view === "project" && planDateRange()) {
    const fit = element("button", null, "Fit");
    fit.title = "Fit the window to this project's dates";
    fit.onclick = () => { fitProjectWindow(); redraw(); };
    container.appendChild(fit);
  }

  if (custom) {
    const from = element("input");
    from.type = "date";
    from.value = formatDate(origin);
    from.onchange = () => {
      if (from.value) win.start = from.value;
      redraw();
    };

    const to = element("input");
    to.type = "date";
    to.value = win.customEnd;
    to.onchange = () => {
      if (to.value) win.customEnd = to.value;
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

async function loadProjectList() {
  state.projects = await api("/api/projects");
  renderProjectList();
  // The track suggestions come off the same read, so naming a new track is
  // enough to make it offerable everywhere -- nothing stores the list.
  refreshTrackPickers();
}

// Whether the sidebar is folded to its icon rail. **In `localStorage`, not in
// `state`**, which is the one place this app keeps a way of looking across a
// reload: the standing `mapTiers` and `timelineMode` have is "gone on reload",
// because they are pinned for the plan in front of you. This is not -- you fold
// the sidebar to get 184px back for a wide table and you want it to stay folded
// next time. Same reasoning, and the same key prefix, as the sprint editor's
// column widths, which is the other thing here worth keeping.
//
// Both directions are guarded: `localStorage` *throws* when it is disabled rather
// than returning nothing, and the cost of failing is a sidebar that does not
// remember, never an app that does not start.
const SIDEBAR_KEY = "roadmap.sidebar-collapsed";

function sidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function applySidebar(collapsed) {
  document.querySelector(".app").classList.toggle("sidebar-collapsed", collapsed);
  const button = $("sidebar-toggle");
  // `aria-expanded` reads off the class rather than being tracked separately, for
  // the reason the ⋯ menu's does: one truth, so the two cannot disagree.
  button.setAttribute("aria-expanded", String(!collapsed));
  button.title = collapsed
    ? "Show the project list"
    : "Fold the sidebar to its icons — the project list needs the width";
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  } catch (_) { /* no storage: it folded, it just will not be remembered */ }
  // Folding changes the container's width, and `weekGrid` fits its columns to
  // that -- so a chart drawn before the fold is fitted to the wrong width until
  // something re-renders it. `redraw` is guarded on every branch, so calling it
  // from the boot path costs nothing and the two stay in step wherever this is
  // called from. The Sprint tab needs no branch: its tables are auto-layout HTML
  // and re-fit themselves.
  redraw();
}

// **A refresh should put you back, not start you over.** Which tab, which
// project and which sprint file, in `localStorage` beside the sidebar's fold and
// for the same reason: where you were looking is a fact about this browser, not
// about the plan, so it has no business in the dataset or in a settings row.
//
// Guarded both ways, like the sidebar: storage that is switched off *throws*, and
// the cost of that is a page that starts where it always used to, never a page
// that fails to start.
const SESSION_KEY = "roadmap.session";

// Read once at boot and consulted by `loadSprints`, which runs later and only
// when the Sprint tab is actually opened -- there is no point fetching a file for
// a tab you may never look at.
let rememberedSprint = null;

// A sprint key that came from the URL rather than from storage, read by
// `openingSprintKey` and preferred there over the fortnight containing today: a
// link naming a file is a request for that file, where a remembered one is only
// where you last were.
let routedSprint = null;

function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      view: state.view,
      projectId: state.currentProjectId,
      sprint: state.sprint.number,
    }));
  } catch (_) { /* no storage: it still works, it just will not be remembered */ }
}

// **Back should return you to the tab you left**, and only a history entry can do
// that: the browser reads history, not storage, so `localStorage` remembering
// across a reload is no help across a Back. Every view change therefore writes a
// hash, and the hash is the entry.
//
// A hash rather than a real path (`#/sprint/7`, not `/sprint/7`) because the path
// would cost a FastAPI catch-all and a route grammar the server has to agree
// with, for a URL that is prettier and does nothing more. Storage is kept beside
// it, not replaced -- it is what makes a bare URL still land where you were.
//
// The sprint key goes in raw (`7`, not `07`): `state.sprint.number` is a number
// and `TEMPLATE_KEY` is the string `template`, and the route carries the key the
// code already compares with `===` rather than a second, padded spelling of it.
function routeHash() {
  if (state.view === "project") {
    return state.currentProjectId ? `#/project/${state.currentProjectId}` : "#/project";
  }
  if (state.view === "sprint") {
    const key = state.sprint.number;
    return key === null || key === undefined ? "#/sprint" : `#/sprint/${key}`;
  }
  return `#/${state.view}`;
}

// The inverse, and deliberately strict: anything unrecognised comes back `null`
// and is ignored, so a hand-typed hash is never half-applied.
//
// **The read is guarded**, for a different cause than the storage one above:
// `scripts/wire_check.js` and `scripts/map_sweep.js` run this file under a stub
// with no `location`, where a bare read is a `ReferenceError` that takes the
// whole harness down.
function parseHash() {
  let raw = "";
  try {
    raw = location.hash;
  } catch (_) { return null; }

  const parts = raw.replace(/^#\/?/, "").split("/");
  const view = parts[0];
  if (!VIEW_TITLE[view] || parts.length > 2) return null;

  const route = { view, projectId: null, sprint: null };
  const key = parts[1];
  if (key === undefined || key === "") return route;

  if (view === "project") {
    if (!/^\d+$/.test(key)) return null;
    route.projectId = Number(key);
    return route;
  }
  if (view === "sprint") {
    if (!isTemplate(key) && !/^\d+$/.test(key)) return null;
    route.sprint = sprintFileKey(key);
    return route;
  }
  return null;  // portfolio and map carry nothing after the view
}

// **Push, or replace?** A write that records a move you made pushes -- that entry
// is the whole point. A write that only settles the URL on where the app actually
// landed replaces: the boot turning a bare URL into a route, and a pasted route
// that could not be honoured in full. Pushed, those would leave an entry behind
// you for a URL the app has already turned down once, and Back would re-enter the
// view you are standing in.
//
// It is not a `isNavigating` guard and does not suppress anything: the apply/push
// loop is closed by the comparisons in `syncHash` and `applyHash`, and this only
// picks which of two ways to write. Every `syncHash` clears it, and `applyHash`
// raises it again before each step that can write mid-route.
let settlingHash = true;

// Called beside every `saveSession`. Assigning `location.hash` is what pushes the
// entry, so writing nothing when the URL already says what the state says is also
// what stops the `hashchange` our own write fires from being applied back: no
// flag, just a comparison at each end.
function syncHash() {
  const settling = settlingHash;
  settlingHash = false;
  const wanted = routeHash();
  if (location.hash === wanted) return;
  if (settling) history.replaceState(null, "", wanted);
  else location.hash = wanted;
}

// What the state actually is, when it could not be what the URL asked for.
// `replaceState`, never `location.hash`: a push here would make Back walk
// backwards through the refusals.
function replaceHash() {
  if (location.hash !== routeHash()) history.replaceState(null, "", routeHash());
}

// A Back, a Forward, or a hash typed in.
//
// **Every state field the route carries is set before anything is awaited**, and
// that ordering is load-bearing. `loadSprintFile` and `refreshView` each call
// `syncHash` on the way out; reached with the route half-applied, `routeHash()`
// would describe a view nobody asked for and push an entry for it. Set first, the
// hash already matches and both calls write nothing.
async function applyHash() {
  const route = parseHash();
  if (!route) return;

  // A project id is trusted only as far as the list already loaded; an id that is
  // not in it is ignored. That is `loadProjects`' own tolerance for a project
  // deleted since you last looked, and it is why a stale link lands quietly.
  const wanted = state.projects.some((p) => p.id === route.projectId)
    ? route.projectId
    : null;
  const changed = route.view !== state.view
    || (wanted !== null && wanted !== state.currentProjectId);
  state.view = route.view;
  if (wanted !== null) state.currentProjectId = wanted;

  // Through `switchSprintFile`, never `loadSprintFile`: unsaved work in the file
  // being left is flushed first, and a write that will not land still refuses.
  if (route.sprint !== null && route.sprint !== state.sprint.number) {
    settlingHash = true;
    try {
      await switchSprintFile(route.sprint);
    } catch (_) { /* a hash naming a file that is not there changes nothing */ }
  }
  if (changed) {
    settlingHash = true;
    await refreshView();
  }

  // A sprint file with unsaved work refuses to be left, and a Back cannot be
  // refused -- the browser moved the hash before we heard about it. So the URL is
  // put back to what is really open, along with any other part of the route that
  // could not be honoured.
  settlingHash = false;
  replaceHash();
}

window.addEventListener("hashchange", applyHash);

// Before the first load, because `refreshView` reads `state.view` to decide what
// to fetch and `loadProjects` only picks the first project when nothing is
// selected -- both have to be told before either runs.
//
// The project id is taken on trust and checked by `loadProjects`, which already
// falls back to the first project when the selected one is not in the list. So a
// project deleted since you last looked is a quiet fallback rather than an error.
function restoreSession() {
  let session = {};
  try {
    session = JSON.parse(localStorage.getItem(SESSION_KEY)) || {};
  } catch (_) { /* unreadable or unparseable: start where the app always did */ }

  if (VIEW_TITLE[session.view]) state.view = session.view;
  if (typeof session.projectId === "number") state.currentProjectId = session.projectId;
  if (session.sprint !== undefined) rememberedSprint = session.sprint;

  // **A hash outranks the stored session**, field by field: a pasted or
  // bookmarked link is a request, where storage is only a memory. No hash means
  // the session still wins outright, so a bare URL opens exactly as it did before
  // there was a router.
  const route = parseHash();
  if (!route) return;
  state.view = route.view;
  if (route.projectId !== null) state.currentProjectId = route.projectId;
  if (route.sprint !== null) routedSprint = route.sprint;
}

// The sidebar's project list, and the app's picker. It replaced a native
// `<select>` whose only possible badge was an emoji in the option's text, because
// an `<option>` holds no markup: here the rung is a dot in the map's own colours,
// the rank is the digit the map's pip carries, and the list can be filtered.
//
// **The dot is one step less precise than the map's circle, deliberately.** The
// map splits `done` into delivered (green, every checkpoint reached) and closed
// (grey), off the milestone tally on `GET /api/graph`; `/api/projects` carries no
// tally, and inventing one here would be a second copy of a rule that lives in
// `validation`. So a finished project is grey in the list and the map is where
// the split is drawn. That is less detail, not different detail -- the two never
// disagree about a project, one of them simply says more.
//
// No stored order of its own: `db.list_projects` sorts done last and ideas just
// above, and `GET /api/projects` re-sorts on the derived stage, so the middle of
// this list is the work in flight.
function renderProjectList() {
  const list = $("project-list");
  list.innerHTML = "";

  const needle = state.projectFilter.trim().toLowerCase();
  const shown = needle
    ? state.projects.filter((p) => p.name.toLowerCase().includes(needle))
    : state.projects;

  if (shown.length === 0) {
    list.appendChild(element("div", "project-list-empty", state.projects.length
      ? "Nothing matches."
      : "No projects yet."));
    return;
  }

  for (const project of shown) {
    const row = element("button", "project-row");
    row.type = "button";
    row.dataset.id = project.id;
    if (project.id === state.currentProjectId) row.classList.add("selected");
    // An idea is not committed work, so its name sits back from the rest -- the
    // list's version of the dashed rim the map draws round it.
    if (project.derived_stage === "idea") row.classList.add("is-idea");

    row.appendChild(element("span", `project-dot stage-${project.derived_stage}`));
    row.appendChild(element("span", "project-name", project.name));

    const tier = project.tier || 0;
    row.appendChild(element("span", `project-tier tier-${tier}`,
      tier ? String(tier) : "?"));
    // The words the marks stand for. A dot cannot say "planned, needs dates" and
    // a `?` cannot say "untiered", and this is where the legend went when the
    // `<select>` that used to carry it in a `title` was replaced.
    row.title = `${project.name}\n${project.derived_stage} · ${TIER_LABEL[tier]}`;

    list.appendChild(row);
  }
}

// Open a project on the Project tab, from wherever it was named. Three surfaces
// now point here -- a map node, a Future-directions row and a portfolio lane
// title -- and they were one copy away from drifting apart about what "open"
// clears.
//
// The picker needs nothing set here any more: the sidebar list marks the row
// whose id matches `state.currentProjectId`, so the state below *is* the
// selection, and `loadPlan` re-renders the list at the end of every load. That
// used to be a `select.value` write, which had to happen here because the option
// list was rebuilt from scratch on each read and would otherwise lose its value.
//
// `expandedPhases` and `timelineMode` are cleared because both were pinned for a
// different plan. The window is not touched: `loadPlan` fits it, once per
// selection.
async function openProject(id) {
  state.currentProjectId = id;
  state.view = "project";
  state.expandedPhases.clear();
  state.timelineMode = null;
  await refreshView();
}

async function loadProjects() {
  await loadProjectList();

  if (state.projects.length === 0) {
    state.currentProjectId = null;
    state.plan = null;
  } else if (!state.projects.some((p) => p.id === state.currentProjectId)) {
    state.currentProjectId = state.projects[0].id;
  }
  await refreshView();
}

// What you are looking at, in the bar above it. On the Project tab that is the
// open project, its rung and a line of its own facts; on the other three it is
// the view's name, and the project actions are not there to press.
//
// **The span is read off the payload, never derived here.**
// `validation.project_span` owns a project's dates and `main.with_project_span`
// is what puts them on both the portfolio and this project's own payload, so the
// swimlane title and this line cannot disagree. Deriving the pair in JS would be
// a second copy of that arithmetic, which is the mistake `laneSummary`'s comment
// documents not making -- and it is why this reads `span_end` rather than taking
// a `max` over the phases sitting right there in `state.plan`.
const VIEW_TITLE = {
  project: "Project",
  portfolio: "Portfolio",
  map: "Team map",
  sprint: "Sprint",
};

function renderTopbar() {
  const title = $("view-title");
  const badge = $("project-badge");
  const meta = $("project-meta");
  const actions = $("topbar-actions");

  const project = state.view === "project" && state.plan
    ? state.plan.project
    : null;

  if (!project) {
    title.textContent = VIEW_TITLE[state.view] || "Mastermind";
    title.title = "";
    badge.hidden = true;
    meta.hidden = true;
    actions.hidden = true;
    return;
  }

  title.textContent = project.name;
  // A name too long for the bar is clipped by the CSS, so the whole of it lives
  // on the tooltip -- the same trade `.lane-title` makes in a 160px column.
  title.title = project.name;

  badge.hidden = false;
  badge.innerHTML = "";
  badge.appendChild(element("span", `project-dot stage-${project.derived_stage}`));
  badge.appendChild(element("span", null, project.derived_stage));
  badge.title = "Worked out from the plan and today's date. Only idea, committed"
    + " and closed are yours to set.";

  // An undated project says so rather than printing blanks or half a range --
  // the swimlane title's own rule, and `span_*` is `""` on whichever half is
  // unscheduled, so a half-dated project still reports the half it has.
  const dates = project.span_start && project.span_end
    ? `${project.span_start} → ${project.span_end}`
    : "no dates yet";
  const facts = [
    project.track || "no track",
    dates,
    `${project.phase_count} phase${project.phase_count === 1 ? "" : "s"}`,
    `${project.total_points} pts`,
  ];
  meta.hidden = false;
  meta.textContent = facts.join(" · ");

  actions.hidden = false;
}

async function refreshView() {
  const isProject = state.view === "project";
  const isPortfolio = state.view === "portfolio";
  const isMap = state.view === "map";
  const isSprint = state.view === "sprint";
  // The map is still worth showing with nothing planned -- it is where the
  // first future direction gets captured. So is the sprint tab: its files are
  // on disk and have nothing to do with whether a project exists.
  const noProjects = state.projects.length === 0;

  $("empty-state").hidden = !(isProject && noProjects);
  $("workspace").hidden = !isProject || noProjects;
  $("portfolio-view").hidden = !isPortfolio;
  $("map-view").hidden = !isMap;
  $("sprint-view").hidden = !isSprint;
  $("tab-project").classList.toggle("active", isProject);
  $("tab-portfolio").classList.toggle("active", isPortfolio);
  $("tab-map").classList.toggle("active", isMap);
  $("tab-sprint").classList.toggle("active", isSprint);

  if (isProject) {
    if (!noProjects) await loadPlan();
  } else if (isPortfolio) {
    await loadPortfolio();
  } else if (isSprint) {
    await loadSprints();
  } else {
    await loadGraph();
  }
  // After the load, not before: on the Project tab the bar reads `state.plan`,
  // which is what the load fetches. `renderProjectView` calls it too, so an edit
  // retags the bar without a tab switch.
  renderTopbar();
  // A render rebuilds the tables, so the badges drawn on the old nodes went with
  // them. Redraw from the roll this page already holds, and say where this page
  // is now looking -- a tab switch moves you as surely as a click does.
  drawPresence();
  announceHere();
  // Every tab switch and every project opened lands here, so this is the one
  // place that has to remember. The sprint file has its own call in
  // `loadSprintFile`, because switching files never comes back through here.
  saveSession();
  syncHash();
}

async function loadPlan() {
  if (!state.currentProjectId) return;
  state.plan = await api(`/api/projects/${state.currentProjectId}`);
  state.settings = state.plan.settings;
  // Before the render, because the deliverable list draws the badge from it. Read
  // on every plan load rather than cached: the references it counts are typed
  // into markdown, and nothing about a roadmap edit says when that happened.
  await loadDeliverableSprints();
  // Opening a project frames the chart on that project's dates. Once per
  // selection, not once per load: every edit lands here, and refitting on each
  // one would drag the viewport back while you were paging it. `Fit` in the
  // window bar is how you ask for it again after moving dates around. Marked
  // even when there was nothing to fit, so an undated project is not refitted
  // out from under you the moment its first phase gets a date.
  if (state.windowFittedTo !== state.plan.project.id) {
    fitProjectWindow();
    state.windowFittedTo = state.plan.project.id;
  }
  renderProjectView();
  // Naming a deliverable, setting a date or ticking the last milestone all
  // change the badge on the project you are looking at, and every edit lands
  // here. Re-reading the list is one localhost query, and it keeps the ladder
  // in `project_stage` instead of growing a second copy of it in JS.
  await loadProjectList();
}

async function loadPortfolio() {
  state.portfolio = await api("/api/portfolio");
  // Dragging a bar moves work into or out of the open fortnight, so the slice
  // is re-read with it. The drawer still writes nothing -- it is the chart's
  // edit that invalidated what it was showing.
  if (state.fortnight.start) {
    // Re-asked with the day that was picked, not the Monday it snapped to, so
    // the slice comes back reporting the same pair of dates it did when it was
    // opened -- the heading's "snapped back from" line is read off that pair.
    state.fortnight.slice = await api(`/api/fortnight?start=${
      encodeURIComponent(state.fortnight.planFrom || state.fortnight.start)}`);
  }
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
  renderTopbar();
  renderProjectFields();
  renderSettingsFields();
  renderWarnings();
  renderUnscheduled();
  renderTimeline();
  // Checkpoints are rows in the phase table now, so `renderPhases` draws both
  // kinds and there is no milestone render of its own to call.
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
  // 'active' is a legacy spelling of committed and no longer has an option of
  // its own, so it reads back as 'planned' -- the same thing to the ladder.
  $("project-stage").value = project.stage === "active" ? "planned" : project.stage;
  $("project-tier").value = String(project.tier ?? 0);
  $("project-track").value = project.track || "";
  $("project-velocity").value = project.velocity_override ?? "";
}

// The checkpoint list. It replaced the drafting switch, which asked the same
// question twice -- shape the plan, then flip a toggle saying you had -- and
// could go stale. A checkpoint is evidence rather than a promise, and unlike
// the switch it is worth writing down for its own sake.
//
// Ticking every one is what finishes the project, so the tally says how far off
// that is. Nothing here is hidden: the list decides the stage on a plan being
// drafted, and it is the record of what the project is for once it is running.
// The rows themselves are built by `milestoneRow` and drawn interleaved with the
// phases; what is left here is the tally beside the heading and the gate on the
// Promote button, both of which are about the list as a whole.
function renderMilestoneTally(milestones) {
  const reached = milestones.filter((milestone) => milestone.achieved).length;
  $("milestone-tally").textContent = milestones.length === 0
    ? "no checkpoints yet"
    : `${reached}/${milestones.length} reached`;
  renderPromote(milestones.length);
}

// A checkpoint row, in the same table as the phases. It keeps the furniture the
// deliverable list settled on -- grip in its own column, tick, struck-through
// name when it is ticked -- and adds a ◆ before the name, because in a table of
// phases the row has to say what kind of row it is. The four columns a phase
// spends on weeks, points, status and its derived end are one muted cell here: a
// checkpoint is a point with no work of its own, which is the whole distinction.
function milestoneRow(milestone) {
  const line = element("tr",
    `checkpoint-row${milestone.achieved ? " done" : ""}`);

  const gripCell = element("td", "grip");
  const grip = element("span", "grip-handle", "⠿");
  grip.title = "Drag to move this checkpoint in the sequence";
  gripCell.appendChild(grip);
  line.appendChild(gripCell);

  const tickCell = element("td", "tick");
  const tick = element("input");
  tick.type = "checkbox";
  tick.checked = Boolean(milestone.achieved);
  tick.title = milestone.achieved ? "Reached" : "Not reached yet";
  tick.onchange = () => saveMilestone(milestone.id, { achieved: tick.checked });
  tickCell.appendChild(tick);
  line.appendChild(tickCell);

  const nameCell = fieldCell(milestone, "name", "text", saveMilestone,
    {}, "milestone");
  nameCell.classList.add("checkpoint-name");
  const mark = element("span", "checkpoint-mark", "◆");
  mark.title = "Checkpoint";
  nameCell.insertBefore(mark, nameCell.firstChild);
  const nameInput = nameCell.querySelector("input");
  nameInput.onkeydown = (event) => {
    if (event.key !== "Enter") return;
    state.focusMilestoneAdder = true;
    if (nameInput.value === milestone.name) renderPhases();
  };
  line.appendChild(nameCell);

  line.appendChild(fieldCell(milestone, "target_date", "date", saveMilestone,
    {}, "milestone"));

  const spanCell = element("td", "muted", "checkpoint");
  spanCell.colSpan = 4;
  line.appendChild(spanCell);

  const actionCell = element("td");
  const remove = element("button", "btn-ghost", "✕");
  remove.title = "Delete checkpoint";
  remove.onclick = async () => {
    await api(`/api/milestones/${milestone.id}`, { method: "DELETE" });
    await loadPlan();
  };
  actionCell.appendChild(remove);
  line.appendChild(actionCell);

  return { line, grip };
}

// Turning an idea into a plan, which is the one transition the ladder will not
// make for you. `idea` beats every derived rung on purpose -- the portfolio and
// the map filter on the *stored* stage, so a derived promotion would show a
// planned badge on a project that is still absent from both.
//
// The gate is at least one checkpoint, and it is enforced by disabling the
// button rather than by the server refusing the write. The two write-time
// refusals this app has both guard malformed data; refusing to let you set your
// own project's stage would be a scheduling opinion, which rule 1 forbids. The
// cost, stated: a hand-rolled PUT still promotes an idea with nothing to aim at.
function renderPromote(count) {
  const button = $("promote-project");
  const isIdea = state.plan.project.stage === "idea";

  button.hidden = !isIdea;
  if (!isIdea) return;

  button.disabled = count === 0;
  button.title = count === 0
    ? "Add a milestone first. A plan is a direction with something to aim at — "
      + "that is what separates it from an idea."
    : "Commit this idea as a plan. It joins the portfolio and the map; "
      + "the ladder works out the rest.";
}

async function promoteProject() {
  try {
    await api(`/api/projects/${state.currentProjectId}`, {
      method: "PUT",
      // Promotion is a write, not an inference, so it says what it is promoting
      // *from*: a project someone else already committed is not promoted twice.
      body: JSON.stringify({ stage: "planned", expect: { stage: "idea" } }),
    });
  } catch (failure) {
    reportStaleWrite(failure);
  }
  await loadPlan();
}

// --- the plan sequence: phases and checkpoints on one number line -------------

// Phases and milestones are separate tables with a `sort_order` each, and this
// reads the two as one sequence: a checkpoint sits *between* two phases, so the
// order across both is the thing worth arranging and neither column alone can
// say it. No schema change buys this -- `list_phases` and `list_milestones` both
// order by `sort_order` and only ever use it relatively, so gaps in either
// table's numbers are harmless.
//
// A new row of either kind is appended to the shared sequence server-side, by
// `db.next_plan_sort_order` reading the MAX across both tables. Ties are still
// possible and still handled: a file written before the sequence merged has its
// phases at 0..n-1 and its checkpoints at 0..m-1, so almost every row collides
// until the first drag renumbers them. Ties break phases-first, and the sort is
// stable, so rows of one kind keep the order the server sent them in.
// Takes the two lists rather than reading `state.plan`, because the **portfolio**
// merges the same sequence per swimlane off its own flat payload -- both charts
// draw one row per plan row, and two copies of this arithmetic would drift.
// Handed a subset (a window's worth of bars, the checkpoints that could be
// placed) it still holds: a subset of one ordering keeps that ordering.
function mergePlanRows(phases, milestones) {
  const rows = [];
  for (const phase of phases || []) rows.push({ kind: "phase", item: phase });
  for (const milestone of milestones || []) {
    rows.push({ kind: "milestone", item: milestone });
  }
  rows.sort((a, b) => (a.item.sort_order - b.item.sort_order)
    || (a.kind === b.kind ? 0 : a.kind === "phase" ? -1 : 1));
  return rows;
}

function orderedPlanRows() {
  return mergePlanRows(state.plan.phases, state.plan.milestones);
}

// Renumbered from zero across both kinds, each row written to its own endpoint
// and only if it actually moved. Writes `sort_order` and nothing else -- not a
// tick, not a date, not a phase's status -- the same contract the deliverable
// list and the timeline's bar drag have. No rule reads the order, so nothing
// fires.
//
// **No `expect` here, deliberately.** A drag renumbers most of the list, so a
// per-row guard would refuse almost every drag that happened near someone
// else's -- and refuse it halfway through, leaving the line part-written.
// Ordering is arrangement rather than state: nothing validates it, ties and
// gaps are well-formed, and the worst a lost race costs is a second drag.
async function savePlanOrder(rows) {
  for (let index = 0; index < rows.length; index += 1) {
    const { kind, item } = rows[index];
    if (item.sort_order === index) continue;
    const path = kind === "phase"
      ? `/api/phases/${item.id}`
      : `/api/milestones/${item.id}`;
    await api(path, { method: "PUT", body: JSON.stringify({ sort_order: index }) });
  }
  await loadPlan();
}

// One drag for both row kinds, because it is one sequence.
//
// Rows here are **not** uniform height -- an expanded phase carries its
// deliverable table under it -- so the step-per-row arithmetic the deliverable
// list uses cannot work. The drop slot is the number of other rows whose
// midpoint the cursor has passed. Those midpoints are frozen at mousedown, on
// purpose: reading the live boxes would feed the preview back into the decision
// and oscillate on a boundary.
function makePlanRowDraggable(entry, entries, index) {
  entry.grip.onmousedown = (event) => {
    event.preventDefault();
    const from = { x: event.clientX, y: event.clientY };
    const row = entry.line;
    const table = row.parentElement;
    const others = entries.filter((other) => other !== entry);
    const midpoints = others.map((other) => {
      const box = other.line.getBoundingClientRect();
      return box.top + box.height / 2;
    });
    let targetIndex = index;
    let armed = false;

    const onMove = (moveEvent) => {
      if (!armed) {
        const travelled = Math.hypot(moveEvent.clientX - from.x, moveEvent.clientY - from.y);
        if (travelled < DRAG_ARM_PX) return;
        armed = true;
        row.classList.add("dragging");
      }
      const next = midpoints.filter((middle) => middle < moveEvent.clientY).length;
      if (next === targetIndex) return;
      targetIndex = next;
      table.insertBefore(row, others[targetIndex] ? others[targetIndex].line : null);
      // An open phase's deliverables travel with it: they are a sibling row, so
      // leaving them behind would park them under whichever phase took the slot.
      if (entry.extra) table.insertBefore(entry.extra, row.nextSibling);
    };

    const onUp = async () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      row.classList.remove("dragging");
      if (!armed) return;
      if (targetIndex === index) {
        renderPhases();  // put the previewed list back where it was
        return;
      }
      const reordered = others.slice();
      reordered.splice(targetIndex, 0, entry);
      await savePlanOrder(reordered);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
}

async function saveMilestone(milestoneId, fields) {
  try {
    await api(`/api/milestones/${milestoneId}`, {
      method: "PUT",
      body: JSON.stringify(fields),
    });
  } catch (failure) {
    reportStaleWrite(failure);
  }
  // Ticking the last one changes the project's stage, so the whole plan and the
  // picker badge are re-read -- the same trade every other edit here makes.
  await loadPlan();
}

async function addMilestone() {
  const nameInput = $("new-milestone-name");
  const dateInput = $("new-milestone-date");
  const name = nameInput.value.trim();
  if (!name) return;
  await api(`/api/projects/${state.currentProjectId}/milestones`, {
    method: "POST",
    body: JSON.stringify({ name, target_date: dateInput.value }),
  });
  nameInput.value = "";
  dateInput.value = "";
  state.focusMilestoneAdder = true;
  await loadPlan();
}

function renderSettingsFields() {
  $("setting-velocity").value = state.settings.default_velocity_points_per_sprint;
  $("setting-sprint-days").value = state.settings.sprint_length_days;
  $("setting-tolerance").value = state.settings.v1_tolerance_pct;
}

// The banner at the top of the project view. It goes quiet rather than away when
// there is nothing to report: `is-clear` drops the amber, the border and the
// aside, and the count becomes the sentence. Keeping the slot means the page does
// not jump the moment the last warning clears -- and an empty card carrying a `0`
// pill, which is what this was, is furniture.
function renderWarnings() {
  const banner = $("warnings-banner");
  const list = $("warning-list");
  const warnings = state.plan.warnings;
  list.innerHTML = "";

  const clear = warnings.length === 0;
  banner.classList.toggle("is-clear", clear);
  $("warning-count").textContent = clear
    ? "No problems detected."
    : `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`;
  if (clear) return;

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
  const visible = new Set(phases.filter((phase) => inWindow(phase, view))
    .map((phase) => phase.id));
  offWindowNote(timeline, phases.length - visible.size);

  const body = weekGrid(timeline, view);
  // Before the milestone rows, deliberately: both are positioned, so DOM order
  // is what decides which paints over the other, and a diamond and its label
  // must not be cut by the line. Bars need no such care -- they are plain block
  // elements, so any positioned sibling paints above them whatever the order.
  const now = todayLine(view);
  if (now) body.appendChild(now);

  const { marks, undated, offWindow } = milestoneMarks(state.plan.milestones, view);
  const placed = markIndex(marks);
  const warned = warnedPhaseIds();
  // One chart row per plan row, in the shared `sort_order` -- see the note above
  // `milestoneLane`. A phase with no date, or one scrolled out of the window,
  // takes no row and is counted in the notes below instead.
  for (const row of orderedPlanRows()) {
    if (row.kind === "phase") {
      if (!visible.has(row.item.id)) continue;
      body.appendChild(phaseBar(row.item, view, warned.has(row.item.id)));
    } else if (placed.has(row.item.id)) {
      body.appendChild(milestoneLane([placed.get(row.item.id)]));
    }
  }
  milestoneNotes(timeline, undated, offWindow);
  stackMilestoneLanes(timeline);  // needs layout, so after the chart is attached
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

// --- milestone diamonds ------------------------------------------------------

// A milestone is a point rather than a span, so it draws as a diamond and needs
// a lane of its own: a zero-width bar among the phases would be invisible and
// impossible to hover.
//
// Diamonds are absolutely positioned inside the lane so several could share one
// line. Every other bar in this app is a block element owning its own row, which
// is exactly what a point marker must not be.
//
// **Both charts now hand it exactly one mark**, and get one row per checkpoint
// interleaved among the bars on the shared `sort_order` -- the project timeline in
// either mode, and a portfolio swimlane. Every checkpoint in a single lane above
// the bars was the first shape and it made the sequence unreadable: a checkpoint
// belonging between phases 3 and 4 drew above phase 1, while the phase table right
// below the chart interleaved them properly -- two pictures of one number line.
// Row position is the sequence; the mark's x is still its own date, so a
// checkpoint dated in the middle of a phase draws in the middle of it. The two
// are independent and neither is snapped to the other.
//
// It still takes a list, and `stackMilestoneLanes` still sweeps the finished
// chart, so a shared strip remains a thing this can draw. Nothing asks for one:
// interleaving is what dissolved the label collisions the sweep exists for, since
// one mark per row cannot collide with anything. Both are a row's worth of code
// away from being deleted -- the CSS carries the one-row height already.
function milestoneLane(marks) {
  const lane = element("div", "milestone-lane");
  for (const { milestone, x } of marks) {
    const mark = element("div",
      `milestone-mark${milestone.achieved ? " reached" : ""}`);
    mark.style.left = `${x}px`;
    mark.title = `${milestone.name}${milestone.target_date ? ` — ${milestone.target_date}` : ""}`
      + (milestone.achieved ? " (reached)" : "");
    mark.appendChild(element("span", "milestone-diamond"));
    mark.appendChild(element("span", "milestone-label", milestone.name));
    lane.appendChild(mark);
  }
  return lane;
}

// A label is wider than the gap between two nearby dates, so a single line put
// one checkpoint's name on top of another's -- which is what this lane did until
// now, with the `title` as the consolation. Marks are dropped into the first row
// that has cleared them, so a cluster grows the lane downwards instead of
// printing over itself, and the lane's own height grows with it: the bars below
// are block elements, so a second row has to push them down rather than paint
// across them.
//
// It runs over the finished chart rather than inside `milestoneLane`, and that is
// forced: a detached element has no layout, so `offsetWidth` inside the builder
// is 0 -- and neither the project timeline's grid body nor a portfolio swimlane
// is in the document when its lane is built. Failing to call it costs only the
// overlap it fixes, which is why it is a sweep and not a step.
const MILESTONE_ROW_PX = 16;
const MILESTONE_LABEL_GAP_PX = 8;

function stackMilestoneLanes(root) {
  for (const lane of root.querySelectorAll(".milestone-lane")) {
    // Ascending by position, not by `sort_order`: the greedy row assignment is
    // only correct left to right, and the marks arrive in list order.
    const marks = Array.from(lane.children)
      .map((mark) => ({ mark, left: parseFloat(mark.style.left) || 0 }))
      .sort((a, b) => a.left - b.left);
    const rowEnds = [];

    for (const { mark, left } of marks) {
      let row = 0;
      while (row < rowEnds.length && rowEnds[row] > left) row += 1;
      rowEnds[row] = left + mark.offsetWidth + MILESTONE_LABEL_GAP_PX;
      mark.style.top = `${row * MILESTONE_ROW_PX}px`;
    }
    lane.style.height = `${Math.max(rowEnds.length, 1) * MILESTONE_ROW_PX + 4}px`;
  }
}

// Undated and off-window are counted apart because they are different problems:
// one is a checkpoint nobody has committed to a date, the other is one you have
// simply scrolled away from.
function milestoneNotes(chart, undated, offWindow) {
  if (undated > 0) {
    chart.appendChild(element("p", "muted",
      `${undated} milestone(s) with no target date.`));
  }
  if (offWindow > 0) {
    chart.appendChild(element("p", "muted",
      `${offWindow} milestone(s) outside this window.`));
  }
}

// Placed on the calendar, the same arithmetic `phaseSpan` uses. Takes the list
// rather than reading `state.plan`, because the portfolio draws checkpoints per
// swimlane off its own payload and two copies of this would drift.
function milestoneMarks(milestones, view) {
  const marks = [];
  let undated = 0;
  let offWindow = 0;

  for (const milestone of milestones || []) {
    if (!milestone.target_date) { undated += 1; continue; }
    const day = daysBetween(view.origin, parseDate(milestone.target_date));
    if (day < 0 || day > view.totalDays) { offWindow += 1; continue; }
    marks.push({ milestone, x: day * view.pxPerDay });
  }
  return { marks, undated, offWindow };
}

// Both mark builders return a list; both charts draw one mark per row, so they
// need to find one by id while walking the plan sequence -- and a milestone
// missing from here is one that could not be placed, which is what skips its row.
function markIndex(marks) {
  return new Map(marks.map((mark) => [mark.milestone.id, mark]));
}

// Weeks mode has no calendar, so a milestone's stored date has to be measured
// against something: the project's own start. Without that there is no origin to
// count from and nothing can be placed -- which is the common case here, since
// this mode is what an undated project opens on. Counting them as undated says
// so rather than dropping them silently.
function relativeMilestoneMarks(view) {
  const marks = [];
  let undated = 0;
  let offWindow = 0;
  // Tested as a string: `parseDate("")` is an Invalid Date, which is truthy.
  const start = state.plan.project.start_date;

  for (const milestone of state.plan.milestones || []) {
    if (!milestone.target_date || !start) { undated += 1; continue; }
    const weeks = daysBetween(parseDate(start), parseDate(milestone.target_date)) / 7;
    if (weeks < 0 || weeks > view.weeks) { offWindow += 1; continue; }
    marks.push({ milestone, x: weeks * view.pxPerWeek });
  }
  return { marks, undated, offWindow };
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
  const { marks, undated, offWindow } = relativeMilestoneMarks(view);
  const placed = markIndex(marks);
  const warned = warnedPhaseIds();

  // One row per plan row, the same sequence the phase table shows. The phase
  // index counted here is its index in `state.plan.phases`, which is what the
  // drag re-sequences: both lists are `sort_order` ascending and the merge sorts
  // stably, so counting the phase rows off reproduces it.
  const rows = [];
  let phaseIndex = 0;
  for (const row of orderedPlanRows()) {
    if (row.kind === "phase") {
      const bar = relativeBar(row.item, row.item.offset_weeks, view, warned);
      rows.push({ kind: "phase", item: row.item, node: bar, index: phaseIndex });
      phaseIndex += 1;
      body.appendChild(bar);
    } else if (placed.has(row.item.id)) {
      const lane = milestoneLane([placed.get(row.item.id)]);
      rows.push({ kind: "milestone", item: row.item, node: lane });
      body.appendChild(lane);
    }
  }

  // Armed only once every row exists: the drag previews the whole sequence, so
  // it has to know about the rows that are not bars.
  for (const row of rows) {
    if (row.kind !== "phase") continue;
    makeResequenceable(row.node, row.item, row.index, row.item.offset_weeks, view, rows);
  }
  milestoneNotes(timeline, undated, offWindow);
  stackMilestoneLanes(timeline);
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

// The drag is armed by the caller rather than here, since it needs the finished
// row list -- checkpoint rows included -- and that does not exist yet.
function relativeBar(phase, offset, view, warned) {
  const isWarned = warned.has(phase.id);
  const bar = element("div",
    `bar status-${phase.status}${isWarned ? " bar-warn" : ""} draggable`);
  placeRelativeBar(bar, offset, phaseWeeks(phase), view);
  const span = `W${Math.floor(offset) + 1}–W${Math.ceil(offset + phaseWeeks(phase))}`;
  bar.title = `${phase.name}: ${span} (${phase.duration_weeks}w, `
    + `${phase.effort_points} pts)  (drag to re-order)`;
  bar.textContent = phase.name;
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
function makeResequenceable(bar, phase, index, offset, view, rows) {
  bar.onmousedown = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const body = bar.parentElement;
    const others = state.plan.phases.filter((other) => other.id !== phase.id);
    const barsById = new Map(rows.filter((row) => row.kind === "phase")
      .map((row) => [row.item.id, row.node]));
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

      // Re-appended in the *merged* sequence, checkpoint rows included, which is
      // the same merge `saveOrder` writes on the drop: the phase slots take the
      // previewed order and a checkpoint keeps the slot it occupies. Re-appending
      // the bars alone would sweep every one of them past every checkpoint, so
      // the preview would show a sequence the drop then would not produce.
      // A checkpoint's own x is a date and a re-order writes none, so no mark
      // moves sideways here.
      let next = 0;
      for (const row of rows) {
        if (row.kind !== "phase") {
          body.appendChild(row.node);
          continue;
        }
        const item = preview[next];
        const node = barsById.get(item.id);
        body.appendChild(node);
        if (item.id !== phase.id) {
          placeRelativeBar(node, offsets[next], phaseWeeks(item), view);
        }
        next += 1;
      }
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
// A phase-only reorder, from dragging a bar on the Weeks timeline. Phases share
// one number line with checkpoints now (see `orderedPlanRows`), so renumbering
// the phases 0..n-1 on their own would walk them straight through the
// checkpoints between them. The new phase order is written back into the merged
// sequence instead: checkpoints keep the slots they occupy, and the phases fill
// the rest in the order the drop put them in.
async function saveOrder(phases) {
  let next = 0;
  const merged = orderedPlanRows().map((row) =>
    row.kind === "phase" ? { kind: "phase", item: phases[next++] } : row);
  await savePlanOrder(merged);
}

// --- phases and deliverables ------------------------------------------------

// The plan's one ordered list: phases, and the checkpoints between them. It was
// two sections and two tables, which could hold no opinion at all about what
// comes before what -- and where a checkpoint sits in the sequence is exactly
// what a plan is being drafted to decide.
function renderPhases() {
  const body = $("phase-table").querySelector("tbody");
  const warned = warnedPhaseIds();
  const milestones = state.plan.milestones || [];
  body.innerHTML = "";
  renderMilestoneTally(milestones);

  const entries = [];
  for (const row of orderedPlanRows()) {
    const built = row.kind === "phase"
      ? phaseRow(row.item, warned)
      : milestoneRow(row.item);
    body.appendChild(built.line);
    // An open phase's deliverables are a second row rather than a cell, so the
    // drag has to know to carry it along.
    if (built.extra) body.appendChild(built.extra);
    entries.push({ ...built, kind: row.kind, item: row.item });
  }

  // Wired once the whole sequence exists: a drag needs its neighbours' boxes.
  entries.forEach((entry, index) => makePlanRowDraggable(entry, entries, index));

  // An input can only take focus once it is in the document, so this happens
  // here rather than where the adder is built.
  if (state.focusAdder !== null) {
    const adder = body.querySelector(`input.adder[data-phase="${state.focusAdder}"]`);
    state.focusAdder = null;
    if (adder) adder.focus();
  }
  if (state.focusMilestoneAdder) {
    state.focusMilestoneAdder = false;
    $("new-milestone-name").focus();
  }
  // The table this just rebuilt is where most of the badges live.
  drawPresence();
}

function phaseRow(phase, warned) {
  const row = element("tr", warned.has(phase.id) ? "row-warn" : null);
  // How a live refresh finds the row again to flash it. The table is rebuilt on
  // every render, so nothing can hold the node -- the deliverable rows carry the
  // same marker for `revealDeliverableRow`, and for the same reason.
  row.dataset.phase = phase.id;
  const isOpen = state.expandedPhases.has(phase.id);

  // Its own column, the same conclusion the deliverable list reached: a drag
  // surface over the rest of the row would cost click-to-place-cursor inside the
  // name. Phases had no grip at all until the sequence merged -- they reordered
  // only by dragging a bar on the Weeks timeline, which still works and still
  // writes nothing but `sort_order`.
  const gripCell = element("td", "grip");
  const grip = element("span", "grip-handle", "⠿");
  grip.title = "Drag to move this phase in the sequence";
  gripCell.appendChild(grip);
  row.appendChild(gripCell);

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

  row.appendChild(fieldCell(phase, "name", "text", savePhase, {}, "phase"));
  row.appendChild(fieldCell(phase, "start_date", "date", savePhase, {}, "phase"));
  row.appendChild(fieldCell(phase, "duration_weeks", "number", savePhase,
    { step: "0.5", min: "0" }, "phase"));
  row.appendChild(fieldCell(phase, "effort_points", "number", savePhase,
    { step: "1", min: "0" }, "phase"));

  const statusCell = element("td");
  const select = element("select");
  for (const status of ["planned", "in_progress", "done"]) {
    const option = element("option", null, status);
    option.value = status;
    select.appendChild(option);
  }
  select.value = phase.status;
  select.onchange = () => savePhase(phase.id,
    { status: select.value, expect: { status: phase.status } });
  statusCell.appendChild(select);
  row.appendChild(statusCell);

  row.appendChild(element("td", "muted", phase.end_date || "unscheduled"));

  const actionCell = element("td");
  // The same ✕ the checkpoint row beside it has always used, rather than the word
  // "Delete": one table, one row-removal mark, and the label was the widest thing
  // in a column that holds nothing else. The confirm is what makes it safe to be
  // small, and the title is what makes it readable.
  const remove = element("button", "btn-ghost", "✕");
  remove.title = "Delete phase";
  remove.onclick = async () => {
    if (!confirm(`Delete phase "${phase.name}" and its deliverables?`)) return;
    await api(`/api/phases/${phase.id}`, { method: "DELETE" });
    state.expandedPhases.delete(phase.id);
    await loadPlan();
  };
  actionCell.appendChild(remove);
  row.appendChild(actionCell);

  return { line: row, grip, extra: isOpen ? deliverableRow(phase) : null };
}

function deliverableRow(phase) {
  const row = element("tr", "deliverable-row");
  const cell = element("td");
  // Nine now, not eight: the phase table grew a grip column when checkpoints
  // moved into it.
  cell.colSpan = 9;

  const table = element("table", "deliverables");
  const head = element("tr");
  for (const heading of ["", "Done", "Deliverable", ""]) {
    head.appendChild(element("th", null, heading));
  }
  table.appendChild(head);

  const lines = [];
  for (const deliverable of phase.deliverables) {
    const line = element("tr", deliverable.done ? "done" : null);
    // What `revealDeliverableRow` finds the row by. The table is rebuilt on every
    // render, so an arriving jump has to look the row up rather than hold a node.
    line.dataset.deliverable = deliverable.id;

    // The grip is its own column because the rest of the row is a checkbox and
    // a text field: a drag surface over either would cost you click-to-place-
    // cursor inside the name.
    const gripCell = element("td", "grip");
    const grip = element("span", "grip-handle", "⠿");
    grip.title = "Drag to reorder";
    gripCell.appendChild(grip);
    line.appendChild(gripCell);

    const tickCell = element("td", "tick");
    const tick = element("input");
    tick.type = "checkbox";
    tick.checked = Boolean(deliverable.done);
    tick.title = deliverable.done ? "Done" : "Still ongoing";
    tick.onchange = () => saveDeliverableTick(deliverable.id, tick.checked);
    tickCell.appendChild(tick);
    line.appendChild(tickCell);

    const nameCell = fieldCell(deliverable, "name", "text", saveDeliverable,
      {}, "deliverable");
    // Enter on a name already in the list ends up in the adder too, so a
    // correction leaves the cursor where the next one is typed. The flag is set
    // in keydown; the `change` Enter fires next is what saves and re-renders.
    // With nothing edited there is no change to wait for, so render now.
    const nameInput = nameCell.querySelector("input");
    // The reference you would type into a sprint file, on hover. A tooltip rather
    // than a column: the id matters only while writing `[#D-42]` somewhere else,
    // and a column of ids would be read once a fortnight and looked past daily.
    nameInput.title = `D-${deliverable.id}`;
    nameInput.onkeydown = (event) => {
      if (event.key !== "Enter") return;
      state.focusAdder = phase.id;
      if (nameInput.value === deliverable.name) renderPhases();
    };
    // The other end of `D-42`: which sprint files planned this, and a way into
    // the newest of them. In the name cell rather than a column of its own --
    // most deliverables are in no sprint file, and a column would be four-fifths
    // empty to serve the fifth.
    const planned = state.deliverableSprints.byId.get(deliverable.id) || [];
    if (planned.length > 0) {
      // Flex, so the badge sits beside the name field rather than under it. The
      // same answer `#phase-table td.checkpoint-name` reached, and for the same
      // reason: `td input` is 100% wide and would push anything after it down.
      nameCell.classList.add("deliverable-name");
      const numbers = planned.map((one) => one.number);
      const last = numbers[numbers.length - 1];
      const jump = element("a", "deliverable-sprint", `↗ ${numbers.join(", ")}`);
      jump.href = "#";
      jump.title = numbers.length === 1
        ? `Planned in sprint ${last} — open it`
        : `Planned in sprints ${numbers.join(", ")} — open sprint ${last}`;
      jump.onclick = async (event) => {
        event.preventDefault();
        await revealSprintFile(last);
        revealSprintReference(deliverable.id);
      };
      nameCell.appendChild(jump);
    }
    line.appendChild(nameCell);

    const actionCell = element("td");
    const remove = element("button", "btn-ghost", "✕");
    remove.title = "Delete deliverable";
    remove.onclick = async () => {
      await api(`/api/deliverables/${deliverable.id}`, { method: "DELETE" });
      await loadPlan();
    };
    actionCell.appendChild(remove);
    line.appendChild(actionCell);
    table.appendChild(line);
    lines.push({ line, grip, deliverable });
  }

  const adder = element("tr");
  // Nothing to tick yet -- a new deliverable always starts ongoing.
  const gripSpacer = element("td");
  const spacerCell = element("td");
  const nameCell = element("td");
  const nameInput = element("input", "adder");
  nameInput.placeholder = "New deliverable";
  nameInput.dataset.phase = phase.id;
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
    // The reload rebuilds this box; the cursor comes back to the new one.
    state.focusAdder = phase.id;
    await loadPlan();
  };
  nameInput.onkeydown = (event) => { if (event.key === "Enter") add.click(); };
  buttonCell.appendChild(add);

  adder.append(gripSpacer, spacerCell, nameCell, buttonCell);
  table.appendChild(adder);

  // Wired once the whole list exists: a drag needs its neighbours, and the
  // adder is the anchor for a drop past the last row.
  lines.forEach((entry, index) =>
    makeDeliverableDraggable(entry, lines, index, adder, phase));

  cell.appendChild(table);
  row.appendChild(cell);
  return row;
}

// Dragging a deliverable writes `sort_order` and nothing else -- not the tick,
// not the phase above it, and no date anywhere. Rows are uniform height, so the
// drop index is the distance travelled in rows; the row itself moves during the
// drag and the others close the gap behind it, so the landing place is read off
// the list on screen rather than guessed.
function makeDeliverableDraggable(entry, lines, index, adder, phase) {
  entry.grip.onmousedown = (event) => {
    event.preventDefault();
    const from = { x: event.clientX, y: event.clientY };
    const row = entry.line;
    const table = row.parentElement;
    const others = lines.filter((other) => other !== entry).map((other) => other.line);
    const step = row.getBoundingClientRect().height;
    let targetIndex = index;
    let armed = false;

    const onMove = (moveEvent) => {
      if (!armed) {
        const travelled = Math.hypot(moveEvent.clientX - from.x, moveEvent.clientY - from.y);
        if (travelled < DRAG_ARM_PX) return;
        armed = true;
        row.classList.add("dragging");
      }
      const moved = Math.round((moveEvent.clientY - from.y) / step);
      const next = Math.min(Math.max(index + moved, 0), lines.length - 1);
      if (next === targetIndex) return;
      targetIndex = next;
      table.insertBefore(row, others[targetIndex] || adder);
    };

    const onUp = async () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      row.classList.remove("dragging");
      if (!armed) return;
      if (targetIndex === index) {
        renderPhases();  // put the previewed list back where it was
        return;
      }
      const reordered = phase.deliverables.filter((item) => item.id !== entry.deliverable.id);
      reordered.splice(targetIndex, 0, entry.deliverable);
      await saveDeliverableOrder(reordered);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
}

// Renumbered from zero so the stored order matches what is on screen, and only
// the rows that actually moved are written. The phase twin is `saveOrder`, and
// so is its unguarded-on-purpose note.
async function saveDeliverableOrder(deliverables) {
  for (let index = 0; index < deliverables.length; index += 1) {
    if (deliverables[index].sort_order === index) continue;
    await api(`/api/deliverables/${deliverables[index].id}`, {
      method: "PUT",
      body: JSON.stringify({ sort_order: index }),
    });
  }
  await loadPlan();
}

function fieldCell(record, key, type, save, attributes = {}, kind = "") {
  const cell = element("td");
  const input = element("input");
  input.type = type;
  input.value = record[key];
  Object.assign(input, attributes);
  // What presence names this cell by, and the reason every typed field in the
  // plan gets a badge for free: they all come through here. `kind` is passed
  // rather than derived, so a renamed save function cannot silently unname a
  // cell that two people are looking at.
  if (kind) input.dataset.presence = presenceKey(kind, record.id, key);
  input.onchange = () => {
    const value = type === "number" ? Number(input.value) : input.value;
    // What this row held when it was drawn. The server refuses the write if
    // someone else has moved this field since -- see `expect` in `main.py`.
    // Every typed field in the plan goes through here, so this one line is the
    // guard for all of them.
    save(record.id, { [key]: value, expect: { [key]: record[key] } });
  };
  cell.appendChild(input);
  return cell;
}

// A refused write, said out loud. 409 here means the field this save was about
// to overwrite had already moved: nothing was written, and the reload that
// follows puts the other person's value on screen. Never merged, never retried
// -- the same contract the sprint editor's "Changed on disk" has. Anything
// other than a conflict is rethrown, because it is not this function's failure.
function reportStaleWrite(failure) {
  if (failure.status !== 409) throw failure;
  showToast(failure.message);
}

async function savePhase(phaseId, fields) {
  try {
    await api(`/api/phases/${phaseId}`, { method: "PUT", body: JSON.stringify(fields) });
  } catch (failure) {
    reportStaleWrite(failure);
  }
  await loadPlan();
}

async function saveDeliverable(deliverableId, fields) {
  try {
    await api(`/api/deliverables/${deliverableId}`, {
      method: "PUT",
      body: JSON.stringify(fields),
    });
  } catch (failure) {
    reportStaleWrite(failure);
  }
  await loadPlan();
}

// The tick has a second half the other fields do not: a task line in a sprint
// file draws this deliverable, so the marker on that line goes with it. See
// `pushDeliverableMarks`.
//
// **No `expect` on a tick, deliberately**, here or on a checkpoint's. A box is
// one click and holds nothing typed: two people ticking the same thing agree,
// and the guard would refuse the second of them for reaching the same answer.
// What the guard is for is a write that overwrites something someone wrote.
async function saveDeliverableTick(deliverableId, done) {
  await saveDeliverable(deliverableId, { done });
  const marks = await pushDeliverableMarks(deliverableId, done);
  announceMarks(deliverableId, done, marks,
    () => saveDeliverableTick(deliverableId, !done));
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
    // Ghost, because the row is a fact being read and the button is the exception
    // you occasionally want -- the same weight the ✕ carries in the plan table.
    const remove = element("button", "btn-ghost", "Unlink");
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
      project.stage === "idea" ? `${IDEA_BADGE} ${project.name}` : project.name);
    option.value = project.id;
    select.appendChild(option);
  }
  select.value = previous;
}

// --- portfolio view ---------------------------------------------------------

// The width of the swimlane name column, and the only thing that sets a grid
// gutter anywhere in the app. Wide enough for a typical project name at 13px
// bold; a longer one is clipped with an ellipsis and keeps the whole name on the
// tooltip it already had. Sized rather than fitted to the longest name on
// purpose: the calendar beside it would then be a different width per dataset,
// and the column is meant to be a straight edge you scan down.
// 168 rather than 160 since the cell gained a track rail and a second line: the
// rail and its gap take 9px off the text, and the rung underneath needs the
// name not to be clipped tighter than it already is. It is spent before
// `weekGrid` fits the columns, so every bar on this chart moves 8px right and
// the calendar loses 8px of width -- at the 26-week cap that is a third of a
// pixel per column.
const LANE_NAME_PX = 168;

// The name column of a lane. A cell of its own with the clickable title inside
// it, rather than the title being the cell: the title stays `fit-content`, so
// the underline and the click target are the name and not the empty half of the
// column beside it.
//
// The twisty goes in here beside the name rather than on the rows, because the
// name column is the one part of a lane that is always in the same place --
// the rows start wherever the project's dates put them, which on a paged window
// can be the far right of the chart or nowhere at all.
// The rail is identity, never meaning: which track this project belongs to, in
// the same hue the map paints that track's rings. The bar's fill still says how
// far along the work is and the dot below still says which rung it is on, so no
// vocabulary is spent -- what it buys is being able to see that three of the
// lanes are one programme, which a column of names cannot say.
//
// `trackPalette` is keyed off the whole dataset on both surfaces, so a project
// takes the same colour here as on the map. Untracked, and anything past the
// eighth track, take the grey it hands back rather than a hue nobody could tell
// from another.
function laneName(title, twisty, hue, meta) {
  const cell = element("div", "lane-name");
  const rail = element("div", "track-rail");
  rail.style.background = hue || "var(--faint)";
  // The name and the rung it is on, stacked, so the twisty and the rail keep
  // their own widths while the name still shrinks to its ellipsis.
  const text = element("div", "lane-name-text");
  text.append(title, meta);
  cell.append(rail, twisty, text);
  return cell;
}

// The rung the ladder put this project on, said on the lane rather than left in
// the title's tooltip. The dot is the sidebar's own `.project-dot`, class and
// all: the map draws a rung as a circle, the picker as a dot, and this is the
// picker's dot -- one colour table, and this surface adds only its size.
function laneMeta(project) {
  const meta = element("div", "lane-meta");
  meta.appendChild(element("span", `project-dot stage-${project.derived_stage}`));
  const track = trackPath(project.track);
  meta.appendChild(element("span", "lane-rung",
    track.length ? `${project.derived_stage} · ${track[0]}` : project.derived_stage));
  return meta;
}

// Open this lane, or fold it back to one bar. A `<button>` rather than a div
// with a handler, so it is in the tab order and takes Enter and Space for free
// -- the same reason the sprint editor's rail grip is one.
function laneTwisty(project, open) {
  const twisty = element("button", "lane-twisty", open ? "▾" : "▸");
  twisty.type = "button";
  twisty.setAttribute("aria-expanded", String(open));
  twisty.title = open
    ? `Fold ${project.name} back to one bar`
    : `Show every phase and checkpoint in ${project.name}`;
  twisty.onclick = () => {
    if (open) state.laneOpen.delete(project.id);
    else state.laneOpen.add(project.id);
    renderPortfolio();
  };
  return twisty;
}

// The whole project as one bar: its own span, filled to how much of the work is
// ticked off. It is the collapsed lane's only row, and it is **not draggable** --
// a drag on this chart moves one phase to a date, and there is nothing honest for
// a drop on a summary to write. Open the lane to move something.
//
// The span comes off the payload, never from the bars on screen: a lane only
// draws the phases inside the current window, so measuring those would make one
// project report a different length depending on where the chart is scrolled.
// Placed by `placeBar`, so a span running off either end of the window keeps the
// dotted clip edge every other bar uses.
function laneSummaryBar(project, view) {
  const bar = element("div", "bar lane-summary");
  placeBar(bar,
    daysBetween(view.origin, parseDate(project.span_start)),
    daysBetween(view.origin, parseDate(project.span_end)), view);

  // A project with no phases has no frame to measure against, so it draws no
  // fill at all rather than an empty one -- the server sends `null`, never 0,
  // and the difference is the whole point. A lane only exists where a phase is
  // on screen, so this is the belt to the payload's braces.
  const filled = project.completion;
  if (filled !== null && filled !== undefined) {
    const fill = element("div", "bar-fill");
    fill.style.width = `${filled * 100}%`;
    bar.appendChild(fill);
  }
  bar.appendChild(element("span", "bar-text", filled === null
    ? `${project.phase_count} phase(s) · nothing to measure`
    : `${percentText(filled)} · ${project.phases_done}/${project.phase_count} phases`
      + ` · ${project.deliverables_done}/${project.deliverables_total} delivered`));

  bar.title = `${laneSummary(project)}\n${completionNote(project)}`
    + "\n\nOpen the lane to move a phase.";
  return bar;
}

// The fraction as a whole number, and the two roundings that matter.
//
// **100% is only ever printed by a project that is actually complete**, and 0%
// only by one where nothing is: 199 of 200 rounds to 99, not to a finish that
// has not happened, and one of 200 rounds to 1 rather than reporting nothing
// started. Everything between is ordinary rounding. A percentage on a chart is
// read as a claim, and those two are the claims worth being exact about.
function percentText(fraction) {
  const percent = Math.round(fraction * 100);
  if (percent >= 100 && fraction < 1) return "99%";
  if (percent <= 0 && fraction > 0) return "1%";
  return `${percent}%`;
}

// What the number was read off, spelt out wherever there is room for a sentence.
// The arithmetic is not guessable from one figure -- phases as the frame,
// deliverables filling their own phase's share -- and a percentage nobody can
// account for is a percentage nobody trusts.
function completionNote(project) {
  if (project.completion === null || project.completion === undefined) {
    return "No phases yet, so there is nothing to measure against.";
  }
  return `${percentText(project.completion)} complete — each phase is an equal `
    + `share, filled by the deliverables named under it`
    + `\n${project.phases_done}/${project.phase_count} phases closed · `
    + `${project.deliverables_done}/${project.deliverables_total} deliverables ticked`;
}

// How far ahead the checkpoint strip looks. A fortnight because that is the
// cadence everything else here is planned on -- the sprint length, the drawer,
// the slice -- not because two weeks is a natural horizon for a roadmap.
const HORIZON_DAYS = 14;

// The four readings a chart of bars cannot give you: how much is committed, what
// the plans are aiming at next, whether anything has run past its dates, and how
// much has never been committed to at all.
//
// Every figure is read off a payload already in hand. Three come from
// `/api/portfolio`; **ideas come from `state.projects`**, and that is not an
// oversight -- `/api/portfolio` omits them deliberately ("an idea nobody has
// committed to does not belong on a delivery timeline"), so the count of what is
// *not* on this tab has to come from the list that holds everything. That list is
// the sidebar's and is loaded before any view renders.
//
// Nothing here derives a stage or reads a rule: `derived_stage` is the ladder's
// own answer, arriving on the payload.
function renderPortfolioHeadline() {
  const band = $("portfolio-headline");
  band.innerHTML = "";

  const tile = (caption, value, sub, tone) => {
    const box = element("div", `tile${tone ? ` tile-${tone}` : ""}`);
    box.appendChild(element("div", "tile-cap", caption));
    box.appendChild(element("div", "tile-num", String(value)));
    box.appendChild(element("div", "tile-sub", sub));
    return box;
  };

  // Committed is every project on this payload the ladder has not called done --
  // the payload is already every stage but `idea`, so this is the second half of
  // "committed and not finished".
  const live = state.portfolio.projects.filter(
    (project) => project.derived_stage !== "done");
  const dated = live.filter((project) => project.span_start && project.span_end);
  band.appendChild(tile("Committed", live.length,
    `${dated.length} on the calendar · ${live.length - dated.length} waiting for dates`));

  const soon = checkpointsAhead();
  const reached = soon.filter((mark) => mark.achieved).length;
  const projects = new Set(soon.map((mark) => mark.project_id)).size;
  band.appendChild(tile(`Checkpoints, next ${HORIZON_DAYS} days`, soon.length,
    soon.length
      ? `across ${projects} project(s) · ${reached} reached`
      : "nothing is being aimed at this fortnight",
    soon.length ? "live" : "quiet"));

  // The `overdue` rung, not V6 -- a rule about one project's phases belongs in
  // the project view, which is the standing decision in FR-2. So this counts
  // projects whose *last* phase end has passed with phases still open, and it
  // will read 0 on a plan whose late work is all mid-project. That is the honest
  // reading of the field rather than a second copy of a rule.
  const overdue = state.portfolio.projects.filter(
    (project) => project.derived_stage === "overdue");
  band.appendChild(tile("Overdue", overdue.length,
    overdue.length
      ? "past the last phase end, still open"
      : "nothing has run past its last phase",
    overdue.length ? "warn" : "quiet"));

  const ideas = state.projects.filter(
    (project) => project.derived_stage === "idea");
  band.appendChild(tile("Ideas", ideas.length, "captured, not committed to", "quiet"));
}

// The dated checkpoints falling inside the horizon, in date order. Read off the
// portfolio payload, which already carries every dated checkpoint on a committed
// project -- so an undated one is absent here for the same reason it draws no
// diamond on the chart.
function checkpointsAhead() {
  const from = formatDate(new Date());
  const to = shiftDate(from, HORIZON_DAYS);
  return (state.portfolio.milestones || [])
    .filter((mark) => mark.target_date >= from && mark.target_date < to)
    .sort((a, b) => a.target_date.localeCompare(b.target_date));
}

// The fortnight ahead as a day strip, one diamond per checkpoint.
//
// The chart below already draws every one of these, spread across as many lanes
// as there are projects -- which is exactly why they are hard to read as a set.
// This is the same marks on one dated line, and it is the one question a plan
// gets asked most often: what is supposed to land next.
//
// Read-only, like the fortnight drawer: a checkpoint is reached in the project
// view, where the record is kept.
function renderCheckpointHorizon() {
  const strip = $("checkpoint-horizon");
  const marks = checkpointsAhead();
  // `.horizon` sets `display`, so the attribute alone would not hide it -- the
  // stylesheet carries the `[hidden]` guard that makes this work.
  strip.hidden = marks.length === 0;
  strip.innerHTML = "";
  if (!marks.length) return;

  const named = new Map(state.portfolio.projects.map(
    (project) => [project.id, project.name]));
  const byDate = new Map();
  for (const mark of marks) {
    if (!byDate.has(mark.target_date)) byDate.set(mark.target_date, []);
    byDate.get(mark.target_date).push(mark);
  }

  const caption = element("div", "horizon-cap");
  caption.appendChild(element("div", "horizon-title", `Next ${HORIZON_DAYS} days`));
  caption.appendChild(element("div", "hint", "What the plans are aiming at"));
  strip.appendChild(caption);

  const days = element("div", "horizon-days");
  const today = formatDate(new Date());
  for (let index = 0; index < HORIZON_DAYS; index += 1) {
    const iso = shiftDate(today, index);
    const date = parseDate(iso);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const cell = element("div", `horizon-day${weekend ? " is-weekend" : ""}`
      + `${index === 0 ? " is-today" : ""}`);
    cell.appendChild(element("div", "horizon-date", weekdayDate(iso)));

    for (const mark of byDate.get(iso) || []) {
      const hit = element("div", `horizon-mark${mark.achieved ? " reached" : ""}`);
      hit.appendChild(element("div", "milestone-diamond"));
      hit.appendChild(element("div", "horizon-name", mark.name));
      hit.title = `${mark.name}\n${named.get(mark.project_id) || ""}\n`
        + `${weekdayDate(iso)} — ${mark.achieved ? "reached" : "not reached yet"}`;
      cell.appendChild(hit);
    }
    days.appendChild(cell);
  }
  strip.appendChild(days);
}

function renderPortfolio() {
  renderPortfolioHeadline();
  renderCheckpointHorizon();
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
  // The swimlane names get a column of their own, left of the calendar. They used
  // to be a row above each lane's bars, which put every name on the gridlines and
  // under the today line -- the one marker on this chart that is deliberately 2px
  // of near-black ink, so it cut straight through whichever name it landed on.
  // A column also means the names line up as a list you can scan, which is how
  // you find a lane among a dozen.
  view.gutterPx = LANE_NAME_PX;
  const visible = phases.filter((phase) => inWindow(phase, view));
  offWindowNote(chart, phases.length - visible.length);

  // Drawn even with nothing on it: the empty grid is the drop target for the
  // tray, and a dataset where nothing is dated yet is exactly when you need it.
  const body = weekGrid(chart, view, portfolioRuler);
  const now = todayLine(view);
  if (now) body.appendChild(now);

  // Checkpoints, per lane. Grouped once rather than filtered per project: the
  // payload is flat because a milestone belongs to a project and not to a
  // phase, which is the one thing the chart cannot read off a bar.
  const checkpoints = new Map();
  for (const milestone of state.portfolio.milestones || []) {
    if (!checkpoints.has(milestone.project_id)) checkpoints.set(milestone.project_id, []);
    checkpoints.get(milestone.project_id).push(milestone);
  }

  // Keyed off `state.projects` -- every project there is, ideas included -- and
  // not off the projects this chart draws. Same rule the map follows and for the
  // same reason: a colour must not move because a project got dated, left the
  // window, or was filtered out somewhere else.
  const palette = trackPalette(state.projects);

  const drawn = [];
  for (const project of projects) {
    const own = visible.filter((phase) => phase.project_id === project.id);
    // Bars decide which lanes exist, as they always have. A project whose work
    // is all off-window keeps its checkpoints off-window with it rather than
    // opening a lane holding nothing but a diamond.
    if (own.length === 0) continue;
    drawn.push(project.id);

    const lane = element("div", "lane");
    const title = element("div", "lane-title", project.name);
    // The way from a bar you are reading to the plan behind it. Same affordance
    // as the ruler's week cells -- a div with a tabIndex rather than a button,
    // so it keeps the lane's own type -- and the same wording pattern on the
    // tooltip. It is a read, so nothing about the chart is disturbed by it.
    title.title = `${laneSummary(project)}\n\nClick to open this project.`;
    title.tabIndex = 0;
    title.onclick = () => openProject(project.id);
    title.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openProject(project.id);
    };
    const open = state.laneOpen.has(project.id);
    lane.classList.toggle("open", open);
    lane.appendChild(laneName(title, laneTwisty(project, open),
      palette.get(trackPath(project.track)[0]), laneMeta(project)));
    // One row per plan row inside the lane, the same shape and the same
    // components as the project timeline: a bar for a phase, a one-mark lane for
    // a checkpoint, interleaved on the shared `sort_order`. Every checkpoint in
    // one strip above the bars was the first shape here too, and it read as
    // "these come first" -- while a lane's bars have always been in `sort_order`
    // (`db.list_all_phases`), so the sequence was already the thing the rows say.
    // The lane grows by a row per dated checkpoint, which is what it costs.
    const marks = milestoneMarks(checkpoints.get(project.id), view).marks;
    const placed = markIndex(marks);
    // The rows go in the lane's second column, beside the name rather than under
    // it. Bars still measure from the column's own left edge, which is where the
    // calendar starts, so nothing about how one is placed changed.
    const rows = element("div", "lane-rows");
    if (!open) {
      // Two rows at most, and usually one: the span, then every checkpoint on a
      // single strip. That strip is the shape `milestoneLane` and
      // `stackMilestoneLanes` were kept alive for after interleaving left them
      // with one mark per row and nothing to stack -- "the cheap way back if a
      // compact all-checkpoints strip is ever wanted". This is it, and the sweep
      // below has a real input again.
      rows.appendChild(laneSummaryBar(project, view));
      if (marks.length) rows.appendChild(milestoneLane(marks));
    } else {
      for (const row of mergePlanRows(own, checkpoints.get(project.id))) {
        if (row.kind === "phase") {
          const bar = phaseBar(row.item, view, false);
          bar.classList.add("draggable");
          bar.title += "  (drag to move; hold Alt for day steps)";
          makeDraggable(bar, row.item, view);
          rows.appendChild(bar);
        } else if (placed.has(row.item.id)) {
          rows.appendChild(milestoneLane([placed.get(row.item.id)]));
        }
      }
    }
    lane.appendChild(rows);
    body.appendChild(lane);
  }

  // The lanes actually on screen, not every committed project: a track whose
  // work is all off-window has no rail here to explain.
  renderTrackKey(palette, projects.filter((project) => drawn.includes(project.id)));
  renderLaneControls(drawn);
  // Every lane at once, now that they are all attached and have a layout.
  stackMilestoneLanes(chart);
  renderTray(body, view);
  renderPlacementUndo();
  // Redrawn from the slice already in hand: the chart moving underneath it
  // does not change which fortnight you opened.
  renderFortnightDrawer();
}

// What the rails stand for. Only the tracks with a lane on this chart are
// listed -- the map's legend keys the whole dataset because the map draws the
// whole dataset, while a rail here belongs to a swimlane and a track with no
// swimlane has no rail to explain.
//
// The colours still come from the whole-dataset palette, so this narrows what is
// *listed* without moving what anything is *painted*. The greys are claimed only
// when something is wearing one.
function renderTrackKey(palette, drawnProjects) {
  const key = $("track-key");
  key.innerHTML = "";

  const roots = [...new Set(drawnProjects
    .map((project) => trackPath(project.track)[0]))];
  const named = roots.filter(Boolean).sort();
  if (!named.length && !roots.length) return;

  key.appendChild(element("span", "filter-caption", "Track"));
  const entry = (name, hue, tooltip) => {
    const item = element("span", "track-key-item");
    const swatch = element("span", "track-key-swatch");
    swatch.style.background = hue || "var(--faint)";
    item.append(swatch, element("span", "track-key-name", name));
    item.title = tooltip;
    key.appendChild(item);
  };

  for (const name of named) {
    const hue = palette.get(name);
    entry(name, hue, hue
      ? `${name} — the same colour this track wears on the map.`
      : `${name} — past the eighth track, so it takes the grey rather than a `
        + "hue nobody could tell from another.");
  }
  if (roots.some((root) => !root)) {
    entry("untracked", null, "Projects with no track written down.");
  }
}

// One button for the whole chart, beside the count of what it is showing.
// Twelve lanes means twelve twisties, and the gesture this tab is for -- read
// the department, then open the one project you are asking about -- starts with
// all of them one way.
//
// Built here rather than wired in `bindEvents` because its label is a reading of
// the state: it says the thing it will do next, so with any lane open it offers
// to collapse. Only the lanes actually **drawn** are counted, so a project whose
// work is all off-window is neither counted nor opened by it.
function renderLaneControls(drawn) {
  const bar = $("lane-controls");
  bar.innerHTML = "";
  if (drawn.length === 0) return;

  const openCount = drawn.filter((id) => state.laneOpen.has(id)).length;
  const collapse = openCount > 0;
  const button = element("button", null, collapse ? "Collapse all" : "Expand all");
  button.type = "button";
  button.title = collapse
    ? "Fold every lane back to one bar per project"
    : "Show every phase and checkpoint in every lane";
  button.onclick = () => {
    // Collapsing clears the whole set rather than the drawn ids, so paging the
    // window cannot leave a lane open off-screen and make the next press read
    // "Collapse all" with nothing on screen open.
    if (collapse) state.laneOpen.clear();
    else for (const id of drawn) state.laneOpen.add(id);
    renderPortfolio();
  };
  bar.append(button, element("span", "muted",
    `${drawn.length} lane(s) · ${openCount} open`));
}

// The lane's own dates, which its bars cannot say between them: each bar carries
// one phase, and the span is the question the Portfolio tab exists to answer.
//
// Every number here is read off the payload, never derived from the bars on
// screen -- a lane only draws the phases inside the current window, so measuring
// those would make the same project report different dates as you page the
// chart. `validation.project_span` owns the arithmetic.
function laneSummary(project) {
  const dates = project.span_start && project.span_end
    ? `${project.span_start} → ${project.span_end}`
    : "no dates yet";
  return `${project.name}\n${dates} · ${project.phase_count} phase(s) · `
    + `${project.total_points} pts\n${STAGE_BADGE[project.derived_stage] || ""} `
    + `${project.derived_stage}`;
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

// --- the drag readout -------------------------------------------------------

// The date you are about to drop on, pinned to the cursor.
//
// Both drags already wrote it into the thing being dragged, and that is where it
// failed: a bar is exactly as wide as its phase, so at the 22px/week floor a
// two-week bar is 44px and the text is clipped to nothing -- in precisely the
// case where the readout matters. Alt then moves it by a few pixels, so the
// gesture that most needs a date had the least room to print one.
//
// `position: fixed`, so clientX/clientY land it without any scroll arithmetic;
// the portfolio chart sits in a scroll container and the pill deliberately does
// not live in it.
const DRAG_PILL_OFFSET = 14;

let dragPill = null;

function showDragPill(event, text) {
  if (!dragPill) {
    dragPill = element("div", "drag-pill");
    document.body.appendChild(dragPill);
  }
  dragPill.textContent = text;
  dragPill.style.left = `${event.clientX + DRAG_PILL_OFFSET}px`;
  dragPill.style.top = `${event.clientY + DRAG_PILL_OFFSET}px`;
}

function hideDragPill() {
  if (dragPill) dragPill.remove();
  dragPill = null;
}

// Alt is what drops the snap from a week to a single day, and coming off a
// Monday deliberately is the only reason to hold it -- so that is exactly when
// the weekday is worth printing.
function dropLabel(iso, altKey) {
  if (!altKey) return iso;
  return `${iso} · ${parseDate(iso).toLocaleDateString(
    undefined, { weekday: "short" })}`;
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
    //
    // **First row, not last.** It was appended, which put it under however many
    // lanes the chart already had -- on a real dataset that is below the fold, so
    // the one thing the gesture is aimed at was the one thing you could not see.
    // At the top it sits directly under the tray the chip came from, whatever the
    // chart has grown to. The rows below shift down by a row while the drag is
    // live; the placement is horizontal, so that costs the gesture nothing.
    const arm = () => {
      lane = element("div", "lane lane-ghost");
      lane.appendChild(laneName(element("div", "lane-title", entry.project_name)));
      const rows = element("div", "lane-rows");
      ghost = element("div", "bar tray-ghost");
      rows.appendChild(ghost);
      lane.appendChild(rows);
      // The today line is in here too and is positioned, so DOM order costs it
      // nothing -- it stays over the bars either way.
      body.insertBefore(lane, body.firstChild);
      chip.classList.add("dragging");
    };

    const onMove = (moveEvent) => {
      if (!lane) {
        const travelled = Math.hypot(moveEvent.clientX - from.x, moveEvent.clientY - from.y);
        if (travelled < DRAG_ARM_PX) return;
        arm();
      }
      // The body's box starts at the name column, which the calendar does not:
      // the gutter comes off before the pointer is turned into a day, or every
      // drop would land a column's worth of weeks early.
      const rect = body.getBoundingClientRect();
      const raw = (moveEvent.clientX - rect.left - (view.gutterPx || 0))
        / view.pxPerDay;
      // Whole weeks by default, matching how bars are dragged; Alt for a
      // project that has to begin mid-week.
      const snapped = moveEvent.altKey ? Math.round(raw) : Math.round(raw / 7) * 7;
      dropDay = Math.min(Math.max(snapped, 0), view.totalDays - 1);
      placeBar(ghost, dropDay, dropDay + span, view);
      const landing = formatDate(addDays(view.origin, dropDay));
      ghost.textContent = `${entry.project_name} → ${landing}`;
      showDragPill(moveEvent, dropLabel(landing, moveEvent.altKey));
    };

    const onUp = async () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      hideDragPill();
      chip.classList.remove("dragging");
      if (lane) lane.remove();
      // A press that never armed is a click, and a click must not schedule
      // anything -- a date this consequential only comes from a real drag.
      if (dropDay === null) return;

      const startDate = formatDate(addDays(view.origin, dropDay));
      try {
        await api(`/api/projects/${entry.project_id}`, {
          method: "PUT",
          body: JSON.stringify({
            start_date: startDate,
            expect: { start_date: entry.start_date },
          }),
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
          // Kept whole, not just the ids: the undo states each date it is
          // clearing, so a phase re-dated by someone else after the drop is
          // refused rather than blanked.
          placements: result.placements,
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
        body: JSON.stringify({
          start_date: "",
          expect: { start_date: (last.placements || {})[phaseId] },
        }),
      });
    }
    await api(`/api/projects/${last.projectId}`, {
      method: "PUT",
      body: JSON.stringify({
        start_date: last.previousStart,
        expect: { start_date: last.startDate },
      }),
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
      const landing = shiftDate(phase.start_date, dayDelta);
      bar.textContent = dayDelta === 0 ? label : `${label} → ${landing}`;
      showDragPill(moveEvent, dropLabel(landing, moveEvent.altKey));
    };

    const onUp = async () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      hideDragPill();
      bar.classList.remove("dragging");
      bar.textContent = label;
      if (dayDelta === 0) return;
      // Only this phase moves. Dependents stay put and start warning instead.
      try {
        await api(`/api/phases/${phase.id}`, {
          method: "PUT",
          body: JSON.stringify({
            start_date: shiftDate(phase.start_date, dayDelta),
            expect: { start_date: phase.start_date },
          }),
        });
      } catch (failure) {
        reportStaleWrite(failure);
      }
      await loadPortfolio();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
}

// --- fortnight slice --------------------------------------------------------

// One fortnight of the roadmap, drawn as a day-resolution strip of phase bars
// over a list of deliverables. Two layers because that is what the schema has,
// not as a design preference: a phase carries dates and can be placed on a time
// axis, while a deliverable carries none and cannot be placed on one at all.
//
// Divs on a CSS grid rather than SVG. The two charts this sits beside are divs
// on a week grid; the map is the one hand-rolled SVG in the codebase and this
// is not the map.
//
// The component reads and never writes. It is handed a slice and draws it --
// no fetching, no opening, no closing. `compact` is what the drawer passes:
// the same DOM at tighter metrics, so the drawer and the eventual sprint tab
// cannot drift into two different pictures of one fortnight.
//
// Points are drawn **whole, on the bar**, and the part of a phase that falls
// inside the window is carried by the bar's width and nothing else. There is no
// windowed points total here and there must not be one.

const BAND_NOTE = {
  overdue: "ended before this fortnight and is still open",
  window: "in this fortnight",
  lead_out: "starts in the lead-out week",
};

const shortDate = (iso) => parseDate(iso).toLocaleDateString(
  undefined, { day: "numeric", month: "short" });

// The strip is the fortnight plus its lead-out, so it is measured off the
// window rather than assumed: the server owns how long either half is.
const sliceDays = (window) =>
  daysBetween(parseDate(window.start), parseDate(window.lead_out_end)) + 1;

const dayIndex = (window, iso) =>
  daysBetween(parseDate(window.start), parseDate(iso));

function renderSprintSlice(container, slice, { compact = false } = {}) {
  const { window, lanes } = slice;
  const days = sliceDays(window);
  container.innerHTML = "";
  container.classList.add("slice");
  container.classList.toggle("slice-compact", compact);
  container.style.setProperty("--slice-days", days);

  container.appendChild(sliceHeading(window));

  const strip = element("div", "slice-strip");
  strip.appendChild(sliceRuler(window, days));
  const colours = laneColours(lanes);

  const body = element("div", "slice-body");
  body.appendChild(sliceBackdrop(window, days));
  // Absent rather than parked off-screen when today is not on the strip: a
  // line at an edge would read as "today is here", which is the one thing it
  // must never say.
  if (window.today) body.appendChild(sliceTodayLine(window, days));
  for (const lane of lanes) {
    body.appendChild(sliceLane(lane, window, days, colours.get(lane.project_id)));
  }
  strip.appendChild(body);
  container.appendChild(strip);

  if (lanes.length === 0) {
    container.appendChild(element("p", "muted",
      "Nothing scheduled in this fortnight."));
    return;
  }
  container.appendChild(sliceDeliverables(lanes, colours));
}

// One colour per project, so several lanes of one project read as one project
// and its neighbour reads as somebody else's. It is **identity, not meaning**:
// the bar fill still says status and the one red still says overdue, which is
// why the colour goes on the row's rail, its name and a wash faint enough to
// leave the weekend shading showing through, and never on the bar.
//
// Assigned in order of first appearance rather than by project id, so adjacent
// rows differ: `TRACK_HUES` is sequenced for exactly that -- neighbouring pairs
// -- and lanes sort by band then project, so first-appearance order is the
// order down the strip. The cost is that a project can take a different colour
// in a different fortnight. Accepted: this panel is one fortnight read on its
// own, and the alternative -- a stable hash -- lets two adjacent rows collide,
// which is the thing being fixed.
//
// The eight are the map's, deliberately reused rather than a second palette
// invented: they are already checked for the three common colour-blindnesses
// against a 3:1 floor. They mean *track* on the map, but the map is a different
// picture and this panel draws no tracks at all, so nothing is being said twice
// in one place. A ninth project in one fortnight wraps, which is one more than
// the real dataset has ever put in a fortnight.
function laneColours(lanes) {
  const colours = new Map();
  for (const lane of lanes) {
    if (colours.has(lane.project_id)) continue;
    colours.set(lane.project_id, TRACK_HUES[colours.size % TRACK_HUES.length]);
  }
  return colours;
}

function sliceHeading(window) {
  const head = element("div", "slice-head");
  head.appendChild(element("strong", null,
    `${shortDate(window.start)} – ${shortDate(window.end)}`));
  head.appendChild(element("span", "muted",
    `lead-out to ${shortDate(window.lead_out_end)}`));
  // A fortnight always starts on a Monday. Saying so when the date you asked
  // for was not one is cheaper than silently drawing a different fortnight.
  if (window.requested_start !== window.start) {
    head.appendChild(element("span", "muted",
      `snapped back from ${shortDate(window.requested_start)}`));
  }
  return head;
}

function sliceRuler(window, days) {
  const ruler = element("div", "slice-ruler");
  const origin = parseDate(window.start);
  for (let index = 0; index < days; index += 1) {
    const day = addDays(origin, index);
    const cell = element("div", sliceDayClass(window, day, index, "slice-tick"),
      String(day.getDate()));
    cell.title = day.toLocaleDateString(
      undefined, { weekday: "long", day: "numeric", month: "long" });
    ruler.appendChild(cell);
  }
  return ruler;
}

// Weekends and the lead-out are shading rather than anything positional, so
// they are one layer behind the lanes instead of a class on every bar.
function sliceBackdrop(window, days) {
  const backdrop = element("div", "slice-backdrop");
  const origin = parseDate(window.start);
  for (let index = 0; index < days; index += 1) {
    const day = addDays(origin, index);
    backdrop.appendChild(
      element("div", sliceDayClass(window, day, index, "slice-day")));
  }
  return backdrop;
}

function sliceDayClass(window, day, index, base) {
  const weekend = day.getDay() === 0 || day.getDay() === 6;
  // The fortnight is the first 14 columns; everything past it is the lead-out,
  // and the first of those carries the divider.
  const leadOut = index >= 14;
  // Today's whole column is shaded, alongside the line that marks the day
  // exactly. The line says *where* today is to the day; the shading is what you
  // find without looking for it. `window.today` is already null when today is
  // off the strip, so this cannot land on a column that is not today.
  const today = window.today && formatDate(day) === window.today;
  return `${base}${weekend ? " is-weekend" : ""}`
    + `${leadOut ? " is-lead-out" : ""}${index === 14 ? " is-lead-edge" : ""}`
    + `${today ? " is-today" : ""}`;
}

function sliceTodayLine(window, days) {
  const line = element("div", "slice-today");
  line.style.left = `calc(${dayIndex(window, window.today)} * 100% / ${days})`;
  line.title = `Today, ${shortDate(window.today)}`;
  return line;
}

function sliceLane(lane, window, days, colour) {
  const row = element("div", `slice-lane band-${lane.band}`);
  // Inline, like the map's --track-dot and for the same reason: the hue is a
  // value worked out from the data, not one of a fixed set of classes. The wash
  // carries an alpha rather than being mixed towards white, so the weekend and
  // lead-out shading behind the row still shows through it.
  if (colour) {
    row.style.setProperty("--lane-hue", colour);
    row.style.setProperty("--lane-tint", hexRgba(colour, 0.09));
  }

  const title = element("div", "slice-lane-title");
  title.appendChild(element("span", "slice-project", lane.project_name));
  title.appendChild(element("span", "slice-phase", lane.phase_name));
  if (lane.band === "overdue") {
    title.appendChild(element("span", "slice-flag", "overdue"));
  }
  row.appendChild(title);
  row.appendChild(sliceBar(lane, window, days));
  return row;
}

function sliceBar(lane, window, days) {
  const bar = element("div",
    `slice-bar band-${lane.band} status-${lane.status}`);

  let from = dayIndex(window, lane.start_date);
  // The end date is the day work stops, so the last day drawn is the one
  // before it. A same-week phase would otherwise reach a column too far.
  let to = dayIndex(window, lane.end_date) - 1;
  from = Math.max(from, 0);
  to = Math.min(Math.max(to, from), days - 1);
  // An overdue phase ends before the strip begins, so both ends clamp to the
  // first column: it pins to the left edge, which is where "before this
  // fortnight" belongs.
  bar.style.gridColumn = `${from + 1} / ${to + 2}`;

  bar.classList.toggle("clip-start", lane.clipped_start);
  bar.classList.toggle("clip-end", lane.clipped_end);
  // Whole, never pro-rated: this is the phase's own estimate, not a share of
  // it apportioned to the fortnight.
  bar.textContent = `${lane.effort_points} pts`;
  bar.title = `${lane.project_name} · ${lane.phase_name}\n`
    + `${lane.start_date} to ${lane.end_date} `
    + `(${lane.duration_weeks}w, ${lane.effort_points} pts, ${lane.status})\n`
    + BAND_NOTE[lane.band];
  return bar;
}

// Names and their tick. A deliverable is still a planning unit -- no estimate,
// no owner, no date -- but "which of these is already done" is the first thing
// asked of a fortnight's scope, and the tick is the only answer the roadmap has.
// `fortnight_lane` has always carried `done` for exactly this: shown, never
// derived from. An earlier version of this drew names alone.
//
// **Read-only, in a panel that reads.** The boxes are disabled: ticking one is
// roadmap state and the project view owns that gesture, the same line this panel
// is on the safe side of everywhere else. The strike-through is the deliverable
// list's own vocabulary, so a done row reads the same in both places.
function sliceDeliverables(lanes, colours) {
  const wrap = element("div", "slice-deliverables");
  wrap.appendChild(element("div", "slice-deliv-head", "Deliverables in scope"));

  let named = 0;
  for (const lane of lanes) {
    if (lane.deliverables.length === 0) continue;
    named += 1;
    const group = element("div", "slice-deliv-group");
    // The same rail as the strip above, so a group of names is traceable back
    // to the row it came from without reading the project name twice.
    const colour = colours.get(lane.project_id);
    if (colour) group.style.setProperty("--lane-hue", colour);
    group.appendChild(element("div", "slice-deliv-title",
      `${lane.project_name} · ${lane.phase_name}`));
    const list = element("ul", "slice-deliv-list");
    for (const deliverable of lane.deliverables) {
      const done = Boolean(deliverable.done);
      const row = element("li", done ? "done" : null);
      const tick = element("input", null);
      tick.type = "checkbox";
      tick.checked = done;
      tick.disabled = true;
      // The box says what it is rather than looking broken: a disabled control
      // takes no pointer events, so the title rides on the row.
      row.title = done ? "Done -- tick it in the project view" : "Not done yet";
      row.appendChild(tick);
      row.appendChild(element("span", null, deliverable.name));
      list.appendChild(row);
    }
    group.appendChild(list);
    wrap.appendChild(group);
  }

  if (named === 0) {
    wrap.appendChild(element("p", "muted",
      "None of this fortnight's phases name a deliverable yet."));
  }
  return wrap;
}

// --- the sprint tab's scope panel -------------------------------------------

// **The roadmap, beside the file you are planning into.** The Sprint tab had no
// roadmap in it at all: the fortnight drawer on Portfolio was the one place the
// two met, and it is on the wrong tab to fill a capacity table from.
//
// It **reads and never writes**, which is the line this panel is deliberately on
// the safe side of: allocating deliverables into sprints is a Phase 2 non-goal,
// and a panel that could put one into the file is a step towards allocating them.
// You read it and type what you decide.
//
// It costs no endpoint and no server code. The file's fortnight is already on
// `GET /api/sprints` -- `sprint_window_from_heading` reads it off the first line,
// leniently, so a heading with no dates in it simply has no window -- and
// `GET /api/fortnight` already answers "what is in that fortnight". The panel is
// the two of them joined, drawn with `sliceDeliverables`, the same component the
// drawer uses, so the two pictures of one fortnight cannot drift apart.
const openSprintWindow = () => state.sprint.files.find(
  (file) => file.number === state.sprint.number)?.window || null;

// What the cached slice is a read of: **which fortnight, at which edition of the
// roadmap.** The fortnight alone was the whole key until 2026-08-17, and that was
// the bug -- a slice fetched once was kept forever, so adding a deliverable on
// the Project tab left this panel drawing the scope from before the edit, with
// nothing on screen admitting it was stale.
//
// Keying on `roadmapRevision` rather than clearing the cache when the Sprint tab
// opens: the tab is reached by a click that changes nothing far more often than
// by one that follows an edit, and a key that says what it was read at re-asks
// exactly when the answer can have changed.
const scopeKey = (window) => `${window.start}#${state.roadmapRevision}`;

function scopeSilence() {
  if (state.sprint.number === null) return "No sprint file open.";
  if (isTemplate(state.sprint.number)) {
    return "The template covers no fortnight — its heading is filled in when a "
      + "sprint is created from it.";
  }
  return "This file's first line names no dates, so there is no fortnight to look up.";
}

function renderSprintScope() {
  // The links ride in on this render rather than one of their own: it is the
  // app.js end of the sprint view, it runs on every draw of the tab, and the
  // chips are drawn from `state` by the cell renderer whenever the answer lands.
  loadSprintLinks();

  const panel = $("sprint-scope");
  if (!panel) return;
  const scope = state.sprintScope;
  const window = openSprintWindow();
  panel.innerHTML = "";
  panel.appendChild(element("h3", "sprint-scope-head", "Deliverables in scope"));

  if (!window) {
    // Three different silences, and they are worth telling apart: nothing open,
    // the template, or a heading whose dates cannot be read. None of them is
    // guessed at -- inventing a fortnight is exactly what the server refuses to
    // do for the overlap check. The template's heading is a *placeholder* for the
    // dates the server fills in on create, so it has no fortnight by design
    // rather than by an edit that went wrong.
    panel.appendChild(element("p", "muted", scopeSilence()));
    return;
  }

  panel.appendChild(element("p", "sprint-scope-window",
    `${shortDate(window.start)} → ${shortDate(window.end)}`));

  // The slice already in hand is kept on screen while a re-read is in flight, so
  // an edit does not blank the panel and flash "Reading the roadmap…" over a
  // picture that is one deliverable out of date. It is replaced when the answer
  // lands; only a panel with nothing at all to draw says it is reading.
  const key = scopeKey(window);
  if (scope.asked !== key) loadSprintScope(window, key);
  if (!scope.slice || scope.start !== window.start) {
    panel.appendChild(element("p", "muted", scope.error || "Reading the roadmap…"));
    return;
  }

  // The heading's dates are the sprint's own and are never snapped; the chart
  // window is Monday-based and is. So when the two differ the panel says so
  // rather than quietly showing two days the sprint does not cover -- the same
  // distinction `sprint_window` and `fortnight_window` exist separately to keep.
  const framed = scope.slice.window.start;
  if (framed !== window.start) {
    panel.appendChild(element("p", "muted sprint-scope-note",
      `Read from the week of ${shortDate(framed)}.`));
  }

  panel.appendChild(sliceDeliverables(scope.slice.lanes, laneColours(scope.slice.lanes)));
}

// Fired from the render and re-rendering when it lands, so nothing else has to
// be made async. `asked` is set before the request and never cleared: a failure
// leaves the message on screen rather than asking again on the next render,
// which would be a request per keystroke on a localhost that is refusing.
async function loadSprintScope(window, key) {
  const scope = state.sprintScope;
  scope.asked = key;
  try {
    const slice = await api(`/api/fortnight?start=${encodeURIComponent(window.start)}`);
    Object.assign(scope, { key, start: window.start, slice, error: "" });
  } catch (failure) {
    Object.assign(scope, { key: null, start: null, slice: null, error: failure.message });
  }
  // Only if the panel is still asking the same question: switching file mid-flight
  // must not paint the previous file's fortnight over the new one's, and an edit
  // landing mid-flight has already asked a newer one that will draw itself.
  const open = openSprintWindow();
  if (open && scopeKey(open) === key) renderSprintScope();
}

// --- deliverable links ------------------------------------------------------

// **`D-42` in a sprint row is deliverable 42**, and this is the half of that
// which draws. The reference is text in your markdown; the chip it draws carries
// the deliverable's own tick and an arrow to it.
//
// Why the tick is the deliverable's rather than the row's Status cell: two places
// claiming to own "is this done" is what makes a two-way sync undefinable. Clear
// the tick on the Project tab and there is no value to write back into a Status
// column -- the work was maybe in `Testing`, and inventing `Not Started` would be
// the app editing your file with a guess. One owner and the reverse direction
// stops needing a definition: the chip is drawing the deliverable, so it is
// already right.
//
// The row's Status column is never read here and never written here. It stays
// your five-state note about how the work is going.
//
// This lives in `app.js` and reaches the editor through two seams it exposes,
// `registerCellInline` and `registerCellMenu`. That is the whole reason those
// exist: `editor.js` renders a cell but must not know what a deliverable is, and
// its own discipline is that a cell renders only what its menu can insert -- so
// the chip and the picker are registered together or neither is.

// Kept in step with `DELIVERABLE_REF` in `main.py`, which is what decides whether
// a row is linked at all. This one only decides where the chip is drawn.
//
// Two spellings, one written: `[#D-42]` is what the picker writes, `D-42` is what
// the files already on disk say. See the argument in `main.py`.
const DELIVERABLE_REF = /\[#D-(\d+)\]|\bD-(\d+)\b/;

// The id out of whichever spelling matched.
const referencedId = (match) => Number(match[1] || match[2]);

// The deliverable a chip draws: the file's read links when they are in hand, the
// roadmap's own list when they are not.
//
// **The fallback is what makes a reference you have just typed draw at once.**
// `/api/sprints/{number}/links` is cached against `roadmapRevision`, and a sprint
// save deliberately does not move that counter -- a `PUT` per autosave debounce
// would re-read the fortnight to redraw a panel nothing had changed. So a fresh
// `D-42` is not in `byId` and would sit there as plain text until some unrelated
// roadmap write happened to re-read it. Everything a chip needs is already in
// `/api/deliverables`; only `rows`, the "named in N rows of this file" count, is
// the links' to answer, and it is a tooltip rather than the link.
//
// Null rather than a made-up link while there is nothing to answer from: no file
// open, the template (it plans no fortnight, so a live tick in it would link real
// data to a document about nothing), or the roadmap not read yet -- calling a
// reference dead before reading the roadmap would accuse it of being a typo.
function sprintLink(id) {
  const found = state.sprintLinks.byId.get(id);
  if (found) return found;
  if (state.sprint.number === null || isTemplate(state.sprint.number)) return null;
  if (!state.allDeliverables.length) return null;

  const one = state.allDeliverables.find((row) => row.id === id);
  if (!one) return { deliverable_id: id, label: "", rows: 1, missing: true };
  return {
    deliverable_id: id,
    label: "",
    rows: 1,
    missing: false,
    name: one.name,
    done: one.done,
    phase_id: one.phase_id,
    project_id: one.project_id,
    project_name: one.project_name,
  };
}

// Null rather than a node when there is nothing to draw the chip from:
// `firstCellInline` skips a rule that declines to build, and leaves the text it
// matched alone. So an unresolved `D-42` is the characters you typed, which is
// also exactly what it is in the file.
// `where.ownTick === false` is a surface saying it already draws a box for this
// line, so the chip must not draw a second one. **A tick belongs to one control**,
// and on a task line the control is the box at the front -- nearest the thumb, and
// the one every other line in the file has. The chip keeps the reference and the
// way through, which is all it ever was besides the tick.
//
// A table cell says nothing, so the chip carries its own box there: a row has no
// box of its own to hand it to.
function deliverableChip(match, where) {
  const id = referencedId(match);
  const link = sprintLink(id);
  if (!link) return null;

  const chip = element("span", link.missing ? "cell-ref cell-ref-dead" : "cell-ref");
  if (link.missing) {
    // The characters you typed, in the spelling you typed them: a dead reference
    // is a typo to find in the file, so the file's own text is what to show.
    chip.textContent = match[0];
    chip.title = `No deliverable ${id} in the roadmap — check the reference.`;
    return chip;
  }

  // The box is the only thing in a cell that is not "click here to type", so it
  // stops the click that would otherwise open the editor over it -- the same
  // reason and the same handling as a checkbox line.
  let box = null;
  if (!where || where.ownTick !== false) {
    box = element("input", "cell-ref-tick");
    box.type = "checkbox";
    box.checked = link.done;
    box.title = link.done ? "Done — untick to reopen" : "Still ongoing — tick to finish";
    box.onclick = (event) => {
      event.stopPropagation();
      toggleLinkedDeliverable(id, box.checked);
    };
  }

  // The reference stays on screen as written. The deliverable's name is the
  // tooltip rather than the label: the row already carries a task name you typed,
  // and drawing the name again would say the same thing twice in one cell.
  const label = element("span", "cell-ref-id", `D-${id}`);

  // An `<a>` on purpose -- `sprintCellHost` lets a click through a link rather
  // than opening the editor under it, which is the behaviour a jump wants.
  const jump = element("a", "cell-ref-jump", "↗");
  jump.href = "#";
  jump.title = `Open ${link.name} in ${link.project_name || "its project"}`;
  jump.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    jumpToDeliverable(id);
  };

  chip.title = link.rows > 1
    ? `${link.name} · ${link.project_name} · named in ${link.rows} rows of this file`
    : `${link.name} · ${link.project_name}`;
  if (box) chip.append(box);
  chip.append(label, jump);
  return chip;
}

// Nothing for an empty filter, which is the contract `registerCellMenu` states:
// `/` on its own is the editor's own inventory, and the roadmap only joins it
// once you have typed something to narrow it. `d` is the something that reaches
// all of them, since every key here starts with it.
// `lineUnique` is the editor's "one of these per line" mark, and this regex is why
// it exists: `row_references` and `line_reference` in `main.py` both take a line's
// **first** reference and stop, so a second one on the same line is not a second
// link -- it would draw a tick the file's own reader ignores. Picking again
// therefore moves the reference the line already has rather than adding one beside
// it. A second *line*, in the same cell or not, is its own link and takes its own
// reference.
function deliverableMenuEntries(filter) {
  if (!filter.trim()) return [];
  return state.allDeliverables.map((one) => ({
    key: `d${one.id}`,
    label: one.name,
    markdown: `[#D-${one.id}] `,
    lineUnique: DELIVERABLE_REF,
  }));
}

registerCellInline({ mark: DELIVERABLE_REF, render: deliverableChip });
registerCellMenu(deliverableMenuEntries);

// --- a task line's own link --------------------------------------------------

// **A checkbox line is a unit of work, so it can be one of the roadmap's.** The
// two halves are the editor's `registerLineOwner` and `registerLineAction` seams,
// and they are registered together for the same reason the two above are: the
// action is the only way to give a line an owner, so an owner nothing can create
// would be a state you could only reach by typing the reference by hand.
//
// What the owner does: the line's box draws the deliverable's tick, and pressing
// it ticks the deliverable. The marker in the file is written too -- your file
// keeps saying what you ticked -- but the roadmap is what the box *shows*, so the
// two cannot sit there disagreeing about a line you are looking at.

// The line's first reference, resolved, or null when it has none, when it names
// nothing, or when there is no roadmap read yet to say either way.
function lineDeliverable(text) {
  const found = DELIVERABLE_REF.exec(text);
  if (!found) return null;
  const id = referencedId(found);
  const link = sprintLink(id);
  if (!link || link.missing) return null;
  return { id, link };
}

function deliverableLineOwner(text) {
  const owned = lineDeliverable(text);
  if (!owned) return null;
  const { id, link } = owned;
  return {
    done: Boolean(link.done),
    title: link.done
      ? `${link.name} is done. Untick to reopen it on the roadmap.`
      : `${link.name} is still ongoing. Tick to finish it on the roadmap.`,
    toggle: (done) => toggleLinkedDeliverable(id, done),
  };
}

// One glyph in front of both labels, line and row alike, so "this press is about a
// link" reads before the word does. Part of the label rather than a span of its
// own: the seam hands the editor a string, and a press is not worth a second seam.
const SYNC_ICON = "🔗";

// The press that opens the picker. Offered on every task line rather than only on
// an unlinked one: picking again is how a line's reference is *moved*, which is
// the gesture for "this turned out to be the other deliverable".
//
// Null in the template, for `loadSprintLinks`' reason -- it plans no fortnight, so
// a link from it would point real roadmap state at a document about nothing.
function deliverableLineAction(text) {
  const number = state.sprint.number;
  if (number === null || isTemplate(number)) return null;
  const owned = lineDeliverable(text);
  return {
    label: owned ? `${SYNC_ICON} Linked` : `${SYNC_ICON} Sync`,
    title: owned
      ? `Synced to ${owned.link.name} — press to sync it elsewhere, or pick it again to unlink`
      : "Sync this line to a deliverable",
    run: (press, current, write, where) => openSyncPicker(press, owned ? owned.id : null,
      (id) => linkTickedLine(press, id, current, write, where),
      owned ? () => write(withoutReference(current)) : null),
  };
}

registerLineOwner(deliverableLineOwner);
registerLineAction(deliverableLineAction);

// --- a checkbox line inside a table cell -------------------------------------

// **The line is the unit here too.** A cell often holds a checklist rather than
// one task, and `row_references` in `main.py` reads each of its lines as its own
// link -- so each gets the press a task line outside the table has, through
// `registerCellLineAction`.
//
// Per line and not per row: a row that plans three things names three
// deliverables, and a single press somewhere in the row could only ever mean one
// of them. The provider, the picker and the write are the list line's; all that
// differs is which surface drew the press.
function deliverableCellLineAction(text) {
  const number = state.sprint.number;
  if (number === null || isTemplate(number)) return null;
  const owned = lineDeliverable(text);
  return {
    label: owned ? `${SYNC_ICON} Linked` : `${SYNC_ICON} Sync`,
    title: owned
      ? `Synced to ${owned.link.name} — press to sync it elsewhere, or pick it again to unlink`
      : "Sync this line to a deliverable",
    run: (press, current, write, where) => openSyncPicker(press, owned ? owned.id : null,
      (id) => linkTickedLine(press, id, current, write, where),
      owned ? () => write(withoutReference(current)) : null),
  };
}

// The same owner a task line outside the table has. A checkbox line in a cell is
// the same unit of work, so its box draws the deliverable's tick and pressing it
// ticks the deliverable -- and the cell's own marker is written too, so the file
// keeps saying what you ticked.
registerCellLineOwner(deliverableLineOwner);
registerCellLineAction(deliverableCellLineAction);

// One reference per line, so a line that has one has it **moved** rather than
// joined by a second. Same rule as a table row's, and the same reason:
// `line_reference` in `main.py` takes the first and stops.
function withReference(text, id) {
  const mark = `[#D-${id}]`;
  const found = DELIVERABLE_REF.exec(text);
  if (found) {
    return text.slice(0, found.index) + mark + text.slice(found.index + found[0].length);
  }
  const base = text.replace(/\s+$/, "");
  return base ? `${base} ${mark}` : mark;
}

// The reverse. The line keeps its marker, its box and its words -- only the
// reference goes, and **nothing is ticked or unticked by unlinking**: the box was
// drawing the deliverable's state, and the file's own marker already says the
// same thing, so it stays exactly as it was drawn.
//
// The gap the reference leaves is closed, because `Ship it [#D-42]` unlinked
// should read `Ship it` and not `Ship it ` -- a trailing space is a diff nobody
// asked for.
function withoutReference(text) {
  const found = DELIVERABLE_REF.exec(text);
  if (!found) return text;
  const cut = text.slice(0, found.index) + text.slice(found.index + found[0].length);
  return cut.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/, "");
}

// --- saying what just happened ------------------------------------------------

// One notice at a time, at the foot of the window, gone in eight seconds or when
// you dismiss it. Built and removed like the picker: no element in `index.html`
// to keep in step, and no `hidden` attribute to be caught by the `display` trap.
//
// This exists for one message -- a sprint file rewritten by a tick you made
// somewhere else -- and should stay that narrow. An app that announces its every
// success is one you stop reading.
const toast = { node: null, timer: null };

function hideToast() {
  clearTimeout(toast.timer);
  if (toast.node) toast.node.remove();
  toast.node = null;
  toast.timer = null;
}

function showToast(text, undo) {
  hideToast();
  const node = element("div", "app-toast");
  node.appendChild(element("span", "app-toast-text", text));

  if (undo) {
    const back = element("button", "app-toast-undo", "Undo");
    back.type = "button";
    back.title = "Put the marker back and clear the tick";
    back.onclick = () => {
      hideToast();
      undo();
    };
    node.appendChild(back);
  }

  const close = element("button", "app-toast-close", "×");
  close.type = "button";
  close.title = "Dismiss";
  close.onclick = hideToast;
  node.appendChild(close);

  document.body.appendChild(node);
  toast.node = node;
  toast.timer = setTimeout(hideToast, 8000);
}

// --- the sync picker ---------------------------------------------------------

// **The fortnight first, the roadmap behind it.** A sprint file plans the work
// that overlaps its dates, so those are the deliverables worth offering; the rest
// of the roadmap is one press away rather than absent, because a plan that reaches
// forward is a thing people write and refusing to link it would be an opinion
// about scheduling this app does not get to have.
//
// Grouped by project, sub-headed by phase, in the scope panel's own lane colours:
// the two lists are answering the same question a foot apart, and a deliverable
// should look the same in both.
//
// Built and removed rather than hidden. Nothing in here is toggled with the
// `hidden` attribute, so nothing here can be caught by the `display` trap that
// `css_check.js` exists for.
const syncPicker = { node: null, dismiss: null };

function closeSyncPicker() {
  if (!syncPicker.node) return;
  document.removeEventListener("mousedown", syncPicker.dismiss, true);
  syncPicker.node.remove();
  syncPicker.node = null;
  syncPicker.dismiss = null;
}

// The ids the open fortnight has in scope, or null while the slice has not been
// read. Null rather than an empty set, because "nothing in scope" and "not read
// yet" want different words on screen.
function scopedDeliverableIds() {
  const slice = state.sprintScope.slice;
  if (!slice) return null;
  const ids = new Set();
  for (const lane of slice.lanes) {
    for (const one of lane.deliverables) ids.add(one.id);
  }
  return ids;
}

// Deliverables in list order, grouped project by project and phase by phase. The
// order inside a group is `/api/deliverables`' own -- by id -- so a name edited
// elsewhere does not reshuffle the list under the cursor.
function pickerGroups(rows) {
  const groups = [];
  const at = new Map();
  for (const one of rows) {
    const key = `${one.project_id}#${one.phase_id}`;
    let group = at.get(key);
    if (!group) {
      group = {
        key,
        project_id: one.project_id,
        project_name: one.project_name || "No project",
        phase_name: one.phase_name || "",
        rows: [],
      };
      at.set(key, group);
      groups.push(group);
    }
    group.rows.push(one);
  }
  return groups;
}

function pickerMatches(one, filter) {
  if (!filter) return true;
  const hay = `${one.name} ${one.project_name} ${one.phase_name} d-${one.id}`;
  return hay.toLowerCase().includes(filter);
}

// `unlink` is null on a line that has no reference yet. When it is given, picking
// the row already linked -- the one drawn `.here` -- takes the reference off
// instead of writing it again. **A link you cannot undo is a link you hesitate to
// make**, and picking the same thing twice is the gesture people try first.
function openSyncPicker(anchor, currentId, choose, unlink = null) {
  closeSyncPicker();

  const panel = element("div", "sync-picker");
  const head = element("div", "sync-picker-head");
  const search = element("input", "sync-picker-search");
  search.type = "text";
  search.placeholder = "Search deliverables";
  const tally = element("span", "sync-picker-tally");
  head.append(search, tally);

  const list = element("div", "sync-picker-list");
  const foot = element("div", "sync-picker-foot");
  const scopeOnly = element("button", "sync-picker-scope");
  const everything = element("button", "sync-picker-scope");
  scopeOnly.type = "button";
  everything.type = "button";
  const hint = element("span", "sync-picker-hint", "↑↓ · ⏎ · esc");
  foot.append(scopeOnly, everything, hint);
  panel.append(head, list, foot);

  const scoped = scopedDeliverableIds();
  // The roadmap outright when there is no fortnight to narrow to: an empty list
  // with a toggle to press is a worse answer than the list you can use.
  let wide = scoped === null || scoped.size === 0;
  let selected = 0;
  let shown = [];

  // One place, so the keyboard and the mouse cannot disagree about what picking
  // the row you are already on means.
  const pick = (id) => {
    closeSyncPicker();
    if (id === currentId && unlink) unlink();
    else choose(id);
  };

  const draw = () => {
    const filter = search.value.trim().toLowerCase();
    const pool = wide || !scoped
      ? state.allDeliverables
      : state.allDeliverables.filter((one) => scoped.has(one.id));
    shown = pool.filter((one) => pickerMatches(one, filter));
    if (selected >= shown.length) selected = Math.max(0, shown.length - 1);

    tally.textContent = `${shown.length} of ${pool.length}`;
    scopeOnly.textContent = `In scope (${scoped ? scoped.size : 0})`;
    everything.textContent = `Whole roadmap (${state.allDeliverables.length})`;
    scopeOnly.disabled = !scoped || scoped.size === 0;
    scopeOnly.classList.toggle("on", !wide);
    everything.classList.toggle("on", wide);

    list.textContent = "";
    if (shown.length === 0) {
      list.appendChild(element("p", "sync-picker-empty", wide
        ? "Nothing in the roadmap matches. This picker only writes a reference — name the deliverable on the Project tab first."
        : "Nothing in this fortnight matches. Widen to the whole roadmap, or name it on the Project tab first."));
      return;
    }

    // The scope panel's own colours, so a deliverable reads the same in the panel
    // and in the picker a foot away from it. Empty while there is no fortnight
    // read: an uncoloured group is honest about there being nothing to colour by.
    const hues = state.sprintScope.slice
      ? laneColours(state.sprintScope.slice.lanes)
      : new Map();

    for (const group of pickerGroups(shown)) {
      const title = element("div", "sync-picker-group");
      const colour = hues.get(group.project_id);
      if (colour) title.style.setProperty("--lane-hue", colour);
      title.appendChild(element("span", "sync-picker-project", group.project_name));
      if (group.phase_name) {
        title.appendChild(element("span", "sync-picker-phase", group.phase_name));
      }
      list.appendChild(title);

      for (const one of group.rows) {
        const row = element("div", "sync-picker-row");
        if (shown[selected] && shown[selected].id === one.id) {
          row.setAttribute("aria-selected", "true");
        }
        const here = one.id === currentId;
        if (here) row.classList.add("here");
        const tick = element("input", null);
        tick.type = "checkbox";
        tick.checked = Boolean(one.done);
        tick.disabled = true;
        const name = element("span", one.done ? "sync-picker-name done" : "sync-picker-name",
          one.name);
        row.append(tick, name, element("span", "sync-picker-ref", `D-${one.id}`));
        // The row you are already linked to says what pressing it does, because
        // what it does there is the opposite of what it does everywhere else.
        if (here && unlink) row.title = "Linked to this line — press again to unlink";
        else if (here) row.title = "Linked to this line";
        else row.title = one.done ? "Already done" : "Not done yet";
        // `mousedown` rather than `click`: the press must not blur the search field
        // first, which is what closes the picker.
        row.onmousedown = (event) => {
          event.preventDefault();
          pick(one.id);
        };
        list.appendChild(row);
      }
    }
  };

  search.oninput = () => {
    selected = 0;
    draw();
  };

  search.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSyncPicker();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (shown[selected]) pick(shown[selected].id);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      if (shown.length) selected = (selected + step + shown.length) % shown.length;
      draw();
      const here = list.querySelector('[aria-selected="true"]');
      if (here) here.scrollIntoView({ block: "nearest" });
    }
  };

  scopeOnly.onclick = () => {
    wide = false;
    selected = 0;
    draw();
    search.focus();
  };
  everything.onclick = () => {
    wide = true;
    selected = 0;
    draw();
    search.focus();
  };

  // Filled before it is placed: an empty panel measures a few pixels tall, and a
  // panel placed on that measurement is one that fits everywhere and then grows
  // off the bottom of the window.
  document.body.appendChild(panel);
  draw();
  placeSyncPicker(panel, anchor);
  search.focus();

  // Capture, so a press anywhere else closes this before that press does whatever
  // else it was going to do.
  syncPicker.node = panel;
  syncPicker.dismiss = (event) => {
    if (!panel.contains(event.target)) closeSyncPicker();
  };
  document.addEventListener("mousedown", syncPicker.dismiss, true);
}

// Under the press it was opened from, flipped above it when there is no room
// below, and pushed back inside the window when there is room for neither -- a
// panel hanging off the bottom edge is a list you cannot reach the end of.
// `position: fixed`, so the numbers are viewport ones and a scrolled document
// needs no correction.
function placeSyncPicker(panel, anchor) {
  const at = anchor.getBoundingClientRect();
  const size = panel.getBoundingClientRect();
  const below = window.innerHeight - at.bottom;
  const wanted = below > size.height + 8 || at.top < size.height + 8
    ? at.bottom + 4
    : at.top - size.height - 4;
  const top = Math.max(8, Math.min(wanted, window.innerHeight - size.height - 8));
  const left = Math.max(8, Math.min(at.left, window.innerWidth - size.width - 8));
  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;
}

// --- linking two records that already disagree --------------------------------

// **Linking is where a line's box and a deliverable's tick meet, and they may
// already say different things.** Neither is wrong: the box is what the file
// recorded and the tick is what the roadmap recorded, both were typed by someone
// on purpose, and this app does not get to pick between two user-entered states.
// So it asks once, at the moment the link is made, and from then on there is one
// answer -- the box draws the deliverable, and the question cannot come back.
//
// Asked **only** when they disagree. A question with one possible answer is a
// keystroke tax, so agreeing states link silently, as they always have.
//
// Nothing is repaired here and nothing is inferred: cancelling writes neither the
// reference nor either tick, which is the same stance as the rest of the app --
// every rule reports, and the user's press is what changes something.
function linkTickedLine(anchor, id, current, write, where) {
  const text = withReference(current, id);
  const link = sprintLink(id);
  const lineDone = Boolean(where && where.done);
  // A reference to nothing has no state to disagree with, and neither has a
  // roadmap that has not been read yet.
  if (!link || link.missing || Boolean(link.done) === lineDone) {
    write(text);
    return;
  }

  openTickConflict(anchor, link, lineDone, (winner) => {
    if (winner === "line") {
      // The file's answer wins: the line keeps the box it has and the roadmap is
      // told. `toggleLinkedDeliverable` is the same write the box itself makes,
      // so this reaches every other file naming it, exactly as a press would.
      write(text);
      toggleLinkedDeliverable(id, lineDone);
      return;
    }
    // The roadmap's answer wins: the reference and the marker are written
    // together, so the file agrees with the box before the next render draws it.
    write(text, Boolean(link.done));
  });
}

// Built and removed like the picker, anchored to the same press, and dismissed
// the same way -- no element in `index.html` to keep in step, and no `hidden`
// attribute for the `display` trap to catch.
const tickConflict = { node: null, dismiss: null, keys: null };

function closeTickConflict() {
  if (!tickConflict.node) return;
  document.removeEventListener("mousedown", tickConflict.dismiss, true);
  document.removeEventListener("keydown", tickConflict.keys, true);
  tickConflict.node.remove();
  tickConflict.node = null;
  tickConflict.dismiss = null;
  tickConflict.keys = null;
}

// The two states, spelled out as what each one would do rather than as "yes" and
// "no": the press has to say which record is about to change, because one of them
// is a file and the other is the roadmap.
function openTickConflict(anchor, link, lineDone, choose) {
  closeTickConflict();

  const panel = element("div", "tick-conflict");
  panel.appendChild(element("p", "tick-conflict-head",
    `${link.name} is ${link.done ? "done" : "not done"} on the roadmap.`));
  panel.appendChild(element("p", "tick-conflict-note",
    `This line says ${lineDone ? "done" : "not done"}. Which one starts the link?`));

  const answer = (winner) => {
    closeTickConflict();
    choose(winner);
  };

  const roadmap = element("button", "tick-conflict-pick",
    `Take the roadmap's — ${link.done ? "tick" : "untick"} this line`);
  roadmap.type = "button";
  roadmap.title = "The line's box is rewritten to match the deliverable.";
  roadmap.onclick = () => answer("deliverable");

  const file = element("button", "tick-conflict-pick",
    `Take this line's — mark ${link.name} ${lineDone ? "done" : "not done"}`);
  file.type = "button";
  file.title = "The deliverable is written on the roadmap, and every other file naming it follows.";
  file.onclick = () => answer("line");

  panel.append(roadmap, file);
  panel.appendChild(element("p", "tick-conflict-hint", "esc · don't link"));

  document.body.appendChild(panel);
  placeSyncPicker(panel, anchor);
  roadmap.focus();

  tickConflict.node = panel;
  // Dismissing is cancelling: nothing has been written yet, so the line is left
  // exactly as it was, unlinked.
  tickConflict.dismiss = (event) => {
    if (!panel.contains(event.target)) closeTickConflict();
  };
  tickConflict.keys = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeTickConflict();
  };
  document.addEventListener("mousedown", tickConflict.dismiss, true);
  document.addEventListener("keydown", tickConflict.keys, true);
}

// Same shape as `scopeKey` and for the same reason: the answer can change when
// the roadmap does, so the key says which edition it was read at. The file is in
// it too, because switching file changes the question entirely.
const sprintLinksKey = () => `${state.sprint.number}#${state.roadmapRevision}`;

// Fired from the render and re-rendering when it lands, like `loadSprintScope`.
// `asked` is set before the request and never cleared on failure, so a refusal
// leaves the chips undrawn rather than asking again on every keystroke.
async function loadSprintLinks() {
  const links = state.sprintLinks;
  const number = state.sprint.number;
  // The template plans no fortnight and copies into every future file, so a live
  // tick in it would be a link to real data from a document about nothing.
  if (number === null || isTemplate(number)) {
    links.asked = null;
    links.byId = new Map();
    links.error = "";
    return;
  }

  const key = sprintLinksKey();
  if (links.asked === key) return;
  links.asked = key;
  try {
    const [found, all] = await Promise.all([
      api(`/api/sprints/${number}/links`),
      api("/api/deliverables"),
    ]);
    links.byId = new Map(found.map((one) => [one.deliverable_id, one]));
    state.allDeliverables = all;
    links.error = "";
  } catch (failure) {
    links.byId = new Map();
    links.error = failure.message;
  }
  // Only if the page is still asking the same question -- switching file
  // mid-flight must not paint the previous file's links over the new one's.
  if (sprintLinksKey() === key) renderSprintView();
}

// The write, and the only one this feature makes. Optimistic on the way out so
// the box does not flick back while the request is in the air; the PUT moves
// `roadmapRevision`, so the render behind it re-reads the links and the server's
// answer is what survives.
async function toggleLinkedDeliverable(id, done) {
  const link = state.sprintLinks.byId.get(id);
  if (link) link.done = done;
  // The roadmap copy too, because a chip drawn from the fallback above is built
  // fresh from this row on every render -- setting it only on a link object that
  // may not exist would let the box flick back on the next draw.
  const one = state.allDeliverables.find((row) => row.id === id);
  if (one) one.done = done;
  await api(`/api/deliverables/${id}`, {
    method: "PUT",
    body: JSON.stringify({ done }),
  });
  const marks = await pushDeliverableMarks(id, done);
  renderSprintView();
  announceMarks(id, done, marks, () => toggleLinkedDeliverable(id, !done));
}

// --- the tick, going out to the files ----------------------------------------

// **The reverse direction, and the only writing this app does to a document you
// did not type in.** A task line's box draws the deliverable, so a tick anywhere
// has to reach the marker on that line -- otherwise the file says one thing and
// the screen beside it says another.
//
// Narrow on purpose: task markers only. A table row has no marker and its Status
// column stays a note the app has no opinion about, so a deliverable named only
// in tables changes nothing here and nothing is announced.
//
// The file the editor is holding unsaved is the editor's own to change. Its disk
// copy is already behind what is on screen, and a server write under it is how a
// half-typed line goes missing -- so it is named in `skip` and flipped in memory
// instead, riding out on the next autosave.
async function pushDeliverableMarks(id, done) {
  const open = state.sprint.number;
  const holding = open !== null && !isTemplate(open) && sprintHasUnsavedWork();
  const answer = await api("/api/sprints/marks", {
    method: "POST",
    body: JSON.stringify({
      deliverable_id: id,
      done,
      skip: holding ? [open] : [],
    }),
  });

  const changed = answer.files || [];
  const mine = holding ? markOpenSprint(id, done) : 0;

  // A file the server wrote that is also the one on screen. It had no unsaved
  // work -- that is why it was not skipped -- but its mtime has moved, and the
  // next autosave quotes the old one and would be refused as a conflict.
  if (open !== null && changed.some((one) => one.number === open)) {
    await loadSprintFile(open);
    renderSprintView();
  }
  return { changed, mine };
}

// The same flip as `marked_for` in `main.py`, against the blocks in memory. Kept
// in step with it; the server's is the one that decides what is on disk.
const TASK_MARKER = /^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[([ xX])\]/;

// A checkbox line inside a cell, in either spelling. `_CELL_MARKER` in `main.py`
// is the same expression, and the two are kept in step for the same reason
// `TASK_MARKER` is: the server decides what is on disk, this decides what the
// open file shows until the next save carries it there.
const CELL_MARKER = /^([ \t]*)(☐|☑|(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\])/;

// One consequence worth stating: a block being typed in at this moment holds its
// text in `sprint.draft`, and the draft is written back over `raw` when the edit
// lands. So a flip that arrives while you are editing that very line loses to
// what you type, which is the right way round for it to lose.
function markOpenSprint(id, done) {
  let changed = 0;
  for (const block of state.sprint.blocks) {
    if (block.table) {
      changed += markOpenSprintTable(block, id, done);
      continue;
    }
    if (block.type !== "list" && block.type !== "quote") continue;
    block.raw = block.raw.split("\n").map((line) => {
      const found = TASK_MARKER.exec(line);
      if (!found) return line;
      const rest = line.slice(found[0].length);
      const reference = DELIVERABLE_REF.exec(rest);
      if (!reference || referencedId(reference) !== id) return line;
      if ((found[2].toLowerCase() === "x") === done) return line;
      changed += 1;
      return `${found[1]}[${done ? "x" : " "}]${rest}`;
    }).join("\n");
  }
  if (changed) scheduleSprintSave();
  return changed;
}

// The same flip inside a table the editor is holding. The grid is the client's
// copy of the table -- `serialiseEditedTables` turns it back into markdown at save
// time -- so the write is to the cell value and the block is flagged, exactly as a
// press on the box in that cell would leave it.
function markOpenSprintTable(block, id, done) {
  let changed = 0;
  for (const row of block.table.rows) {
    row.forEach((cell, column) => {
      const lines = String(cell ?? "").replace(/<br\s*\/?>/gi, "\n").split("\n");
      let touched = 0;
      const written = lines.map((line) => {
        const found = CELL_MARKER.exec(line);
        if (!found) return line;
        const rest = line.slice(found[0].length);
        const reference = DELIVERABLE_REF.exec(rest);
        if (!reference || referencedId(reference) !== id) return line;
        const marker = found[2] === "☑" || /\[[xX]\]/.test(found[2]);
        if (marker === done) return line;
        touched += 1;
        return `${found[1]}${cellMarkerFor(found[2], done)}${rest}`;
      });
      if (!touched) return;
      row[column] = written.join("\n");
      changed += touched;
    });
  }
  if (changed) block.tableEdited = true;
  return changed;
}

// One cell marker set to `done`, in the spelling the line already uses --
// `markCellTodo`'s rule in `editor.js`, and `_tick_cell_marker`'s in `main.py`.
function cellMarkerFor(marker, done) {
  if (marker === "☐" || marker === "☑") return done ? "☑" : "☐";
  return marker.replace(/\[[ xX]\]/, done ? "[x]" : "[ ]");
}

// Said out loud, because a file changing while you were not typing in it is the
// one edit here nobody asked for directly. Silent when nothing changed, which is
// most ticks: most deliverables are in no sprint file at all.
function announceMarks(id, done, marks, undo) {
  const names = marks.changed.map((one) => one.name);
  if (marks.mine) names.push(state.sprint.name || "the open file");
  if (names.length === 0) return;

  showToast(`${deliverableName(id)} ${done ? "ticked" : "unticked"} — `
    + `${names.join(" and ")} updated.`, undo);
}

// Whichever list is in hand. `allDeliverables` is the Sprint tab's read of the
// whole roadmap and the open plan is the Project tab's, and a tick happens on
// both -- neither tab has a reason to load the other's list to name one row.
function deliverableName(id) {
  const known = state.allDeliverables.find((row) => row.id === id);
  if (known) return known.name;
  for (const phase of state.plan ? state.plan.phases : []) {
    const one = (phase.deliverables || []).find((row) => row.id === id);
    if (one) return one.name;
  }
  return `Deliverable ${id}`;
}

// The arrow. `openProject` clears the open phases, so the one being jumped to is
// expanded after it rather than before -- otherwise the tab arrives with the
// deliverable's phase shut and nothing on screen saying where it went.
async function jumpToDeliverable(id) {
  const link = sprintLink(id);
  if (!link || link.missing || link.project_id === null) return;
  await openProject(link.project_id);
  if (link.phase_id !== null) {
    state.expandedPhases.add(link.phase_id);
    renderPhases();
  }
  revealDeliverableRow(id);
}

// --- landing on the thing you asked for --------------------------------------

// **Arriving on a tab is not the same as arriving at the row.** Both jumps used
// to stop at the tab: the phase opened, and the deliverable was wherever it
// happened to be -- often below the fold, which reads as "it did nothing".
//
// Centred rather than `nearest`, because the row is the whole point of the press
// and one resting a pixel inside the bottom edge is still something to go looking
// for. The flash is what says *which* row, once the scrolling has stopped.

// A second jump to the same row has to flash again, and an animation does not
// restart on an element already carrying the class -- so it is taken off, the
// layout is read to force the style to settle, and it goes back on.
const ARRIVAL_FLASH_MS = 1600;

function flashArrival(node) {
  node.classList.remove("just-arrived");
  void node.offsetWidth;
  node.classList.add("just-arrived");
  setTimeout(() => node.classList.remove("just-arrived"), ARRIVAL_FLASH_MS);
}

function revealDeliverableRow(id) {
  const row = document.querySelector(`tr[data-deliverable="${id}"]`);
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  flashArrival(row);
}

// The other direction. The chip is `deliverableChip`'s and carries the id as the
// text it draws, so that is what is matched -- nothing else in the document
// writes `D-42` into an element of its own.
//
// Retried once: `loadSprintLinks` lands after the render that opened the file and
// re-renders when it does, which would replace the chip found on the first look.
function revealSprintReference(id, retry = true) {
  const wanted = `D-${id}`;
  const chip = Array.from(document.querySelectorAll(".cell-ref-id"))
    .find((one) => one.textContent === wanted);
  if (!chip) {
    if (retry) setTimeout(() => revealSprintReference(id, false), 300);
    return;
  }
  const host = chip.closest(".cell-ref") || chip;
  host.scrollIntoView({ block: "center", behavior: "smooth" });
  flashArrival(host);
}

// The other direction, for the Project tab's badge. Read with the plan and never
// cached against `roadmapRevision`: a sprint save does not touch the roadmap, so
// the roadmap's edition cannot tell you a reference was typed into a file.
async function loadDeliverableSprints() {
  try {
    const found = await api("/api/sprints/links");
    state.deliverableSprints.byId = new Map(
      found.map((one) => [one.deliverable_id, one.sprints]));
  } catch {
    state.deliverableSprints.byId = new Map();
  }
}

// --- the fortnight drawer ---------------------------------------------------

// Reads and nothing else, including file creation. Clicking a week on the
// portfolio ruler opens the fortnight that starts on that Monday; the drawer
// draws the same slice component the sprint tab will, and offers no edit.

// `day` is any date, not necessarily a Monday: the ruler's day chips open the
// fortnight *containing* a day. The server snaps the window back to its Monday
// and reports both dates, so `start` is read off the answer rather than assumed
// -- it is what marks the two open weeks on the ruler, and marking a Wednesday
// would mark nothing. `planFrom` is the day you actually picked, and it is what
// the sprint file gets written from; see `plannedFrom`.
async function openFortnight(day) {
  const slice = await api(`/api/fortnight?start=${encodeURIComponent(day)}`);
  state.fortnight.start = slice.window.start;
  state.fortnight.planFrom = day;
  state.fortnight.slice = slice;
  // The portfolio render draws the drawer and marks the two open weeks on the
  // ruler. Nothing refetches: looking at a fortnight changes no plan.
  renderPortfolio();
}

// Esc is bound on the document, so this can fire from any tab. Only the
// portfolio has a ruler to unmark, and only it is guaranteed to have a chart
// in hand to redraw.
function closeFortnight() {
  if (!state.fortnight.start) return;
  state.fortnight = { start: null, planFrom: null, slice: null };
  if (state.view === "portfolio" && state.portfolio) renderPortfolio();
  else renderFortnightDrawer();
}

function renderFortnightDrawer() {
  const drawer = $("fortnight-drawer");
  const { start, slice } = state.fortnight;
  drawer.hidden = !start || !slice;
  if (drawer.hidden) return;

  drawer.innerHTML = "";
  const head = element("div", "drawer-head");
  head.appendChild(element("h3", null, "This fortnight"));
  const close = element("button", "drawer-close", "✕");
  close.title = "Close (Esc)";
  close.onclick = closeFortnight;
  head.appendChild(close);
  drawer.appendChild(head);

  const body = element("div", "drawer-body");
  drawer.appendChild(body);
  renderSprintSlice(body, slice, { compact: true });

  drawer.appendChild(fortnightFooter(slice.window));
}

// The date a sprint file gets written from: the day picked off the ruler, or
// the fortnight's own Monday when the week itself was clicked.
//
// This is the whole point of the day chips. `fortnight_window` snaps to a
// Monday and must -- the strip is drawn on Monday-based week columns -- while
// `sprint_window` deliberately does not, because the cadence is the team's own
// and planning happens on a Wednesday here. The two functions exist separately
// for exactly this reason, and until now the drawer could only ever post the
// snapped Monday, so a Wednesday sprint could not be started from this tab at
// all.
const plannedFrom = (window) => state.fortnight.planFrom || window.start;

const weekdayDate = (iso) => parseDate(iso).toLocaleDateString(
  undefined, { weekday: "short", day: "numeric", month: "short" });

// The drawer's one write, and it writes a file rather than a plan: the sprint
// template, copied and numbered. The drawer still only reads the roadmap -- what
// it creates is a markdown file, and editing that file is the Sprint tab's job,
// which is where this hands you.
//
// A second press for the same fortnight is the thing to guard against, because
// the number comes off the directory: it would make sprint N+1 with the same
// heading. So once a file exists for this window the button opens it instead.
function fortnightFooter(window) {
  const footer = element("div", "drawer-foot");
  const from = plannedFrom(window);
  const made = state.plannedSprints.get(from);
  const note = element("span", "muted", made
    ? `Started ${made.path}.`
    : "Copies templates/sprint.md to the next sprints/NN.md and opens it on the "
      + "Sprint tab.");
  const button = element("button", null,
    made ? `Open ${made.name} →` : "Plan this fortnight →");
  const result = element("span", "muted");

  // Only when it is not the Monday the strip is framed on, because that is the
  // one case where the file's dates and the picture above it differ. Saying so
  // here is cheaper than explaining a heading that reads two days later than
  // the strip you planned it from.
  if (from !== window.start) {
    footer.appendChild(element("span", "drawer-from",
      `planning from ${weekdayDate(from)}`));
  }

  button.onclick = async () => {
    button.disabled = true;
    try {
      const created = made || await api("/api/sprints", {
        method: "POST",
        body: JSON.stringify({ start: from }),
      });
      state.plannedSprints.set(from, created);
      // Creating the file and then leaving you to find it in a picker is the
      // step that makes a button not worth pressing.
      closeFortnight();
      await revealSprintFile(created.number);
    } catch (error) {
      result.className = "error";
      result.textContent = error.message;
      button.disabled = false;
    }
  };

  footer.append(note, button, result);
  return footer;
}

// The portfolio's own ruler: the shared one plus a click target per week. Kept
// separate rather than flagged on, so the project timeline's ruler is untouched
// and nothing there has to know the drawer exists.
// A quarter band above the months, so a window can be placed at a glance without
// reading week numbers or counting month blocks. Only this ruler grows one:
// `weekGrid` takes the ruler as an argument, so the project timeline is untouched
// by every line of it, and `relativeRuler` has no calendar to put quarters on.
//
// Prepended rather than built inside `weekRuler`, and after `weekRuler` has run,
// so the `.week` cells this function goes on to index are unaffected -- and the
// gutter spacer `weekGrid` inserts into every `.ruler-row` finds this row like
// any other.
function quarterRow(view) {
  const row = element("div", "ruler-row ruler-quarters");
  let block = null;
  let key = null;
  let weeks = 0;

  for (let index = 0; index < view.weeks; index += 1) {
    const monday = addDays(view.origin, index * 7);
    // A week belongs to the quarter of its Monday, the same rule the month row
    // follows, so the two can never disagree about where a boundary falls.
    const stamp = `${monday.getFullYear()}-${Math.floor(monday.getMonth() / 3)}`;
    if (stamp !== key) {
      key = stamp;
      weeks = 0;
      block = element("div", "quarter",
        `Q${Math.floor(monday.getMonth() / 3) + 1} ${monday.getFullYear()}`);
      row.appendChild(block);
    }
    weeks += 1;
    block.style.width = `${weeks * view.pxPerWeek}px`;
  }
  return row;
}

function portfolioRuler(view) {
  const ruler = weekRuler(view);
  ruler.insertBefore(quarterRow(view), ruler.firstChild);
  const open = state.fortnight.start;
  const second = open ? shiftDate(open, 7) : null;

  ruler.querySelectorAll(".week").forEach((cell, index) => {
    const monday = formatDate(addDays(view.origin, index * 7));
    cell.classList.add("week-target");
    cell.classList.toggle("week-open", monday === open || monday === second);
    cell.tabIndex = 0;
    cell.title += " — click to read the fortnight starting here";
    cell.onclick = () => openFortnight(monday);
    cell.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openFortnight(monday);
    };
    // The strip is far wider than a column, so the last few open leftwards
    // rather than hanging off the end of the chart and growing a scrollbar.
    cell.appendChild(weekDays(monday, index >= view.weeks - 3));
  });
  return ruler;
}

// Sunday-first, because `Date.getDay()` is.
const DAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

// The seven days inside a week cell, revealed on hover. The cell prints its
// Monday's date and nothing else, so until now a fortnight could only be opened
// from a Monday -- while the planning day is the team's own and lands on a
// Wednesday here, and a fortnight is occasionally started over a weekend.
//
// Picking a day opens the fortnight *containing* it and, more to the point,
// becomes the date the sprint file is written from (`plannedFrom`). The strip
// itself stays Monday-framed: it is drawn on week columns, which is why
// `fortnight_window` snaps and `sprint_window` does not.
//
// Built for every cell on every render rather than on demand -- 7 nodes across
// at most 26 weeks, against a chart that is already drawing a bar per phase --
// so revealing is pure CSS and there is no hover state in JS to get wrong.
// Mouse only, deliberately: making 182 chips focusable would put that many
// stops in the tab order to reach the chart. `Enter` on the cell still opens
// the Monday, which is the keyboard path this had before.
function weekDays(monday, openLeft = false) {
  const strip = element("div", `week-days${openLeft ? " days-end" : ""}`);
  const origin = parseDate(monday);

  for (let index = 0; index < 7; index += 1) {
    const day = addDays(origin, index);
    const iso = formatDate(day);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const chip = element("div", `week-day${weekend ? " is-weekend" : ""}`);
    chip.appendChild(element("span", "week-day-initial", DAY_INITIALS[day.getDay()]));
    chip.appendChild(element("span", "week-day-num", String(day.getDate())));
    chip.title = `Plan the fortnight from ${weekdayDate(iso)}`;
    // The cell underneath opens the Monday, and a chip is inside it.
    chip.onclick = (event) => {
      event.stopPropagation();
      openFortnight(iso);
    };
    strip.appendChild(chip);
  }
  return strip;
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
// A track nests on the slash to any depth, so the rings between the hub and the
// projects are a table rather than two constants. Every row starts at 0.36 and
// the deeper ones fill the band out to 0.625 -- past that a 38px node on the
// 0.74 ring reaches back into the label space.
//
// Depth 2 is exactly the 0.36/0.48 this used to hard-code, so a map with no
// third level anywhere draws pixel-for-pixel as it did before. 0.48 is not the
// midpoint of track and project and is deliberately nearer its parent: a group
// with a single project sits at that project's own angle, and the clearance is
// set by the node reaching back rather than by the text.
//
// The band runs out at four. Derived on the short vertical axis, which is the
// binding one: at 1530px `rings.y` is 330, the node clearance eats 0.115, and a
// level needs its dot plus LABEL_GAP plus LABEL_LINE -- about 25px. Four levels
// leaves 29px between rings; five leaves 22px and adjacent labels touch, with
// nothing at runtime able to detect it. So the model nests without limit and
// the *renderer* stops here -- see foldPath, which makes the flattening say so
// instead of silently dropping a level the way the first-slash split did.
const RING_FRACTIONS = {
  1: [0.36],
  2: [0.36, 0.48],
  3: [0.36, 0.49, 0.625],
  4: [0.36, 0.448, 0.537, 0.625],
};
const MAX_DRAWN_DEPTH = 4;
const PROJECT_RING = 0.74;
const IDEA_RING = 1.0;
// Dot radius per level, shrinking with depth so the hierarchy reads off weight
// as well as tone. The first two are the 6 and 4 the two rings used to carry.
const LEVEL_DOTS = [6, 4, 3.5, 3];
// How many characters a level's label keeps. Deeper rings sit in tighter arcs.
const LEVEL_LIMITS = [22, 18, 16, 14];
// The tier-1 pip. Deliberately not derived from the node radius -- see
// projectNode. Big enough to hold a 10px numeral, small enough not to read as
// a second node.
const TIER_PIP_R = 8;
// Line height of a label block, and the clear space between a circle's rim and
// the nearest edge of its label.
const LABEL_LINE = 13;
const LABEL_GAP = 8;
// Which way a label leans off its node -- see labelPlace.
const ALONG_RING = true;
const ACROSS_RING = false;
// A track nests on the slash: "Source Expansion / New Metrics / Network".
// Convention, not schema -- project.track stays one free-text column and a name
// without a slash is simply a track with nothing under it.
const SUBTRACK_SEPARATOR = "/";
// Hues for the track and subtrack rings. Bounded at eight because
// distinguishable colours are bounded and free-text tracks are not; a ninth
// track takes the grey rather than a hue nobody could tell from another.
//
// Picked by maximising the worst pair under protanopia, deuteranopia and
// tritanopia, with a floor of 3:1 on white because the ring labels are drawn in
// the hue as well as the dots. That floor is what ruled out the light entries
// of the palettes these come from -- Okabe-Ito and Tol muted, both designed for
// exactly this. One green only: two were the weakest pair on the map and green
// now means delivered on a project node.
//
// The order is load-bearing. Wedges are laid out in sorted track order, so
// slots N and N+1 land side by side; sequenced for the weakest *neighbouring*
// pair, which it lifts from 17 to 36.
const TRACK_HUES = [
  "#CC79A7", "#D55E00", "#882255", "#EE6677",
  "#0072B2", "#009E73", "#332288", "#40607A",
];
// How far each level's dot sits from its track's hue, mixed towards white, so
// depth reads as a tone of one colour rather than as a colour of its own. Level
// 2 is the 0.45 the subtrack ring has always used.
//
// Fixed rather than spread over whatever depth a track happens to reach: an
// allocated ramp would shift every tone above a node the moment somebody added
// a child, which is the "adding data moves a colour" complaint `trackPalette`
// is keyed off the whole dataset specifically to avoid. Running out at four
// levels is a feature -- it makes the tone ceiling and the ring ceiling the
// same number instead of two independent limits to explain.
//
// Only the *dot* takes a tone. Labels keep the full hue at every depth, which
// is what keeps TRACK_HUES' 3:1-on-white floor -- picked because ring labels
// are drawn in the hue -- untouched by nesting: measured, the ramp runs 3.06 ->
// 1.78 -> 1.47 -> 1.33 on the palette's weakest entry, so a lightened *label*
// would have walked straight through that floor by level two.
const LEVEL_TONES = [0, 0.45, 0.62, 0.72];

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

// Track colour has to be inline: a track is free text, so the hue is a value
// rather than one of a fixed set of classes. It goes on `style` and not on a
// `fill`/`stroke` attribute because the CSS rule would outrank the attribute --
// the same specificity trap `[hidden]` has now cost five features. Every
// variable falls back to the grey already in style.css, so a group with no hue
// draws exactly as it did before.
const paint = (node, variables) => {
  for (const [name, value] of Object.entries(variables)) {
    if (value) node.style.setProperty(name, value);
  }
  return node;
};

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

// "Source Expansion / New Metrics / Network" -> the three names it nests
// through. Every slash splits, to any depth.
//
// This replaced a `splitTrack` that cut on the *first* slash and returned
// exactly {track, sub}, which meant a third level became part of the second
// one's name: the value above drew a subtrack literally labelled "New Metrics /
// Network", sitting as a *sibling* of the "New Metrics" it belongs inside. The
// field is free text and nothing validates it, so the hierarchy was already
// being typed and already being drawn wrongly.
//
// Empty segments are dropped, which is what keeps "/ Metrics" a track rather
// than half a hierarchy, and absorbs the spacing already in the dataset
// ("AI Agent /  Alerting", "Agent Memory ").
const trackPath = (raw) => String(raw || "")
  .split(SUBTRACK_SEPARATOR)
  .map((part) => part.trim())
  .filter(Boolean);

// The path as the map is willing to *draw* it. The model nests without limit;
// the rings run out at four (see RING_FRACTIONS), so a deeper path is cut there
// and the project hangs off the deepest level that fits.
//
// It **truncates rather than joining the tail into a name**, and that is the
// whole correctness of this function. Joining looks like the obvious fold and
// was tried first: "A/B/C/D/E" becomes a node called "D / E" which then sits
// beside the "D" it belongs inside -- a node claiming to be a peer of its own
// parent, which is exactly the bug the first-slash split caused and this item
// exists to remove. Verified against a synthetic six-deep track, where the join
// put three siblings on one ring that were really a chain.
//
// So a level past the ceiling is **omitted from the picture, never misstated**.
// What is dropped is not lost: the node is marked (a dashed rim) and its
// tooltip names every stored value folded into it.
const foldPath = (path) => path.slice(0, MAX_DRAWN_DEPTH);

// The branch a drawn thing belongs to, as one string, so hovering a level can
// find everything under it with a prefix test rather than walking the tree again
// at hover time. Unambiguous because a segment can never hold a separator --
// `trackPath` splits on every one of them -- so "A/B" is under "A" and a track
// called "Ax" is not.
//
// Empty for the untracked group, which draws no level node: its projects belong
// to no branch and are dimmed by every branch hover, which is what they are.
const trackKey = (path) => path.join(SUBTRACK_SEPARATOR);

// One hue per track name, keyed off **every** track in the dataset rather than
// the tracks currently drawn. The tier filter runs before mapGroups, so a track
// can leave the map entirely; keying off what is drawn would recolour the whole
// map when you toggle a tier off. Counting off the whole dataset is what the
// tier chips already do, for the same reason.
//
// Sorted, so the assignment is deterministic: adding a project never moves a
// colour, and adding a new track only moves the tracks after it alphabetically.
// A track past the eighth gets no hue and falls back to the map's grey.
// Keyed off the *root* of the path, so nesting spends nothing from the eight:
// depth is a tone of the root's hue, never a hue of its own. That is what keeps
// a dataset already holding eight top-level tracks from running out of colours
// the moment somebody nests one a level deeper.
function trackPalette(projects) {
  const names = [...new Set(
    projects.map((project) => trackPath(project.track)[0]))]
    .filter(Boolean)
    .sort();
  return new Map(names.map((name, index) => [name, TRACK_HUES[index]]));
}

// The same hue at an alpha, for a wash that has to let what is behind it
// through -- the fortnight strip's row tint sits over the weekend and lead-out
// shading, which mixing towards white would paint out.
function hexRgba(hex, alpha) {
  const channel = (at) => parseInt(hex.slice(at, at + 2), 16);
  return `rgba(${channel(1)}, ${channel(3)}, ${channel(5)}, ${alpha})`;
}

// Mix a hue towards white. The subtrack ring is its track's colour a few steps
// lighter, so the hierarchy still reads off weight the way the two greys it
// replaces did.
function mixWhite(hex, amount) {
  const channel = (at) => {
    const value = parseInt(hex.slice(at, at + 2), 16);
    return Math.round(value + (255 - value) * amount);
  };
  return `rgb(${channel(1)}, ${channel(3)}, ${channel(5)})`;
}

// Whether the status filter is letting a project through.
//
// A rung with no chip is **always drawn** -- see `MAP_STAGE_CHIPS` for which two
// those are and why. That is the half worth reading twice: the set holds what is
// shown, so testing membership alone would hide `planned` and `overdue` the
// instant the default set stopped mentioning them, which is a filter switching
// off work nobody can switch back on.
//
// Read off `derived_stage` rather than the stored column, so the picture ages by
// itself and every filter here reads one field. For `idea` the two can never
// disagree anyway -- it beats every derived rung by design -- but reading the
// same field as the rest is what keeps them one kind of thing. The `done` rung
// covers both of the things it means, work that shipped and work closed with
// phases still open: the node colours tell those apart, the filter deliberately
// does not, because neither bears on where the team is pointed next.
const stageShown = (project) =>
  !MAP_STAGE_CHIPS.includes(project.derived_stage)
  || state.mapStages.has(project.derived_stage);

// The track a legend swatch stands for: the **root** of the path, since roots
// are what the legend lists and what `trackPalette` keys a hue off. Depth is a
// tone of the root rather than a colour of its own, so there is nothing deeper
// for the key to offer.
//
// Untracked projects collapse onto `UNTRACKED_KEY`, which is safe as a sentinel
// for the reason `TEMPLATE_KEY` is: `trackPath` drops empty segments, so no real
// track can ever be the empty string. They are a group the map genuinely draws
// -- hanging straight off the hub -- so they get a swatch like anything else.
const UNTRACKED_KEY = "";
const trackRoot = (project) => trackPath(project.track)[0] || UNTRACKED_KEY;

// Whether the track filter is letting a project through. An empty set is the
// default and means every track; see `state.mapTracks`.
const trackShown = (project) =>
  state.mapTracks.size === 0 || state.mapTracks.has(trackRoot(project));

// **The map's three filters, in one place.** They were written inline in
// `renderMap` and copied into `map_sweep.js --tree`, which is a copy that goes
// stale the moment a filter changes -- the sweep would then print a hierarchy
// the map does not draw, which is the one thing that tool exists to be trusted
// about. Exported to the sweep so both read the same function.
//
// Three rather than four since the status filter became one set: it was `done`
// and `ideas` as separate flags, and it now covers five rungs in one test.
//
// Filtering happens **before `mapGroups`**, so a wedge is sized by what is
// actually drawn and a track with nothing left in it leaves the map entirely.
// Hiding the noise is what widens the room around everything else, and it is why
// all four of these are worth having.
function mapDrawn(projects) {
  return projects.filter((project) =>
    state.mapTiers.has(project.tier ?? 0)
    && stageShown(project)
    && trackShown(project));
}

// Where a project sits in tier order: 1, 2, 3, then untiered. Untiered last
// because it is an unanswered question, not the lowest priority.
const tierRank = (project) => {
  const found = TIER_ORDER.indexOf(project.tier ?? 0);
  return found === -1 ? TIER_ORDER.length : found;
};

// The track hierarchy as a tree of any depth. Each node carries the projects
// sitting on its exact value (`direct`), the nodes below it (`kids`), and the
// total underneath it, which is what sizes its wedge.
//
// Levels sorted by name, projects by tier then id, so nothing reshuffles
// between renders. Untracked projects come last and hang straight off the hub;
// inside any level, projects on that exact value come before the levels below
// it and hang straight off it -- the same rule the two-level version had, now
// applied at every depth.
//
// Tier orders each `direct` list rather than the whole wedge: a node owns a
// contiguous run of slots and sits at the middle of it, so sorting across the
// wedge would interleave subtrees and leave their nodes pointing at nothing.
function mapGroups(projects) {
  const node = (name, path) => ({
    name, path, direct: [], children: new Map(), kids: [], total: 0,
    // Set when a path was deeper than the rings can draw. `folded` holds the
    // stored values that landed here, so the tooltip can say what was folded
    // rather than leaving the label to imply a level that is not there.
    flattened: false, folded: new Set(),
  });
  const root = node(null, []);

  for (const project of projects) {
    const full = trackPath(project.track);
    const shown = foldPath(full);
    let at = root;
    shown.forEach((name, index) => {
      if (!at.children.has(name)) {
        at.children.set(name, node(name, shown.slice(0, index + 1)));
      }
      at = at.children.get(name);
    });
    if (shown.length < full.length) {
      at.flattened = true;
      at.folded.add(full.join(` ${SUBTRACK_SEPARATOR} `));
    }
    at.direct.push(project);
  }

  const settle = (at) => {
    at.direct.sort((a, b) => tierRank(a) - tierRank(b) || a.id - b.id);
    at.kids = [...at.children.keys()].sort().map(
      (name) => settle(at.children.get(name)));
    at.total = at.direct.length
      + at.kids.reduce((sum, kid) => sum + kid.total, 0);
    return at;
  };
  settle(root);

  // One wedge per top-level track, then the untracked projects last -- they
  // draw no group node at all and hang straight off the hub.
  const groups = [...root.kids];
  if (root.direct.length) groups.push(root);
  return groups;
}

// How deep the tree actually goes, which picks the ring table. Measured across
// the whole map rather than per track: different tracks placing their levels at
// different radii would stop the rings being rings.
function treeDepth(groups) {
  const deepest = (at) => (at.name === null ? 0 : 1)
    + Math.max(0, ...at.kids.map(deepest));
  return Math.max(1, ...groups.map(deepest));
}

// Every slot in a wedge, in drawing order, each remembering the node it hangs
// off. Building it flat is what lets a node sit at the middle of the run of
// slots its subtree occupies -- the trick the subtrack ring already used, which
// turns out to be exactly the recursive step an intermediate level needs.
function collectSlots(at, out = []) {
  at.slotFrom = out.length;
  for (const project of at.direct) out.push({ project, owner: at });
  for (const kid of at.kids) collectSlots(kid, out);
  at.slotTo = out.length - 1;
  return out;
}

// Two groups of chips, because they answer two different questions: how much of
// the ranking to draw, and how far along the work has to be to be on the picture
// at all. Mixing them into one row read as four tiers and some stray extra ones,
// and that only got truer when the status row grew from two chips to five.
//
// Every count is off the whole dataset rather than the filtered view, so a chip
// still tells you what is behind it while it is switched off. That means a tier
// count routinely exceeds what is drawn, since the status row is hiding four
// rungs by default -- the alternative is counts that move when you touch a
// different filter, which is worse. Turning everything off is allowed: the empty
// map says why, and it is one click back.
function renderMapFilters() {
  const projects = state.graph.projects;

  const openGroup = (id, caption) => {
    const bar = $(id);
    bar.innerHTML = "";
    bar.appendChild(element("span", "filter-caption", caption));
    return bar;
  };

  const chip = (bar, modifier, label, held, shown, subject, toggle) => {
    const button = element("button",
      `map-chip ${modifier}${shown ? " on" : ""}`, `${label} ${held}`);
    button.type = "button";
    button.setAttribute("aria-pressed", String(shown));
    button.title = `${shown ? "Hide" : "Show"} ${subject} `
      + `(${held} project${held === 1 ? "" : "s"})`;
    button.onclick = () => {
      toggle();
      renderMap();
    };
    bar.appendChild(button);
    return button;
  };

  const tiers = openGroup("tier-filter", "Tier");
  for (const tier of TIER_ORDER) {
    const held = projects.filter(
      (project) => (project.tier ?? 0) === tier).length;
    const shown = state.mapTiers.has(tier);
    chip(tiers, `tier-${tier}`, TIER_LABEL[tier], held, shown,
      TIER_LABEL[tier], () => {
        if (shown) state.mapTiers.delete(tier); else state.mapTiers.add(tier);
      });
  }

  // In the ladder's order, which is what makes the row read as a ramp with a
  // window open on it rather than as five unrelated switches. `active` is the
  // one that starts on; see `MAP_STAGE_DEFAULT` for why the map opens there.
  //
  // The two rungs with no chip, `planned` and `overdue`, are drawn whatever this
  // row says and are deliberately not represented in it -- a chip that cannot be
  // switched off is a control lying about what it does. `MAP_STAGE_CHIPS` is
  // where that is argued, and the legend under the canvas is where all seven
  // rungs are still spelt out.
  const status = openGroup("status-filter", "Status");
  for (const rung of MAP_STAGE_CHIPS) {
    const held = projects.filter(
      (project) => project.derived_stage === rung).length;
    const shown = state.mapStages.has(rung);
    chip(status, `status-${rung}`, rung, held, shown, STAGE_SUBJECT[rung], () => {
      if (shown) state.mapStages.delete(rung); else state.mapStages.add(rung);
    });
  }
}

// What a node's own colours mean, in the ladder's order. The map has carried two
// colour axes for a while -- the stage on a project node, the track hue on the
// rings -- and explained neither anywhere you could see while looking at it.
//
// The wording is the data model's, cut to what fits beside a swatch; the
// sentence each rung actually means is on the tooltip. `done` is the one rung
// listed twice, because the map is the one place it is drawn as two things: a
// close with checkpoints outstanding is as often cancelled as finished, and only
// reaching every checkpoint earns the green.
const STAGE_LEGEND = [
  ["idea", "idea", "A future direction. Nobody has committed to it yet."],
  ["planning", "planning", "Committed, but with no work named or nothing to aim at."],
  ["planned", "planned", "Work named and a checkpoint set. Waiting only for dates."],
  ["dated", "dated", "On the calendar, not started."],
  ["active", "active", "Today falls inside the project's span."],
  ["overdue", "overdue", "The last phase end has passed with phases still open."],
  ["done", "done · closed", "Closed by hand with checkpoints outstanding — "
    + "descoped or cancelled as often as finished."],
  ["done delivered", "done · delivered", "Every checkpoint reached."],
];

// The two colour vocabularies, drawn from the map's own CSS rather than from a
// second palette: a stage swatch is a real `.map-node` circle and a track swatch
// a real `.map-group` one, so a rule that changes the picture changes the key
// with it. A legend that can drift from what it explains is worse than none.
function renderMapLegend() {
  const legend = $("map-legend");
  legend.innerHTML = "";

  const group = (caption) => {
    const box = element("div", "legend-group");
    box.appendChild(element("span", "filter-caption", caption));
    legend.appendChild(box);
    return box;
  };

  const swatch = (className, painted) => {
    const svg = svgElement("svg", {
      class: "legend-swatch", width: 20, height: 20, viewBox: "0 0 20 20",
    });
    const node = svgElement("g", { class: className });
    node.appendChild(svgElement("circle", { cx: 10, cy: 10, r: 6 }));
    if (painted) paint(node, painted);
    svg.appendChild(node);
    return svg;
  };

  // One row of the key, and -- when it is given a `pick` -- one control as well.
  // A `<button>` rather than a clickable `<span>` so it is in the tab order and
  // answers the keyboard, which is the whole difference between a control and a
  // thing that happens to respond to a mouse.
  //
  // Three states rather than two: with no filter on, every track sits plain,
  // because "all of them" is the default and dressing eight rows as *selected*
  // would say a filter was running when none is. Once one is picked the others
  // are the ones that have to look switched off.
  const entry = (box, className, label, tooltip, painted, colour, pick) => {
    const picked = pick && state.mapTracks.has(pick.key);
    const item = pick
      ? element("button", "legend-item legend-pick"
        + (state.mapTracks.size === 0 ? "" : picked ? " is-picked" : " is-muted"))
      : element("span", "legend-item");
    item.title = tooltip;
    if (pick) {
      item.type = "button";
      item.setAttribute("aria-pressed", String(Boolean(picked)));
      item.onclick = () => {
        pickMapTrack(pick.key);
        renderMap();
      };
    }
    item.appendChild(swatch(className, painted));
    const name = element("span", "legend-name", label);
    if (colour) name.style.color = colour;
    item.appendChild(name);
    box.appendChild(item);
  };

  const stages = group("Stage");
  for (const [className, label, tooltip] of STAGE_LEGEND) {
    entry(stages, `map-node stage-${className}`, label, tooltip);
  }

  // Keyed off the whole dataset, exactly as `trackPalette` is and for the same
  // reason: hiding a tier must not move a colour, and a key that only lists the
  // tracks currently drawn would empty itself as you filter. That reason is now
  // twice as load-bearing, since this half of the key is also the track filter:
  // a legend that dropped the tracks it was hiding would be a filter you could
  // not switch back off.
  const palette = trackPalette(state.graph.projects);
  const tracks = group("Track");
  const held = (key) => state.graph.projects
    .filter((project) => trackRoot(project) === key).length;
  const focus = (key) => state.mapTracks.has(key)
    ? "Click to stop drawing it."
    : state.mapTracks.size
      ? "Click to add it to what the map is drawing."
      : "Click to draw only this track.";

  // **Every root track gets its own row, named, including the ones past the
  // eighth that take the grey.** It used to collapse those into one `N more`
  // entry, which was fine while the key only explained the picture and is wrong
  // now that it filters it: a track with no row of its own is a track you cannot
  // focus, and the real dataset has nine roots, so exactly one of them — `UIUX` —
  // was unreachable. Several grey rows saying nothing but their names is also the
  // honest drawing of what the map does to them, since it paints them the same
  // grey; the tooltip is where "the palette ran out" is said.
  //
  // A no-hue row paints nothing, so `--track-dot` falls back to the grey the
  // stylesheet already carries, and its name is left in the legend's own ink
  // rather than coloured.
  let pickable = 0;
  for (const [name, hue] of palette) {
    pickable += 1;
    entry(tracks, "map-group", name,
      `${name} — ${held(name)} project${held(name) === 1 ? "" : "s"}. `
      + (hue
        ? "Every level under it is a lighter tone of this colour. "
        : "Past the eighth track the map runs out of colours anyone could tell "
          + "apart, so this one takes the grey. ")
      + focus(name),
      hue ? { "--track-dot": hue } : undefined, hue, { key: name });
  }
  if (state.graph.projects.some((project) => !trackPath(project.track).length)) {
    pickable += 1;
    entry(tracks, "map-group", "untracked",
      `Projects with no track — ${held(UNTRACKED_KEY)} of them. They hang `
      + `straight off the hub and draw no ring. ${focus(UNTRACKED_KEY)}`,
      undefined, undefined, { key: UNTRACKED_KEY });
  }

  // The way out of the filter, and it is **only here while there is one to get
  // out of**. A control that appears and disappears is normally the one you
  // cannot find, which is why it sits at the end of the row it belongs to,
  // says the count it is about to throw away, and is the one thing in the key
  // wearing a border. Switching your last track back off lands in the same
  // place, so this is the findable way rather than the only way.
  if (state.mapTracks.size) {
    const clear = element("button", "legend-clear",
      `✕ clear track filter (${state.mapTracks.size} of ${pickable})`);
    clear.type = "button";
    clear.title = "Draw every track again. The map is filtered to "
      + `${[...state.mapTracks].map((key) => key || "untracked").join(", ")}.`;
    clear.onclick = () => {
      state.mapTracks.clear();
      renderMap();
    };
    tracks.appendChild(clear);
  }

  legend.appendChild(element("p", "legend-note",
    "Circle size is total effort points. The percentage in a circle — and how "
    + "far it is filled — counts every phase as an equal share, each one filled "
    + "by the deliverables named under it; a phase closed by hand counts whole. "
    + "The numbered pip is the project's tier; an unpipped node has never been "
    + "ranked. Click a track above to draw only that one, then click others to "
    + "add them — the whole key stays listed, so nothing you hide is lost."));
}

// Clicking a track in the key, and it needs **no special case for the default**
// -- which is the whole payoff of storing what has been picked rather than what
// has been hidden. "Draw only this one" and "add this one as well" are the same
// write, and the difference between them lives entirely in what an empty set
// means to `trackShown`.
//
// Clicking your last pick back off empties the set, which is the same state the
// ✕ writes: the way back to every track, arrived at from the other direction.
function pickMapTrack(key) {
  if (state.mapTracks.has(key)) state.mapTracks.delete(key);
  else state.mapTracks.add(key);
}

function renderMap() {
  const canvas = $("map-canvas");
  canvas.innerHTML = "";
  $("department-name").value = state.graph.department_name || "";
  renderMapFilters();
  renderMapLegend();

  // Every filter, in `mapDrawn` rather than here, so `map_sweep.js` reads the
  // same one. Filtered before grouping -- see that function.
  const projects = mapDrawn(state.graph.projects);
  if (state.graph.projects.length === 0) {
    canvas.appendChild(element("p", "muted",
      "Nothing here yet. Capture a future direction below to start the map."));
    return;
  }
  if (projects.length === 0) {
    // Either filter above can empty the map, so the message names the two rows
    // rather than the individual chips it used to -- there are five status chips
    // now, and listing them would be longer than the sentence is worth. The
    // legend is drawn before this return, so the ✕ that clears a track filter is
    // on screen next to the empty canvas.
    canvas.appendChild(element("p", "muted",
      "Every project is filtered out. Switch a tier or a status back on "
      + "above — or clear the track filter under the canvas — to see them."));
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
  // Unfiltered on purpose -- see trackPalette.
  const palette = trackPalette(state.graph.projects);

  // Which ring each level sits on. The whole map shares one table, so a level
  // is a ring rather than a per-track radius -- see RING_FRACTIONS.
  const fractions = RING_FRACTIONS[Math.min(treeDepth(groups), MAX_DRAWN_DEPTH)];

  let travelled = 0;  // start at 12 o'clock and go clockwise
  for (const group of groups) {
    const span = (Math.max(group.total, 1) / weight) * ruler.total;
    // Null for the untracked group, which draws no group node at all, and for
    // a track past the end of the palette. Both then fall back to the grey.
    const hue = group.name ? palette.get(group.name) : null;

    // Every project gets one angular slot, and a level owns the contiguous run
    // of slots its subtree occupies -- which is what lets it sit at the middle
    // of the slice its projects take up, at any depth.
    const slots = collectSlots(group);
    // Every slot owns an equal length of the group's ring, so two neighbours
    // are the same number of pixels apart wherever on the map they land.
    const step = span / (slots.length + 1);
    const distanceAt = (index) => travelled + step * (index + 1);

    // Group nodes are collected rather than appended: they go on after the
    // projects, because a level sits close enough to the ring outside it that a
    // large circle would otherwise paint over its label.
    const levelNodes = [];
    const anchorOf = new Map([[group, { x: cx, y: cy }]]);

    // Depth-first from the top level down, so a node's parent always has an
    // anchor by the time the edge to it is drawn.
    const place = (at, depth, from) => {
      let anchor = from;
      if (at.name !== null) {
        // The middle of the run measured in ring *length*, not in angle: the
        // two stopped being the same thing once the steps became unequal.
        // Distances also climb steadily where angles wrap, so there is no seam
        // at 12 o'clock to handle.
        const middle = (distanceAt(at.slotFrom) + distanceAt(at.slotTo)) / 2;
        const angle = ruler.angleAt(middle);
        anchor = polar(cx, cy, rings, fractions[depth - 1], angle);
        anchorOf.set(at, anchor);

        // Tagged with the branch it *arrives at*, not the one it leaves, so the
        // spoke down from the hub is part of the branch a track hover lights and
        // the lit shape reaches the centre instead of floating.
        edges.appendChild(paint(svgElement("line", {
          class: "map-edge", "data-track": trackKey(at.path),
          x1: from.x, y1: from.y, x2: anchor.x, y2: anchor.y,
        }), { "--track-edge": hue }));
        levelNodes.push(levelNode(at, depth, anchor, labelPlace(
          anchor, rings, angle, dotFor(depth) + LABEL_GAP, ALONG_RING), hue));
      }
      for (const kid of at.kids) place(kid, depth + 1, anchor);
    };
    place(group, 1, { x: cx, y: cy });

    slots.forEach((slot, index) => {
      const isIdea = slot.project.stage === "idea";
      const from = anchorOf.get(slot.owner);
      const angle = ruler.angleAt(distanceAt(index));
      const point = polar(cx, cy, rings, isIdea ? IDEA_RING : PROJECT_RING,
        angle);
      // The project and its spoke belong to the level they hang off, which is
      // the deepest one that fits -- a project on a path past the ring ceiling
      // lights with the folded node it was drawn under, since that is where the
      // picture put it.
      const branch = trackKey(slot.owner.path);
      edges.appendChild(svgElement("line", {
        class: `map-edge${isIdea ? " map-edge-idea" : ""}`, "data-track": branch,
        x1: from.x, y1: from.y, x2: point.x, y2: point.y,
      }));
      const radius = nodeRadius(slot.project.effort_points, largest);
      centres.set(slot.project.id, { x: point.x, y: point.y, r: radius });
      nodes.appendChild(projectNode(slot.project, point, radius, labelPlace(
        point, rings, angle, radius + LABEL_GAP, ACROSS_RING), branch));
    });

    // Deepest first, so a shallower level's label draws over a deeper one's
    // dot rather than under it where the two rings crowd.
    for (const node of levelNodes.reverse()) nodes.appendChild(node);
    travelled += span;
  }

  // Last, so the hub draws over any spoke that passes near the centre.
  nodes.appendChild(hubNode(state.graph.department_name, cx, cy));
  wireMapFocus(svg, focusEdges, centres);
  wireTrackFocus(svg);
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

// Pointing at a track or a subtrack dims the map to that branch: the level
// itself, every level under it, the projects hanging off any of them and the
// spokes joining the lot. On a map of a dozen projects across eight tracks, "what
// is actually in here" was a question you had to answer by following spokes with
// your eye -- the hue says which ring a node belongs to, not which subtree.
//
// A second mode rather than a reuse of `wireMapFocus`, because the two answer
// different questions and want opposite things from the edges: dependency focus
// dims every spoke to .12 (the arrows it draws are the point), while a branch
// *is* its spokes -- lit, they make one connected shape instead of a scatter of
// circles that happen to be bright.
//
// Membership is a prefix test over `data-track` (see trackKey) rather than a walk
// of the tree, so nothing here needs the group nodes it was built from and the
// whole mechanism is two attributes and a class.
//
// Mouse only, deliberately. Project nodes get the dependency highlight from the
// keyboard for free because they are already focusable for click-to-open; a level
// node is not focusable and making it so would add a tab stop per track on the way
// to the chart, which is the same trade the ruler's day chips declined.
function wireTrackFocus(svg) {
  const inBranch = (key, root) => key === root
    || key.startsWith(`${root}${SUBTRACK_SEPARATOR}`);

  const clear = () => {
    svg.classList.remove("map-branched");
    for (const node of svg.querySelectorAll(".branch-lit")) {
      node.classList.remove("branch-lit");
    }
  };

  const focus = (root) => {
    clear();
    svg.classList.add("map-branched");
    for (const node of svg.querySelectorAll("[data-track]")) {
      if (inBranch(node.dataset.track, root)) node.classList.add("branch-lit");
    }
  };

  // `.map-group` rather than `.map-group[data-track]`: every level node carries
  // the attribute by construction, and the compound selector would be a third
  // shape for `map_sweep.js`'s stub DOM to support for no gain.
  for (const node of svg.querySelectorAll(".map-group")) {
    const root = node.dataset.track;
    if (!root) continue;
    node.addEventListener("mouseenter", () => focus(root));
    node.addEventListener("mouseleave", clear);
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

// Per-level metrics, clamped so a level past the drawn ceiling still has
// numbers rather than undefined ones.
const atLevel = (table, depth) => table[Math.min(depth, table.length) - 1];
const dotFor = (depth) => atLevel(LEVEL_DOTS, depth);

// One node for every level of the track hierarchy: the ring it lands on, the
// tone it takes and the room its label gets are all the depth.
//
// Placed ALONG_RING by its caller, so the name runs into the empty arc beside
// it rather than onto the ring in front or behind.
//
// The dot takes the level's tone and the label keeps the *full* hue at every
// depth. At 10px, text in a tone is the one place the lightening would cost
// legibility -- and it is what would walk the palette through its contrast
// floor. The hierarchy is carried by the dot, the type size and the ring.
//
// Colour rides on the group: custom properties inherit, so the circle and the
// text below pick them up from here.
function levelNode(at, depth, point, place, hue) {
  const tone = hue ? mixWhite(hue, atLevel(LEVEL_TONES, depth)) : null;
  // A folded node wears a dashed rim, because its *label* is indistinguishable
  // from the bug this replaced -- a name with a slash in it. The rim is what
  // says "there is more here than the rings can draw" rather than "somebody
  // typed a slash into a name".
  const group = paint(svgElement("g", {
    class: `map-group level-${depth}${at.flattened ? " folded" : ""}`,
    // What a hover reads to light this branch, and what everything under it is
    // tested against -- see wireTrackFocus.
    "data-track": trackKey(at.path),
  }), { "--track-dot": tone, "--track-text": hue });
  group.appendChild(svgElement("circle", {
    cx: point.x, cy: point.y, r: dotFor(depth),
  }));
  group.appendChild(labelText(
    [{ text: truncate(at.name, atLevel(LEVEL_LIMITS, depth)) }], place));

  // The label is truncated and, past the ring ceiling, is carrying more than
  // one level of the path. Both are things the picture cannot say for itself,
  // so the tooltip says them: the full path, what is underneath it, and -- when
  // the rings ran out -- the stored values that were folded into this node.
  const lines = [
    at.path.join(` ${SUBTRACK_SEPARATOR} `),
    `${at.total} project${at.total === 1 ? "" : "s"}`,
  ];
  if (at.flattened) {
    lines.push(`flattened — the map draws ${MAX_DRAWN_DEPTH} levels:`,
      ...[...at.folded].sort());
  }
  group.appendChild(svgElement("title", {}, lines.join("\n")));
  return group;
}

function projectNode(project, point, radius, place, branch) {
  const tier = project.tier ?? 0;
  // Styled off the derived stage, not the stored one. The map used to show a
  // project as committed-not-started until somebody remembered to change the
  // field by hand; now the picture ages by itself as dates pass.
  // `done` is two different things wearing one name. Every checkpoint reached is
  // work delivered; a manual close with checkpoints outstanding is work that
  // stopped, which is as often cancelled or descoped as finished -- CLAUDE.md is
  // explicit that the stored close is "not delivered but closed without
  // finishing". Only the first earns the green: painting a cancelled project as
  // a success is worse than leaving it grey.
  //
  // This reads the milestone tally, not the phase one. It read phases until the
  // ladder moved onto checkpoints, and leaving it there would have been wrong in
  // both directions: a project that reached every checkpoint with phases still
  // open would have been painted grey, and a cancelled one whose phases happened
  // to be ticked would have been painted green -- exactly the case the split
  // exists to prevent.
  const delivered = project.derived_stage === "done"
    && project.milestones_total > 0
    && project.milestones_reached === project.milestones_total;

  const group = svgElement("g", {
    class: `map-node stage-${project.derived_stage} tier-${tier}`
      + (delivered ? " delivered" : ""),
    tabindex: "0", role: "button", "data-project-id": project.id,
    // The branch this node hangs off, so a track hover can light it. Read off
    // the level it was *drawn* under rather than off `project.track`, which the
    // ring ceiling can fold -- the picture is what the hover is dimming.
    "data-track": branch || "",
  });
  group.appendChild(svgElement("circle", { cx: point.x, cy: point.y, r: radius }));
  // **Every ranked project wears its number.** Tier 3 used to recede instead --
  // half opacity on the fill and the stroke -- and that failed twice over: it
  // was reported as not reading as a rank at all, and it sat on top of the stage
  // fill, so a faded `dated` node and a faded `idea` were the same wash. A rank
  // is a number and now says so; untiered gets no pip, because the absence of a
  // decision is not a fourth rank and the label's `T?` is where that is said.
  //
  // A ring around the node was the first attempt and failed at the bottom of the
  // radius clamp -- at 16px the gap between node and ring is narrower than the
  // stroke, so the two merge. The pip is a fixed 8px whatever the node does,
  // which is the whole point; a mark that scales with the node fails wherever
  // the node is smallest. All three ranks take the same indigo: the digit is the
  // cue, and a paler pip could not hold white 10px text at the contrast floor.
  //
  // Fixed to the upper-right rather than placed away from the label: a mark
  // that moves stops being scannable, which is the only job it has. It sits at
  // 0.707r diagonally, so its far edge is `0.707r + 8` against a label starting
  // at `r + LABEL_GAP` -- clear at every radius in the 16-38 clamp, which is why
  // putting one on three times as many nodes moves no label.
  if (tier > 0) {
    const px = point.x + radius * 0.707;
    const py = point.y - radius * 0.707;
    group.appendChild(svgElement("circle", {
      class: "map-pip", cx: px, cy: py, r: TIER_PIP_R,
    }));
    group.appendChild(svgElement("text", {
      class: "map-pip-text", x: px, y: py + 3.4, "text-anchor": "middle",
    }, String(tier)));
  }

  // How much of the work is ticked off, as the circle filling from the bottom.
  //
  // It is a **rect clipped to the node's own circle**, not a second circle, and
  // that is the one mechanical thing to know here: every stage rule in the CSS
  // is `.map-node circle:not(.map-pip)`, which outranks anything a class on a
  // `<circle>` could say, so a circle drawn for this would be painted whatever
  // colour the stage is. A rect is not matched by any of them. The clip is a
  // circle a hair inside the rim, so the stroke -- which is half the stage
  // vocabulary -- stays its own colour all the way round.
  //
  // It sits *over* the stage fill rather than replacing it, because the fill is
  // already saying something: hollow is undated, pale is dated, solid is
  // running, green is delivered. Progress reads as depth of colour inside that.
  //
  // Drawn only where there is a plan to measure against. A project with no
  // phases sends `null` rather than 0 and gets neither a wedge nor a number --
  // no frame, no fraction. `validation.completion_fraction` owns the
  // arithmetic; both charts read the same field so they cannot disagree.
  const filled = project.completion;
  if (filled !== null && filled !== undefined) {
    const clipId = `map-fill-${project.id}`;
    const clip = svgElement("clipPath", { id: clipId });
    clip.appendChild(svgElement("circle", {
      cx: point.x, cy: point.y, r: Math.max(radius - 0.75, 1),
    }));
    const height = 2 * radius * filled;
    group.appendChild(clip);
    group.appendChild(svgElement("rect", {
      class: "map-fill", "clip-path": `url(#${clipId})`,
      x: point.x - radius, y: point.y + radius - height,
      width: 2 * radius, height,
    }));
    // The number in the middle of the circle. The wedge says roughly how far at
    // a glance and this says exactly, which is the pair a dashboard usually
    // gets wrong by drawing only one of them.
    //
    // **The font is scaled to the node**, because the radius clamp is 16-38px
    // and a fixed size cannot serve both ends: at 9px "100%" is about 22px wide
    // inside a 32px circle, and at the top of the clamp it would be a speck.
    // Clamped rather than a straight ratio so it never outgrows the circle or
    // falls below legibility.
    group.appendChild(svgElement("text", {
      class: "map-percent", x: point.x, y: point.y,
      "text-anchor": "middle",
      "font-size": Math.max(9, Math.min(radius * 0.45, 13)),
    }, percentText(filled)));
  }

  const meta = [];
  if (project.stage === "idea") {
    meta.push("future direction");
  } else if (project.phases_total > 0) {
    meta.push(`${project.phases_done}/${project.phases_total} phases`);
  } else {
    meta.push("no phases yet");
  }
  if (project.next_date) meta.push(`next ${project.next_date}`);
  // Marked on the first meta line rather than a line of its own: an extra line
  // would grow every label block by one, and the map's label clearances are
  // sized against the block. Marked at all because the circle cannot separate a
  // middling rank from no rank -- tier 2 and untiered are both the plain node.
  meta[0] = `${TIER_MARK[tier]} · ${meta[0]}`;

  group.appendChild(labelText([
    { text: truncate(project.name, 20), className: "map-name" },
    ...meta.map((line) => ({ text: line, className: "map-meta" })),
  ], place, "map-label"));

  // The full name and goal live in the tooltip, since the label is truncated.
  group.appendChild(svgElement("title", {}, [
    `${project.name} — ${project.derived_stage}${delivered ? ", delivered" : ""}`,
    tier === 0 ? "untiered" : `tier ${tier}`,
    `${project.effort_points} pts`,
    project.phases_total ? `${project.phases_done}/${project.phases_total} phases done` : null,
    // What the node is filled to, and how that number was arrived at. On the
    // tooltip rather than the label: the map's label clearances are sized
    // against the height of the label block, so a fourth line would move every
    // one of them. `phase_count` is the graph payload's `phases_total`, so the
    // note is built here rather than shared with the swimlane's.
    project.completion === null || project.completion === undefined ? null
      : `${percentText(project.completion)} complete — each phase an equal `
        + `share, filled by the deliverables under it`,
    project.deliverables_total
      ? `${project.deliverables_done}/${project.deliverables_total} deliverables ticked`
      : null,
    project.milestones_total
      ? `${project.milestones_reached}/${project.milestones_total} milestones reached`
      : null,
    project.next_date ? `next ${project.next_date}` : null,
    project.goal || null,
  ].filter(Boolean).join("\n")));

  const open = () => openProject(project.id);
  group.onclick = open;
  group.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };
  return group;
}

// --- future directions ------------------------------------------------------

// The Project tab spells these two out in its HTML; the map builds a pair per
// idea row, so they live here instead. Same order and same sentence, with
// "idea" for "project" only because every row on this list is one -- the link
// written is the ordinary project-to-project dependency, not a second kind.
const LINK_DIRECTIONS = [
  ["incoming", "must finish before this idea"],
  ["outgoing", "cannot start until this idea finishes"],
];

// Options for the far end of a link. `exclude` drops the idea itself -- a
// project cannot depend on itself, and offering it would only earn a 409.
// `blank` is the "no link" row the capture field needs and a row's form does
// not: capturing an idea is complete without a link, pressing Link is not.
function fillLinkOptions(select, exclude, blank) {
  const previous = select.value;
  select.innerHTML = "";
  if (blank) {
    const none = element("option", null, blank);
    none.value = "";
    select.appendChild(none);
  }
  for (const project of state.graph.projects.filter((p) => p.id !== exclude)) {
    const option = element("option", null,
      project.stage === "idea" ? `${IDEA_BADGE} ${project.name}` : project.name);
    option.value = project.id;
    select.appendChild(option);
  }
  select.value = previous;
  // The project that was selected may have just been deleted or promoted, and a
  // select holding a value none of its options carries renders blank.
  if (select.selectedIndex < 0) select.selectedIndex = 0;
}

function directionSelect() {
  const select = element("select");
  for (const [value, label] of LINK_DIRECTIONS) {
    const option = element("option", null, label);
    option.value = value;
    select.appendChild(option);
  }
  return select;
}

// One link, oriented the way the Project tab orients it: "incoming" reads as
// the other project must finish before this one starts.
function linkProjects(subjectId, otherId, direction) {
  const incoming = direction === "incoming";
  return api("/api/dependencies", {
    method: "POST",
    body: JSON.stringify({
      predecessor_project_id: incoming ? otherId : subjectId,
      successor_project_id: incoming ? subjectId : otherId,
    }),
  });
}

// Both ends in the project view's vocabulary -- "← waits on X", "→ Y waits on
// this". Read straight off the graph payload, which already carries every link
// with its names resolved for the hover highlight, so the column costs no fetch.
function linkChips(idea, links) {
  const box = element("span", "direction-links");
  for (const dep of links) {
    const outgoing = dep.predecessor_project_id === idea.id;
    const incoming = dep.successor_project_id === idea.id;
    if (!outgoing && !incoming) continue;

    const chip = element("span", "link-chip",
      outgoing ? `→ ${dep.successor_name}` : `← ${dep.predecessor_name}`);
    chip.title = outgoing
      ? `${dep.successor_name} waits on this idea`
      : `This idea waits on ${dep.predecessor_name}`;

    const unlink = element("button", "link-unlink", "✕");
    unlink.title = "Remove this link";
    unlink.onclick = async () => {
      await api(`/api/dependencies/${dep.id}`, { method: "DELETE" });
      await loadGraph();
    };
    chip.appendChild(unlink);
    box.appendChild(chip);
  }
  return box;
}

// Hidden until asked for: ten ideas each showing a pair of selects would bury
// the list they hang off. Every write re-renders the list, so the form folds
// itself away again once the link lands.
function linkForm(idea) {
  const form = element("div", "direction-link-form");
  form.hidden = true;

  const other = element("select");
  fillLinkOptions(other, idea.id, null);
  if (other.options.length === 0) {
    form.appendChild(element("p", "muted", "Nothing else to link to yet."));
    return form;
  }

  const direction = directionSelect();
  const error = element("p", "error");
  error.hidden = true;

  const submit = element("button", null, "Link");
  submit.onclick = async () => {
    error.hidden = true;
    const otherId = Number(other.value);
    if (!otherId) return;
    try {
      await linkProjects(idea.id, otherId, direction.value);
      await loadGraph();
    } catch (failure) {
      // V3 rejections land here: the edit is refused, nothing was written.
      error.textContent = failure.message;
      error.hidden = false;
    }
  };

  form.append(other, direction, submit, error);
  return form;
}

function renderDirections() {
  const list = $("direction-list");
  const ideas = state.graph.projects.filter((project) => project.stage === "idea");
  const links = state.graph.dependencies || [];
  $("direction-count").textContent = ideas.length;
  list.innerHTML = "";
  // Refilled whether or not an idea exists yet: the first one captured can be
  // linked to real work on the way in.
  fillLinkOptions($("new-direction-dep"), null, "No link");
  // A refill can drop the project that was picked -- setting a select's value in
  // script fires no `change`, so the direction is re-synced by hand.
  $("new-direction-direction").disabled = !$("new-direction-dep").value;

  if (ideas.length === 0) {
    list.appendChild(element("li", "muted", "No future directions captured yet."));
    return;
  }

  for (const idea of ideas) {
    const item = element("li");
    item.appendChild(element("span", "direction-name", idea.name));
    if (idea.track) item.appendChild(element("span", "muted", idea.track));
    item.appendChild(linkChips(idea, links));

    const form = linkForm(idea);
    // Ghost, so the row reads as an idea with one action on it: promoting is what
    // this list is for, and three buttons of equal weight said otherwise.
    const link = element("button", "btn-ghost", "Link…");
    link.title = "Tie this idea to another project without opening it";
    link.onclick = () => { form.hidden = !form.hidden; };

    const promote = element("button", null, "Promote to project");
    promote.title = "Commit to this, keeping everything already written against it";
    promote.onclick = async () => {
      // 'planned' is what committing writes now. Where it lands on the ladder
      // is worked out from the plan -- an idea with no phases becomes
      // `planning`, one already dated becomes `dated` or `active`.
      try {
        await api(`/api/projects/${idea.id}`, {
          method: "PUT",
          body: JSON.stringify({ stage: "planned", expect: { stage: idea.stage } }),
        });
      } catch (failure) {
        reportStaleWrite(failure);
      }
      await loadProjects();
    };

    const remove = element("button", "btn-ghost", "✕");
    remove.title = "Delete this direction";
    remove.onclick = async () => {
      if (!confirm(`Delete the direction "${idea.name}"?`)) return;
      await api(`/api/projects/${idea.id}`, { method: "DELETE" });
      await loadProjects();
    };

    item.append(link, promote, remove, form);
    list.appendChild(item);
  }
}

// --- track picker -----------------------------------------------------------

// The Track field is the only door into the taxonomy the map draws, and the
// grouping key is the raw string: "Source expansion" and "Source Expansion" are
// two rings, not one. So the field offers back what has already been typed,
// nested the way `trackPath` reads it, and normalises spacing on the way in.
// It stays a text input -- a track nobody has used yet needs no ceremony, it is
// simply typed, and it starts existing when the project is saved.
//
// Hand-rolled because a <datalist> cannot nest, count or offer a create row:
// the browser draws that popup and exposes none of it. The one custom control
// in this codebase, and it is here to stop bad data rather than to look nicer.
const trackPickers = [];

// Any depth, because that is what `trackPath` reads and what the map draws.
// Counts are projects sitting on that exact value, so a level's own count and
// its children's counts are separate numbers that sum to its weight.
//
// Unlike `mapGroups` this does *not* fold at MAX_DRAWN_DEPTH: the ceiling is
// the renderer's, and a field that refused to offer back a value already in the
// dataset would be the picker inventing a rule the data does not have.
function trackTree(projects) {
  const root = { name: null, path: [], count: 0, children: new Map() };
  for (const project of projects) {
    const path = trackPath(project.track);
    if (!path.length) continue;
    let at = root;
    path.forEach((name, index) => {
      if (!at.children.has(name)) {
        at.children.set(name, {
          name, path: path.slice(0, index + 1), count: 0, children: new Map(),
        });
      }
      at = at.children.get(name);
    });
    at.count += 1;
  }

  const settle = (at) => ({
    ...at,
    value: at.path.join(` ${SUBTRACK_SEPARATOR} `),
    kids: [...at.children.values()]
      .map(settle)
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
  return settle(root).kids;
}

// Walk every level of the tree, parents before their children.
function eachLevel(tree, visit, depth = 1) {
  for (const node of tree) {
    visit(node, depth);
    eachLevel(node.kids, visit, depth + 1);
  }
}

const findLevel = (tree, path) => {
  let at = { kids: tree };
  for (const name of path) {
    at = at.kids.find((kid) => kid.name.toLowerCase() === name.toLowerCase());
    if (!at) return null;
  }
  return at.kids ? at : null;
};

// "Mobile /Offline" and "Mobile/ Offline" are one track, at any depth.
// Everything the picker commits goes through here, for the same reason the tree
// is built through `trackPath`: one spelling per ring.
const canonicalTrack = (raw) =>
  trackPath(raw).join(` ${SUBTRACK_SEPARATOR} `);

function trackPicker(input) {
  const root = input.parentElement;
  const panel = element("div", "track-panel");
  const crumb = element("div", "track-crumb");
  const rowsBox = element("div", "track-rows");
  const foot = element("div", "track-foot");
  rowsBox.setAttribute("role", "listbox");
  rowsBox.setAttribute("aria-label", "Tracks");
  panel.append(crumb, rowsBox, foot);
  root.appendChild(panel);
  root.dataset.open = "false";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-autocomplete", "list");
  input.autocomplete = "off";
  input.spellcheck = false;

  let tree = [];
  let rows = [];
  let active = 0;
  // Opening a field that already holds a track shows the whole tree with that
  // track highlighted, rather than filtering the list down to the one value
  // already in the box -- otherwise you could never browse from a project that
  // has a track, which is most of them. Typing anything turns it back into a
  // filter.
  let browsing = false;

  const matches = (text, term) =>
    !term || text.toLowerCase().includes(term.toLowerCase());

  const everyValue = () => {
    const out = [];
    eachLevel(tree, (node) => out.push(node.value));
    return out;
  };

  // What the field is asking for right now: the levels already committed --
  // every complete segment -- and the partial name being typed after the last
  // slash. Splitting on the *last* separator rather than the first is what lets
  // the field be "inside" a path of any depth; the first-slash version could
  // only ever be inside a top-level track.
  function parseQuery(value) {
    const cut = value.lastIndexOf(SUBTRACK_SEPARATOR);
    if (cut === -1) return { scope: null, term: value.trim() };
    return {
      scope: trackPath(value.slice(0, cut)),
      term: value.slice(cut + 1).trim(),
    };
  }

  const rowFor = (node, depth, match) => ({
    kind: depth === 1 ? "track" : "sub", depth, label: node.name, match,
    value: node.value, count: node.count, kids: node.kids.length,
  });

  function buildRows() {
    const raw = browsing ? "" : input.value;
    const { scope, term } = parseQuery(raw);
    const out = [];

    if (scope === null || scope.length === 0) {
      crumb.hidden = true;
      // A level stays visible when only something below it matches, so the
      // parent you are aiming at never disappears from under the thing you
      // typed. Recursive now, so that holds however deep the match is.
      const deepHit = (node) =>
        matches(node.name, term) || node.kids.some(deepHit);

      const emit = (node, depth, all) => {
        const hit = matches(node.name, term);
        out.push(rowFor(node, depth, all && !hit ? "" : term));
        for (const kid of node.kids) {
          if (all || hit) emit(kid, depth + 1, true);
          else if (deepHit(kid)) emit(kid, depth + 1, false);
        }
      };
      for (const node of tree) if (deepHit(node)) emit(node, 1, false);
    } else {
      const parent = findLevel(tree, scope);
      crumb.hidden = false;
      crumb.textContent = "";
      crumb.append(element("span", null, "inside"),
        element("em", null, parent
          ? parent.value
          : scope.join(` ${SUBTRACK_SEPARATOR} `) || "…"));
      for (const kid of parent ? parent.kids : []) {
        if (!matches(kid.name, term)) continue;
        out.push(rowFor(kid, 2, term));
      }
    }

    // A create row only when the text is genuinely new. Text that matches an
    // existing value in a different case offers the existing spelling instead:
    // two spellings of one track would draw two rings.
    const typed = canonicalTrack(raw);
    if (typed) {
      const existing = everyValue()
        .find((value) => value.toLowerCase() === typed.toLowerCase());
      if (!existing) {
        out.push({
          kind: "create", label: typed, value: typed,
          tag: trackPath(typed).length > 1 ? "new subtrack" : "new track",
        });
      } else if (existing !== typed) {
        const row = out.find((candidate) => candidate.value === existing);
        if (row) row.tag = "same, different case";
      }
    }
    return out;
  }

  // The matched run is emboldened the way a browser does it, so you can see
  // which part of a name your typing caught.
  function labelFor(row) {
    const label = element("span", "track-label");
    if (row.kind === "create") {
      label.append(document.createTextNode("Use "),
        element("b", null, row.label));
      return label;
    }
    const at = row.match ? row.label.toLowerCase().indexOf(row.match.toLowerCase()) : -1;
    if (at === -1) {
      label.textContent = row.label;
      return label;
    }
    label.append(
      document.createTextNode(row.label.slice(0, at)),
      element("b", null, row.label.slice(at, at + row.match.length)),
      document.createTextNode(row.label.slice(at + row.match.length)));
    return label;
  }

  function paint() {
    rows = buildRows();
    active = Math.min(Math.max(active, 0), Math.max(rows.length - 1, 0));
    rowsBox.textContent = "";

    if (rows.length === 0) {
      rowsBox.appendChild(element("div", "track-empty", "nothing yet — keep typing"));
    }
    rows.forEach((row, index) => {
      const option = element("div", `track-opt track-${row.kind}`);
      // Indent by depth. Level 2 keeps the 25px `.track-sub` already carries,
      // so a two-level tree looks exactly as it did; deeper levels step in from
      // there rather than all sharing one indent and reading as siblings.
      if (row.depth > 2) option.style.paddingLeft = `${25 + (row.depth - 2) * 14}px`;
      option.id = `${input.id}-opt-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === active));
      option.dataset.active = String(index === active);
      option.appendChild(labelFor(row));
      if (row.tag) option.appendChild(element("span", "track-tag", row.tag));
      if (row.count !== undefined) {
        option.appendChild(element("span", "track-count", row.count));
      }
      // mousedown, not click: the default would blur the input first and close
      // the panel out from under the pointer.
      option.onmousedown = (event) => {
        event.preventDefault();
        commit(row.value);
      };
      option.onmouseenter = () => {
        active = index;
        for (const other of rowsBox.children) other.dataset.active = "false";
        option.dataset.active = "true";
        input.setAttribute("aria-activedescendant", option.id);
      };
      rowsBox.appendChild(option);
    });

    const current = rows[active];
    if (current) {
      input.setAttribute("aria-activedescendant", `${input.id}-opt-${active}`);
      $(`${input.id}-opt-${active}`).scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }

    // The hint offers the key the highlighted row can actually use: a level
    // with anything under it can be opened, anything else can only be taken.
    // No longer restricted to the top level -- the tree nests as far as the
    // slashes do, so a subtrack with children opens exactly like a track.
    foot.textContent = "";
    const openable = Boolean(current && current.kids);
    if (openable) {
      foot.append(
        element("b", null, "/"), element("span", null, "opens this track"),
        element("span", null, "·"),
        element("b", null, "Enter"), element("span", null, "takes it as-is"));
    } else {
      foot.append(
        element("b", null, "Enter"), element("span", null, "commits"),
        element("span", null, "·"),
        element("span", null, "anything you type is allowed"));
    }
  }

  const committed = () => {
    const typed = canonicalTrack(input.value);
    return typed && everyValue().some((value) => value.toLowerCase() === typed.toLowerCase())
      ? typed : "";
  };

  function show(browse) {
    browsing = browse;
    root.dataset.open = "true";
    input.setAttribute("aria-expanded", "true");
    if (browsing) {
      // Built early only to point `active` at the row the field already holds.
      rows = buildRows();
      const at = rows.findIndex((row) =>
        row.value.toLowerCase() === input.value.trim().toLowerCase());
      active = at === -1 ? 0 : at;
    }
    paint();
  }

  // Clicking or arrowing in browses; typing filters.
  const open = () => show(Boolean(committed()));

  function close() {
    root.dataset.open = "false";
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  // Committing fires `change` itself rather than waiting for blur: the field's
  // existing onchange is what saves the project, and picking a row would
  // otherwise appear to do nothing until you clicked elsewhere.
  function commit(value) {
    input.value = canonicalTrack(value);
    close();
    input.dispatchEvent(new Event("change"));
  }

  // A slash on a highlighted level means "go inside it", the way a path field
  // completes a directory -- at any depth now, not just on a top-level track.
  // Anywhere else a slash is just a slash, which is how a level nobody has
  // typed yet gets created.
  function drillInto(row) {
    if (!row || !row.kids) return false;
    input.value = `${row.value} ${SUBTRACK_SEPARATOR} `;
    active = 0;
    show(false);
    return true;
  }

  input.onclick = open;
  input.oninput = () => {
    active = 0;
    show(false);
  };
  input.onblur = close;

  input.onkeydown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (root.dataset.open !== "true") return open();
      if (rows.length === 0) return;
      active = (active + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
      paint();
      return;
    }
    if (event.key === "Enter" && root.dataset.open === "true") {
      event.preventDefault();
      commit(rows[active] ? rows[active].value : input.value);
      return;
    }
    // No longer gated on the field holding no slash: that guard was the two-
    // level ceiling, and it is the one the request was actually about.
    if (event.key === SUBTRACK_SEPARATOR) {
      if (root.dataset.open === "true" && drillInto(rows[active])) event.preventDefault();
      return;
    }
    // One key to undo a wrong turn: backspacing off a trailing slash pops out
    // one level rather than nibbling the last letter of the name before it.
    if (event.key === "Backspace" && /\s*\/\s*$/.test(input.value)) {
      event.preventDefault();
      input.value = canonicalTrack(input.value);
      active = 0;
      open();
      return;
    }
    if (event.key === "Escape" && root.dataset.open === "true") {
      event.preventDefault();
      close();
    }
  };

  // Dragging the panel's scrollbar would otherwise blur the input and close it.
  panel.onmousedown = (event) => event.preventDefault();

  return {
    refresh(projects) {
      tree = trackTree(projects);
      if (root.dataset.open === "true") paint();
    },
  };
}

function refreshTrackPickers() {
  for (const picker of trackPickers) picker.refresh(state.projects);
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
  $("tab-sprint").onclick = async () => {
    state.view = "sprint";
    await refreshView();
  };

  // `sprintFileKey` rather than `Number`: the last row of the picker is the
  // template, whose key is a string.
  $("sprint-select").onchange = (event) => switchSprintFile(sprintFileKey(event.target.value));
  // The template opens in this same editor. `switchSprintFile` is what gets used
  // rather than a path of its own, so unsaved work in the file being left is
  // flushed first and a write that will not land still refuses to move.
  $("sprint-template").onclick = () => switchSprintFile(TEMPLATE_KEY);
  $("sprint-new").onclick = createSprintFile;
  $("sprint-view-doc").onclick = () => setSprintView("doc");
  $("sprint-view-raw").onclick = () => setSprintView("raw");
  // Blur, not input: re-splitting the whole file on every keystroke would rebuild
  // the document under the cursor.
  $("sprint-raw-file").onblur = (event) => commitSprintRawFile(event.target.value);
  // Esc leaves the box first and the view second, in that order: the blur is what
  // re-splits the document, so switching away before it would drop the edit.
  $("sprint-raw-file").onkeydown = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.target.blur();
    setSprintView("doc");
  };

  // Delegated, because the rows are rebuilt on every read of `/api/projects` and
  // binding each one would mean re-binding twenty-eight handlers per edit. It
  // opens the project the ordinary way, so the sidebar clears exactly what a map
  // node and a portfolio lane title clear.
  $("project-list").onclick = async (event) => {
    const row = event.target.closest(".project-row");
    if (!row) return;
    await openProject(Number(row.dataset.id));
  };

  // The filter narrows the list and nothing else -- no fetch, nothing stored, and
  // the open project stays open even when it is filtered out of view. `input`
  // rather than `change` so it narrows as you type, and a re-render is 28 rows.
  $("project-filter").oninput = (event) => {
    state.projectFilter = event.target.value;
    renderProjectList();
  };

  $("sidebar-toggle").onclick = () => applySidebar(
    !document.querySelector(".app").classList.contains("sidebar-collapsed"));

  // The ⋯ menu: rename, the global settings, delete. `aria-expanded` is on the
  // button rather than tracked in `state`, because the panel's own `hidden` is
  // already the truth and a second copy of it could disagree.
  const projectMenu = (open) => {
    $("project-menu-panel").hidden = !open;
    $("project-menu").setAttribute("aria-expanded", String(open));
  };
  $("project-menu").onclick = (event) => {
    event.stopPropagation();
    projectMenu($("project-menu-panel").hidden);
  };
  // Anywhere outside closes it. On `document`, so it fires for a press on the
  // chart or the sidebar as well; the panel's own clicks are stopped below, or
  // typing in the name field would close the box you are typing in.
  $("project-menu-panel").onclick = (event) => event.stopPropagation();
  document.addEventListener("click", () => projectMenu(false));

  // Both reveals, and the topbar's primary action is the third caller. Focus
  // follows, because the button's whole purpose is to get you into the first
  // field -- and pressing it again folds the row back.
  const revealAdder = (rowId, fieldId) => {
    const row = $(rowId);
    row.hidden = !row.hidden;
    if (!row.hidden) $(fieldId).focus();
  };
  $("show-phase-adder").onclick = () => revealAdder("phase-adder", "new-phase-name");
  $("show-milestone-adder").onclick =
    () => revealAdder("milestone-adder", "new-milestone-name");
  // The page's primary action. It only ever opens -- a primary button that
  // sometimes closes the thing it names would be a toggle wearing the wrong
  // label -- and it scrolls the row into view, since the bar is sticky and the
  // table it belongs to may be a screen down.
  $("add-phase-open").onclick = () => {
    const row = $("phase-adder");
    row.hidden = false;
    row.scrollIntoView({ block: "center" });
    $("new-phase-name").focus();
  };

  // The drawer reads and nothing else, so Esc can close it unconditionally --
  // there is never unsaved work behind it to lose.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeFortnight();
    projectMenu(false);
    // Esc out of the raw file view too, but only from outside the textarea:
    // inside it, Esc is how you leave the box, and the blur that follows is what
    // re-splits the document. Leaving the view first would throw that away.
    if (state.sprint.view === "raw" && document.activeElement !== $("sprint-raw-file")) {
      setSprintView("doc");
    }
  });

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
    // The one whole-record write in the app: seven fields go every time any one
    // of them changes, so this is the write that can overwrite six things
    // nobody touched. It states what it believed all seven were -- taken from
    // the loaded row, not from the boxes, which is what makes it an expectation
    // rather than a copy of the request.
    const loaded = state.plan ? state.plan.project : null;
    const fields = {
      name: $("project-name").value,
      goal: $("project-goal").value,
      start_date: $("project-start").value,
      stage: $("project-stage").value,
      tier: Number($("project-tier").value),
      track: $("project-track").value,
      velocity_override: velocity === "" ? null : Number(velocity),
    };
    if (loaded) {
      fields.expect = Object.fromEntries(
        Object.keys(fields).map((key) => [key, loaded[key]]));
    }
    try {
      await api(`/api/projects/${state.currentProjectId}`, {
        method: "PUT",
        body: JSON.stringify(fields),
      });
    } catch (failure) {
      reportStaleWrite(failure);
    }
    await loadProjects();
  };
  for (const id of ["project-name", "project-goal", "project-start",
                    "project-stage", "project-tier", "project-track",
                    "project-velocity"]) {
    $(id).onchange = saveProject;
  }

  // Built once and refilled by `refreshTrackPickers` whenever the project list
  // is re-read, so a track invented in one field shows up in the other.
  trackPickers.push(trackPicker($("project-track")),
    trackPicker($("new-direction-track")));

  $("department-name").onchange = async () => {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ department_name: $("department-name").value }),
    });
    await loadGraph();
  };

  // The direction only means something once there is something to point at.
  $("new-direction-dep").onchange = (event) => {
    $("new-direction-direction").disabled = !event.target.value;
  };

  $("add-direction").onclick = async () => {
    const name = $("new-direction-name").value.trim();
    if (!name) return;
    const error = $("direction-error");
    error.hidden = true;
    const other = Number($("new-direction-dep").value);
    // No start date and no phases: a direction is a note to yourself until the
    // day it gets promoted.
    const idea = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name,
        start_date: "",
        stage: "idea",
        track: $("new-direction-track").value.trim(),
      }),
    });

    if (other) {
      try {
        await linkProjects(idea.id, other, $("new-direction-direction").value);
      } catch (failure) {
        // Two calls, so half of this can fail. A brand new project has no other
        // links and so cannot make a cycle, but say what actually happened
        // rather than letting the idea appear as though nothing went wrong.
        error.textContent = `Captured "${name}", but the link failed: ${failure.message}`;
        error.hidden = false;
      }
    }

    $("new-direction-name").value = "";
    $("new-direction-track").value = "";
    $("new-direction-dep").value = "";
    $("new-direction-direction").disabled = true;
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

  $("promote-project").onclick = promoteProject;
  $("add-milestone").onclick = addMilestone;
  $("new-milestone-name").onkeydown = (event) => {
    if (event.key === "Enter") addMilestone();
  };

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

// --- live invalidation ------------------------------------------------------

// One socket per open page, and the server talks down it when somebody else's
// write lands. Nothing is diffed and nothing is patched: the message says the
// roadmap moved, and the tab makes the same read it already makes after its own
// edits. What arrives is a **hint** -- the server is the record, so a page that
// misses one is repaired by the reload its reconnect does.
//
// Nothing here carries identity. Who is where is presence, and presence waits on
// a name that cannot be typed -- see PLAN-multi-user.md B1.

const LIVE_BACKOFF_MS = 1000;
const LIVE_BACKOFF_CAP_MS = 30000;

function connectLive() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  let socket;
  try {
    socket = new WebSocket(`${scheme}://${location.host}/ws`);
  } catch (_) {
    scheduleLiveReconnect();
    return;
  }
  state.live.socket = socket;

  socket.onopen = () => {
    state.live.attempt = 0;
    markLiveDown(false);
    // Messages were missed while it was down, and there is no replay: the only
    // sound answer is to read everything again. Not on the first connect --
    // the page has just loaded, so it is already current.
    if (state.live.opened) liveRefresh();
    state.live.opened = true;
    // Nobody is holding a place for this page while it was away, so the first
    // thing it says on coming back is where it is.
    state.presence.said = null;
    announceHere(true);
  };

  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (_) {
      return;  // a message this page cannot read is not a reason to stop listening
    }
    handleLiveMessage(message);
  };

  // `onerror` fires before `onclose` on a failed connect, so the reconnect is
  // scheduled from `onclose` alone -- both would double the attempts.
  socket.onclose = () => {
    state.live.socket = null;
    markLiveDown(true);
    // Their badges are as stale as this page is. Clearing them is the honest
    // read: while the socket is down, nothing here knows where anybody is.
    state.presence.users = [];
    drawPresence();
    scheduleLiveReconnect();
  };
}

function scheduleLiveReconnect() {
  const attempt = state.live.attempt;
  state.live.attempt += 1;
  // Exponential with a cap and a little jitter: a closed laptop lid must come
  // back on its own, and a server restart must not have every open page knocking
  // in step.
  const wait = Math.min(LIVE_BACKOFF_CAP_MS, LIVE_BACKOFF_MS * 2 ** attempt);
  setTimeout(connectLive, wait + Math.random() * 250);
}

function handleLiveMessage(message) {
  if (message.type === "welcome") {
    // Which connection this page is. Two tabs of one browser are two of them, so
    // this is what stops a badge drawing you as a stranger in your other window.
    state.presence.me = message.id;
    state.presence.name = message.name;
    announceHere(true);
    return;
  }
  if (message.type === "presence") {
    state.presence.users = message.users || [];
    drawPresence();
    return;
  }
  if (message.type !== "changed") return;
  if (message.scope === "sprint") {
    // Your own save comes back to you, and the mtime is how this page knows: it
    // is already holding the value the file now has. Ignoring it is what stops a
    // save reloading over the typing that followed it.
    if (message.mtime && message.mtime === state.sprint.mtime) return;
    // A write that named one run of blocks can be repeated here rather than
    // re-read, provided this page holds the text it replaced and owes nothing
    // inside it. That is the whole point of the block API: an edit of theirs
    // elsewhere in the file is not a conflict with an edit of yours.
    if (message.splice && applyRemoteSprintSplice(message)) return;
    // Unsaved work in the open file is answered on the spot, by the save bar,
    // and nothing is re-read -- see `liveSprintChanged`.
    if (liveSprintChanged(message.key)) return;
    if (state.view !== "sprint") return;
    // A clean open file is re-read like any other view, through the guard: the
    // caret may be sitting in a block nobody has typed into yet.
    if (sprintFileKey(message.key) === state.sprint.number) {
      state.live.sprintReload = state.sprint.number;
    }
    liveRefresh();
    return;
  }
  // A write is a new edition of the roadmap whoever made it, so the caches keyed
  // by the counter re-ask exactly as they do after an edit of your own.
  state.roadmapRevision += 1;
  liveRefresh();
}

// --- presence ---------------------------------------------------------------

// Who else is here, and which cell their caret is in. The badge **informs and
// never refuses** -- nothing is reserved, no write is blocked, and a stale badge
// costs a moment's confusion where a stuck lock would cost somebody the ability
// to type. See PLAN-multi-user.md B6.
//
// The name is Keycloak's; with the gate off it is `guest-N`. Nothing about a
// person is stored at either end: the server holds it beside an open socket and
// forgets it when the tab closes.

// Six hues, so two people in one table are told apart at a glance. Chrome, not
// data -- a hue means "somebody", never anything about the plan, which is why
// this sits above the chart rules in `style.css`.
const PRESENCE_HUES = 6;

function presenceKey(kind, id, field) {
  return `${kind}:${id}:${field}`;
}

// The file a block belongs to, so a block index from one fortnight cannot mark a
// row in another. `editor.js` stamps it on every row it draws.
function sprintPresenceScope() {
  return `sprint:${state.sprint.number}`;
}

function presenceHue(name) {
  let total = 0;
  for (const character of name) total = (total + character.charCodeAt(0)) % 997;
  return total % PRESENCE_HUES;
}

function presenceInitials(name) {
  const parts = name.split(/[.\-_\s]+/).filter(Boolean);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// Where this page is looking. `field` is the cell the caret is in, stamped on
// the input by `fieldCell` and on a sprint row by `sprintRow`.
function currentPlace() {
  const active = document.activeElement;
  // Walked up rather than read off the focused node: a sprint block's caret is
  // inside a contenteditable child of the row that carries the name, and a table
  // cell's is inside the cell. The nearest named ancestor is the answer in both.
  const holder = active && typeof active.closest === "function"
    ? active.closest("[data-presence]")
    : null;
  const field = holder ? holder.dataset.presence : "";
  const key = state.view === "sprint" ? state.sprint.number : state.currentProjectId;
  return { view: state.view, key: key === undefined ? null : key, field };
}

function announceHere(force = false) {
  const socket = state.live.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const place = currentPlace();
  const said = state.presence.said;
  if (!force && said && said.view === place.view && said.key === place.key
      && said.field === place.field) {
    return;
  }
  state.presence.said = place;
  try {
    socket.send(JSON.stringify({ type: "here", ...place }));
  } catch (_) {
    // Presence is a hint. A socket that will not take it is not a reason to
    // interrupt anything the page is doing.
  }
}

// The whole of the wiring: one pair of delegated listeners, so a cell drawn by
// any render gets this for free and no render site has to remember it.
function watchPresence() {
  document.addEventListener("focusin", () => announceHere());
  document.addEventListener("focusout", () => {
    // After the browser has moved focus on, so tabbing from one cell to the next
    // announces the new cell rather than a moment of nothing.
    setTimeout(() => announceHere(), 0);
  });
}

function drawPresence() {
  for (const held of document.querySelectorAll(".presence-held")) {
    held.classList.remove("presence-held");
    held.removeAttribute("title");
  }
  for (const badge of document.querySelectorAll(".presence-badge")) badge.remove();

  const others = state.presence.users.filter((user) => user.id !== state.presence.me);
  for (const user of others) {
    if (!user.field) continue;
    const input = document.querySelector(`[data-presence="${CSS.escape(user.field)}"]`);
    if (!input) continue;
    const holder = input.closest("td, .sprint-row") || input.parentElement;
    if (!holder) continue;
    holder.classList.add("presence-held");
    holder.title = `${user.name} is editing this. You can still type — nothing is locked.`;
    const badge = element("span", `presence-badge presence-hue-${presenceHue(user.name)}`,
      presenceInitials(user.name));
    badge.title = holder.title;
    holder.appendChild(badge);
  }

  drawPresenceStrip(others);
  drawSprintPresence(others);
}

function drawPresenceStrip(others) {
  const strip = $("presence-strip");
  if (!strip) return;
  strip.textContent = "";
  strip.hidden = others.length === 0;
  for (const user of others) {
    const badge = element("span", `presence-badge presence-hue-${presenceHue(user.name)}`,
      presenceInitials(user.name));
    badge.title = `${user.name} — ${describePlace(user)}`;
    strip.appendChild(badge);
  }
}

function describePlace(user) {
  if (!user.view) return "just arrived";
  if (user.view === "sprint") {
    return user.key === null ? "the Sprint tab" : `sprint file ${user.key}`;
  }
  return `the ${user.view} view`;
}

// The Sprint tab's own line, which is the high-value one: it is the highest
// collision surface in the app, and seeing that somebody is in this fortnight
// before you open it is social locking -- cheaper and more honest than a lock.
function drawSprintPresence(others) {
  const line = $("sprint-presence");
  if (!line) return;
  const here = others.filter((user) => user.view === "sprint"
    && String(user.key) === String(state.sprint.number));
  line.textContent = "";
  line.hidden = here.length === 0;
  for (const user of here) {
    const badge = element("span", `presence-badge presence-hue-${presenceHue(user.name)}`,
      presenceInitials(user.name));
    badge.title = `${user.name} has this file open`;
    line.appendChild(badge);
  }
}

// A refresh must never eat what is being typed. `loadPlan()` rebuilds the phase
// table, and Chrome fires `blur` on a focused element that gets removed -- which
// is the handler that *saves the field*. So an unguarded live refresh does not
// merely interrupt: it can save a half-typed value or throw it away. Hold it
// while something in the open view has focus, and run it on blur.
const LIVE_EDITABLE = "input, textarea, select, [contenteditable='true']";

function editableWithFocus() {
  const active = document.activeElement;
  if (!active || typeof active.closest !== "function") return null;
  if (!active.matches(LIVE_EDITABLE)) return null;
  return active.closest("#workspace, #portfolio-view, #map-view, #sprint-view");
}

function liveRefresh() {
  if (editableWithFocus()) {
    state.live.pending = true;
    watchForBlur();
    return;
  }
  // One read at a time. A burst of edits from two other people is one reload,
  // and the last one wins rather than three overlapping loads racing to render.
  if (state.live.loading) {
    state.live.pending = true;
    return;
  }
  state.live.pending = false;
  state.live.loading = true;
  reloadCurrentView().finally(() => {
    state.live.loading = false;
    if (state.live.pending) liveRefresh();
  });
}

function watchForBlur() {
  const active = document.activeElement;
  if (state.live.watching === active) return;
  state.live.watching = active;
  active.addEventListener("blur", () => {
    state.live.watching = null;
    if (state.live.pending) liveRefresh();
  }, { once: true });
}

async function reloadCurrentView() {
  try {
    if (state.view === "portfolio") {
      await loadPortfolio();
    } else if (state.view === "map") {
      await loadGraph();
    } else if (state.view === "sprint") {
      const wanted = state.live.sprintReload;
      state.live.sprintReload = null;
      // The listing always refreshes -- naming the files on disk touches nothing
      // anyone is typing. The open document only if it is still the same file and
      // still has nothing unsaved: both can have changed while the refresh was
      // held under a cursor.
      await loadSprints();
      if (wanted !== null && wanted === state.sprint.number && !sprintHasUnsavedWork()) {
        await loadSprintFile(wanted);
        renderSprintView();
      }
    } else if (state.projects.length) {
      const before = planRowSignatures();
      await loadPlan();
      flashChangedRows(before);
    } else {
      await loadProjects();  // the first project somebody else created
    }
    renderTopbar();
  } catch (_) {
    // A failed read is not worth a toast: it was not asked for, and the next
    // message -- or the reconnect -- comes back to it.
  }
}

// A value that changes with no explanation reads as a bug, so a row that moved
// under you washes indigo -- the same 1.6s flash a jump arriving already draws.
// It is a **diff of what this page was holding**, which is also why your own
// write never flashes at you: by the time your edit echoes back off the socket,
// the read you made after it is already the value on screen.
function planRowSignatures() {
  const found = new Map();
  if (!state.plan) return found;
  for (const phase of state.plan.phases) {
    // The phase's own signature carries its deliverables, so a tick flashes the
    // phase row as well as the deliverable's. That is right rather than sloppy:
    // the phase row prints the tally, and the tally is what just moved.
    found.set(`phase:${phase.id}`, JSON.stringify(phase));
    for (const deliverable of phase.deliverables || []) {
      found.set(`deliverable:${deliverable.id}`, JSON.stringify(deliverable));
    }
  }
  return found;
}

function flashChangedRows(before) {
  if (!before.size) return;  // nothing to compare against: the first load
  for (const [key, signature] of planRowSignatures()) {
    // Only what changed, never what arrived: a new row is already conspicuous,
    // and flashing every row of a project that was empty is noise.
    if (!before.has(key) || before.get(key) === signature) continue;
    const [kind, id] = key.split(":");
    const row = document.querySelector(`tr[data-${kind}="${id}"]`);
    if (row) flashArrival(row);
  }
}

// Drawn only when it is broken. Silence when it is working is the whole point of
// it working; silence when it is not is exactly when you want to be told.
function markLiveDown(down) {
  state.live.down = down;
  const badge = $("live-down");
  if (badge) badge.hidden = !down;
}

// Column width is measured from the container, so a resized window has to
// redraw to stay fitted. Debounced because dragging a window edge fires this
// continuously and every render rebuilds a whole chart.
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(redraw, 150);
});

// Who the gate says you are. The label is the only thing the shell knows about
// sign-in: the configuration lives in its own document, and a signed-out visitor
// never reaches this file at all -- the server redirects the page request.
async function loadSignInLabel() {
  const link = $("signin-link");
  if (!link) return;
  try {
    const status = await (await fetch("/auth/status")).json();
    state.signedInAs = status.name || "";
    if (status.armed && status.name) {
      link.textContent = status.name;
      link.title = "Signed in through Keycloak. Opens the Sign-in settings.";
    }
  } catch {
    // The label is decoration; a failed read must not stop the app booting.
  }
}

bindEvents();
watchPresence();
// Before the first load, so the sidebar is already the width it was left at when
// the charts measure their container -- `weekGrid` fits its columns to that
// width, so applying it after would fit them to the wrong one and need a redraw.
applySidebar(sidebarCollapsed());
restoreSession();
loadSignInLabel();
loadProjects();
// After the first read, not before: the socket's job is to say what changed
// *since*, and its own first open deliberately reloads nothing.
connectLive();
