# tests/src/task/test_invariants.py — module-local red lines for src/task.
# Guards the cross-repo task pure modules: exported surface present, each one
# carrying its vitest behavior file. Anti-hollow: real asserts, no bare pass.

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent
TASK = ROOT / "src" / "task"
VITEST = ROOT / "tests" / "vitest"


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def test_task_pure_surface_exists():
    """Three pure modules exist with their main exported entry points."""
    scan = _read(TASK / "scan.ts")
    assert "export async function scanParent" in scan
    assert "export function mergeSameGitRoot" in scan
    materials = _read(TASK / "materials.ts")
    for symbol in (
        "fillDirective",
        "fillTo",
        "buildMaterials",
        "assertAscii",
        "leftoverPlaceholders",
        "handoffText",
        "reportFileName",
        "reportMarkdown",
    ):
        assert symbol in materials, f"src/task/materials.ts missing: {symbol}"
    ensure = _read(TASK / "ensure-session.ts")
    assert "export async function ensureGroupedSession" in ensure


def test_task_vitest_mirrors_exist():
    """Every task module has a vitest behavior file (no orphan pure module)."""
    for name in ("task-scan", "task-materials", "task-ensure-session"):
        assert (VITEST / f"{name}.test.ts").is_file(), f"missing {name}.test.ts"
