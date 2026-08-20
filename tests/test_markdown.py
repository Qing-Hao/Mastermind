import glob
import os
import random

import pytest

from app.markdown import (
    MERMAID_CLASS,
    SpliceRefused,
    document_blocks,
    join_blocks,
    parse_table,
    render_block,
    serialise_table,
    splice_blocks,
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


def test_serialise_table_pads_a_cell_to_its_column_side():
    # A right-aligned column is what you write when the numbers should line up,
    # so they line up in the file too, not only on screen.
    written = serialise_table(
        {"head": ["Task", "Pts"], "align": ["", "right"], "rows": [["Ship it", "5"]]}
    )
    assert written.splitlines() == [
        "| Task    | Pts |",
        "| ------- | --: |",
        "| Ship it |   5 |",
    ]


def test_serialise_table_centres_a_centred_column():
    written = serialise_table({"head": ["Owner"], "align": ["center"], "rows": [["@qh"]]})
    assert written.splitlines()[2] == "|  @qh  |"


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


def test_serialise_table_writes_a_newline_in_a_cell_as_a_break():
    # A newline inside a pipe row *is* a new row, so a multi-line cell has to
    # reach the file as `<br>` or it splits the table. Still three lines.
    written = serialise_table({"head": ["a"], "align": [""], "rows": [["x\ny"]]})
    assert len(written.splitlines()) == 3
    assert written.splitlines()[2] == "| x<br>y |"
    assert grid(written)["rows"] == [["x<br>y"]]


def test_serialise_table_writes_one_break_for_a_crlf_cell():
    written = serialise_table({"head": ["a"], "align": [""], "rows": [["x\r\ny"]]})
    assert grid(written)["rows"] == [["x<br>y"]]


def test_serialise_table_escapes_a_pipe_and_a_newline_in_one_cell():
    written = serialise_table({"head": ["a"], "align": [""], "rows": [["x | y\nz"]]})
    assert grid(written)["rows"] == [["x \\| y<br>z"]]


def test_serialise_table_leaves_a_break_alone_on_the_way_back():
    # The cell the frontend hands back already holds `<br>` for any line it did
    # not change, so a save must not double it up into `&lt;br&gt;` or a second
    # break. This is what keeps an untouched multi-line cell byte-stable.
    once = serialise_table({"head": ["a"], "align": [""], "rows": [["x\ny"]]})
    assert serialise_table(grid(once)) == once


def test_a_ticked_cell_line_is_ordinary_text_to_this_module():
    # The grid draws `☐`/`☑` and a hand-typed `- [ ]` as checkboxes, and that is
    # entirely a frontend affair: nothing here recognises a marker, counts one or
    # rewrites one. A multi-line checklist in a cell is one cell of text.
    written = serialise_table(
        {"head": ["Steps"], "align": [""], "rows": [["☑ schema\n- [ ] backfill"]]}
    )
    assert grid(written)["rows"] == [["☑ schema<br>- [ ] backfill"]]
    assert serialise_table(grid(written)) == written


def test_inline_markup_in_a_cell_is_written_exactly_as_typed():
    # The grid draws bold, italic, code and a link in a cell; that is a frontend
    # affair and nothing here escapes, normalises or rewrites a marker. If this
    # ever fails, the grid and the file have stopped agreeing about the source.
    cell = "**bold** *it* `code` [docs](https://example.test)"
    written = serialise_table({"head": ["a"], "align": [""], "rows": [[cell]]})
    assert grid(written)["rows"] == [[cell]]


def test_a_cell_holding_a_break_survives_the_round_trip():
    # The gate, on the construct this feature writes: a `<br>` in a cell is
    # ordinary text to the splitter, so the file comes back byte for byte.
    text = "| a   | b      |\n| --- | ------ |\n| x   | y<br>z |\n"
    assert join_blocks(split_blocks(text)) == text


def test_raw_html_survives_rendering():
    # A sprint file wraps deliverable headings in <u> and hides reference
    # material in <details>, so html=True is load-bearing rather than lax. The
    # template carried both until it was replaced on 2026-08-18; the files
    # written from it still may, and this is the guarantee they rely on.
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


def test_checkboxes_are_not_disabled():
    """Ticking one rewrites the block's markdown, so it has to be pressable.

    The plugin disables them by default. Asserted rather than left to the
    configuration, because a disabled checkbox fails silently -- it looks right
    and simply does not respond.
    """
    assert "disabled" not in render_block({"raw": "- [ ] todo"})


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


# --- splicing a run of blocks -------------------------------------------------
#
# The round trip is the gate here too: replacing a block with itself must give
# the file back byte for byte, and a real splice must leave every byte outside
# the run it replaced alone.

TWO_BLOCKS = "one\n\ntwo\n"


def spliced(text, at, expect, blocks):
    """`splice_blocks`, keeping only the text. The index has its own tests."""
    return splice_blocks(text, at, expect, blocks)[0]


def refusal(text, at, expect, blocks):
    with pytest.raises(SpliceRefused) as raised:
        splice_blocks(text, at, expect, blocks)
    return raised.value


@pytest.mark.parametrize("path", CORPUS, ids=[os.path.basename(p) for p in CORPUS])
def test_replacing_any_corpus_block_with_itself_is_byte_for_byte(path):
    with open(path, encoding="utf-8", newline="") as handle:
        text = handle.read()
    for block in split_blocks(text):
        same = [{"raw": block["raw"], "gap": block["gap"]}]
        assert spliced(text, block["index"], [block["raw"]], same) == text


@pytest.mark.parametrize("text", [AWKWARD, AWKWARD.replace("\n", "\r\n")], ids=["lf", "crlf"])
def test_replacing_any_block_with_itself_survives_either_line_ending(text):
    for block in split_blocks(text):
        same = [{"raw": block["raw"], "gap": block["gap"]}]
        assert spliced(text, block["index"], [block["raw"]], same) == text


def test_replacing_a_run_with_itself_is_byte_for_byte_at_every_width():
    """Random runs, not only single blocks: nothing lost, no separator invented."""
    blocks = split_blocks(AWKWARD)
    generator = random.Random(20260820)
    for _ in range(200):
        at = generator.randrange(len(blocks))
        width = generator.randint(1, len(blocks) - at)
        run = blocks[at:at + width]
        same = [{"raw": block["raw"], "gap": block["gap"]} for block in run]
        assert spliced(AWKWARD, at, [block["raw"] for block in run], same) == AWKWARD


def test_a_splice_leaves_every_byte_outside_the_run_alone():
    text = AWKWARD
    blocks = split_blocks(text)
    target = blocks[4]
    before = join_blocks(blocks[:4])
    after = join_blocks(blocks[5:])

    result = spliced(text, 4, [target["raw"]], [{"raw": "> replaced", "gap": target["gap"]}])
    assert result == before + "> replaced" + target["gap"] + after


def test_the_run_at_at_is_used_when_it_matches():
    assert spliced(TWO_BLOCKS, 1, ["two"], [{"raw": "second"}]) == "one\n\nsecond\n"


def test_a_block_that_moved_is_still_found():
    """Someone inserted a heading above you. Your write lands on your block."""
    moved = "# Heading\n\none\n\ntwo\n"
    # `at` is 1, which is where "one" used to be -- "two" is now at 2.
    assert spliced(moved, 1, ["two"], [{"raw": "second"}]) == "# Heading\n\none\n\nsecond\n"


def test_the_index_returned_is_where_the_splice_landed():
    moved = "# Heading\n\none\n\ntwo\n"
    assert splice_blocks(moved, 1, ["two"], [{"raw": "second"}])[1] == 2
    assert splice_blocks(TWO_BLOCKS, 0, ["one"], [{"raw": "first"}])[1] == 0


def test_a_block_that_changed_is_refused():
    assert refusal(TWO_BLOCKS, 1, ["three"], [{"raw": "x"}]).reason == "gone"


def test_two_identical_blocks_are_refused_rather_than_guessed_at():
    # `at` points at neither, so there is nothing to choose between them.
    text = "- \n\nmiddle\n\n- \n"
    assert refusal(text, 1, ["- "], [{"raw": "- done"}]).reason == "ambiguous"


def test_at_chooses_between_two_identical_blocks():
    text = "- \n\nmiddle\n\n- \n"
    assert spliced(text, 2, ["- "], [{"raw": "- done"}]) == "- \n\nmiddle\n\n- done\n"


def test_an_insert_names_no_block_and_lands_at_at():
    assert spliced(TWO_BLOCKS, 1, [], [{"raw": "mid"}]) == "one\n\nmid\n\ntwo\n"


def test_an_insert_anchored_past_the_end_is_refused():
    assert refusal(TWO_BLOCKS, 9, [], [{"raw": "mid"}]).reason == "out of range"


def test_an_empty_block_list_deletes_the_run():
    assert spliced(TWO_BLOCKS, 0, ["one"], []) == "two\n"


def test_one_block_splits_into_two_and_two_merge_into_one():
    split = spliced(TWO_BLOCKS, 1, ["two"], [{"raw": "two"}, {"raw": "three"}])
    assert split == "one\n\ntwo\n\nthree\n"
    assert spliced(split, 0, ["one", "two"], [{"raw": "one two"}]) == "one two\n\nthree\n"


def test_a_replacement_that_names_no_gap_keeps_the_one_the_run_had():
    # The template writes a bold heading directly above its list, with no blank
    # line. A client that forgets the gap must not reflow that.
    text = "**Deliverable**\n- [ ] task\n\n## Next\n"
    assert spliced(text, 0, ["**Deliverable**"], [{"raw": "**Renamed**"}]) == (
        "**Renamed**\n- [ ] task\n\n## Next\n"
    )


def test_a_named_gap_wins_over_the_one_the_run_had():
    assert spliced(TWO_BLOCKS, 0, ["one"], [{"raw": "one", "gap": "\n"}]) == "one\ntwo\n"


def test_a_trailing_newline_on_raw_counts_as_naming_the_gap():
    assert spliced(TWO_BLOCKS, 0, ["one"], [{"raw": "one\n"}]) == "one\ntwo\n"


def test_appending_keeps_the_file_ending_it_had():
    # AWKWARD ends without a newline, and appending must not invent one.
    blocks = split_blocks(AWKWARD)
    result = spliced(AWKWARD, len(blocks), [], [{"raw": "Appended."}])
    assert result == AWKWARD + "\n\nAppended."


def test_deleting_the_last_block_moves_the_ending_back_one_block():
    assert spliced(TWO_BLOCKS, 1, ["two"], []) == "one\n"


def test_splicing_into_an_empty_document_starts_it():
    assert spliced("", 0, [], [{"raw": "# Sprint 1"}]) == "# Sprint 1\n\n"
