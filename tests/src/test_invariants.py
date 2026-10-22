# tests/src/test_invariants.py — module-local red lines for src (host wiring).
# Binds the host seam: single-thread fork symbols, tool cage allowlists,
# route/tool registration. Pure-logic guards moved to tests/src/debate/
# (S22 symmetry: debate/ vs task/ are peers). Anti-hollow: real asserts.

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
VITEST_DIR = ROOT / "tests" / "vitest"
SRC_INDEX = ROOT / "src" / "index.ts"
HOST_CAGE = ROOT / "src" / "host" / "cage.ts"
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
    """Tool cage (ADR-0022): debater allowlist is exactly the six read-only tools (S27: lives in host/cage.ts)."""
    cage = _read(HOST_CAGE)
    m = re.search(r"export const DEBATER_TOOL_ALLOW = \[([^\]]+)\]", cage)
    assert m, "DEBATER_TOOL_ALLOW literal not found in src/host/cage.ts"
    tools = sorted(t.strip().strip("'\"") for t in m.group(1).split(",") if t.strip())
    assert tools == ["glob", "grep", "read", "read_image", "web_fetch", "web_search"], (
        f"debater allowlist drifted: {tools}"
    )


def test_src_synth_tool_allowlist_is_closed():
    """Tool cage (ADR-0022): synthesizer allowlist is exactly the three read tools (S27: lives in host/cage.ts)."""
    cage = _read(HOST_CAGE)
    m = re.search(r"export const SYNTH_TOOL_ALLOW = \[([^\]]+)\]", cage)
    assert m, "SYNTH_TOOL_ALLOW literal not found in src/host/cage.ts"
    tools = sorted(t.strip().strip("'\"") for t in m.group(1).split(",") if t.strip())
    assert tools == ["glob", "read", "read_image"], f"synth allowlist drifted: {tools}"


def test_src_registered_tools_match_manifest():
    """No model tools: host exposes zero tools.register; manifest contributes.tools is empty."""
    import json

    src = _read(SRC_INDEX)
    assert "tools.register" not in src, "src/index.ts must not register model tools (human-operated plugin)"
    manifest = sorted(json.loads(_read(MANIFEST))["contributes"]["tools"])
    assert manifest == [], f"manifest contributes.tools must be empty, got {manifest}"


def test_src_task_routes_are_eight():
    """Task wiring (ADR-0025 + ADR-0028 recommend): eight /api/task/* routes registered."""
    src = _read(SRC_INDEX)
    routes = sorted(set(re.findall(r"path: '/dsh-session-enhance/api/(task/[a-z]+)'", src)))
    assert routes == [
        "task/build",
        "task/collect",
        "task/launch",
        "task/recommend",
        "task/report",
        "task/scan",
        "task/stop",
        "task/version",
    ], f"task routes drifted: {routes}"


def test_src_peer_symmetry():
    """S22/S27: debate/ vs cross_tasks/ are peer pure-logic dirs; host wiring stays in index.ts + host/."""
    src_dir = ROOT / "src"
    for peer in ("debate", "cross_tasks", "host"):
        d = src_dir / peer
        assert d.is_dir(), f"src/{peer}/ missing: peers must both exist"
        assert (d / "module.toml").is_file(), f"src/{peer}/module.toml missing"
    # No flat pure-logic leftovers at src/ top level (version.ts is shared, index.ts is wiring).
    flat = {p.name for p in src_dir.glob("*.ts")}
    assert flat == {"index.ts", "version.ts"}, f"flat src/*.ts drifted: {sorted(flat)}"
    # Peer dirs carry no host wiring: no webServer register, no tools.register.
    for peer in ("debate", "cross_tasks", "host"):
        for ts in (src_dir / peer).glob("*.ts"):
            text = ts.read_text(encoding="utf-8")
            assert "webServer.register" not in text, f"{ts} must not register routes"
            assert "tools.register" not in text, f"{ts} must not register tools"
