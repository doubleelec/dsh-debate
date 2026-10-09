# Test Index

Human-facing catalog of the governance test suite. This file answers two questions without reading test source code:

1. **What does a given test enforce?** — look up any row below.
2. **Is coverage complete?** — every governance test must have exactly one row; the meta-guard `test_governance_tests_are_indexed` fails on any gap in either direction.

Scope: the **governance suite only** — the global kit tests below plus every module-local `tests/<module>/test_invariants.py`. Unit tests are out of scope.

## Global governance kit

| Test | Enforces | Fails when |
|:---|:---|:---|
| `test_module_boundaries.py::test_no_orphan_submodules` | direct-child inventory integrity | a real child is missing from `module.submodules` |
| `test_module_boundaries.py::test_no_phantom_submodules` | direct-child inventory integrity | a declared child does not exist on disk |
| `test_module_boundaries.py::test_module_submodules_complete` | recursive federated discovery | the discovered module set and the declared submodule tree disagree |
| `test_module_boundaries.py::test_governed_files_have_single_deepest_owner` | deepest-owner safety | a governed `.py` file resolves to zero or multiple deepest owners |
| `test_module_boundaries.py::test_storage_zone_references_respect_ownership` | managed-storage ownership (optional) | a non-owner module hard-codes a managed zone name (skipped when no `[managed_storage.*]` is declared) |
| `test_module_boundaries.py::test_submodule_boundaries` | intra-federation dependency categories | an import violates the declared internal/external dependency contract |
| `test_module_boundaries.py::test_design_flows_schema` | `[[design.flows]]` schema | a flow entry violates the declared schema |
| `test_module_boundaries.py::test_design_flow_links_resolve` | flow-link integrity | a flow link points at a nonexistent stage or target |
| `test_module_boundaries.py::test_required_invariant_coverage` | opt-in `require_invariants` coverage | a critical module keeps no invariant rule with a non-empty `test_ref` |
| `test_interface_contracts.py::test_interface_locks_reference_existing_files` | lock existence | an `[interface_lock.*]` entry names a file that does not exist |
| `test_interface_contracts.py::test_interface_locks_reference_existing_functions` | lock existence | a lock names a function that is not defined |
| `test_interface_contracts.py::test_interface_lock_reasons_are_stated` | lock rationale | a lock declares functions or signature entries but states no reason |
| `test_interface_contracts.py::test_interface_lock_signatures_match_code` | signature drift | a locked function's param names, defaults, or (for `exposed` symbols) param/return types drift from the declared signature entries |
| `test_interface_contracts.py::test_invariant_declarations_are_non_empty` | invariant declaration quality | an invariant rule carries an empty description |
| `test_interface_contracts.py::test_invariant_test_refs_exist` | binding quality (meta-guard) | a `test_ref` points to a missing, skip-short-circuited, or hollow test |
| `test_interface_contracts.py::test_exposed_symbols_have_signature_locks` | Expose is Lock (signature presence) | an `exposed` symbol carries no non-empty `[interface_lock.*.signatures]` signature entry |
| `test_interface_contracts.py::test_public_api_consistency` | `__all__` consistency | `public_api.exposed` and the facade `__all__` disagree |
| `test_interface_contracts.py::test_cross_module_from_imports_in_exposed` | Gateway-Only Import | a cross-module import bypasses the owner's facade or imports an unexposed name |
| `test_architecture_kit_complete.py::test_root_cleanliness` | root as a code-free zone | a `.py` file sits at the project root |
| `test_architecture_kit_complete.py::test_governed_modules_completeness` | governance-kit completeness | a module lacks mandatory `module.toml` sections or its `tests/<module>/` directory |
| `test_architecture_kit_complete.py::test_governance_tests_are_indexed` | index freshness (meta-guard) | a governance test is missing from this file, or a row points at a test that no longer exists |

## Module-local invariants

One row per test function in each `tests/<module>/test_invariants.py`. Use the file basename in the first column and name the owning module in the *Enforces* column when the same function name exists in several modules.

| Test | Enforces | Fails when |
|:---|:---|:---|
| `test_invariants.py::test_module_invariants_placeholder` | src placeholder — TS 行为门在 `test/debate.test.ts` (vitest), 本镜像只满足 kit 完备门 | never; 换成真实红线绑定时同步改本行 |

## Maintenance rules

1. **One row per governance test.** When a test is added or renamed, update this file in the same session — `test_governance_tests_are_indexed` fails otherwise.
2. **Reference format:** `<file>.py::<function>` in the first column, matching the `test_ref` convention used by invariant rules.
3. **Never delete a row to silence the guard.** If its test is gone, the rule it enforced is gone too — remove the rule explicitly (TOML entry + row together) or restore the test.
4. **Use this table to audit coverage** before adding a new invariant: a rule whose red line has no row here (and no `test_ref`) is documentation-only, not governance.
