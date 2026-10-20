# tests/src/debate/test_invariants.py — module-local red lines for src/debate.
# Guards the debate pure-logic half: protocol/lenses/persist surface present,
# each with a vitest behavior mirror. Anti-hollow: real asserts, no bare pass.

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent
PURE = ROOT / "src" / "debate"
VITEST = ROOT / "tests" / "vitest"


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def test_debate_pure_surface_exists():
    """Protocol/lenses/persist keep their main exported entry points."""
    debate = _read(PURE / "debate.ts")
    for symbol in (
        "classifyQuestion",
        "extractSessionContext",
        "buildBuilderPrompt",
        "buildChallengerPrompt",
        "buildSynthesizerPrompt",
        "parseAgree",
        "isSaturated",
        "STOP_PROTOCOL_VERSION",
    ):
        assert symbol in debate, f"src/debate/debate.ts missing: {symbol}"
    lenses = _read(PURE / "lenses.ts")
    assert "LENS_TEMPLATES" in lenses
    persist = _read(PURE / "persist.ts")
    for symbol in ("toRecord", "fromRecord", "renderReport", "STORAGE_UNIT"):
        assert symbol in persist, f"src/debate/persist.ts missing: {symbol}"


def test_debate_vitest_mirrors_exist():
    """Every debate pure module has a vitest behavior file."""
    for name in ("debate", "persist"):
        assert (VITEST / f"{name}.test.ts").is_file(), f"missing {name}.test.ts"
