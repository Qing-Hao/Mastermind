"""Read the last few sprint files and ask a model what they say.

Sprints live as markdown in ``sprints/``, one file per sprint (``14.md``). This
reads the most recent few, hands them to a Pydantic AI agent and prints a
structured review: how the capacity call went, which estimates were off, what
keeps interrupting, and what is worth automating.

    .\\.venv\\Scripts\\python.exe scripts\\sprint_review.py
    .\\.venv\\Scripts\\python.exe scripts\\sprint_review.py --history 5 --write

**History is the point.** One sprint with a manual deploy in it is noise; four
is a pattern, and a pattern is the only thing worth automating. The default
window is three sprints because that is also the window the template's baseline
row averages over.

Needs ``requirements-ai.txt`` installed and the provider's key in the
environment (``OPENAI_API_KEY`` for the default model). The key is read from the
environment and nowhere else — never the database, which ``/api/export`` writes
wholesale to a JSON file that would carry it straight back out.

Set ``SPRINT_MODEL`` to change model or provider; Pydantic AI takes the provider
as a string prefix, so ``anthropic:claude-sonnet-4-6`` or
``google:gemini-3-pro-preview`` is a config change rather than a code change.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

DEFAULT_MODEL = "openai:gpt-5.2"
DEFAULT_SPRINT_DIR = "sprints"
DEFAULT_HISTORY = 3

REVIEW_HEADING = "## AI review"

INSTRUCTIONS = """\
You are reviewing completed sprints for the technical lead of a very small
software team — two or three people who also carry customer support, operations
and deployment themselves. The lead is deliberately learning to plan sprints
better, and is not an expert. Your job is to make the next planning session
better than the last one.

The sprint files follow a fixed template:

- Capacity holds two independent estimates. "Declared" is bottom-up, per person,
  a judgement rather than a calculation. "Baseline" is top-down: the average of
  the last three sprints' delivered points, scaled by available person-days.
  Neither corrects the other. The gap between them is deliberate and is the most
  informative thing in the file.
- Planned work is roadmap work, one block per deliverable, points on the task
  lines only.
- Unplanned work is everything else, each row carrying a category. This includes
  the lead's own review and management load, which is intentional — it consumes
  declared capacity and is usually the reason a sprint underdelivers.
- "At close" reconciles declared against actual.

How to read them:

- Distinguish **overcommitting** (capacity taken was above baseline, or planned
  points exceeded capacity) from **being interrupted** (commitment was sound,
  unplanned work landed on top). These have opposite remedies and conflating
  them is the most common mistake. Say which one happened.
- Judge the declared-vs-actual coding days per person. A lead who declares three
  coding days and gets one and a half every single sprint should be declaring
  one and a half.
- For automation candidates, only count what actually recurs across the files
  you were given. Say how many of them you saw it in. Distinguish work that is
  genuinely automatable (deploys, backups, report generation) from work that
  merely recurs (code review, management) — the remedy for the second is
  declaring less capacity, not buying a tool. Do not recommend automating
  something that appeared once.

Rules:

- Use only what is in the files. Never invent a number, a task or a sprint. If
  a section is blank or a file is missing "At close", say so plainly and reason
  from what is there.
- Quote real figures and real task names when you make a point. "You lost 6
  points to non-roadmap work, 4 of them yours" beats "there were interruptions".
- If there is too little history for a claim, say that instead of stretching.
- Address the lead as "you". Be direct and concrete. No praise sandwiches, no
  generic agile advice that would be true of any team.
"""


class AutomationCandidate(BaseModel):
    """Recurring non-roadmap work that might be worth removing."""

    what: str = Field(description="The recurring work, named as the sprint files name it.")
    category: str = Field(description="Its category from the sprint files.")
    sprints_seen: int = Field(description="How many of the supplied sprints it appears in.")
    points_per_sprint: float = Field(description="Typical points it costs per sprint.")
    automatable: bool = Field(
        description="True if tooling could remove it; False if it recurs but needs a "
        "human (review, management), where the remedy is declaring less capacity."
    )
    recommendation: str = Field(description="What to actually do, in one or two sentences.")


class SprintReview(BaseModel):
    """The structured read of one or more sprints."""

    capacity_read: str = Field(
        description="Did the commitment hold? Name whether this was overcommitment "
        "or interruption, and give the numbers behind the call."
    )
    estimation_signal: str = Field(
        description="Which estimates were wrong and in which direction, including "
        "declared vs actual coding days per person."
    )
    interruption_pattern: str = Field(
        description="What keeps arriving unplanned, and who absorbs it."
    )
    automation_candidates: list[AutomationCandidate] = Field(
        default_factory=list,
        description="Only work that recurs across the supplied sprints. Empty if none does.",
    )
    questions_for_next_planning: list[str] = Field(
        default_factory=list,
        description="Two to four specific questions to put on the table at the next "
        "planning session. Specific to these sprints, not generic agile prompts.",
    )


def sprint_sort_key(path: Path) -> tuple[int, str]:
    """Order sprint files by their leading number, falling back to name.

    ``2.md`` must sort before ``10.md``, which a plain name sort gets wrong.
    Files with no leading digits sort first and keep their relative order.
    """
    match = re.match(r"\D*(\d+)", path.stem)
    return (int(match.group(1)) if match else -1, path.stem)


def find_sprint_files(sprint_dir: Path, history: int) -> list[Path]:
    """The most recent `history` sprint files, oldest first."""
    if not sprint_dir.is_dir():
        raise FileNotFoundError(
            f"No sprint directory at {sprint_dir}. Copy templates/sprint.md to "
            f"{sprint_dir}/01.md and fill it in."
        )
    files = sorted(sprint_dir.glob("*.md"), key=sprint_sort_key)
    if not files:
        raise FileNotFoundError(
            f"{sprint_dir} holds no .md files. Copy templates/sprint.md into it."
        )
    return files[-history:] if history > 0 else files


def build_prompt(files: list[Path]) -> str:
    """Concatenate the sprint files, oldest first, each under its filename."""
    parts = [
        f"There are {len(files)} sprint files below, oldest first. "
        f"Review the most recent one ({files[-1].name}) in the light of the others.\n"
    ]
    for path in files:
        parts.append(f"\n===== {path.name} =====\n{path.read_text(encoding='utf-8')}")
    return "\n".join(parts)


def render_markdown(review: SprintReview, model: str, files: list[Path]) -> str:
    """Format a review as the markdown block appended to a sprint file."""
    covering = ", ".join(path.name for path in files)
    lines = [
        REVIEW_HEADING,
        "",
        f"_Generated by `{model}` over {covering}. Machine-written — argue with it._",
        "",
        "**Capacity read**",
        "",
        review.capacity_read,
        "",
        "**Estimation signal**",
        "",
        review.estimation_signal,
        "",
        "**Interruption pattern**",
        "",
        review.interruption_pattern,
        "",
        "**Automation candidates**",
        "",
    ]

    if review.automation_candidates:
        lines += [
            "| What | Category | Seen in | Pts/sprint | Automatable | Do |",
            "|---|---|---|---|---|---|",
        ]
        for candidate in review.automation_candidates:
            lines.append(
                f"| {candidate.what} | {candidate.category} | "
                f"{candidate.sprints_seen} of {len(files)} | "
                f"{candidate.points_per_sprint:g} | "
                f"{'yes' if candidate.automatable else 'needs a human'} | "
                f"{candidate.recommendation} |"
            )
    else:
        lines.append("_Nothing recurred across these sprints._")

    lines += ["", "**Questions for next planning**", ""]
    if review.questions_for_next_planning:
        lines += [f"- {question}" for question in review.questions_for_next_planning]
    else:
        lines.append("_None raised._")

    return "\n".join(lines) + "\n"


def build_agent(model: Any):
    """Construct the review agent. Imports Pydantic AI lazily.

    `model` is a model string, or a model object — tests pass ``TestModel()``
    here, because constructing from a string resolves the provider eagerly and
    so needs a real key.

    The import is kept out of module scope so the pure helpers above stay
    testable without the optional dependency, and so both failure modes — no
    package, no key — report themselves in one clear sentence instead of a
    traceback out of somebody else's library.
    """
    try:
        from pydantic_ai import Agent
        from pydantic_ai.exceptions import UserError
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise SystemExit(
            "pydantic-ai is not installed. It is an optional dependency:\n"
            "  .\\.venv\\Scripts\\python.exe -m pip install -r requirements-ai.txt"
        ) from exc

    try:
        return Agent(
            model,
            name="sprint_review_agent",
            output_type=SprintReview,
            instructions=INSTRUCTIONS,
        )
    except UserError as exc:  # pragma: no cover - depends on the environment
        raise SystemExit(
            f"{exc}\n\n"
            "The key is read from the environment and nowhere else. In PowerShell:\n"
            '  $env:OPENAI_API_KEY = "sk-..."'
        ) from exc


def append_review(path: Path, block: str, force: bool) -> None:
    """Append a review to a sprint file, refusing to write a second one."""
    existing = path.read_text(encoding="utf-8")
    if REVIEW_HEADING in existing and not force:
        raise SystemExit(
            f"{path.name} already holds an {REVIEW_HEADING!r} section. "
            f"Delete it first, or pass --force to append another."
        )
    separator = "" if existing.endswith("\n\n") else "\n" if existing.endswith("\n") else "\n\n"
    path.write_text(existing + separator + "\n" + block, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Review recent sprints with a language model.",
    )
    parser.add_argument(
        "--dir",
        type=Path,
        default=Path(DEFAULT_SPRINT_DIR),
        help=f"Directory of sprint markdown files (default: {DEFAULT_SPRINT_DIR}/)",
    )
    parser.add_argument(
        "--history",
        type=int,
        default=DEFAULT_HISTORY,
        help=f"How many recent sprints to read, 0 for all (default: {DEFAULT_HISTORY})",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("SPRINT_MODEL", DEFAULT_MODEL),
        help=f"Pydantic AI model string (default: $SPRINT_MODEL or {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Append the review to the newest sprint file instead of only printing it",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="With --write, append even if the file already holds a review",
    )
    args = parser.parse_args(argv)

    try:
        files = find_sprint_files(args.dir, args.history)
    except FileNotFoundError as exc:
        print(exc, file=sys.stderr)
        return 1

    print(f"Reading {', '.join(path.name for path in files)} with {args.model}…", file=sys.stderr)

    agent = build_agent(args.model)
    result = agent.run_sync(build_prompt(files))
    block = render_markdown(result.output, args.model, files)

    print(block)

    if args.write:
        append_review(files[-1], block, args.force)
        print(f"Appended to {files[-1]}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
