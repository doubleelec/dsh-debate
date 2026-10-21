# tests/src/client/test_invariants.py — module-local red lines for src/client.
# Guards the panel half: pure-logic surface present, dialog wiring intact,
# task pure logic present. Anti-hollow: real asserts, no bare pass/docstring-only.

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent.parent.parent
CLIENT = ROOT / "src" / "client"
PANEL = CLIENT / "index.tsx"


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def test_client_pure_surface_exists():
    """Panel pure modules exist with their exported entry points."""
    sections = _read(CLIENT / "sections.ts")
    assert "export function splitSections" in sections
    task = _read(CLIENT / "task.ts")
    for symbol in (
        "parseInvolvedLines",
        "suggestTasksRoot",
        "validateSlug",
        "validateTaskBuild",
        "loadTaskPrefs",
        "saveTaskPrefs",
        "defaultParentRoot",
        "suggestScanDefaults",
    ):
        assert symbol in task, f"src/client/task.ts missing: {symbol}"


def test_client_task_dialog_wired():
    """TaskDialog exists in the panel and calls task/scan + task/build + task/launch."""
    src = _read(PANEL)
    assert "function TaskDialog" in src, "TaskDialog missing from panel"
    for call in ("'task/scan'", "'task/build'", "'task/launch'", "'task/collect'"):
        assert call in src, f"panel missing client call {call}"


def test_client_no_send_key_intercept():
    """Native send key stays unwired (ADR-0025): only setDraft may be touched."""
    code = _read(PANEL)
    # Strip comments first: ADR mentions of inputActions in prose are fine.
    code = re.sub(r"//.*", "", code)
    code = re.sub(r"/\*.*?\*/", "", code, flags=re.S)
    # inputActions itself is fine (setDraft clears the draft after a run starts);
    # what is forbidden is touching the send path (submit or any other key).
    for hit in re.findall(r"inputActions\s*\.\s*([A-Za-z_]+)", code):
        assert hit == "setDraft", f"panel touches forbidden inputActions.{hit} (send key)"
    for hit in re.findall(r"actions\s*\.\s*([A-Za-z_]+)", code):
        assert hit == "setDraft", f"panel touches forbidden actions.{hit} (send key)"
