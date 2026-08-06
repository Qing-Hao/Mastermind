"""Sprint review script — the pure parts, plus the agent wiring offline.

Nothing here reaches the network. The agent test runs against Pydantic AI's
``TestModel``, and skips entirely when the optional dependency is absent, so the
main suite stays green on a machine that never installed it.
"""

from pathlib import Path

import pytest

from scripts.sprint_review import (
    REVIEW_HEADING,
    AutomationCandidate,
    SprintReview,
    append_review,
    build_prompt,
    find_sprint_files,
    render_markdown,
    sprint_sort_key,
)

REVIEW = SprintReview(
    capacity_read="Baseline said 11 and you took 11. Interruption, not overcommitment.",
    estimation_signal="You declared 3 coding days and got 1.5, for the third sprint running.",
    interruption_pattern="Deploys and review, both yours.",
    automation_candidates=[
        AutomationCandidate(
            what="Prod deploy + rollback",
            category="deployment",
            sprints_seen=3,
            points_per_sprint=1.5,
            automatable=True,
            recommendation="Script it; it has cost 4 points over three sprints.",
        ),
        AutomationCandidate(
            what="PR review backlog",
            category="review",
            sprints_seen=2,
            points_per_sprint=2.0,
            automatable=False,
            recommendation="Declare two fewer coding days rather than buying a tool.",
        ),
    ],
    questions_for_next_planning=[
        "Should your declared coding days drop to 1.5?",
        "Is the Metrics block still worth carrying?",
    ],
)


def write_sprints(root: Path, names: list[str]) -> Path:
    sprint_dir = root / "sprints"
    sprint_dir.mkdir()
    for name in names:
        (sprint_dir / name).write_text(f"# {name}\n\nbody of {name}\n", encoding="utf-8")
    return sprint_dir


def test_sprint_sort_key_orders_numerically_not_lexically():
    paths = [Path("10.md"), Path("2.md"), Path("1.md")]
    assert [p.name for p in sorted(paths, key=sprint_sort_key)] == ["1.md", "2.md", "10.md"]


def test_sprint_sort_key_tolerates_names_without_numbers():
    paths = [Path("3.md"), Path("notes.md")]
    assert [p.name for p in sorted(paths, key=sprint_sort_key)] == ["notes.md", "3.md"]


def test_sprint_sort_key_reads_a_number_after_a_prefix():
    paths = [Path("sprint-12.md"), Path("sprint-3.md")]
    assert [p.name for p in sorted(paths, key=sprint_sort_key)] == [
        "sprint-3.md",
        "sprint-12.md",
    ]


def test_find_sprint_files_takes_the_most_recent_oldest_first(tmp_path):
    sprint_dir = write_sprints(tmp_path, ["1.md", "2.md", "3.md", "10.md"])
    found = find_sprint_files(sprint_dir, history=3)
    assert [p.name for p in found] == ["2.md", "3.md", "10.md"]


def test_find_sprint_files_history_zero_takes_everything(tmp_path):
    sprint_dir = write_sprints(tmp_path, ["1.md", "2.md", "3.md"])
    assert len(find_sprint_files(sprint_dir, history=0)) == 3


def test_find_sprint_files_fewer_than_asked_for_is_fine(tmp_path):
    sprint_dir = write_sprints(tmp_path, ["1.md"])
    assert [p.name for p in find_sprint_files(sprint_dir, history=3)] == ["1.md"]


def test_find_sprint_files_missing_directory_names_the_template(tmp_path):
    with pytest.raises(FileNotFoundError, match="templates/sprint.md"):
        find_sprint_files(tmp_path / "nope", history=3)


def test_find_sprint_files_empty_directory_raises(tmp_path):
    sprint_dir = tmp_path / "sprints"
    sprint_dir.mkdir()
    with pytest.raises(FileNotFoundError, match="no .md files"):
        find_sprint_files(sprint_dir, history=3)


def test_build_prompt_carries_every_file_oldest_first(tmp_path):
    sprint_dir = write_sprints(tmp_path, ["1.md", "2.md"])
    prompt = build_prompt(find_sprint_files(sprint_dir, history=2))
    # Compare the section markers, not bare filenames: the header line names the
    # newest file first, so a bare `.index("1.md")` finds that instead.
    assert prompt.index("===== 1.md =====") < prompt.index("===== 2.md =====")
    assert "body of 1.md" in prompt
    assert "body of 2.md" in prompt
    assert "2 sprint files" in prompt
    assert "most recent one (2.md)" in prompt


def test_render_markdown_tabulates_candidates_and_marks_the_unautomatable():
    block = render_markdown(REVIEW, "openai:gpt-5.2", [Path("12.md"), Path("13.md"), Path("14.md")])
    assert block.startswith(REVIEW_HEADING)
    assert "openai:gpt-5.2" in block
    assert "12.md, 13.md, 14.md" in block
    assert "| Prod deploy + rollback | deployment | 3 of 3 | 1.5 | yes |" in block
    assert "needs a human" in block
    assert "- Should your declared coding days drop to 1.5?" in block


def test_render_markdown_says_so_when_nothing_recurred():
    quiet = REVIEW.model_copy(
        update={"automation_candidates": [], "questions_for_next_planning": []}
    )
    block = render_markdown(quiet, "openai:gpt-5.2", [Path("14.md")])
    assert "_Nothing recurred across these sprints._" in block
    assert "_None raised._" in block


def test_append_review_writes_the_block(tmp_path):
    sprint = tmp_path / "14.md"
    sprint.write_text("# Sprint 14\n", encoding="utf-8")
    append_review(sprint, "## AI review\n\nbody\n", force=False)
    text = sprint.read_text(encoding="utf-8")
    assert text.startswith("# Sprint 14\n")
    assert REVIEW_HEADING in text


def test_append_review_refuses_a_second_review(tmp_path):
    sprint = tmp_path / "14.md"
    sprint.write_text("# Sprint 14\n\n## AI review\n\nold\n", encoding="utf-8")
    with pytest.raises(SystemExit, match="--force"):
        append_review(sprint, "## AI review\n\nnew\n", force=False)


def test_append_review_force_appends_anyway(tmp_path):
    sprint = tmp_path / "14.md"
    sprint.write_text("# Sprint 14\n\n## AI review\n\nold\n", encoding="utf-8")
    append_review(sprint, "## AI review\n\nnew\n", force=True)
    assert sprint.read_text(encoding="utf-8").count(REVIEW_HEADING) == 2


def test_agent_returns_a_structured_review_without_a_network_call(tmp_path):
    """The wiring holds: instructions, output_type and run_sync agree.

    TestModel fabricates a valid SprintReview from the schema, so this proves the
    output type is constructible and the agent is assembled correctly without
    spending a token or needing a key.

    The model object is passed straight to `build_agent` rather than overridden
    afterwards: constructing from a string like ``openai:gpt-5.2`` resolves the
    provider eagerly, which fails without a key before there is anything to
    override.
    """
    pytest.importorskip("pydantic_ai")
    from pydantic_ai.models.test import TestModel

    from scripts.sprint_review import build_agent

    agent = build_agent(TestModel())
    result = agent.run_sync("review these sprints")

    assert isinstance(result.output, SprintReview)
    render_markdown(result.output, "test", [tmp_path / "14.md"])
