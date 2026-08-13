"""Markdown blocks: split a sprint file into editable pieces, and back again.

Pure functions only: no database, no framework, no I/O. The sprint editor is a
view over `sprints/NN.md`; the file on disk stays the one record, so nothing
here parses markdown into sprint concepts and nothing here stores anything.

A **block** is one top-level markdown construct -- a heading, a paragraph, a
list, a table, a fence, a quote, a rule, or an HTML island -- carrying its own
raw source:

    index: position in the document, from 0
    type:  one of BLOCK_TYPES
    raw:   the block's markdown, with no trailing line ending
    gap:   the exact text between this block and the next (its own line ending
           plus any blank lines), so the document can be rebuilt byte for byte
    table: head/align/rows, on table blocks only

Two invariants live here specifically:

  1. **Prose is never rewritten.** ``join_blocks(split_blocks(t)) == t`` byte
     for byte: every line of the input belongs to exactly one block's `raw` or
     one block's `gap`. Each block keeps its own source, so the serialiser for
     prose is the identity function and there is no markdown -> AST -> markdown
     round trip to normalise anything. Tables are the single exception, and only
     when the grid was edited -- `serialise_table` aligns the columns it writes,
     which is the feature that motivated the editor.
  2. **This module is sprint-agnostic.** It never learns what a capacity table
     is. Any pipe table gets the same treatment, no category is validated and no
     point is counted. That is the condition the sprint-4 gate override rests
     on: an editor that knows nothing about sprint sections cannot commit the
     storage question early.

The block boundaries are found by hand rather than taken from a parser's token
stream, and that is safe because **the failure mode is benign**: a boundary in
the wrong place reveals a bigger chunk of raw text than ideal when you click it.
It cannot lose or rewrite content, because it never rewrote it in the first
place.
"""

import re

BLOCK_TYPES = (
    "heading",
    "paragraph",
    "list",
    "table",
    "code",
    "quote",
    "rule",
    "html",
)

# What separates two blocks when a caller builds a block list itself -- the
# frontend inserting a new block has no gap to preserve. Blocks that came from
# `split_blocks` carry their own.
DEFAULT_GAP = "\n\n"

# The narrowest column `serialise_table` will write, so a `---` delimiter still
# reads as one and a `:---:` has room for both markers.
MIN_COLUMN_WIDTH = 3

_BLANK = re.compile(r"^[ \t]*\r?\n?$")
_ATX = re.compile(r"^ {0,3}#{1,6}([ \t]|$)")
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_RULE = re.compile(r"^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})\r?\n?$")
_SETEXT = re.compile(r"^ {0,3}(=+|-+)[ \t]*\r?\n?$")
_BULLET = re.compile(r"^ {0,3}[-*+][ \t]")
_ORDERED = re.compile(r"^ {0,3}\d{1,9}[.)][ \t]")
_QUOTE = re.compile(r"^ {0,3}>")
_HTML_COMMENT = re.compile(r"^ {0,3}<!--")
_HTML_TAG = re.compile(r"^ {0,3}</?[A-Za-z][A-Za-z0-9-]*")
_INDENTED = re.compile(r"^([ ]{2,}|\t)")
_DELIMITER_CELL = re.compile(r"^:?-+:?$")
_UNESCAPED_PIPE = re.compile(r"(?<!\\)\|")


# --- reading the document ---------------------------------------------------


def split_blocks(text):
    """Split markdown into blocks that rebuild the input exactly.

    Boundaries only -- nothing is rendered and nothing is reformatted. Blank
    lines ride on the preceding block's `gap`; a blank run at the very start of
    the file has no preceding block, so it rides on the front of the first
    block's `raw` instead.
    """
    lines = text.splitlines(keepends=True)
    blocks = []
    prefix = ""
    index = 0
    i = 0

    while i < len(lines):
        if _is_blank(lines[i]):
            # Before the first block there is no gap to attach this to.
            prefix += lines[i]
            i += 1
            continue

        end, kind = _consume(lines, i)
        raw, gap = _split_trailing_newline("".join(lines[i:end]))
        i = end
        while i < len(lines) and _is_blank(lines[i]):
            gap += lines[i]
            i += 1

        block = {"index": index, "type": kind, "raw": prefix + raw, "gap": gap}
        table = parse_table(raw) if kind == "table" else None
        if table:
            block["table"] = table
        blocks.append(block)
        prefix = ""
        index += 1

    if prefix:
        # An all-whitespace document. Keep it rather than silently emptying it.
        blocks.append({"index": 0, "type": "paragraph", "raw": prefix, "gap": ""})
    return blocks


def join_blocks(blocks):
    """Rebuild a document from blocks, using each block's own gap."""
    return "".join(block["raw"] + block.get("gap", DEFAULT_GAP) for block in blocks)


def _consume(lines, i):
    """Find where the block starting at `i` ends, and what kind it is.

    Returns `(end, type)` with `end` exclusive. Checked in precedence order:
    a fence swallows anything inside it, and a rule is decided before a bullet
    list so `---` is not read as an empty item.
    """
    line = lines[i]

    if _FENCE.match(line):
        return _consume_fence(lines, i), "code"
    if _HTML_COMMENT.match(line):
        return _consume_until(lines, i, "-->"), "html"
    if _HTML_TAG.match(line):
        return _consume_while(lines, i + 1, lambda _: True), "html"
    if _RULE.match(line):
        return i + 1, "rule"
    if _ATX.match(line):
        return i + 1, "heading"

    table_end = _consume_table(lines, i)
    if table_end:
        return table_end, "table"

    if _QUOTE.match(line):
        return _consume_while(lines, i + 1, lambda _: True), "quote"
    if _BULLET.match(line) or _ORDERED.match(line):
        return _consume_list(lines, i), "list"
    return _consume_paragraph(lines, i)


def _consume_fence(lines, i):
    """A fenced block runs to its closing fence, or to the end of the file."""
    opening = _FENCE.match(lines[i])
    marker = opening.group(1) if opening else "```"
    closing = re.compile(r"^ {0,3}%s%s*[ \t]*\r?\n?$" % (re.escape(marker), re.escape(marker[0])))
    for j in range(i + 1, len(lines)):
        if closing.match(lines[j]):
            return j + 1
    return len(lines)


def _consume_until(lines, i, needle):
    for j in range(i, len(lines)):
        if needle in lines[j]:
            return j + 1
    return len(lines)


def _consume_while(lines, i, keep):
    """Take lines from `i` while they are non-blank and `keep` accepts them."""
    j = i
    while j < len(lines) and not _is_blank(lines[j]) and keep(lines[j]):
        j += 1
    return j


def _consume_list(lines, i):
    """A list runs on through blank lines only while indented content follows."""
    # Its own markers do not interrupt it, and neither does an unindented lazy
    # continuation line -- both are the list carrying on.
    j = _consume_while(lines, i + 1, lambda line: not _starts_other_block(line, in_list=True))
    while j < len(lines):
        blanks = j
        while blanks < len(lines) and _is_blank(lines[blanks]):
            blanks += 1
        if blanks == j or blanks >= len(lines) or not _INDENTED.match(lines[blanks]):
            break
        j = _consume_while(lines, blanks, lambda _: True)
    return j


def _consume_paragraph(lines, i):
    """A paragraph runs to a blank line, an interrupting block, or a setext rule."""
    j = i + 1
    while j < len(lines) and not _is_blank(lines[j]):
        if _SETEXT.match(lines[j]):
            # Underlined heading: it wins over a thematic break here, because a
            # `---` directly under text underlines it rather than dividing it.
            return j + 1, "heading"
        if _starts_other_block(lines[j]):
            break
        j += 1
    return j, "paragraph"


def _starts_other_block(line, in_list=False):
    """Whether this line interrupts whatever block is already open."""
    if not in_list and (_BULLET.match(line) or _ORDERED.match(line)):
        return True
    return bool(
        _ATX.match(line)
        or _FENCE.match(line)
        or _RULE.match(line)
        or _QUOTE.match(line)
        or _HTML_COMMENT.match(line)
    )


def _is_blank(line):
    return bool(_BLANK.match(line))


def _split_trailing_newline(text):
    """Split a block's text from its own line ending, which belongs to the gap."""
    for ending in ("\r\n", "\n", "\r"):
        if text.endswith(ending):
            return text[: -len(ending)], ending
    return text, ""


# --- tables ------------------------------------------------------------------


def _consume_table(lines, i):
    """End of the table starting at `i`, or None if this is not a table.

    A pipe line is only a table when a delimiter row follows it **and** matches
    it in column count, which is what GFM requires -- otherwise the row is
    ordinary text that happens to contain pipes.
    """
    if i + 1 >= len(lines) or "|" not in lines[i]:
        return None
    align = _parse_delimiter(lines[i + 1])
    if align is None or len(align) != len(_split_row(lines[i])):
        return None
    j = i + 2
    while j < len(lines) and not _is_blank(lines[j]) and "|" in lines[j]:
        j += 1
    return j


def parse_table(raw):
    """Read a table block into head, align and rows. None if it is not a table."""
    lines = raw.splitlines(keepends=True)
    if _consume_table(lines, 0) is None:
        return None
    return {
        "head": _split_row(lines[0]),
        "align": _parse_delimiter(lines[1]),
        "rows": [_split_row(line) for line in lines[2:]],
    }


def serialise_table(table):
    """Write a table back as markdown with every column padded to its widest cell.

    This is the one place the file is deliberately reformatted, and it is the
    feature: a grid edit comes back aligned rather than ragged.
    """
    head = [_escape_cell(cell) for cell in table.get("head", [])]
    rows = [[_escape_cell(cell) for cell in row] for row in table.get("rows", [])]
    align = list(table.get("align", []))

    columns = max([len(head)] + [len(row) for row in rows])
    align += [""] * (columns - len(align))
    widths = [
        max([MIN_COLUMN_WIDTH] + [len(row[column]) for row in [head] + rows if column < len(row)])
        for column in range(columns)
    ]

    lines = [_write_row(head, widths), _write_row(_write_delimiters(align, widths), widths)]
    lines += [_write_row(row, widths) for row in rows]
    return "\n".join(lines)


def _write_row(cells, widths):
    padded = [
        (cells[column] if column < len(cells) else "").ljust(widths[column])
        for column in range(len(widths))
    ]
    return "| " + " | ".join(padded) + " |"


def _write_delimiters(align, widths):
    dashes = []
    for column, width in enumerate(widths):
        marker = align[column] if column < len(align) else ""
        if marker == "left":
            dashes.append(":" + "-" * (width - 1))
        elif marker == "right":
            dashes.append("-" * (width - 1) + ":")
        elif marker == "center":
            dashes.append(":" + "-" * (width - 2) + ":")
        else:
            dashes.append("-" * width)
    return dashes


def _parse_delimiter(line):
    """The alignment of each column, or None when this is not a delimiter row."""
    if "|" not in line:
        return None
    cells = _split_row(line)
    if not cells or not all(_DELIMITER_CELL.match(cell) for cell in cells):
        return None
    align = []
    for cell in cells:
        left, right = cell.startswith(":"), cell.endswith(":")
        align.append("center" if left and right else "left" if left else "right" if right else "")
    return align


def _split_row(line):
    """Cells of one table row. Escaped pipes stay escaped and stay in the cell."""
    row = line.strip()
    if row.startswith("|"):
        row = row[1:]
    if row.endswith("|") and not row.endswith("\\|"):
        row = row[:-1]
    return [cell.strip() for cell in _UNESCAPED_PIPE.split(row)]


def _escape_cell(cell):
    """One line, with any pipe escaped exactly once."""
    return cell.replace("\\|", "|").replace("|", "\\|").replace("\r", " ").replace("\n", " ")
