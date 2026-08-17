# Feature requests

Gaps found by walking the tool end to end as a product owner would: capture an
idea, cost it, put it on a calendar, run a fortnight against it, come back and
update it. Opened 2026-08-06.

**FR-9 to FR-14 were the requester's own, from `comments.md` on 2026-08-13** —
six items written after using the tool rather than after reading it, which is
why every one of them is about a gesture rather than a rule. FR-16 to FR-18
arrived the same way on 2026-08-14. Each names the comment it came from.

**`comments.md` holds nothing unregistered as of 2026-08-15.** Its three current
items are those same FR-16, FR-17 and FR-18 — status is not automatic, the map
only nests twice, a table cell cannot hold a line or a checkbox — and all three
are closed: two built, one superseded by milestones with its residue reopened as
FR-21. Nothing below is waiting on the requester to write it down.

This file is the **backlog of things the tool does not do yet**, with the reason
each one matters and the reason it might not be worth building. It is not a
plan. `comments.md` is requester feedback, `STATUS.md` is the decision log,
`PLAN-*.md` are the working plans behind one feature each.

**A built item is deleted from this file, not marked built.** The commits and
`STATUS.md` are the record of what shipped and why; a backlog that also carries
it stops being a list of what is left and becomes a second, staler history. The
numbers are never reused, so a gap in the sequence means built — look for it in
`git log` and `STATUS.md`. **Won't-build items stay**, because nothing was
committed for them: the argument against building is the whole artefact, and
deleting it invites the idea back in six months. Built so far and gone from
here: FR-8, FR-9, FR-10, FR-12, FR-13, FR-14, FR-15, FR-16, FR-17, FR-18.

**FR-2 is the one entry that was built and then un-built**, so it sits below as a
won't-build rather than being deleted. The rule holds either way: the file keeps
the argument, because nothing else records a decision *against* something.

**FR-16 is gone but was not built as written.** It asked what to do about
`phase.status`, which nothing maintains; the answer turned out to be that the
question was aimed one level too low. Milestones — a checkpoint entity the
project ladder reads — made all four of its options unnecessary, and shipped in
tree E. What FR-16 actually noticed is still true and is reopened as **FR-21**.

**FR-19 was claimed twice, by two trees that were open at once.** Tree B's
finding — V1 firing on every phase — landed on `main` first and keeps the
number. Tree E's leftover is **FR-21** here, and the number is the one thing
about it that moved: tree E's commit messages and `STATUS.md` item 71 still call
it FR-19, because they were written before the collision existed. Nothing else
in the sequence is affected, and no number has been reused.

Every item below is written against the invariants in `CLAUDE.md`. Where a
request has an obvious bad version that would break one, the bad version is
named — that is the part worth keeping.

---

## Priority

Priority is one letter on the end of every heading below, worked out from three
things and nothing else:

- **Complexity** — what it costs to build, including the risk it carries.
- **Frequency** — how often the thing it fixes is actually touched.
- **Impact** — how much worse the tool is without it.

**P1** next up · **P2** soon after · **P3** blocked on evidence or a decision,
not on effort · **Won't build**.

Frequency does most of the ranking. A one-line tooltip on a control you hover
forty times a week outranks a rule you would read once a sprint — that is what
put FR-13 above FR-12, and both are built and gone from this table.

| # | Request | Complexity | Frequency | Impact | Priority |
|---|---|---|---|---|---|
| FR-1 | Say that sprint task points and phase `effort_points` are one currency | Prose only | — | High | **P1** |
| FR-19 | V1 fires on all 30 phases, so it says nothing | Setting or prose | High | High | **P2** — one decision, no code |
| FR-11 | Project picker belongs to the Project tab | Medium | High | Medium | **P2** |
| FR-3 | Overlap check across projects (**not** a points sum) | Small–medium | Low | Medium | **P3** — sprint 4 |
| FR-2 | Portfolio-wide warnings, not just V2 | Small | High | — | **Won't build** — built, then removed |
| FR-4 | Capacity roster — people and their available days | Medium (new table) | Fortnightly | Medium | **P3** — paper until sprint 4 |
| FR-5 | Velocity learns from delivered history | Medium | Rare | Medium | **P3** — needs 3 baselines |
| FR-6 | Slippage memory — has this date moved before? | Large | Low | High | **P3** — deferred deliberately |
| FR-20 | Milestone diamonds on the portfolio | Small | Medium | Medium | **P2** |
| FR-21 | `phase.status` is still maintained by nobody | Small | High | Medium | **P2** |
| FR-7 | Owners at roadmap level | Small | — | Negative | **Won't build** |

FR-20 and FR-21 both came out of the milestone work in tree E: one is a half
deliberately left out of the build, the other is the half of FR-16 that
milestones did not answer. Neither is blocked on anything. FR-19 is unrelated
and came out of tree B — see the note at the top about the number being claimed
twice.

---

## Dependencies, and what can run in parallel

Written so several of these can be developed at once in separate worktrees.
**No item below needs a schema change** — no table, no column, no `migrate()`
step, no export bump — so the usual `--reload` migration hazard does not apply
to any of this work. FR-4's option B is the one exception, and it is deferred.

### What actually blocks what

Only one real dependency is left among the near-term items. Everything else is
independent.

```
FR-11 ──> tab reorder same change, same files, one commit
FR-20 ──> a decision  per-swimlane or one shared lane, not code
```

- **FR-21 depends on nothing but its own decision** — what `phase.status` is
  for, now that the ladder no longer reads it. The code either way is small.
- **FR-20 wants the portfolio renderer to itself, and now has it.** It is the
  third feature to edit that block, after FR-13 and the reverted FR-2, and it is
  the one file worth keeping to a single worktree at a time — the branch that had
  it is merged, so nothing else is in there and it can start whenever.
- **FR-11 depends on nothing either, but it moves DOM other branches render
  into** — see the merge order below.
- **Everything built is on `main` and nothing left here touches it.** FR-12,
  FR-13, FR-17 and FR-18 rewrote the map block of `app.js`, the grid in
  `editor.js`, `_escape_cell` in `markdown.py` and their `style.css` regions;
  none of the three items above goes near any of them. The one inheritance worth
  naming is milestones: **FR-20 gets `milestoneLane` for free**, and **FR-21 gets
  a `phase.status` that now feeds V6 and V7 and nothing else** — narrower than
  the field FR-16 complained about, and the reason its complaint survived.
- **FR-2 was built and reverted the same day**, so its footprint is back to
  nothing: `validate_plan` ends exactly as it did before, and `read_portfolio`'s
  `warnings` is V2-only. Worth knowing only because the revert is in the history
  and a `git log` reading will find code that is no longer there.

### Where each one lands

| FR | Python | `app.js` | `index.html` | `style.css` | Tests |
|---|---|---|---|---|---|
| FR-11 | — | `loadProjectList` 422–473, 2975, 3577 | **header, 10–26** | header | `wire_check.js` |
| FR-20 | `main.read_portfolio` | `renderPortfolio` 1441–1725; reuses `milestoneLane` 904 | — | reuses `.milestone-lane` | `test_api.py` |
| FR-21 | — | `renderPhases` 1138; the status cell 1174–1183 | phase table head, 167–172 | phase status | `test_api.py` |

The line numbers above were re-read against `main` at `2e446f4`, with everything
built merged in — `app.js` is 3,823 lines and `editor.js` 2,036. They are a
starting point, not a contract: **re-grep rather than trusting the column**. The
milestone section pushed everything below it in `#project-view` down, and the
next item to land will do the same to these.

One property worth noticing: **`style.css` gets touched by most of these, in
disjoint regions.** Git merges that fine as long as nobody reflows the file. Do
not reorder or reformat blocks you are not changing. The `[hidden]` trap — a
class setting `display` outranks the UA sheet — has now cost five separate
features; check it before adding any new hideable element.

### Suggested worktrees

| Tree | Items, in order | Why they belong together |
|---|---|---|
| **D · shell** | FR-11 + tab reorder | Both edit the header, both are small, and the reorder is what makes the picker's placement obviously wrong. Goes last and alone — see below. |
| **FR-20** | portfolio milestone lane | Wants `renderPortfolio` to itself. One decision (per-swimlane or shared) then a payload field. |
| **FR-21** | phase close | Its own decision first — what `phase.status` is for. Touches the phase row and nothing else. |

**The four trees that ran are deleted from this table, not struck through**, the
same rule the entries themselves follow: B (portfolio), E (status), F (map) and
G (editor) are merged, and `git log` plus `STATUS.md` are the record. What
carries forward is the one live claim they support — **the split works.** Four
trees open at once, and the only conflicts were prose in this file and in
`CLAUDE.md`. **Nothing is live now**, so the traps below apply from whenever the
next one is opened.

Two things they left behind that the next tree uses, and one that is still open:

- **`scripts/wire_check.js`** runs `bindEvents()` behind a stub DOM and names
  every id the JS asks for that `index.html` does not define. FR-11 is the item
  that needs it — moving an element out of the header is exactly the frontend
  migration nothing else fails loudly on.
- **`scripts/map_sweep.js`** is the map's only verification, and it wants the
  real dataset: what the map looks like at this shape — 8 tracks, one already
  three deep — *is* the check, so a fresh worktree's empty `data/` makes map
  work unverifiable rather than merely dull.
- **Still outstanding: an eyeball on the drag pill and the lane tooltip.** Both
  were verified headlessly out of the real `app.js` behind a stubbed DOM because
  the browser extension would not connect; neither has a suite to belong to. See
  `STATUS.md`.

**D goes last, alone.** Not because it conflicts textually — the header is its
own region — but because it moves the project picker out of the global header
into the Project view and reorders the tabs. Every other branch renders into a
page whose shape it changes, and `#empty-state`, `loadProjectList` and the badge
refresh in `loadPlan` all get touched. Rebasing several branches onto a moved
header is worse than rebasing one moved header onto merged branches.

### Running several worktrees at once — two practical traps

- **`data/` and `sprints/` are gitignored, so a fresh worktree has neither.**
  A new tree comes up with an empty database and no sprint files, which makes
  the map, the portfolio and the Sprint tab all look broken when they are not.
  Copy `data/roadmap.db` and `sprints/` into each tree. Copy — do not point two
  servers at the one file.
- **One port per tree.** `--port 8000`, `8001`, `8002`. Two `--reload` servers on
  one port fail in a way that looks like a code error.

---

## FR-1 · One point currency, stated out loud — **P1**

**What:** Write down, in `templates/sprint.md` and `CLAUDE.md`, that a point on
a sprint task line and a point in `phase.effort_points` are the same unit.

**Why it matters.** Nothing currently says this, and three separate mechanisms
quietly assume it:

- `settings.default_velocity_points_per_sprint` (20) drives every V1 check
  (`app/validation.py:225`).
- The sprint template's baseline row reads *"last 3 sprints — **roadmap** points
  delivered"* (`templates/sprint.md:42`) and divides by person-days.
- The sprint file puts points on task lines under a deliverable heading
  (`templates/sprint.md:65-69`), invented fresh at planning time.

V5 was deleted, so there is no rollup from deliverables to phases and nothing
reconciles the two. If the currencies drift, the baseline is meaningless, V1 is
meaningless, and neither will announce itself — they will just both be quietly
wrong in the same direction.

**The bad version:** re-introducing V5, or putting an estimate field on
deliverables. Rule 4 forbids it and the deletion was right. The fix here is a
stated invariant, not a check.

**Verdict: do it now.** It is the cheapest item on this list and it is the
precondition for FR-3, FR-4 and FR-5 all meaning anything.

---

## FR-2 · Portfolio-wide warnings — **Won't build**

*Built on 2026-08-15 in tree B, then removed the same day at the requester's
instruction: **"warning just keep within the project is good enough"**, and
**"remove it, i dont want it to show on portfolio page"**. Reverted in full —
`main.plan_warnings`, the `project_id` stamp on `validate_plan`, the panel, its
CSS and its three tests. `GET /api/portfolio`'s `warnings` is V2-only again.*

**This entry stays because deleting it would lose the only record of the
decision.** The code is gone from `main`; a backlog entry saying "built" would be
wrong and no entry at all invites someone to build it again in six months. The
original argument for it is preserved below, because it was not a bad argument —
it was overruled, which is a different thing.

**What it was.** V1/V4/V6/V7 across every project on the Portfolio tab, grouped
by project above the chart. `validate_plan` answers for one project and
`validate_portfolio` runs only V2, so *"what is late across everything"* — framed
here as the first question of the week — could only be assembled by opening each
project in turn.

**The argument for, which still stands on its own terms.** V6 is the rule that
finds late work: it catches a phase a month past its end inside a project with
months still to run, which the `overdue` rung cannot see. On the real dataset it
found exactly two, and both were real.

**The argument against, which won.** The Portfolio tab answers *when things
happen*; a rule about whether one project's estimate hangs together is read while
you are looking at that project, with the phase table in front of you and
somewhere to act on it. A panel listing every project's problems above a chart
about scheduling is a second front door to the project view, and the requester
did not want one. Frequency argues for it and locality argues against — locality
won, and it is the user's tool.

**What building it turned up, and the reason it was not wasted.** V1 fires on
**all 30 phases** of the real dataset, which is now FR-19 and is the more
valuable finding of the two. It is only visible when you ask every rule at once,
which is a thing this feature did and nothing else does.

**Interaction with FR-21:** the two are the same complaint from opposite ends.
FR-21 makes closing a phase cheap enough that people do it; this makes the whole
portfolio say where things stand at once. Neither needs the other, and doing
FR-21 first would make this list read against a status people actually maintain
— which matters more since the milestone work, because `phase.status` now feeds
V6 and V7 and nothing else.

**If it ever comes back**, three things are already known: V2 must be filtered
out of any such list (the dependency list below the chart marks the link it is
about, and the count pill there keys off the same array, so an unrelated V6 turns
it amber); the rules must carry `project_id`, which they do not — `validate_plan`
is the one place that knows it; and FR-19 has to be settled first, or the panel is
thirty V1s with the real findings buried in them.

---

## FR-3 · An overlap check across projects — **P3**

**What:** A rule that reports how much work is running concurrently — *"in the
week of 14 Sep, six phases across five projects are all open."*

**Why it matters.** Portfolio is the step where work is committed to a calendar,
and it is the only step with no reality check in it. You can drop six projects
into the same six weeks and nothing says anything. Sprint planning has a capacity
conversation; roadmap planning has none.

**This corrects an earlier suggestion of mine.** I first framed this as *"sum
`effort_points` per fortnight across projects and compare to velocity."* That is
wrong, and the fortnight view's invariant 2 already says why — it is now in
`CLAUDE.md` as *"the fortnight drawer never sums points across its window"*: a 55-point
six-week phase does not deliver 18 points in a fortnight, so summing points
across a time window is a points-per-day constant in disguise — the exact
constant the whole capacity design exists to avoid.

**The version that survives the invariant counts phases, not points.** Overlap
is a fact derived from dates already stored; no rate is invented. Whether six at
once is too many is the user's judgement, which is the house style — report,
never repair, never invent a number.

Fits the existing architecture exactly: a pure function beside V2 in
`validate_portfolio`, reported as a warning, repairing nothing.

**Open:** what unit the warning fires on — a threshold in `settings`, or no
threshold at all and just a rendered concurrency count on the Portfolio ruler.
Leaning toward the count with no threshold, because a threshold is a number
nobody has evidence for yet. Decide with FR-4.

**Verdict: sprint 4.** It wants the roster (FR-4) to be worth a threshold.

---

## FR-4 · Capacity config — the roster of people and their available time — **P3**

**What:** A place in the app to record who is on the team and how much time each
of them has, instead of retyping it into every sprint file.

**Shape:** a `person` table — handle, `days_per_sprint`, active flag — plus a
config surface beside Settings. Not part of any sprint table; this is reference
data about the team, not about a sprint.

**What it feeds:**

1. **The declared table** (`templates/sprint.md:28-32`) — the Person and Days
   available columns are the same rows every fortnight and are currently typed
   fresh each time.
2. **`Person-days normal`** (`templates/sprint.md:44`) — presently a hand-typed
   `20`. With a roster it is derived: the sum of active people's days. Today it
   is a constant that nobody revisits when the team changes size, sitting in the
   denominator of the baseline.
3. **`this sprint`** — the same sum minus leave, once leave is recorded.

**Why it matters beyond convenience.** `default_velocity_points_per_sprint` is a
team-level constant driving V1 across the entire roadmap. When the team changes
size, that constant is wrong and nothing anywhere prompts you to look at it. A
roster makes a team-size change a visible event rather than an invisible one.

### The lines this must not cross

These are the reason to write the request down rather than just build it. Each
has an obvious, tempting, wrong version.

| Do not add | Why |
|---|---|
| `points_per_day`, or points anywhere on a person | The whole capacity design rests on declared points being a **judgement** with coding-days as *evidence, not a multiplier* (`templates/sprint.md:34-36`). A per-person rate is the focus factor coming back in through the roster. |
| `phase.owner_id`, `deliverable.assignee`, any link from a person to work | The moment a person links to a work item this is a tracker, and tracking is a stated non-goal. The roster exists for arithmetic only — see FR-7. |
| Logins, roles, permissions | Non-goal, and pointless: single user, localhost, no auth anywhere in the app. A person is a name string in a table. |
| Deriving velocity from the roster | Velocity comes from **delivered history**, never from headcount. The roster explains why a baseline moved; it does not compute one. See FR-5. |

### Scope trap: holidays and leave

The worked example names them inline — *"Merdeka Mon 31/8; @a on leave 2d"*
(`templates/sprint.md:137`). That is the right amount of structure for now. A
holiday calendar is region-specific, annual, needs maintaining, and interacts
with `sprint_length_days`; it is a table that grows forever to save a sentence.
**Recommend leaving leave and holidays as prose in the sprint file** and letting
the roster carry only steady-state availability.

### Where it lives — options

| Option | Pro | Con |
|---|---|---|
| **A.** Extend the `settings` singleton | No new table | `settings` is one row; people are a list. Does not fit. |
| **B.** New `person` table + config section | Proper home; exports with everything else | Schema change, `migrate()` step, export bump to v10 |
| **C.** Stay on paper, roster block at the top of the sprint template | Free; keeps the paper-first staging decision intact | Retyped each fortnight; `person-days normal` stays hand-typed |
| **D.** A JSON file beside the db | No migration, no export bump | Second storage mechanism; `/api/export` would not carry it |

**Recommendation: C now, B at sprint 4.**

The honest reason is the one this project already committed to: the schema would
be designed against guesses about which columns get filled in. It is not yet
known whether the right field is `days_per_sprint`, an FTE fraction, or days per
week — and for a team of two to four, retyping the roster is under a minute a
fortnight. Running it on paper answers the column question for free, which is
exactly the argument `CLAUDE.md` makes for deferring sprints themselves. Building
a table and an export bump now, to feed a markdown file you fill in by hand,
would abandon that reasoning for the one case where it is most obviously right.

**Worth doing immediately and for free:** add a roster block to the top of
`templates/sprint.md` so `Person-days normal` is arithmetic you can see rather
than a constant you inherited. When B is built, it fills that block in.

Note B is a **table addition**, which is the safe half of `migrate()` — the
guarded `ADDED_COLUMNS` path, nowhere near `migrate_stage_check`. Still back the
data file up under a fresh name first, and not over `data/roadmap.db.bak`.

---

## FR-5 · Velocity learns from delivered history — **P3**

**What:** Let the sprint baseline inform `default_velocity_points_per_sprint`
instead of the two numbers living separate lives.

**Why it matters.** The setting is 20. In the template's own worked example the
baseline is 11 and the sprint closes at 5 (`templates/sprint.md:136-171`). From
sprint 4 you will have hard evidence that the number driving every V1 check on
the roadmap is optimistic, and `scripts/sprint_review.py` will have computed it
— while the roadmap goes on never learning it.

**The bad version:** writing it back automatically. That crosses the line the
sprint template draws in its own header — *"Nothing here writes back to the
roadmap"* — and it feeds a number back before you trust the number.

**The version worth building:** show the two side by side wherever velocity is
edited, and let the user change it deliberately. The tool points out the
disagreement; the user resolves it. Same shape as V1 itself, which cross-checks
weeks against points and repairs neither.

**Verdict: after three real baselines exist.** Depends on FR-1.

---

## FR-6 · Slippage memory — **P3**

**What:** Record that a date moved, so "has this slipped before?" is answerable.

**Why it matters.** The tool can tell you a phase is late (V6). It cannot tell
you it is late *for the third time*, because dates are overwritten in place and
nothing remembers. Whether a plan is drifting — and how fast — is the question a
roadmap is supposed to answer and this one currently cannot.

**Cost:** large, and it is a genuine architecture change: a change-log table, a
write path on every date edit, an export bump, and a view. It also brushes up
against "no activity feeds" in the non-goals, though a date-change log is
narrower than a feed.

**Verdict: deferred, and named here so it is deferred deliberately.** This is
the item that would move the tool from *recording a plan* to *telling you
something you did not already know*. It used to say "revisit once FR-2 makes late
work visible at all" — **FR-2 is won't-build, so that precondition is gone and
this one is deferred on its own merits.** V6 is still visible per project, which
is where the requester wants warnings to live; whether "has this slipped before?"
is worth a change-log table is a question you answer by missing the answer often
enough to notice.

---

## FR-7 · Owners at roadmap level — **Won't build**

**What:** A name on a phase or project, so Portfolio knows that two projects
scheduled in the same weeks are really one person.

**Verdict: recommend not building.** Listed because it is the obvious next
thought after FR-4 and should be argued with rather than drifted into. It stays
in this file for exactly that reason: no commit records a decision not to build,
so this entry is the only record there is.

Velocity is a team-level number by design, and the sprint file is where `@owner`
already lives (`templates/sprint.md:69`) — at the task level, for one fortnight,
where an owner is a real commitment rather than a guess months out. An owner on
a phase is a guess months out that then looks authoritative.

It is also the single change that would turn the roster (FR-4) from reference
data into assignment, and the tool into the tracker the brief forbids. If the
overlap problem is real, FR-3 addresses it without naming anybody.

---

## FR-11 · The project picker belongs to the Project tab — **P2**

*From `comments.md` #3 on 2026-08-13. It confirms the **Tab order** note at the
foot of this file, which called this out as an observation; it is now a request.*

**What:** move the project `<select>` (and `Delete`) out of the global header
into the Project view. `New project` stays where it is, but clicking it switches
to the Project tab and lands on the project it just made.

**Why it matters.** Three of the four tabs ignore the picker. On Portfolio, Map
and Sprint it is a control that changes nothing you can see — and on Map and
Sprint it actively misleads, because both of those look like views that *should*
be scopeable to a project and neither is.

**Careful bits, none of them hard but all of them easy to miss:**

- `loadPlan` re-reads `/api/projects` after every edit so the option's badge
  retags immediately (`CLAUDE.md`, *Picker*). Moving the element must not break
  that refresh, and `refreshTrackPickers` runs inside `loadProjectList` too.
- `#empty-state` is currently the top-level stand-in for "no project selected".
  Once the picker lives inside the Project view, that message belongs inside it.
- `Delete` is destructive and currently sits beside `Export`/`Import`, which is
  the wrong neighbourhood for it anyway. **Recommend it moves with the picker** —
  it deletes the project the picker names, so it belongs beside it.
- **Run `node scripts\wire_check.js` after every edit to `index.html`.** This is
  the one item on the list that moves markup `bindEvents()` addresses, and a
  `$()` that finds nothing returns null, throws on the next property access, and
  silently kills every handler wired after it — including the boot call. The
  tests are API-level and never load the page.

**Do it in the same pass as the tab reorder** (`Map → Project → Portfolio →
Sprint`, see below). Both edit the header, both are small, and the reorder is the
thing that makes the picker's placement obviously wrong — land on Map first and
a project selector is the first thing you see.

**Cost:** medium-small. `index.html` markup, the tab-switch wiring in `app.js`
(keyed off element ids, not order), and CSS for the relocated row.

---

## FR-21 · `phase.status` is still maintained by nobody — **P2**

*The half of FR-16 that milestones did not answer. FR-16 is deleted; this is
what it actually noticed, reopened under its own number.*

Milestones took the completion question off `phase.status`, so the `done` rung is
reachable again without it. What has not changed is the measurement that opened
FR-16, against `data\roadmap.db` on 2026-08-14:

| | |
|---|---|
| phases at `planned` | **29 of 30** |
| phases at `in_progress` | **0, ever** |
| dated phases whose window contains today, still `planned` | 6 |

`phase.status` now has **exactly one job: feeding V6 and V7.** That is a narrower
and more useful field than it was, and it makes the bookkeeping problem sharper
rather than softer — V6 is the only rule that has ever found real late work, and
it fires on `status != 'done'`, so an unmaintained field means V6 warns about
phases that are actually finished. The signal degrades into noise you learn to
scroll past.

**What is worth doing, roughly FR-16's option D without any of its derivation.**
Make closing a phase cheap where you already are: a done tick on the phase row
instead of a three-value `<select>` nobody opens, and an action on the V6 warning
that already names the phase. `in_progress` has never been used once, so the
select is offering a state the team does not have.

**What is not worth doing, and the reason is unchanged.** Deriving `status` from
dates kills V6 outright — a phase past its end would auto-read `done` and the
rule could never fire again. FR-16's options A, B and C were all attempts to work
around that, and all of them are now unnecessary rather than merely awkward: the
thing they were trying to rescue (project completion) has its own object.

**What changed on 2026-08-17, and it sharpens this again rather than answering
it.** Two charts now show how far along a project is — the portfolio's folded
swimlane and the map's node fill — and both read the **deliverable tick**, because
this field could not carry them: the same measurement, re-taken that day, said 34
of 39 phases at the untouched default and `in_progress` still never used once, so
a phase-driven bar drew empty for 10 of the 13 projects holding work. The
requester was offered the phase done-tick above as the fix that would have made
the phase tally usable, and declined it: the ticks are the number people maintain.
So `phase.status` is no longer just unmaintained, it is now read by **V6 and V7
and nothing else at all** — and V6, the one rule that has found real late work,
still fires on `status != 'done'`. The done-tick remains the cheap fix; nothing
about the argument for it has weakened.

**Open question before building:** dropping `in_progress` narrows a CHECK, which
means rebuilding the `project`-shaped table for `phase` — the `migrate_stage_check`
path that cost a real dataset once. Leaving the value in the column while removing
it from the UI costs nothing and risks nothing. Prefer that unless there is a
reason not to.

---

## FR-20 · Milestone diamonds on the portfolio — **P2**

*Deliberately left out of the milestone build in tree E, logged so the deferred
half stays visible rather than buried in a closed entry.*

Milestones draw as diamonds on the **Project** timeline, in both Dates and Weeks
modes. The **Portfolio** — every project's scheduled phases on one axis — draws
none, so the whole-department view cannot show what any of it is aiming at.

It was left out for a scheduling reason rather than a design one: another tree
was editing the portfolio renderer at the time (FR-13, FR-12, FR-2), and adding a
lane to it from the milestone tree would have put both in one file for the sake
of a feature neither was blocked on. Keeping them disjoint is what let them merge
on prose conflicts alone. **Both are merged now, so that reason is spent and
nothing blocks this.**

**What it needs.** `GET /api/portfolio` does not carry milestones; the graph
payload does (`milestones_reached` / `milestones_total`, added for the map's
green) but only as counts, not dates. So this is a payload addition plus a lane
in the swimlane renderer — the marks themselves already exist as `milestoneLane`
(`app/static/app.js:904`), which takes marks and knows nothing about which chart
it is in, and is already called from both timeline modes.

**The thing to decide first:** one lane per swimlane, or one shared lane above
the whole chart. Per-swimlane keeps a checkpoint next to its own project's bars
and costs a row of height per project; a shared lane is compact and makes it
ambiguous whose checkpoint a diamond is. Per-swimlane is probably right, and the
label overlap noted below gets worse either way at portfolio density.

**Known cost, inherited:** two checkpoints a few days apart overlap their labels
on the project timeline already. The `title` carries the full text and thinning
them out would need text measurement the charts do not do — the map has the same
problem and answers it with a collision sweep rather than at runtime.

---

## FR-19 · V1 fires on every phase in the dataset — **P2**

*Not a request. Found while building FR-2 on 2026-08-15 — the one thing that
survives it, since FR-2 itself is won't-build. **This finding is independent of
that panel**: the rule fires the same whether or not anything lists it in one
place. Asking every rule at once is simply what made it countable.*

**What:** across the real file, every project running V1/V4/V6/V7 produces **32
warnings: 30 V1 and 2 V6.** There are 30 phases. V1 fires on **every single one
of them** — 2 to 5 per project, which is what the Project tab has been showing all
along, one project at a time, without it ever adding up to a number anyone looked
at.

**Why that matters more than it looks.** A rule that fires on everything carries
no information. It is not wrong — V1 is doing exactly what it is specified to do
— but a warning list that is always full is a warning list nobody reads, and the
two V6 findings that *are* real sit in the same list. Ordering them within a
project was FR-2's workaround; with FR-2 gone there is no workaround, only the
underlying question.

**The arithmetic, because the cause is not a bug.** `implied_weeks =
(effort_points / velocity) × (sprint_length_days / 7)`, so at the default
velocity 20 and a 14-day sprint a phase's points imply `points / 10` weeks. The
real dataset's phases carry **2 to 12 points against durations of 1 to 8 weeks** —
a 2-week phase with 3 points implies 0.3 weeks. Nothing is within 5%.

So one of three things is true, and **only the user can say which**:

| If | Then |
|---|---|
| The points are on a different scale than velocity 20 assumes | `default_velocity_points_per_sprint` is wrong for this team, and FR-5 is the item that fixes it — from delivered history, never from headcount |
| The points are right and the durations are calendar time, not effort time | V1 is comparing two things that were never the same thing, and the rule needs re-stating, not re-tuning |
| Both are right and 5% is simply too tight | `v1_tolerance_pct` is a setting; it exists to be changed |

**The bad version:** widening the tolerance until the warnings stop. That is
tuning a rule to be silent, which is the same as deleting it while keeping the
code. If V1 has nothing to say about this dataset, deleting it outright is the
honest move — V5 is the precedent and `CLAUDE.md` rule 5 records how that was
done.

**Depends on nothing and blocks nothing.** It is a conversation with a number
attached, and the number is `30 of 30`. **Recommend looking at it before FR-1**,
which writes down that sprint points and `effort_points` are one currency: that
invariant is worth stating, and worth stating about numbers that mean something.
It also gates any future attempt at FR-2 — a list of every rule at once is
unreadable until this is settled.

**To re-measure it** without the panel FR-2 would have given you, since nothing
in the app now asks every rule at once: open two or three projects and count the
V1s on each, or run `validate_plan` over `db.list_projects()` in a scratch
script. It was 30 of 30 on 2026-08-15.

---

## Tab order

Separate from the above and not a gap: the tab bar is
`Project | Portfolio | Map` (`app/static/index.html:13-15`), which runs backwards
along the commitment ladder the tool is actually built on
(`validation.project_stage`). `Map → Project → Portfolio → Sprint` matches it —
ideas are captured on the Map, costed on Project, dated on Portfolio, executed in
a sprint.

Reordering is three lines: tab handling is keyed off element ids, not order
(`app/static/app.js:417-419`, `2466-2474`). Landing tab is a separate decision
and should probably stay on Project.

One thing it exposes: the project `<select>`, `New project` and `Delete` sit in
the global header but only mean anything in Project view. Land on Map first and
that is the first thing you see. **That is now FR-11**, raised independently by
the requester — so the two should be done together.
