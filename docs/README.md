# Mastermind documentation

Product documentation for the team using Mastermind. For what the tool is and how
to start it, see the [project README](../README.md).

| Page | Read it for |
|---|---|
| [getting-started.md](getting-started.md) | Installing, and a first project from idea to date, step by step |
| [concepts.md](concepts.md) | Projects, phases, deliverables, checkpoints, dependencies, estimation, and how a project's status is derived |
| [views.md](views.md) | Map, Project, Portfolio and Sprint, screen by screen, with screenshots |
| [rules.md](rules.md) | V1–V8, the gaps at V3 and V5, and the two write-time refusals |
| [admin.md](admin.md) | Docker, the Keycloak gate, backups, export/import, and getting back in |

Two documents sit outside this folder and answer different questions:

- [PROMPT.md](../PROMPT.md) — the original brief and its amendments. What was
  asked for, and what was deliberately ruled out.
- [CLAUDE.md](../CLAUDE.md) — how to work in the repo: where code goes, what must
  not be built, and the traps worth knowing before editing.

## The one idea behind all of it

**The timeline never auto-reschedules.** Dates belong to the person planning.
Every rule reports a problem and none of them repairs one, so a plan is allowed
to sit in a warning state for as long as you like.

Only two things refuse a write, and both guard malformed data rather than a
scheduling opinion: a dependency cycle, and a sprint overlapping one already on
disk.

## Screenshots

The screenshots in [views.md](views.md) and [admin.md](admin.md) come from a
seeded demo dataset, not from a real roadmap. Re-shooting them means running the
app against a throwaway database — nothing in `docs/` is generated from the live
data file.
