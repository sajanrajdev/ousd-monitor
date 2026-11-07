"""SQL against the raw store lives in store.py, behind named methods, so every query the pipeline
runs on it is in one place. Ruff has no rule for this, so the source is scanned here."""

import ast
from pathlib import Path

PIPELINE = Path(__file__).resolve().parent.parent / "pipeline"
# The store itself, and migrations, which run DDL on a connection before any Store exists.
ALLOWED = {PIPELINE / "ousd" / "store.py", PIPELINE / "ousd" / "migrations.py"}
QUERIES = {"execute", "executemany", "sql", "query"}


def query_lines(source: str) -> list[int]:
    """The line of each `<anything>.db.<query>(...)` call. A connection taken into a variable of
    its own first is not seen, so the store's connection is never handed out that way."""
    return [
        node.lineno
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in QUERIES
        and isinstance(node.func.value, ast.Attribute)
        and node.func.value.attr == "db"
    ]


def direct_queries(path: Path) -> list[str]:
    """Each such call, as `file:line`."""
    return [f"{path.relative_to(PIPELINE)}:{line}" for line in query_lines(path.read_text())]


def test_no_module_but_the_store_queries_the_store_directly():
    sources = sorted(PIPELINE.rglob("*.py"))
    assert sources
    found = [hit for path in sources if path not in ALLOWED for hit in direct_queries(path)]
    assert found == [], "move these queries into a named Store method"


def test_the_scan_sees_the_stores_own_queries():
    # So a change to how the store is reached can't leave the scan above finding nothing.
    assert direct_queries(PIPELINE / "ousd" / "store.py")


def test_the_scan_finds_each_kind_of_query():
    source = "\n".join(f"store.db.{query}('SELECT 1')" for query in sorted(QUERIES))
    assert query_lines(source) == list(range(1, len(QUERIES) + 1))
    assert query_lines("store.newest_samples(run_id, chain)\nmarts.execute('SELECT 1')") == []
