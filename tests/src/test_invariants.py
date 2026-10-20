# tests/src/test_invariants.py — module-local red lines for src (debate host).
# Each rule mirrors a vitest behavior file in tests/vitest/ but binds on its own
# terms: what breaks in Python is that the red line was edited in TOML without a
# bound guard, or the documented TS surface drifted. Anti-hollow: real asserts,
# no bare pass/docstring-only.

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
VITEST_DIR = ROOT / "tests" / "vitest"
SRC_INDEX = ROOT / "src" / "index.ts"
MANIFEST = ROOT / "dsh.plugin.json"


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def test_src_single_thread_seam_exists():
    """Single-thread fork seam (ADR-0024): create/step/sweep present in host."""
    src = _read(SRC_INDEX)
    for symbol in (
        "createSingleThread",
        "stepOpenSingle",
        "stepRoundSingle",
        "sweepSingleThread",
        "singleError",
    ):
        assert symbol in src, f"src/index.ts missing single-thread seam symbol: {symbol}"


def test_src_debater_tool_allowlist_is_closed():
    """Tool cage (ADR-0022): debater allowlist is exactly the six read-only tools."""
    src = _read(SRC_INDEX)
    m = re.search(r"export const DEBATER_TOOL_ALLOW = \[([^\]]+)\]", src)
    assert m, "DEBATER_TOOL_ALLOW literal not found in src/index.ts"
    tools = sorted(t.strip().strip("'\"") for t in m.group(1).split(",") if t.strip())
    assert tools == ["glob", "grep", "read", "read_image", "web_fetch", "web_search"], (
        f"debater allowlist drifted: {tools}"
    )


def test_src_synth_tool_allowlist_is_closed():
    """Tool cage (ADR-0022): synthesizer allowlist is exactly the three read tools."""
    src = _read(SRC_INDEX)
    m = re.search(r"export const SYNTH_TOOL_ALLOW = \[([^\]]+)\]", src)
    assert m, "SYNTH_TOOL_ALLOW literal not found in src/index.ts"
    tools = sorted(t.strip().strip("'\"") for t in m.group(1).split(",") if t.strip())
    assert tools == ["glob", "read", "read_image"], f"synth allowlist drifted: {tools}"


def test_src_registered_tools_match_manifest():
    """Tool registration matches dsh.plugin.json contributes.tools exactly."""
    import json

    src = _read(SRC_INDEX)
    registered = sorted(set(re.findall(r"name: '(debate_[a-z_]*|task_[a-z_]*)'", src)))
    manifest = sorted(json.loads(_read(MANIFEST))["contributes"]["tools"])
    assert registered == manifest, f"registered {registered} != manifest {manifest}"


def test_src_task_routes_are_seven():
    """Task wiring (ADR-0025): exactly seven /api/task/* routes registered."""
    src = _read(SRC_INDEX)
    routes = sorted(set(re.findall(r"path: '/dsh-debate/api/(task/[a-z]+)'", src)))
    assert routes == [
        "task/build",
        "task/collect",
        "task/launch",
        "task/report",
        "task/scan",
        "task/stop",
        "task/version",
    ], f"task routes drifted: {routes}"
