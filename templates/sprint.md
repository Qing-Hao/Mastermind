# Sprint N · YYYY-MM-DD → YYYY-MM-DD

<!--
Copy to sprints/NN.md, one per sprint. Two weeks, always — the cadence is fixed
so the only dates you enter are the sprint's own.

The shape below is the Docmost sprint format (Main tasks / Sub tasks, a row per
title carrying PIC · storypoints · status · priority) with the capacity and
at-close sections kept around it. The wiki's glossary is the vocabulary here
too: **Title** is a row, **Stories** are its top-level bullets, **Tasks** are the
nested ones.

Two places per title, deliberately: the table is the scoreboard you re-read and
re-status during the sprint, the checklist under it is what you tick. Adding a
title means adding a row and a block.

Nothing here writes back to the roadmap. A sprint that overruns is reported in
Reflection; phase dates in the planner are changed by hand, deliberately, or not
at all.

Fill Goal, Capacity, Main tasks and Sub tasks at planning. Fill Unplanned work
as it happens. Fill Day 5 on day 5. Fill "At close" on the last day, before the
retro — that section is what makes the next sprint's planning better than this
one's.
-->

## Goal

**Goal:** _one sentence — what this sprint is for. Not a task list; the thing the
sprint should be judged against, and the thing "At close" gives a verdict on._

- **What is the focus?**
- **Why is this focus prioritised?**
- **Is it aligned with the product direction?**

_Start here, before any title is written down. A sprint whose goal is a bullet
list of "work on X" has no way to come out either met or missed._

## Capacity

_Two independent numbers, the same way V1 cross-checks weeks against points:
one bottom-up from who is actually available, one top-down from what this team
has actually delivered. **Neither corrects the other.** The gap between them is
the thing worth reading._

**Holidays & leave this window:** _name them — public holidays, leave, training.
This is what the person-days row below is counted from._

**Bottom-up — declared**

| Person | Days available | Of which coding | Declared pts | Last sprint declared → actual | The rest goes to |
|---|---|---|---|---|---|
| @you | 10 | | | | |
| @them | 10 | | | | |
| **Total** | | | | | |

_Declared points are a **judgement**, not days × a rate. The coding-days column is
the evidence for the judgement, not a multiplier — inventing a points-per-day
constant is the guess this whole block exists to avoid._

_The "last sprint" column is copied from the previous file's At close table. It
is **evidence, not arithmetic**: nobody divides by it. It exists because the one
thing worth knowing at planning is which way you are reliably wrong, and that
number was being written down and then thrown away._

**Top-down — baseline**

| | |
|---|---|
| Last 3 sprints — **roadmap** points delivered | a · b · c → avg |
| Person-days normal / this sprint | 20 / N  _(from the holidays line above)_ |
| **Baseline** (avg × this ÷ normal) | |

_**Roadmap** points, not total: the "At close" table below separates the two, and
this row reads the roadmap line. Averaging total load would predict how busy you
will be, which you already know. What you need predicted is how much of the
roadmap moves — and because past sprints carried their own interruptions, a
typical amount of interruption is already priced in._

_Your split between building and everything else is **already inside** the
delivered number — that is why there is no focus factor to declare. Sprints 1–3
have no history, so write a deliberate guess here and mark it as one. From
sprint 4 this row is arithmetic._

| | Points |
|---|---|
| **Capacity taken** — the lower of declared and baseline, unless you write why not | |
| Carried in from Sprint N−1 | _its "Carried out" row_ |
| **Committed** | |

## Main tasks

_The work the Goal is about. One row per title; the checklist under it is the
same title's Stories and Tasks._

Status is one of: `not started` · `ongoing` · `on PR` · `blocked` · `done`.
Priority is `HIGH` · `MEDIUM` · `LOW` and should match the project's tier in the
planner (T1 → HIGH, T2 → MEDIUM, T3 → LOW). Keep to both lists — a status
invented once counts for nothing when you tally the quarter.

| Title | PIC | Pts | Status | Priority |
|---|---|---|---|---|
| | | | | |
| | | | | |

**<u>Project — Title</u>**
- [ ] Story
  - [ ] Task
  - [ ] Task
- [ ] Story

**<u>Project — Title</u>**
- [ ] Story
  - [ ] Task

_**Points sit on the table row, not on the story lines** — a title is the unit
you estimate and the unit the roadmap knows about. The cost is that a title is
all-or-nothing at close: its points count as completed only when every story
under it is ticked, and anything else is carried out whole. If that is losing
you real progress, split the title into two rows at planning rather than
inventing part-marks at close._

## Sub tasks

_Everything else committed this sprint: work that is on the roadmap but not what
the Goal is about — smaller items, follow-ups, research. Same columns, same
rules. If this table is bigger than Main tasks, the Goal is not the sprint._

| Title | PIC | Pts | Status | Priority |
|---|---|---|---|---|
| | | | | |

**<u>Project — Title</u>**
- [ ] Story
  - [ ] Task

## Totals

| | Points |
|---|---|
| Planned — main | |
| Planned — sub | |
| **Total planned** | _must equal Committed, or say why below_ |
| **Completed** | _filled at close_ |
| **Carried out** to Sprint N+1 | _filled at close; this is next sprint's carry-in_ |

_**Total planned is the sum of the rows above it, and Completed is the sum of the
rows marked `done`.** Both are worth re-adding at close: a total that does not
reconcile with its own table is the one number in the file nobody can check._

## Unplanned work

_Everything that isn't on the roadmap — customer requests, ops, deployment, **and
your own review and management load**. It is listed here for one reason: work you
never write down is work you never automate, and work you never count is work
that silently eats the capacity you declared above._

Category is one of: `customer request` · `ops/support` · `deployment` · `infra` ·
`internal tooling` · `review` · `planning & mgmt` · `admin`. Keep to this list;
a category invented once counts for nothing when you tally the quarter.

_Reviewing **this sprint's own planned work** is not unplanned — it is known at
planning and belongs in the reviewer's "The rest goes to" column. Putting it here
buries the genuine interruptions this table exists to find._

| Task | Category | Owner | Pts | Done |
|---|---|---|---|---|
| | | | | |

## Day 5 check

_One line, on the middle Friday. Cheap, and the only thing here that can still
change the outcome._

- **Goal still reachable?** yes / at risk / no —
- **What changed since planning:**
- **Anything to hand back now** _(better than discovering it on day 10)_:

## At close

_Fill this on the last day. It is the only part that teaches: you predicted, now
check. Nothing here is a score — a declared number that was wrong is information,
and the point is to find out **which way** you are reliably wrong._

**Goal met?** yes / partly / no — _one sentence. Points delivered and goal met are
different questions, and you can hit one while missing the other._

| | Declared | Actual |
|---|---|---|
| @you coding days | | |
| @them coding days | | |
| **Roadmap points delivered** | | |
| Non-roadmap points | — | |

**Where the gap went:**

**Roadmap edits to make** — _the sprint file never writes back, so anything the
sprint changed about the plan has to be done by hand, in the planner, now.
Deliberately cut work whose phase will go overdue lives here._

- [ ] 

## Reflection

- **What surprised us:**
- **What got interrupted, and by what:**
- **What should be automated:** _the payoff for the unplanned table. Look for the
  same category showing up sprint after sprint with real points against it._

---

<!-- Reference — not part of the sprint. Delete from a copy, or leave it. -->

<details>
<summary>Filled example — the real 17 Jun → 01 Jul sprint, in this format</summary>

# Sprint N · 2026-06-17 → 2026-07-01

## Goal

**Goal:** Get multi-data-source onto a shared environment/tenant structure so a
second provider can be added without another schema change.

- **What is the focus?** The backend split — table structure, migration, and the
  query paths that read tenant ids.
- **Why is this focus prioritised?** Everything else queued behind it; the poller
  and the reporting APIs cannot be finished twice.
- **Is it aligned with the product direction?** Yes — it is the continuation of
  the 03 Jun kickoff.

## Capacity

**Holidays & leave this window:** 17/6 Awal Muharram.

**Bottom-up — declared**

| Person | Days available | Of which coding | Declared pts | Last sprint declared → actual | The rest goes to |
|---|---|---|---|---|---|
| @songle | 10 | 9 | 11 | 12 → 9 | review |
| @boojing | 9 | 7 | 5 | 6 → 5 | mobile support |
| @shahirul | 9 | 7 | 3 | 3 → 3 | |
| @bernard | 9 | 6 | 3 | 4 → 2 | research write-up |
| **Total** | **37** | **29** | **22** | | |

**Top-down — baseline**

| | |
|---|---|
| Last 3 sprints — **roadmap** points delivered | 19 · 21 · 18 → 19 |
| Person-days normal / this sprint | 40 / 37 _(Awal Muharram 17/6)_ |
| **Baseline** (19 × 37 ÷ 40) | **18** |

| | Points |
|---|---|
| **Capacity taken** — lower of 22 and 18 | **18** |
| Carried in from Sprint N−1 | 0 |
| **Committed** | **18** |

## Main tasks

| Title | PIC | Pts | Status | Priority |
|---|---|---|---|---|
| Multi Data Source Integration — Backend | @songle | 8 | ongoing | HIGH |
| Data Poller Enhancement + CI/CD | @songle | 3 | on PR | MEDIUM |
| Automated Performance Report Research | @boojing | 3 | ongoing | MEDIUM |

**<u>Multi Data Source Integration — Backend</u>**
- [ ] Database table structure update — new env level above tenant (Environment)
  - [x] Migration script
- [ ] Backend changes
  - [x] router tenant id
  - [ ] reporting
  - [ ] data query api/function
- [ ] Data ingestion
  - [ ] Remove python poller *(breaking change)*

**<u>Data Poller Enhancement + CI/CD</u>**
- [x] Data validation
- [x] Queue traffic — do not drop jobs
- [ ] Test run
- [ ] CI/CD
  - [ ] Docker compose file update

**<u>Automated Performance Report Research</u>**
- [ ] Performance Report V2 *(prototype)*
  - [x] Auto-format
  - [ ] Word styling
  - [ ] Correlation visualization
- [ ] Rearrange workflow
- [ ] Report evaluation

## Sub tasks

| Title | PIC | Pts | Status | Priority |
|---|---|---|---|---|
| Mobile Bug Fix | @shahirul, @boojing | 3 | ongoing | MEDIUM |
| AI Agent Enhancement Research | @bernard | 3 | ongoing | MEDIUM |

**<u>Mobile Bug Fix</u>**
- [x] Milestone 2 — @boojing
- [ ] Milestone 3 — @shahirul
- [ ] Milestone 4 — @shahirul: change theme, fix charts

**<u>AI Agent Enhancement Research</u>**
- [ ] Agent skills
  - [ ] One API that returns every existing Dynatrace API, so the agent stops
        querying the wrong metrics
- [ ] Evals

## Totals

| | Points |
|---|---|
| Planned — main | 14 |
| Planned — sub | 6 |
| **Total planned** | **20** — 2 over Committed (18); taken knowingly, see below |
| **Completed** | **3** — only *Data Poller + CI/CD* closed |
| **Carried out** to Sprint N+1 | **17** |

## Unplanned work

| Task | Category | Owner | Pts | Done |
|---|---|---|---|---|
| Dynatrace Managed cert renewal | ops/support | @songle | 1 | ✅ |
| Prod deploy for the mobile hotfix | deployment | @boojing | 1 | ✅ |

## Day 5 check

- **Goal still reachable?** at risk — the migration script landed but the
  reporting and query paths had not started.
- **What changed since planning:** the Environment table needed an Alembic step
  nobody costed.
- **Anything to hand back now:** the report *evaluation* half; kept it, and it
  did not get done.

## At close

**Goal met?** partly — the structure exists and the migration runs, but nothing
reads through the new level yet, so a second provider still cannot be added.

| | Declared | Actual |
|---|---|---|
| @songle coding days | 9 | 8 |
| @boojing coding days | 7 | 5 |
| **Roadmap points delivered** | 18 | 3 |
| Non-roadmap points | — | 2 |

**Where the gap went:** not interruptions — 2 points of unplanned work is the
quietest fortnight in months. The 8-point title was one title, and it is 80%
done and worth zero. Committing 20 against a baseline of 18 was not the error;
estimating the backend split as a single all-or-nothing row was.

**Roadmap edits to make**

- [ ] Push the *Multi Data Source → Backend* phase end out by one fortnight; it
      will read overdue (V6) on 01/07 otherwise.
- [ ] Split that phase in two in the planner, matching the split below.

## Reflection

- **What surprised us:** the Alembic step; and that a near-finished 8-pointer
  reports identically to one never started.
- **What got interrupted, and by what:** almost nothing. This sprint was quiet.
- **What should be automated:** nothing new — but *deployment* has now appeared
  three sprints running at 1 pt each. Next time it shows up, script it.
- **For next planning:** no title above 5 points. The 8 was the whole story.

</details>
