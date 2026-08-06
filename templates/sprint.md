# Sprint N · YYYY-MM-DD → YYYY-MM-DD

<!--
Copy this file per sprint. Two weeks, always — the cadence is fixed so the only
dates you enter are the sprint's own.

Nothing here writes back to the roadmap. A sprint that overruns is reported in
Reflection; phase dates in the planner are changed by hand, deliberately, or not
at all.
-->

**Goal:** _one sentence — what this sprint is for. Not a task list; the thing the
sprint should be judged against._

## Capacity

| | Points |
|---|---|
| Nominal (velocity × people) | |
| Holidays / leave | − |
| **Capacity** | |
| Carried in from Sprint N−1 | |
| **Committed** | |

_Name the holidays and the leave, don't just net them out — next quarter you will
want to know which sprints were short and why._

## Planned work

_From the roadmap: one block per deliverable. Points live on the task lines only,
never on the heading, so the sprint total is a single sum._

**<u>Project — Deliverable</u>**
- [ ] 0 · task — @owner / rev @reviewer

**<u>Project — Deliverable</u>**
- [ ] 0 · task — @owner / rev @reviewer

## Unplanned work

_Everything that isn't on the roadmap: customer requests, ops, deployment, admin.
It is listed here for one reason — work you never write down is work you never
automate._

Category is one of: `customer request` · `ops/support` · `deployment` · `infra` ·
`internal tooling` · `admin`. Keep to this list; a category invented once counts
for nothing when you tally the quarter.

| Task | Category | Owner | Pts | Done |
|---|---|---|---|---|
| | | | | |

## Reflection

- **What surprised us:**
- **What got interrupted, and by what:**
- **What should be automated:** _the payoff for the table above. Look for the same
  category showing up sprint after sprint with real points against it._

---

<!-- Reference — not part of the sprint. Delete from a copy, or leave it. -->

<details>
<summary>Filled example</summary>

# Sprint 14 · 2026-08-10 → 2026-08-21

**Goal:** Ship the v2 connector so client onboarding stops needing a manual import.

## Capacity

| | Points |
|---|---|
| Nominal (velocity × people) | 20 |
| Holidays / leave | −3 (Merdeka 31/8; A on leave 2d) |
| **Capacity** | **17** |
| Carried in from Sprint 13 | 3 |
| **Committed** | 16 |

## Planned work

**<u>Source expansion — Connector rewrite</u>**
- [x] 3 · Parse v2 payloads — @qh / rev @a
- [ ] 2 · Backfill script — @a / rev @qh

**<u>Metrics — Dashboard v2</u>**
- [ ] 5 · Aggregation query — @qh / rev @a

## Unplanned work

| Task | Category | Owner | Pts | Done |
|---|---|---|---|---|
| Client X CSV import failing | customer request | @a | 2 | ✅ |
| Prod deploy + rollback | deployment | @qh | 1 | ✅ |
| Staging disk full | ops/support | @qh | 1 | ✅ |

## Reflection

- **What surprised us:** the backfill needed a schema change nobody costed.
- **What got interrupted, and by what:** two days on the CSV import for client X.
- **What should be automated:** third sprint running with a manual prod deploy —
  1–2 pts each time. Worth a half-sprint to script it.

</details>
