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


def test_client_task_dialog_takes_sessions():
    """TaskDialog receives useSessions like DebateDialog (cwd snapshot, ADR-0026 fix).

    Regression guard: the prop threading was once lost in a merge, silently
    reverting TaskDialog to service-line-only cwd (empty in some hosts).
    """
    src = _read(PANEL)
    assert "function TaskDialog(props: { onClose: () => void; useSessions?" in src, (
        "TaskDialog must accept useSessions prop"
    )
    assert "<TaskDialog onClose=" in src and "useSessions={props.useSessions}" in src, (
        "DebateRoot must pass useSessions to TaskDialog"
    )


def test_client_task_dialog_cwd_key_not_snap_current():
    """TaskDialog keys cwd lookup on currentSid, not snap.current (0.2.0 probe).

    0.2.0 snapshots carry no `current`; DebateDialog already falls back to the
    input.right sessionId cache (currentSid). TaskDialog keyed only on
    snap.current, so on 0.2.0 hosts it always resolved empty and errored
    "no workspace" even with a live cwd. Both dialogs must share the key.
    """
    src = _read(PANEL)
    m = re.search(r"function TaskDialog\(.*?\{([\s\S]*?)\n  try \{", src)
    assert m, "TaskDialog body not found"
    body = m.group(1)
    assert "currentSid" in body, "TaskDialog must seed the lookup key from currentSid"
    assert "byId?.[liveSid]" in src or "byId[liveSid]" in src or "byId?.[live" in src, (
        "TaskDialog must look up byId with the seeded key, not snap.current alone"
    )


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
