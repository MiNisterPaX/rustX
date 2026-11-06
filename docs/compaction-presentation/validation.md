# Compaction presentation validation

The implementation is stacked on asynchronous compaction commit
`ff7fa5455646298443b73f85961debcf9918265e`, following blocking compaction commit
`c8d6b7f435dacfef3e4740f934ca7eec1ecdc3e6` and baseline
`a81d053f7fed8295d347149696430a2e26e6c26e`.

## Invariant-to-test map

| Invariant | Owning evidence |
| --- | --- |
| One status per native operation, Ready does not spin, typed independent failures | Web `context-seat.test.tsx`; TUI `compaction-presentation.test.ts` |
| One committed marker, exact anchor/activation order, finite explicit history | Web `compaction-placement.test.tsx`, `compaction-summary.test.tsx`; TUI `compaction-presentation.test.ts` |
| Released text/focus survives reconnect; replaced authority rejects stale reads | Web `conversation-reading-disconnect.test.tsx`, `compaction-inspection.test.tsx`; real client reconnect acceptance |
| Exact committed summary, bounded preview limitation, no canonical summary Message | Web `compaction-trace-preview.test.tsx`; native Trace inspection and actual HTTP conformance |
| Frozen Provider/model/Profile, distinct physical fallback, exact u64 and unknown usage | Web `compaction-inspection.test.tsx`, real `compaction-chunks.spec.ts`; native Auxiliary conformance |
| Real multi-call operation in both clients | TUI `integration.test.ts` multi-call case and Web `compaction-chunks.spec.ts`: 21 accepted fragments, 22 physical requests, one final checkpoint, stable reconnect identity |
| Idle manual admission, optional instructions, typed no-op/cancel/error and no implicit abort | TUI command/receipt suites; Web receipt/context suites and `compaction.spec.ts` real native flow |
| Disclosure, CJK/narrow widths, resize and dark/light presentation | TUI compaction render cases; eight `compaction-summary.spec.ts` browser cases; pinned component comparison images |

The shared `chunked_compaction` HTTP scenario rejects the first native JSON
Schema request and gates the first Prompt retry. Both clients first observe
one native operation and no checkpoint marker, release that gate, then require
more than twelve accepted fragments and one installed marker. Web reads every
Call page and checks physical request metadata. TUI renders the actual native
state with its terminal component. Reconnect must retain the checkpoint identity
and one marker. No static fixture, timer or screenshot substitutes for these
native assertions. Test observation timeouts cover constructing the large
history; they do not change runtime/Auxiliary deadlines.

## Environment and results

Local verification uses Linux x86_64 in the task container, Rust 1.98.1, Node
24.22.0, pnpm 11.13.1 and the frozen provider emulator. Browser runs use the
repository-pinned Playwright image and unchanged screenshot comparators.
Canonical Git-index inputs are exported as LF; the Windows checkout's CRLF
conversion is not used as test or provenance input.
The Rust and JavaScript protocol generators run in Linux. The `check` wrapper's
final Git invocation cannot interpret this Windows-owned worktree's absolute
gitdir, so Windows Git performs the same generated-file comparison against the
staged sources. That comparison passes with no drift; the Linux wrapper itself
is not reported as a successful Git check.

| Check | Result |
| --- | --- |
| Rust formatting and strict all-target/all-feature Clippy | Passed |
| Native tests, all 21 compiled targets | 6,108 passed, 21 ignored, no failed target |
| Linux FULL test-lane coverage checker | Passed against actual workflow selectors |
| Rust App Server generation and TypeScript generation | v75 schema/fixtures/types regenerated; zero generated drift |
| Protocol, Web, TUI and dev TypeScript | Passed |
| TUI full suite, provider emulator required | 1,329 passed, 1 platform skip |
| Web full suite | 4,037 passed, 11 failed, 4 skipped; failures require unavailable Office sandbox host capabilities |
| Web i18n, source provenance/notices, production build | Passed |
| Real native browser multi-call plus English/Chinese compaction continuation | 3 passed |
| Dark/light, desktop/narrow summary browser acceptance | 8 passed |
| Full browser shards | All 640 discovered cases executed once: 342/346 and 280/294 passed; 18 failed |
| Final strict Trajectory and compaction browser checks | 73 passed after the reviewed reference updates |
| Isolated uploads and lost model-selection acknowledgement | 3 passed with unchanged assertions and timeouts |

[Browser results](evidence/browser-results.json) preserve the full shard
outcomes separately from follow-up checks. Six initial failures require the
intentional running-compaction reference change. All changed reference pixels
are confined to that row's role/state text; [visual deltas](evidence/visual-deltas.json)
record the exact bounds and before/after hashes. The comparator and rasterizer
noise policies are unchanged. Three additional browser failures passed the
isolated checks. Nine document-preview/Office conversion cases remain failed
in this local environment; neither the full run nor those cases are reported
as passing.

The 11 local Web failures belong to `document-integration.test.ts` and
`office-resource-boundary.test.ts`. This Docker environment lacks the delegated
host cgroup/service boundary and real sandbox conversion prerequisites. Three
rejection reports originate from that same failed resource setup. These failures
are not recorded as passes. Full macOS native, macOS Office and complete remote
FULL CI are separate host lanes; local Linux results do not claim them.

Representative commands:

```sh
cargo fmt --all -- --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --all-targets --all-features --no-run
cargo run --profile test --all-features --example check_test_lanes
pnpm --dir protocol/app-server check
pnpm --dir protocol/app-server typecheck
pnpm --dir web-console typecheck
pnpm --dir web-console test
pnpm --dir web-console check:i18n
pnpm --dir web-console check:provenance
pnpm --dir web-console build
pnpm --dir web-console test:e2e
RUSTX_REQUIRE_PROVIDER_EMULATOR=1 pnpm --dir tui test
pnpm --dir tui typecheck
pnpm --dir dev typecheck
git diff --check
```

The local native run invokes the compiled test executables from the successful
all-target build, with the frozen emulator and ordinary Runtime settings.
No paid/live semantic evaluation or production deployment was performed.
