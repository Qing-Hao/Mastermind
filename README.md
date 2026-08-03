# Roadmap Planner

Lightweight internal tool for planning software delivery from roadmap to phases.
Single user, runs on localhost, all data in one SQLite file.

Scope and rules are specified in [PROMPT.md](PROMPT.md). Sprint generation and
capacity forecasting are deliberately **not** built yet (Phase 2).

## Run

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

Then open <http://127.0.0.1:8000>.

## Test

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

## Data

Everything lives in `data/roadmap.db` (gitignored). To back up, copy that file,
or use **Export JSON** in the header. **Import JSON** replaces the entire dataset.

## Layout

| Path | Purpose |
|------|---------|
| `app/validation.py` | Rules V1–V4. Pure functions, no I/O. The heart of the tool. |
| `app/db.py` | SQLite schema and CRUD. Rows in and out as plain dicts. |
| `app/main.py` | FastAPI routes. Thin — no business logic. |
| `app/static/` | Vanilla JS frontend, no build step. |
| `tests/` | `test_validation.py` (rules), `test_api.py` (acceptance criteria). |

## Scheduling behaviour

The timeline **never auto-reschedules**. Dates are always the user's to set.
Dependencies produce warnings, not movement, and a plan may sit in a warning
state indefinitely.

The one exception is a dependency **cycle**: that is malformed data rather than
a scheduling opinion, so the API rejects the edit with `409` and writes nothing.

## Estimation

Duration (weeks) and effort (points) are entered independently. The tool
cross-checks them rather than deriving one from the other:

```
implied_weeks = (effort_points / velocity) * (sprint_length_days / 7)
```

Velocity is the project's `velocity_override` if set, otherwise the global
setting. V1 warns when entered duration and implied duration disagree by more
than `v1_tolerance_pct` (default 5%).
