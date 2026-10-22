# Test Index

Human-facing catalog of the governance test suite. This file answers two questions without reading test source code:

1. **What does a given test enforce?** — look up any row below.
2. **Is coverage complete?** — every governance test must have exactly one row; the meta-guard `test_governance_tests_are_indexed` fails on any gap in either direction.

Scope: the **governance suite** (global kit + module-local `test_invariants.py`) **plus the vitest behavior suite** (`tests/vitest/`) — both gates in one catalog. Run them with `npm run test:sandbox` (vitest, 233) and `pytest tests/ -q` (governance + invariants). Unit tests are out of scope.

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

## Module-local invariants (live red lines, S20)

One row per test function in each `tests/<module>/test_invariants.py`. Placeholders retired in S20: every row below binds a `test_ref` in its module's `module.toml` and fails on real drift.

| Test | Enforces | Fails when |
|:---|:---|:---|
| `test_invariants.py::test_src_single_thread_seam_exists` | src single-thread fork seam (ADR-0024) | a seam symbol (create/step/sweep) disappears from host |
| `test_invariants.py::test_src_debater_tool_allowlist_is_closed` | src debater allowlist closed at six tools (ADR-0022) | the allowlist gains/loses an entry |
| `test_invariants.py::test_src_synth_tool_allowlist_is_closed` | src synth allowlist closed at three tools (ADR-0022) | the allowlist gains/loses an entry |
| `test_invariants.py::test_src_registered_tools_match_manifest` | src registers no model tools, manifest tools empty (human-operated plugin) | a tools.register returns or manifest tools non-empty |
| `test_invariants.py::test_src_task_routes_are_eight` | src task wiring keeps eight routes (ADR-0025 + ADR-0028 recommend) | a task route is added/removed/renamed |
| `test_invariants.py::test_src_peer_symmetry` | src debate/ vs task/ peer symmetry (S22, S27: host/ joins) | a peer dir loses module.toml, flat leftovers return, or wiring leaks into peers |
| `test_invariants.py::test_client_pure_surface_exists` | src/client pure modules keep entry points | an exported pure function disappears |
| `test_invariants.py::test_client_task_dialog_wired` | src/client TaskDialog wired to task calls | dialog or a task/* call disappears |
| `test_invariants.py::test_client_task_dialog_takes_sessions` | src/client TaskDialog takes useSessions like DebateDialog (ADR-0026 fix) | the useSessions prop threading is lost in a merge |
| `test_invariants.py::test_client_task_dialog_cwd_key_not_snap_current` | src/client TaskDialog keys cwd lookup on currentSid (0.2.0 snapshots carry no current) | TaskDialog keys byId lookup on snap.current alone |
| `test_invariants.py::test_client_task_recommend_wired` | src/client TaskDialog recommends involved repos via task/recommend (ADR-0028/0029: no lead, no title field) | panel drops the recommend call, merge, entry draft gate, or reintroduces lead/title fields |
| `test_invariants.py::test_client_no_send_key_intercept` | src/client send key stays unwired (ADR-0025) | panel code touches `inputActions`/`actions` beyond `setDraft` |
| `test_invariants.py::test_debate_pure_surface_exists` | src/debate pure modules keep entry points (S22) | an exported pure function disappears |
| `test_invariants.py::test_debate_vitest_mirrors_exist` | src/debate every module keeps vitest mirror (S22) | a deliberation vitest file is missing |
| `test_invariants.py::test_task_pure_surface_exists` | src/cross_tasks pure modules keep entry points | an exported pure function disappears |
| `test_invariants.py::test_task_vitest_mirrors_exist` | src/cross_tasks every module keeps vitest mirror | a cross_tasks vitest file is missing |
| `tests/src/host/test_invariants.py::test_host_cage_lives_in_cage` | src/host cage symbols live in host/cage.ts (S27) | a cage symbol moves back into index.ts |
| `tests/src/host/test_invariants.py::test_host_resident_lives_in_resident` | src/host resident symbols live in host/resident.ts (S27) | a resident symbol moves back into index.ts |

## Behavior suite (vitest, `tests/vitest/`)

One row per file (each file's cases are the gate). Run: `npm run test:sandbox`.

| Test file | Enforces | Fails when |
|:---|:---|:---|
| `debate.test.ts` | 协议纯函数 + 回合推进 + 单线分叉 + 笼子交集 + 打断计划 | 判定/收敛/停机/工具笼任一语义漂移 |
| `persist.test.ts` | 落盘白名单 + 宽容反序列化 + 文件名净化 + markdown 结构 + mode 三态 + sweep | 历史局读不出或文档排布坏掉 |
| `version.test.ts` | 构建期内联版本 + 三方对账 + stale 判据 | 徽标显示的版本不代表真实程序 |
| `session.test.ts` | 会话 id 归一 + 增强入口 label | 面板开错会话或入口按钮回退 |
| `dialogLayout.test.ts` | 对话框尺寸钳制 + 高度持久化 | 面板尺寸越界或记忆丢失 |
| `labels.test.ts` | 角色名 + 轮次标签/小结 + stopKey | 面板人话标签漂移 |
| `task-scan.test.ts` | 跨仓结构探针 + git 归属判定 | 仓识别错（repo/part/external 误判）|
| `task-materials.test.ts` | directive/to 模板填充 + ASCII 门 + 回信汇总（ADR-0029 去牵头仓） | 材料缺占位或混入非 ASCII |
| `task-ensure-session.test.ts` | 分组会话三道门 + 临时会话回收 | 会话拉错仓或泄漏 |
| `task-routes.test.ts` | task 七路由 + 模型工具参数校验 | 路由/工具与纯模块脱节 |
| `task-panel.test.ts` | 面板任务纯逻辑（slug 缩写/推荐合并/校验/偏好，ADR-0029） | slug 生成、推荐合并或偏好读写坏掉 |
| `task-recommend.test.ts` | 涉及仓推荐输出解析（ADR-0028） | 模型输出清洗（过滤/截断/抛错）坏掉 |

## Maintenance rules

1. **One row per test.** When a test is added or renamed, update this file in the same session — `test_governance_tests_are_indexed` fails otherwise (governance rows are meta-guarded; behavior rows are convention, checked in review).
2. **Reference format:** `<file>.py::<function>` for bound rows (matches `test_ref`); `<file>.test.ts` for behavior rows.
3. **Never delete a row to silence the guard.** If its test is gone, the rule it enforced is gone too — remove the rule explicitly (TOML entry + row together) or restore the test.
4. **Use this table to audit coverage** before adding a new invariant: a rule whose red line has no row here (and no `test_ref`) is documentation-only, not governance.
