# tests/src/host/test_invariants.py — module-local red lines for src/host.
# Guards the P0 extraction (S27): cage + resident live in host/*,
# index.ts only re-exports. Anti-hollow: real asserts, no bare pass.

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent
HOST = ROOT / "src" / "host"
SRC_INDEX = ROOT / "src" / "index.ts"


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def test_host_cage_lives_in_cage():
    """Cage symbols are defined in host/cage.ts, not in index.ts."""
    cage = _read(HOST / "cage.ts")
    for symbol in (
        "export const DEBATER_TOOL_ALLOW",
        "export function toolAllowFor",
        "export function resolveToolAllow",
        "export function visibleNamesOf",
        "export function cageLabel",
        "export function scopedToolGuard",
        "export async function askSubagent",
        "export function turnVerdict",
    ):
        assert symbol in cage, f"host/cage.ts missing: {symbol}"
    src = _read(SRC_INDEX)
    assert "export const DEBATER_TOOL_ALLOW = " not in src, "cage definition leaked back into index.ts"
    assert "from './host/cage'" in src, "index.ts must import from host/cage"


def test_host_resident_lives_in_resident():
    """Resident symbols are defined in host/resident.ts, not in index.ts."""
    resident = _read(HOST / "resident.ts")
    for symbol in (
        "export async function createResidentPair",
        "export async function driveResidentTurn",
        "export function extractHandoffConclusion",
        "export function heartbeatOf",
        "export function epochStopReason",
        "export function epochStopDetail",
        "export function isRetriableTurnError",
        "export const SUBAGENT_DELEGATION_CONTEXT",
    ):
        assert symbol in resident, f"host/resident.ts missing: {symbol}"
    src = _read(SRC_INDEX)
    assert "export async function createResidentPair" not in src, "resident definition leaked back into index.ts"
    assert "from './host/resident'" in src, "index.ts must import from host/resident"
