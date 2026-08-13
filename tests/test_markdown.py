import glob
import os

import pytest

from app.markdown import (
    MERMAID_CLASS,
    document_blocks,
    join_blocks,
    parse_table,
    render_block,
    serialise_table,
    split_blocks,
)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The committed template plus whatever real sprint files are on disk. `sprints/`
# is gitignored, so a fresh clone has none and this collapses to the template --
# which is why the awkward syntax below is in a fixture of its own as well.
# Read-only: no test here writes into either directory.
CORPUS = [os.path.join(REPO_ROOT, "templates", "sprint.md")]
CORPUS += sorted(glob.glob(os.path.join(REPO_ROOT, "sprints", "*.md")))

# Every construct the sprint template and its filled example between them use,
# plus the ones that break a naive splitter: a fence containing both a rule and
# a pipe row, a `---` that is really a setext underline, and an HTML island.
AWKWARD = """Underlined heading
==================

A paragraph that runs
over two lines.
- [ ] a task list interrupting it with no blank line
- [x] and its second item

- top
  - nested
    - deeper

    still the same list, after a blank line
- second top-level item

> quoted
> over two lines

```text
---
| not | a | table |
```

<!-- a comment
spanning lines -->

<details>
<summary>Reference</summary>

Inner paragraph, parsed as markdown in its own right.

</details>

| Cell | With a pipe |
|---|---:|
| x \\| y | z |

---

Trailing paragraph, no newline at the end of the file."""


def grid(raw):
    """`parse_table`, asserting it found one. Keeps the tests below subscriptable."""
    table = parse_table(raw)
    assert table is not None
    return table


@pytest.mark.parametrize("path", CORPUS, ids=[os.path.basename(p) for p in CORPUS])
def test_corpus_round_trips_byte_for_byte(path):
    with open(path, encoding="utf-8", newline="") as handle:
        text = handle.read()
    assert join_blocks(split_blocks(text)) == text


def test_awkward_fixture_round_trips_byte_for_byte():
    assert join_blocks(split_blocks(AWKWARD)) == AWKWARD


def test_crlf_line_endings_survive():
    text = AWKWARD.replace("\n", "\r\n")
    assert join_blocks(split_blocks(text)) == text


def test_empty_document_has_no_blocks():
    assert split_blocks("") == []
    assert join_blocks([]) == ""


def test_whitespace_only_document_is_kept():
    assert join_blocks(split_blocks("\n\n")) == "\n\n"


def test_leading_blank_lines_ride_on_the_first_block():
    blocks = split_blocks("\n\n# Heading\n")
    assert len(blocks) == 1
    assert blocks[0]["raw"] == "\n\n# Heading"


def test_gap_records_a_missing_blank_line():
    # The template writes a bold deliverable heading directly above its task
    # list. Joining blocks with a blank line would insert one here.
    blocks = split_blocks("**Deliverable**\n- [ ] task\n\n## Next\n")
    assert [block["type"] for block in blocks] == ["paragraph", "list", "heading"]
    assert [block["gap"] for block in blocks] == ["\n", "\n\n", "\n"]


def test_block_types_and_order_of_the_awkward_fixture():
    types = [block["type"] for block in split_blocks(AWKWARD)]
    assert types == [
        "heading",  # setext, not a paragraph followed by a rule
        "paragraph",
        "list",  # the task list that interrupted it
        "list",  # nested, carried on across a blank line by its indent
        "quote",
        "code",
        "html",  # the comment
        "html",  # <details> + <summary>
        "paragraph",  # inner content still parses as markdown
        "html",  # </details>
        "table",
        "rule",
        "paragraph",
    ]


def test_index_counts_from_zero_in_document_order():
    blocks = split_blocks(AWKWARD)
    assert [block["index"] for block in blocks] == list(range(len(blocks)))


def test_fence_swallows_rules_and_pipe_rows():
    blocks = split_blocks("```text\n---\n| not | a | table |\n```\n")
    assert len(blocks) == 1
    assert blocks[0]["type"] == "code"
    assert "| not | a | table |" in blocks[0]["raw"]


def test_unclosed_fence_runs_to_the_end_of_the_file():
    blocks = split_blocks("```\nstill open\n")
    assert [block["type"] for block in blocks] == ["code"]


def test_rule_is_a_rule_when_it_does_not_underline_anything():
    blocks = split_blocks("A paragraph.\n\n---\n\nAnother.\n")
    assert [block["type"] for block in blocks] == ["paragraph", "rule", "paragraph"]


def test_table_needs_a_delimiter_row():
    blocks = split_blocks("| a | b |\n| c | d |\n")
    assert [block["type"] for block in blocks] == ["paragraph"]


def test_table_needs_the_delimiter_to_match_the_header_width():
    # GFM's rule, and worth keeping: a mismatched row means the pipes are text.
    blocks = split_blocks("| a | b |\n|---|---|---|\n| c | d |\n")
    assert [block["type"] for block in blocks] == ["paragraph"]


def test_a_block_with_no_table_has_no_table_key():
    for block in split_blocks("# Heading\n\nA paragraph with a | pipe in it.\n"):
        assert "table" not in block


def test_table_block_carries_its_grid():
    block = split_blocks("| a | b |\n|---|---:|\n| c | d |\n")[0]
    assert block["type"] == "table"
    assert block["table"] == {
        "head": ["a", "b"],
        "align": ["", "right"],
        "rows": [["c", "d"]],
    }


def test_empty_header_cells_still_make_a_table():
    # The template's baseline table has a headerless first row.
    block = split_blocks("| | |\n|---|---|\n| Baseline | 20 |\n")[0]
    assert block["type"] == "table"
    assert block["table"]["head"] == ["", ""]


def test_parse_table_returns_none_for_prose():
    assert parse_table("Just a paragraph.") is None


def test_parse_table_keeps_an_escaped_pipe_inside_the_cell():
    assert grid("| a | b |\n|---|---|\n| x \\| y | z |")["rows"] == [["x \\| y", "z"]]


def test_serialise_table_pads_a_ragged_grid():
    written = serialise_table(
        {
            "head": ["Person", "Days"],
            "align": ["", ""],
            "rows": [["@qh", "10"], ["**Total**", "20"]],
        }
    )
    assert written == (
        "| Person    | Days |\n"
        "| --------- | ---- |\n"
        "| @qh       | 10   |\n"
        "| **Total** | 20   |"
    )


def test_serialise_table_is_idempotent():
    once = serialise_table(grid("| a | bbbbb |\n|---|---|\n| cc | d |"))
    assert serialise_table(grid(once)) == once


def test_alignment_markers_survive_a_parse_and_serialise_cycle():
    raw = "| a | b | c | d |\n|:---|---:|:---:|---|\n| 1 | 2 | 3 | 4 |"
    assert grid(serialise_table(grid(raw)))["align"] == ["left", "right", "center", ""]


def test_serialise_table_writes_columns_at_least_three_wide():
    written = serialise_table({"head": ["", ""], "align": ["", ""], "rows": [["a", "b"]]})
    assert written.splitlines()[1] == "| --- | --- |"


def test_serialise_table_escapes_a_pipe_typed_into_a_cell():
    # A grid edit can put a bare pipe in a cell; writing it unescaped would
    # split the cell in two the next time the file is read.
    written = serialise_table({"head": ["a"], "align": [""], "rows": [["x | y"]]})
    assert "x \\| y" in written
    assert grid(written)["rows"] == [["x \\| y"]]


def test_serialise_table_grows_to_its_widest_row():
    written = serialise_table({"head": ["a"], "align": [""], "rows": [["b", "c"]]})
    assert written.splitlines()[0] == "| a   |     |"
    assert grid(written)["rows"] == [["b", "c"]]


def test_serialise_table_flattens_a_newline_pasted_into_a_cell():
    written = serialise_table({"head": ["a"], "align": [""], "rows": [["x\ny"]]})
    assert len(written.splitlines()) == 3


def test_raw_html_survives_rendering():
    # The template wraps deliverable headings in <u> and hides its worked
    # example in <details>, so html=True is load-bearing rather than lax.
    assert "<u>Project</u>" in render_block({"raw": "**<u>Project</u>**"})
    assert render_block({"raw": "<details>\n<summary>Filled example</summary>"}).startswith(
        "<details>"
    )


def test_gfm_tables_and_strikethrough_render():
    html = render_block({"raw": "| a | b |\n|---|---:|\n| c | d |"})
    assert "<table>" in html
    assert 'style="text-align:right"' in html
    assert "<s>gone</s>" in render_block({"raw": "~~gone~~"})


def test_task_list_renders_as_checkboxes():
    html = render_block({"raw": "- [ ] todo\n- [x] done"})
    assert html.count("<input") == 2
    assert 'checked="checked"' in html


def test_mermaid_fence_is_marked_and_its_source_preserved():
    html = render_block({"raw": "```mermaid\ngraph TD\n  a-->b\n```"})
    assert f'class="{MERMAID_CLASS}"' in html
    assert "graph TD" in html
    # Drawing it is the frontend's job -- nothing here emits SVG.
    assert "<svg" not in html


def test_other_fences_render_normally():
    html = render_block({"raw": "```text\nhello\n```"})
    assert MERMAID_CLASS not in html
    assert "language-text" in html


def test_rendering_never_mutates_raw():
    block = {"raw": "| a | b |\n|---|---|\n| c | d |"}
    before = block["raw"]
    render_block(block)
    assert block["raw"] == before


def test_document_blocks_attaches_html_to_every_block():
    blocks = document_blocks(AWKWARD)
    assert all(block["html"] for block in blocks)
    assert join_blocks(blocks) == AWKWARD


@pytest.mark.parametrize("path", CORPUS, ids=[os.path.basename(p) for p in CORPUS])
def test_every_block_in_the_corpus_renders(path):
    with open(path, encoding="utf-8", newline="") as handle:
        blocks = document_blocks(handle.read())
    for block in blocks:
        assert block["html"], f'{block["type"]} block {block["index"]} rendered to nothing'


def test_join_blocks_falls_back_to_a_blank_line_for_a_new_block():
    # The frontend inserts a block that never came from a file, so it has no gap.
    assert join_blocks([{"type": "paragraph", "raw": "one"}, {"type": "paragraph", "raw": "two"}]) == (
        "one\n\ntwo\n\n"
    )
