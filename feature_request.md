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
FR-21, **which is itself built as of 2026-08-22.** So every line the requester has
written down is now answered in code, and nothing below is waiting on them to
write something new. The two things below that *are* waiting on them are FR-23 and
FR-19, and both are questions rather than reports.

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
here: FR-8, FR-9, FR-10, FR-11, FR-12, FR-13, FR-14, FR-15, FR-16, FR-17,
FR-18, FR-20, FR-21.

**Swept 2026-08-24 against `main` at `7e0e328`.** Three entries were still
listed as open after their code had landed, which is what a backlog costs when
it is written in one tree and built in another:

- **FR-20 shipped on 2026-08-17** in `d6c6d08`, not deferred as its entry
  claimed. `GET /api/portfolio` carries `milestones` — dated, flat, `project_id`
  tagged — and every swimlane draws its own checkpoints through the same
  `milestoneLane` the project timeline uses. The decision the entry left open was
  taken: **per-swimlane, not one shared lane**, and bars still decide which lanes
  exist so an off-window project opens no lane for a diamond alone.
- **FR-21 shipped on 2026-08-22** in `346aa61`, as the entry recommended and no
  further: `validation.phases_ready_to_close` reports that a phase's ticks and
  its status disagree, three surfaces offer the write, and nothing derives.
  `in_progress` stayed in the column and in the select, so the `migrate_stage_check`
  rebuild the entry warned about never had to happen.
- **FR-11 was answered by the shell redesign rather than built as written**, the
  FR-16 precedent. There is no header `<select>` any more: the picker is the
  sidebar's filterable project list, `Delete` moved into the project `⋯` menu
  away from `Export`/`Import`, `#empty-state` is already scoped to the Project
  view (`app.js:1612`), and `openProject` sets `state.view = "project"` — so
  picking a project from Map, Portfolio or Sprint lands you on the plan instead
  of changing nothing you can see. That was the whole complaint. What did *not*
  happen is the literal ask, the list living inside the Project view: it is
  global chrome, foldable to an icon rail. No residue is reopened, because a
  global list that navigates is a different answer rather than half of one.

**FR-2 is the one entry that was built and then un-built**, so it sits below as a
won't-build rather than being deleted. The rule holds either way: the file keeps
the argument, because nothing else records a decision *against* something.

**FR-16 is gone but was not built as written.** It asked what to do about
`phase.status`, which nothing maintains; the answer turned out to be that the
question was aimed one level too low. Milestones — a checkpoint entity the
project ladder reads — made all four of its options unnecessary, and shipped in
tree E. What FR-16 actually noticed was reopened as **FR-21**, and that shipped
too on 2026-08-22 — so the whole chain is closed and both numbers are gaps.

**FR-19 was claimed twice, by two trees that were open at once.** Tree B's
finding — V1 firing on every phase — landed on `main` first and keeps the
number, and it is the one still open. Tree E's leftover was **FR-21**, now built;
the number was the one thing about it that moved, so tree E's commit messages and
`STATUS.md` item 71 call it FR-19 while meaning the phase-status entry. Worth
knowing when reading back: **an FR-19 in an August commit message is FR-21.** No
number has been reused.

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
| FR-19 | V1 fires on all 40 phases, so it says nothing | Setting or prose | High | High | **P2** — one decision, no code |
| FR-3 | Overlap check across projects (**not** a points sum) | Small–medium | Low | Medium | **P3** — sprint 4 |
| FR-2 | Portfolio-wide warnings, not just V2 | Small | High | — | **Won't build** — built, then removed |
| FR-4 | Capacity roster — people and their available days | Medium (new table) | Fortnightly | Medium | **P3** — paper until sprint 4 |
| FR-5 | Velocity learns from delivered history | Medium | Rare | Medium | **P3** — needs 3 baselines |
| FR-6 | Slippage memory — has this date moved before? | Large | Low | High | **P3** — deferred deliberately |
| FR-23 | Versioning: who changed what, and revert | Large (needs a store) | — | High | **P3** — a brief decision |
| FR-7 | Owners at roadmap level | Small | — | Negative | **Won't build** |

**Nothing left in this table is code.** FR-19 and FR-1 are a number and a
paragraph, and **FR-19 goes first**: FR-1 writes down that SP and `effort_points`
are one currency, and that is worth stating about numbers that mean something.
Everything else is P3 — blocked on evidence (FR-3, FR-4, FR-5), deferred on
purpose (FR-6), or waiting on your answer (FR-23).

**FR-23's other half is built.** It arrived on 2026-08-24 as one request and was
split in two, because the two halves are different kinds of question: a gesture
with nothing stored, and a history with an author on it. The gesture was FR-22,
`Ctrl+Z` in the Sprint tab, and it shipped the same day — a snapshot stack in
memory, per session, nothing keyed to a person. `git log` and `STATUS.md` are the
record. What is left below is the half that needs a store and an answer from you.

---

## Dependencies, and what can run in parallel

Written when several of these could be developed at once in separate worktrees.
**Nothing left here has any code in it**, so this section is now a record of how
the parallel work went — kept because the traps below apply to the next tree,
whenever there is one.

**No near-term item needs a schema change** — no table, no column, no
`migrate()` step, no export bump — so the usual `--reload` migration hazard does
not apply. FR-4's option B and FR-23's store are the two exceptions, and both are
deferred.

### What actually blocks what

No dependency is left among the near-term items. The two that were decisions
rather than effort — FR-20's lane placement and FR-21's `phase.status` question —
were both taken and both built.

```
FR-23 ──> a decision  the brief, not the code — and then a store
```

- **FR-23 blocks on the brief, then on a store**, and shares that store with
  FR-6. Neither should invent its own.

- **Everything built is on `main`, and nothing left here opens a file.** FR-1 is
  prose, FR-19 is a number and a conversation, FR-3/FR-4/FR-5/FR-6/FR-23 are all
  waiting on evidence or on an answer. So the merge-order reasoning that used to
  live here is spent.
- **FR-2 was built and reverted the same day**, so its footprint is back to
  nothing: `validate_plan` ends exactly as it did before, and `read_portfolio`'s
  `warnings` is V2-only. Worth knowing only because the revert is in the history
  and a `git log` reading will find code that is no longer there.

### Where each one lands

**The table that used to be here is gone with FR-11, FR-20 and FR-21** — it named
`app.js`, `index.html` and `style.css` regions at line numbers from when `app.js`
was 3,823 lines, and every one of the three has since been built. The rule it was
written to teach still holds for whatever lands next: **re-grep rather than
trusting a line number**, because anything inserted in `#project-view` pushes
everything below it down.

**The anchor table for FR-22 is gone with it.** What it was written to teach is
worth keeping, and the sprint undo is now the example: the anchors it listed were
mutation sites, and the shape that shipped derives the range each edit touched by
diffing two snapshots instead of having every site declare one. **Look for the
funnel before writing down a list of call sites** — `editSprintCell`,
`editSprintBlock` and the six grid operations turned out to cover twenty gestures
between them.

One property worth carrying forward even with the CSS items built: **`style.css`
merges cleanly only while nobody reflows it.** Do not reorder or reformat blocks
you are not changing. The `[hidden]` trap — a class setting `display` outranks the
UA sheet — has now cost five separate features; check it before adding any new
hideable element.

### Suggested worktrees

**The table is empty, because nothing left here opens a file.** FR-22 was the last
entry in it and went straight onto `main` instead — the tree was suggested because
it wanted `editor.js` to itself, and with nothing else live there was nothing to
isolate it from.

**The four trees that ran are deleted from this table, not struck through**, the
same rule the entries themselves follow: B (portfolio), E (status), F (map) and
G (editor) are merged, and `git log` plus `STATUS.md` are the record. What
carries forward is the one live claim they support — **the split works.** Four
trees open at once, and the only conflicts were prose in this file and in
`CLAUDE.md`. **Nothing is live now**, so the traps below apply from whenever the
next one is opened.

Two things they left behind that the next tree uses, and one that is still open:

- **`scripts/wire_check.js`** runs `bindEvents()` behind a stub DOM and names
  every id the JS asks for that `index.html` does not define. FR-11 was the item
  that needed it and it is built; the standing rule is unchanged — run it after
  any edit to `index.html`, because moving markup is the frontend migration
  nothing else fails loudly on.
- **`scripts/map_sweep.js`** is the map's only verification, and it wants the
  real dataset: what the map looks like at this shape — 8 tracks, one already
  three deep — *is* the check, so a fresh worktree's empty `data/` makes map
  work unverifiable rather than merely dull.
- **Still outstanding: an eyeball on the drag pill and the lane tooltip.** Both
  were verified headlessly out of the real `app.js` behind a stubbed DOM because
  the browser extension would not connect; neither has a suite to belong to. See
  `STATUS.md`.

**Tree D is gone with FR-11.** Its rule was worth keeping in general, though, and
it is the reason the shell work went last: **a branch that reshapes the page every
other branch renders into is rebased onto them, not the other way round.**

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

**What:** Write down — in `templates/sprint.md`, `docs/concepts.md` and
`CLAUDE.md` — that an **SP** on a sprint task row and a point in
`phase.effort_points` are the same unit.

**Re-read against the current template on 2026-08-24.** The requester's own
format replaced the original on 2026-08-18 (`a3a07d6`), so every line number this
entry used to cite is gone — and the gap it names got **wider**, because the two
now do not even share a word:

- `settings.default_velocity_points_per_sprint` (20) drives every V1 check
  (`app/validation.py:298`, `check_effort_duration_mismatch`), and the roadmap
  calls the unit a **story point** (`README.md`, `docs/getting-started.md`).
- The template calls it **SP** throughout — the task table's `SP` column, `Planned
  Product SP`, `Total Planned SP` (`templates/sprint.md:49`, `55-57`, `107-109`) —
  and states `Historical Velocity: ~20 SP / Sprint` (`:24`) with no statement
  anywhere that this is the same 20 the setting holds.
- The old template's derivation is gone with it: there is no baseline row averaging
  roadmap points over person-days any more, so the arithmetic that used to link
  the two is not merely unstated, it is absent.

V5 was deleted, so there is no rollup from deliverables to phases and nothing
reconciles the two. If the currencies drift, the historical-velocity line is
meaningless, V1 is meaningless, and neither will announce itself — they will just
both be quietly wrong in the same direction.

**The `~20 SP / Sprint` line makes this sharper than it was.** It is a number
typed into a markdown file that happens to match a number in the database, with
nothing saying they are the same quantity — which is exactly the kind of
coincidence FR-19 is about.

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

> **2026-08-21 — a narrow slice of this shipped, and this entry is still
> won't-build.** The requester asked for an overdue alert in the top bar; it is
> `GET /api/late` and the bell beside presence. Read what it is *not* before
> reading this as a reversal:
>
> - **One question, not every rule.** V6 and V8 — what is past its date. V1, V2,
>   V4 and V7 are absent, which is what makes FR-19 stop mattering here: the
>   thirty V1s that would have buried the real findings are not in the answer.
> - **Not on the Portfolio page.** The instruction that killed this was *"i dont
>   want it to show on portfolio page"*, and the bell is in the top bar on all
>   four tabs. The locality argument that won is untouched: a rule about whether
>   an estimate hangs together is still read only in the project it belongs to.
> - **V8 is new** (`check_milestone_overdue`) and rides on the project view as
>   well, so nothing is said in the bell that the project cannot say for itself.
>
> The two things this entry said would be needed first are still true and still
> unbuilt: a list carrying V1/V4/V7 across every project, and V2 filtered out of
> it. **If the ask ever widens back to "every rule, everywhere", it is this
> entry again**, with FR-19 in front of it.

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

**Interaction with FR-21, which is now built:** the two were the same complaint
from opposite ends. FR-21 shipped on 2026-08-22 and made closing a phase one
press, so if this ever comes back it would read against a status people can
actually maintain — the argument for doing that half first was right, and it is
the half that happened.

**If it ever comes back**, three things are already known: V2 must be filtered
out of any such list (the dependency list below the chart marks the link it is
about, and the count pill there keys off the same array, so an unrelated V6 turns
it amber); the rules must carry `project_id`, which they do not — `validate_plan`
is the one place that knows it; and FR-19 has to be settled first, or the panel is
**forty** V1s with the real findings buried in them — it was thirty when this was
written, which is the argument getting stronger on its own.

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
wrong, and the fortnight view's invariant 2 already says why — it is now
non-negotiable 8 in `CLAUDE.md`, *"nothing sums points across a window"*: a 55-point
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

**What it feeds, re-read against the current template on 2026-08-24** — the
requester's format replaced the original on 2026-08-18 (`a3a07d6`), and the
roster half of it is *more* hand-typed than before, not less:

1. **The capacity table** (`templates/sprint.md:27-32`) — `Person | Available
   Days | Leave / Holiday | Notes`, with the four handles already typed into the
   template itself. The names are now committed to git and the days are blank
   every fortnight, which is the wrong half fixed: a roster would fill in the days
   and stop the names from being a template edit when someone joins.
2. **`Team: 4 people`** (`:23`) — a hand-typed headcount that has to be kept in
   step with the rows two lines below it. Nothing checks the two agree.
3. **`Historical Velocity: ~20 SP / Sprint`** (`:24`) — typed, and the same
   number as `default_velocity_points_per_sprint` by coincidence rather than by
   any link. See FR-1.
4. **The derived line this entry used to point at is gone.** The old template
   divided roadmap points by person-days to get a baseline; the current one has no
   such arithmetic, so *"is 20 SP still right for a team of four"* is a question
   nothing in the file asks any more.

**Why it matters beyond convenience.** `default_velocity_points_per_sprint` is a
team-level constant driving V1 across the entire roadmap. When the team changes
size, that constant is wrong and nothing anywhere prompts you to look at it. A
roster makes a team-size change a visible event rather than an invisible one.

### The lines this must not cross

These are the reason to write the request down rather than just build it. Each
has an obvious, tempting, wrong version.

| Do not add | Why |
|---|---|
| `points_per_day`, or points anywhere on a person | The capacity design rests on declared points being a **judgement** with available days as *evidence, not a multiplier* — the template says it in its own words: *"Historical velocity is a planning reference, not a hard capacity limit"* (`templates/sprint.md:36`). A per-person rate is the focus factor coming back in through the roster. |
| `phase.owner_id`, `deliverable.assignee`, any link from a person to work | The moment a person links to a work item this is a tracker, and tracking is a stated non-goal. The roster exists for arithmetic only — see FR-7. |
| Logins, roles, permissions | Non-goal, and now doubly so: sign-in exists and is deliberately **a gate, not an account model** — non-negotiable 7 names roles, permissions and any row keyed by a person as never-build. A person here is a name string in a table, and a roster row must not become the thing the gate refused to store. |
| Deriving velocity from the roster | Velocity comes from **delivered history**, never from headcount. The roster explains why a baseline moved; it does not compute one. See FR-5. |

### Scope trap: holidays and leave

**The current template already answered this, and answered it the cheap way:**
`Leave / Holiday` is a free-text column on the capacity table
(`templates/sprint.md:27`), typed per person per fortnight. A holiday calendar is
region-specific, annual, needs maintaining, and interacts with
`sprint_length_days`; it is a table that grows forever to save a sentence.
**Leave and holidays stay text in the sprint file**, and the roster — if built —
carries only steady-state availability.

### Where it lives — options

| Option | Pro | Con |
|---|---|---|
| **A.** Extend the `settings` singleton | No new table | `settings` is one row; people are a list. Does not fit. |
| **B.** New `person` table + config section | Proper home; exports with everything else | Schema change, `migrate()` step, export bump to v10 |
| **C.** Stay on paper — the capacity table the template already carries | Free; keeps the paper-first staging decision intact, and it is what is happening today | Days retyped each fortnight; `Team: 4 people` and the `~20 SP` line stay hand-typed and unchecked |
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

**Option C is now the state of the world rather than a proposal.** The template
carries the capacity table with the four handles in it, so the cheap half of this
entry happened when the format changed on 2026-08-18. What is still free and
still not done: make the arithmetic visible — a person-days total under the table
that `Team: 4 people` and `~20 SP / Sprint` can be read against. Today all three
numbers are typed and none of them is checked against the others.

Note B is a **table addition**, which is the safe half of `migrate()` — the
guarded `ADDED_COLUMNS` path, nowhere near `migrate_stage_check`. Still back the
data file up under a fresh name first, and not over `data/roadmap.db.bak`.

---

## FR-5 · Velocity learns from delivered history — **P3**

**What:** Let the sprint baseline inform `default_velocity_points_per_sprint`
instead of the two numbers living separate lives.

**Why it matters.** The setting is 20 and the template says `~20 SP / Sprint`
(`templates/sprint.md:24`) — two numbers, typed twice, linked by nothing. From
sprint 4 the closed files will say what was actually delivered, and
`scripts/sprint_review.py` will have read them, while the roadmap goes on never
learning it.

**The evidence this entry used to cite is gone**, and that is the change worth
recording: the old template shipped a worked example where the baseline was 11
against a setting of 20. The requester's format (2026-08-18) carries no worked
example, so **there is no illustration of the gap any more — only real sprint
files will show it**, which pushes this further behind FR-1 rather than closer.

**The bad version:** writing it back automatically. It feeds a number back before
you trust the number, and the sprint file has never written to the roadmap — the
one exception, the deliverable tick, is a press somebody makes.

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

Velocity is a team-level number by design, and the sprint file is where a name
already lives — the `PIC` and `Reviewer` columns on every task row
(`templates/sprint.md:49`), at the task level, for one fortnight, where an owner
is a real commitment rather than a guess months out. An owner on a phase is a
guess months out that then looks authoritative.

**The 2026-08-18 template strengthens this**, because it puts two named columns on
every row: the tool now has a perfectly good place for a person, in a file, in
markdown, keyed to nothing. That is the whole answer, and it is why a `person`
column on a phase would be the tracker rather than the convenience.

It is also the single change that would turn the roster (FR-4) from reference
data into assignment, and the tool into the tracker the brief forbids. If the
overlap problem is real, FR-3 addresses it without naming anybody.

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

**Re-measured on 2026-08-24, read-only against `data/roadmap.db`, and it is
worse rather than stale — and the obvious fix has already been tried and did not
work.** 30 projects, 40 phases: **V1 40, V6 2, V7 2, V8 2.** Nine days and ten
more phases later, still every phase, and the two real V6 findings are now
outnumbered twenty to one.

**The new fact is the override.** Four projects carry a `velocity_override` — 11,
26, 12 and 13 against the global 20 — and **V1 fires on all of their phases too**,
3, 4, 4 and 5 respectively. So the first row of the table below has been tested by
hand: retuning velocity per project, the lever the app already offers, does not
make this rule say anything. Whatever V1 is comparing, a different divisor does
not reconcile it — which moves the weight onto the second row, that weeks here are
calendar time and were never effort time.

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
| The points are on a different scale than velocity 20 assumes | `default_velocity_points_per_sprint` is wrong for this team, and FR-5 is the item that fixes it — from delivered history, never from headcount. **Weakened by the 2026-08-24 measurement:** four projects already override it and V1 fires on every one of their phases anyway |
| The points are right and the durations are calendar time, not effort time | V1 is comparing two things that were never the same thing, and the rule needs re-stating, not re-tuning |
| Both are right and 5% is simply too tight | `v1_tolerance_pct` is a setting; it exists to be changed |

**The bad version:** widening the tolerance until the warnings stop. That is
tuning a rule to be silent, which is the same as deleting it while keeping the
code. If V1 has nothing to say about this dataset, deleting it outright is the
honest move — V5 is the precedent and `CLAUDE.md` rule 5 records how that was
done.

**Depends on nothing and blocks nothing.** It is a conversation with a number
attached, and the number is `40 of 40`. **Recommend looking at it before FR-1**,
which writes down that sprint points and `effort_points` are one currency: that
invariant is worth stating, and worth stating about numbers that mean something.
It also gates any future attempt at FR-2 — a list of every rule at once is
unreadable until this is settled.

**To re-measure it** without the panel FR-2 would have given you, since nothing
in the app now asks every rule at once: run `validate_plan` over
`db.list_projects()` in a scratch script, opening the database read-only
(`sqlite3.connect("file:...?mode=ro", uri=True)`) so the measurement cannot be
the thing that changes the dataset. It was **30 of 30 on 2026-08-15** and **40 of
40 on 2026-08-24**.

---

## FR-23 · Versioning: who changed what, and revert — **P3, a brief decision, not effort**

*The second half of the same 2026-08-24 request, split out because it is a
different kind of question. Asked as: "the versioning where we can see who make
the changes and revert if needed."*

**Not buildable as written**, and the reason is not effort. Non-negotiable 7
names activity feeds and audit logs as never-build, and a version row carrying an
author is `created_by` — *a row keyed by a person*, which is the exact shape the
gate was narrowed to avoid on 2026-08-21. Presence shows a name it was handed; it
does not record one. Building this makes the tool the tracker `PROMPT.md`
forbids, on the one axis the brief was most explicit about.

The underlying want is real, though, and it is two wants wearing one coat:

- **"Take that back"** — answered by FR-22, entirely, with nothing stored.
- **"What did this file look like on Tuesday, and can I have it back"** — a
  history question, and the only half that needs a store.

### Two honest ways it could exist

| Option | Pro | Con |
|---|---|---|
| **A · Anonymous file snapshots** — keep the last N versions of `sprints/NN.md`, no names, revert to any | no person-keyed row, so the brief survives intact; a sprint file is small and there are ~26 a year | answers *what* changed and never *who* — which is half of what was asked |
| **B · Amend the brief** — a versions table with an author column | actually answers the question | crosses non-negotiable 7 deliberately; needs the argument written into `PROMPT.md` as an amendment, and it is the door the brief was holding shut |

Both need a store, which is FR-6's problem too — and FR-6 is deferred for
exactly this reason, so whichever store lands should serve both rather than each
growing its own.

**This entry is not waiting on a developer.** It is waiting on the requester to
say A, B, or neither. Until then the argument above *is* the artefact, which is
why it sits here rather than being deleted — the same reason FR-2 and FR-7 stay.

---

**The `Tab order` note that used to close this file is deleted with FR-11**, the
only entry that quoted it. Both halves are built: the nav has run
`Map → Project → Portfolio → Sprint` since 2026-08-20 (`7b23b2f`), and the picker
is the sidebar list. `git log` is the record.
