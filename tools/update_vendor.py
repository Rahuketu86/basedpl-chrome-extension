#!/usr/bin/env python3
"""Regenerate vendor/{input.js,layout.json,symbols.json} from the installed `basedpl` package.

All three come from ONE installed version on purpose: the engine (input.js), the key
layout and the symbol table have to agree. Mixing versions breaks the extension -- e.g.
a newer input.js reads `hanzi` from every symbol row, so an older symbols.json makes the
engine throw at startup.

    pip install -U basedpl
    python3 tools/update_vendor.py
"""
import importlib.metadata as md
import json
from pathlib import Path

import basedpl

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
PKG = Path(basedpl.__file__).parent
# The only symbol fields the extension reads (content.js, input.js). Upstream also has
# monad_rank/dyad_ranks, which nothing here uses.
FIELDS = ("glyph", "name", "kind", "monad", "dyad", "hanzi", "shortcut")

HEADER = """\
// Vendored from AnswerDotAI/basedpl's python/basedpl/input.js (basedpl {version}), except for
// this one wrapper: the upstream file is a bare expression, meant to be concatenated into a
// larger eval'd script by python/basedpl/notebooks.py. Loaded as a plain content-script file it
// would otherwise evaluate and discard itself, so we capture the factory here.
// Regenerate with tools/update_vendor.py -- do not edit by hand.
"""

version = md.version("basedpl")
engine = (PKG / "input.js").read_text(encoding="utf-8").rstrip("\n")
(VENDOR / "input.js").write_text(
    HEADER.format(version=version) + f"self.__basedplInputFactory = {engine};\n", encoding="utf-8")

(VENDOR / "layout.json").write_text((PKG / "layout.json").read_text(encoding="utf-8"), encoding="utf-8")

rows = [{k: row[k] for k in FIELDS} for row in basedpl.symbols]
(VENDOR / "symbols.json").write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")

print(f"vendored basedpl {version}: {len(rows)} symbols -> {VENDOR}")
