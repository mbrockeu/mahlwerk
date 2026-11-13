"""Read a table from an .xlsx workbook or a delimited text file, row by row, without extra dependencies.

`read_rows(path)` yields every row of the first sheet as a list of strings (empty string for an empty cell), the header
row first. A workbook is read with the standard library only (zip + streaming XML), so a 100 MB sheet needs no more
memory than its shared string table. Numbers come back as the text stored in the file; the caller parses them.
"""

import codecs
import csv
import io
import posixpath
import re
import zipfile
from collections.abc import Iterator
from pathlib import Path
from xml.etree import ElementTree as ET

_MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_PACKAGE_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
_CELL_REF = re.compile(r"([A-Z]+)")
DELIMITERS = ",;\t|"


class TableError(Exception):
    """The file is not a readable table."""


def read_rows(path: str) -> Iterator[list[str]]:
    if zipfile.is_zipfile(path):
        return _xlsx_rows(path)
    return _text_rows(path)


# xlsx


def _column(ref: str) -> int:
    """'AB12' -> 27 (zero based column index)."""
    match = _CELL_REF.match(ref or "")
    if not match:
        raise TableError(f"bad cell reference {ref!r}")
    index = 0
    for letter in match.group(1):
        index = index * 26 + ord(letter) - 64
    return index - 1


def _text(element: ET.Element) -> str:
    """Text of a shared or inline string: plain `t`, or the runs `r/t` of rich text (phonetic hints are skipped)."""
    parts = []
    for child in element:
        if child.tag == f"{_MAIN}t":
            parts.append(child.text or "")
        elif child.tag == f"{_MAIN}r":
            parts.extend(t.text or "" for t in child if t.tag == f"{_MAIN}t")
    return "".join(parts)


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    strings = []
    with archive.open("xl/sharedStrings.xml") as handle:
        for _, element in ET.iterparse(handle):
            if element.tag == f"{_MAIN}si":
                strings.append(_text(element))
                element.clear()
    return strings


def _first_sheet(archive: zipfile.ZipFile) -> str:
    names = archive.namelist()
    try:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relations = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        sheet = next(workbook.iter(f"{_MAIN}sheet"))
        target = next(
            r.get("Target") for r in relations.iter(f"{_PACKAGE_REL}Relationship") if r.get("Id") == sheet.get(f"{_REL}id")
        )
        path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
        if path in names:
            return path
    except (KeyError, StopIteration, ET.ParseError):
        pass
    sheets = sorted(n for n in names if n.startswith("xl/worksheets/") and n.endswith(".xml"))
    if not sheets:
        raise TableError("the workbook has no sheet")
    return sheets[0]


def _xlsx_rows(path: str) -> Iterator[list[str]]:
    try:
        archive = zipfile.ZipFile(path)
    except zipfile.BadZipFile as exc:
        raise TableError(f"not a readable workbook: {exc}") from exc
    with archive:
        strings = _shared_strings(archive)
        with archive.open(_first_sheet(archive)) as handle:
            try:
                for _, element in ET.iterparse(handle):
                    if element.tag != f"{_MAIN}row":
                        continue
                    cells: dict[int, str] = {}
                    next_column = 0
                    for cell in element.iter(f"{_MAIN}c"):
                        column = _column(cell.get("r")) if cell.get("r") else next_column
                        next_column = column + 1
                        kind = cell.get("t")
                        value = cell.find(f"{_MAIN}v")
                        if kind == "inlineStr":
                            inline = cell.find(f"{_MAIN}is")
                            text = _text(inline) if inline is not None else ""
                        elif value is None or value.text is None:
                            continue
                        elif kind == "s":
                            index = int(value.text)
                            text = strings[index] if 0 <= index < len(strings) else ""
                        elif kind == "b":
                            text = "1" if value.text.strip() == "1" else "0"
                        else:  # number, formula result or error text
                            text = value.text
                        cells[column] = text
                    element.clear()
                    yield [cells.get(i, "") for i in range(max(cells) + 1)] if cells else []
            except ET.ParseError as exc:
                raise TableError(f"the sheet is not readable: {exc}") from exc


# delimited text


def _decode(path: str) -> str:
    raw = Path(path).read_bytes()  # such files are a few MB
    if raw.startswith(codecs.BOM_UTF8):
        raw = raw[len(codecs.BOM_UTF8):]
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")  # what Excel writes as "CSV" on Windows


def _text_rows(path: str) -> Iterator[list[str]]:
    text = _decode(path)
    first = text.split("\n", 1)[0]
    delimiter = max(DELIMITERS, key=first.count)
    if first.count(delimiter) == 0:
        raise TableError("no delimiter found in the first line (expected one of , ; tab |)")
    csv.field_size_limit(1 << 24)
    yield from csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
