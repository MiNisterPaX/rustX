# PR #545 admission schema check

Checked against deployed commit `d82d7f9b8d9dd4f5064dba8d377103c8c6049d28` on 2026-11-16.

## Confirmed provider failures

The invocation-envelope change originated in `e1ff6b59000985e1992db0b36115f4754cad1f7b`, merged by PR #545 (`e1d4b52d085853fed18656dd5e9839a9f241a9cd`).

`compile_tool_contract` in `src/tools/schema.rs` publishes business schemas as a closed resource graph, then references the business root from `properties.arguments`. The graph is valid for the native validator, but is not a portable provider schema.

Actual requests to `https://api.kimi.com/coding/v1/chat/completions`, model `kimi-for-coding`, used the 16 tool definitions captured from the failing session. Every request asked for `OK`, with `tool_choice: none`; no tool was executed.

| Request | HTTP status | Result |
| --- | --- | --- |
| No tools | 200 | `OK` |
| Original 16 tool schemas | 400 | `properties.arguments.$ref`: references must start with `#/$defs/` |
| Root `$defs` and local references only | 400 | `properties.arguments`: detected infinite recursion without termination condition |
| Local references and equivalent singleton `allOf` unwrapping | 200 | `OK`, no tool calls |
| Same accepted schemas, streaming response | 200 | SSE completed with `OK`, no tool calls |

The second rejection occurs on a finite runtime-generated graph: its intermediate nodes contain only a one-element `allOf`. Therefore rewriting reference strings alone is insufficient. The provider accepts these same schemas after those wrappers are unwrapped.

## Patch boundary

The Chat Completions adapter projects tool schemas only for the exact Moonshot API hosts. It resolves bundled resources using the existing `referencing` dependency, places reachable schemas in root `$defs`, and emits local references. It unwraps an `allOf` only when it is the node's sole remaining field and has exactly one child. Other conjunctions and sibling constraints remain intact. Literal data in `const`, `enum`, and `default` is not rewritten.

Canonical tool definitions, original business validators, tool arguments and permission admission remain unchanged. Projection performs no schema retrieval from the filesystem or network. Dynamic/recursive reference keywords are rejected explicitly by this projection; the 16 tested schemas do not contain them. This is not a general implementation of every MFJS feature.

## Other admission paths reviewed

- Responses and Anthropic adapters also forward the canonical resource graph unchanged. This is an unverified compatibility risk; neither provider was live-tested, and no failure is claimed for them.
- Model-selected calls decode the outer invocation envelope before business normalization and validation against the captured canonical validator. Unknown outer fields and invalid execution selectors are rejected.
- Fixed workflow tool nodes use `prepare_fixed` with business arguments and their captured definition. They do not accidentally require the model-facing envelope.
- Capability selection, named-agent visibility and workflow admission remain separate. The checked paths do not grant tool authority merely because a resource exists.
- Native mutation tests still enforce held-directory commit semantics and reject replaced plan-file symlinks. No permission bypass was found in these checked paths.

Existing adapter tests chiefly establish schema serialization fidelity. They do not establish that a provider accepts the serialized dialect, as the two live Moonshot rejections demonstrate.

## Validation

- 206 tests passed across schema/envelope, tool execution, capability selection/coordinator, agent-profile, workflow admission/composition, native mutation/support and model-adapter regression groups (including the seven projection-specific tests). The final groups were run against the final compiled patch.
- The loopback connection test initially received a proxy-generated HTTP 503. Re-running that test with loopback proxy bypass passed.
- Projection-specific tests cover recursive business schemas, bundled relative resources, all native tool definitions, singleton conjunctions, retained sibling constraints, literal business data, unavailable resources and provider-host selection.
- The final accepted wire schema contains no `allOf` nodes for the 16 captured tools. Provider acceptance is scoped to these actual definitions and this endpoint/model; it does not establish support for arbitrary future MCP schemas.

The machine-readable server evidence records request conditions, schema hashes, HTTP responses and model usage without credentials or conversation messages.

References: [Moonshot MFJS specification](https://github.com/MoonshotAI/walle/blob/main/docs/mfjs-spec.md), [official validator and validation levels](https://github.com/MoonshotAI/walle).
