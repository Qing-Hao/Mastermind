# Sprint N · YYYY-MM-DD → YYYY-MM-DD

<!--
Copy to sprints/NN.md, one per sprint. Two weeks, always — the cadence is fixed
so the only dates you enter are the sprint's own.

Nothing here writes back to the roadmap. A sprint that overruns is reported in
Reflection; phase dates in the planner are changed by hand, deliberately, or not
at all.

Fill Capacity and Planned work at planning. Fill Unplanned work as it happens.
Fill "At close" on the last day, before the retro — that section is what makes
the next sprint's planning better than this one's.
-->

**Goal:** _one sentence — what this sprint is for. Not a task list; the thing the
sprint should be judged against._

## Capacity

_Two independent numbers, the same way V1 cross-checks weeks against points:
one bottom-up from who is actually available, one top-down from what this team
has actually delivered. **Neither corrects the other.** The gap between them is
the thing worth reading._

**Bottom-up — declared**

| Person | Days available | Of which coding | Declared pts | The rest goes to |
|---|---|---|---|---|
| @you | 10 | | | |
| @them | 10 | | | |
| **Total** | | | | |

_Declared points are a **judgement**, not days × a rate. The coding-days column is
the evidence for the judgement, not a multiplier — inventing a points-per-day
constant is the guess this whole block exists to avoid._

**Top-down — baseline**

| | |
|---|---|
| Last 3 sprints — **roadmap** points delivered | a · b · c → avg |
| Person-days normal / this sprint | 20 / N  _(name the holidays and the leave)_ |
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
| Carried in from Sprint N−1 | |
| **Committed** | |

## Planned work

_From the roadmap: one block per deliverable. Points sit on the task lines only,
never on the heading, so the sprint total is a single sum._

**<u>Project — Deliverable</u>**
- [ ] 0 · task — @owner / rev @reviewer

**<u>Project — Deliverable</u>**
- [ ] 0 · task — @owner / rev @reviewer

## Unplanned work

_Everything that isn't on the roadmap — customer requests, ops, deployment, **and
your own review and management load**. It is listed here for one reason: work you
never write down is work you never automate, and work you never count is work
that silently eats the capacity you declared above._

Category is one of: `customer request` · `ops/support` · `deployment` · `infra` ·
`internal tooling` · `review` · `planning & mgmt` · `admin`. Keep to this list;
a category invented once counts for nothing when you tally the quarter.

| Task | Category | Owner | Pts | Done |
|---|---|---|---|---|
| | | | | |

## At close

_Fill this on the last day. It is the only part that teaches: you predicted, now
check. Nothing here is a score — a declared number that was wrong is information,
and the point is to find out **which way** you are reliably wrong._

| | Declared | Actual |
|---|---|---|
| @you coding days | | |
| @them coding days | | |
| **Roadmap points delivered** | | |
| Non-roadmap points | — | |

**Where the gap went:**

## Reflection

- **What surprised us:**
- **What got interrupted, and by what:**
- **What should be automated:** _the payoff for the unplanned table. Look for the
  same category showing up sprint after sprint with real points against it._

---

<!-- Reference — not part of the sprint. Delete from a copy, or leave it. -->

<details>
<summary>Filled example</summary>

# Sprint 14 · 2026-08-24 → 2026-09-04

**Goal:** Ship the v2 connector so client onboarding stops needing a manual import.

## Capacity

**Bottom-up — declared**

| Person | Days available | Of which coding | Declared pts | The rest goes to |
|---|---|---|---|---|
| @qh | 9 | 3 | 4 | planning, management, review |
| @a | 7 | 6 | 10 | review |
| **Total** | **16** | **9** | **14** | |

**Top-down — baseline**

| | |
|---|---|
| Last 3 sprints delivered | 14 · 11 · 16 → 14 |
| Person-days normal / this sprint | 20 / 16 _(Merdeka Mon 31/8; @a on leave 2d)_ |
| **Baseline** (14 × 16 ÷ 20) | **11** |

| | Points |
|---|---|
| **Capacity taken** — lower of 14 and 11 | **11** |
| Carried in from Sprint 13 | 3 |
| **Committed** | **11** |

## Planned work

**<u>Source expansion — Connector rewrite</u>**
- [x] 3 · Parse v2 payloads *(carried)* — @qh / rev @a
- [x] 2 · Backfill script — @a / rev @qh

**<u>Metrics — Dashboard v2</u>**
- [ ] 5 · Aggregation query — @qh / rev @a
- [ ] 1 · Wire the date filter — @qh / rev @a

## Unplanned work

| Task | Category | Owner | Pts | Done |
|---|---|---|---|---|
| Client X CSV import failing | customer request | @a | 2 | ✅ |
| PR review backlog, two days of it | review | @qh | 2 | ✅ |
| Prod deploy + rollback | deployment | @qh | 1 | ✅ |
| Staging disk full | ops/support | @qh | 1 | ✅ |

## At close

| | Declared | Actual |
|---|---|---|
| @qh coding days | 3 | 1.5 |
| @a coding days | 6 | 5 |
| **Roadmap points delivered** | 11 | 5 |
| Non-roadmap points | — | 6 |

**Where the gap went:** the commitment was not the problem — baseline said 11 and
11 was taken. Six points of non-roadmap work landed on top of it, four of them
mine (review + deploy), and the Metrics block never got started. Declaring 3
coding days for myself was optimistic by half.

## Reflection

- **What surprised us:** the backfill needed a schema change nobody costed.
- **What got interrupted, and by what:** two days on the CSV import for client X,
  two more on review backlog.
- **What should be automated:** third sprint running with a manual prod deploy —
  1–2 pts each time. Worth half a sprint to script it. Review load is the bigger
  number but it is not automatable; it is a reason to declare fewer coding days,
  not a reason to buy a tool.

</details>
