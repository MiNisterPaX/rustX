# Async compaction in Pi Durable and Grok Bot

Research date: 2026-11-05 (Asia/Shanghai). Status: source-backed research and a proposed rustX design, not an implementation specification that has been approved or implemented.

| Source | Immutable revision | Scope |
| --- | --- | --- |
| Pi | [`136a7b2d7d46a65d047c22c5af92ca214763466b`](https://github.com/earendil-works/pi/commit/136a7b2d7d46a65d047c22c5af92ca214763466b) | `packages/durable`, rather than the separate Coding Agent compaction implementation |
| Grok Bot reconstruction | [`a9f633e09d49a85829b8236331b9e21f7e612634`](https://github.com/b-nnett/grok-bot-0.18-reconstructed/commit/a9f633e09d49a85829b8236331b9e21f7e612634) | Readable reconstructed host, agent loop, summarization orchestrator and handler |
| rustX | [`d4645468282dc6df56015fd72d0ad442946694c5`](https://github.com/Caismis/rustX/commit/d4645468282dc6df56015fd72d0ad442946694c5) | Current `origin/main` inspected for staging, Safe Boundary, checkpoint and request-start contracts |

Recommendation: admit a bounded background Summary Operation at a native inter-turn preparation boundary, run its immutable source snapshot concurrently with later model/tool work, and let the Agent Loop install a ready result only before preparing a new logical model turn. Preserve all appended history. Competing results may advance compatible source coverage, never regress it; equality keeps the active result. Mandatory pressure joins useful in-flight work or performs bounded blocking replacement, and every actual primary start still passes full admission.

## 1. Pi Durable

### Trigger and execution ownership

Pi Durable uses two thresholds over its estimated request input `U`:

```text
blocking = contextWindow - reserveTokens
background = blocking - backgroundTokens

U > blocking                           -> create generation-owned task and wait
U > background && backgroundTokens > 0 -> create conversation-owned background task
```

Both decisions require an eligible cut. Equality does not trigger. Default settings are `reserveTokens = 16,384`, `keepRecentTokens = 20,000`, and `backgroundTokens = 32,768`, with per-model overrides. The background branch checks that no compaction is currently listed when committing request preparation. The blocking branch can create its own task while a background task is still running. [Threshold implementation](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/src/harness/generation.ts#L231-L261), [comparison operators](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/src/harness/generation.ts#L449-L469), [documented defaults](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/README.md#L621-L644).

The task implementation is shared. A generation-owned blocking task appends its summary directly before its waiting generation resumes. A conversation-owned background or manual task submits a passive write: immediate placement when idle, otherwise placement at a turn boundary. Completion of the summary task can therefore mean that a write was queued, not that the summary became active. [Ownership and placement](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/src/harness/compaction.ts#L249-L264), [placement implementation](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/src/harness/compaction.ts#L434-L471), [specification](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/docs/spec.md#L5228-L5244).

### Frozen source and later messages

The summary task pins model, thinking level, stream options, output limit, snapshot `tail`, and `firstKept`. It rereads the immutable context at `tail`; new entries cannot extend that request. The cut preserves roughly the configured recent-token budget and explicitly avoids a tool-result cut or a user cut that separates a preceding assistant's tool calls from their results. Earlier summaries are included in the next summary's material. [Pinned request and capture](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/src/harness/compaction.ts#L45-L61), [selection and replay](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/src/harness/compaction.ts#L120-L175), [tool-safe cut](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/src/harness/compaction.ts#L279-L329).

Placement appends a `pi.compaction` head marker whose target is `firstKept`; it does not delete stored entries. Context consists of the newest head marker plus the retained range through the current tail. Consequently, messages appended after the summary snapshot survive the new head. Primary preparation separately pins its own `cutoff`, and the actual request reads context through that cutoff; queued summary placement cannot rewrite that prepared generation. [Context derivation](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/src/harness/context.ts#L144-L157), [prepared request cutoff](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/src/harness/generation.ts#L245-L285), [boundary placement](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/src/harness/inbox.ts#L71-L120).

### Competition is ordered by cut, not completion time

A head write is stale exactly when its target precedes the current active-range start: `candidate.firstKept < current.head`. A later cut can replace an earlier cut even if its summary was selected earlier. Equal cuts are accepted and the later-placed marker replaces the earlier one. The rule is simple because the supported built-in transformations summarize prefixes and heads only advance. It is not a general merge algorithm for arbitrary edits or branches. [Stale predicate](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/src/harness/inbox.ts#L150-L157), [worked concurrency example and limitations](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/docs/spec.md#L3002-L3024).

The repository has controlled tests for a background result losing to a blocking compaction, an older-selected result winning with a later cut, two queued results with smaller/equal/larger cuts, and a manual equal-cut result replacing a blocking result after its primary request used the first summary. There is also an explicit test documenting that an application edit placed during summarization can be lost. These are inspected tests, not tests executed during this research. [Cut ordering tests](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/test/harness-compaction.test.ts#L603-L678), [blocking wins](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/test/harness-compaction.test.ts#L1202-L1222), [equal-cut replacement](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/test/harness-compaction.test.ts#L2162-L2184), [edit limitation](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/test/harness-compaction.test.ts#L1877-L1893).

### Pressure, failure and cancellation

Pi's foreground fallback does not automatically promote or await the older background task: it creates a generation-owned task, and cut ordering arbitrates the results. Provider overflow permits one compaction recovery in that generation; the rejected input is not treated as an ordinary transient retry. A failed blocking-threshold task fails the generation without sending a request, whereas a completed no-op or declined compaction lets the request proceed. That last behavior is weaker than rustX's required final admission. [Blocking result handling](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/src/harness/generation.ts#L190-L204), [overflow branch](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/src/harness/generation.ts#L802-L823).

A manual compaction is ordinary conversation work and ordinary abort cancels it. Automatic background work survives ordinary abort; explicit task abort or `abort(..., { background: true })` cancels it. A summary already queued as a write also survives conversation abort unless its submission is withdrawn. This lifecycle is deliberate Pi behavior and should not be copied into rustX's Attempt ownership. Pi accounts accepted summary-response usage even when placement later becomes stale, but its spec says an aborted/crashed uncommitted summary response is not counted; rustX should retain its own more detailed physical-call accounting. [Cancellation and spend semantics](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/docs/spec.md#L5350-L5358), [stale spend test](https://github.com/earendil-works/pi/blob/136a7b2d7d46a65d047c22c5af92ca214763466b/packages/durable/test/harness-compaction.test.ts#L579-L600).

## 2. Grok Bot reconstruction

This note examines the readable TypeScript at default-branch HEAD [`a9f633e09d49a85829b8236331b9e21f7e612634`](https://github.com/b-nnett/grok-bot-0.18-reconstructed/commit/a9f633e09d49a85829b8236331b9e21f7e612634). This is an **unofficial reconstruction of Anysphere's Grok Bot 0.18**, with extensions; it is neither official xAI source nor Anysphere's original monorepo. Names and behavior may differ from the shipped app. The [repository's own provenance statement](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/README.md#L1-L25) explicitly describes those limits. Findings below describe this pinned reconstruction, not a claim about every deployed Grok Bot version.

### Wiring and trigger budgets

The reconstructed host builds a production turn owner with the model, a **200,000-token configured agent limit**, and no background-threshold override in the shown call; its adapter invokes the constructed agent's stream. The static config supplies background defaults; its override is a programmatic config input, not evidence of a user-facing setting. Some adjacent historical comments call other stream factories dormant, so reachability should be tied to the specific production shell and adapter, not inferred merely from files existing. See [host composition](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/host-runner-composition.ts#L2510-L2525), [production adapter](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/runner/production-turn-run-shell-adapter.ts#L303-L329), and [agent stream call](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/runner/turn-agent-composition.ts#L636-L663). The generic agent constructor's normalization instead defaults to disabled thresholds; supplied config overrides it. [Constructor defaults](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/agent-config-runtime.ts#L12-L24), [config spread](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/agent-config-runtime.ts#L42-L47), [host defaults and override](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/runner/turn-agent-composition.ts#L209-L229), [application](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/runner/turn-agent-composition.ts#L271-L281).

For this host, start when **unused <= 10,000 OR unused/max <= 10%**, and the end-of-turn persistence test is start-eligible AND (**unused <= 5,000 OR unused/max <= 5%**). Equivalently start at `used >= min(max - 10_000, 0.9 * max)`; if effective max=200,000 this is 180,000 used, with persistence at 190,000. The 200,000 configured agent limit should not be assumed to be the effective value for every request: the loop stores `maxTokens` from the stream's extended usage. The constants are host defaults, while effective absolute cutoffs depend on that window; eval overrides and image pressure are additional triggers. The helper returns no threshold for a nonpositive max. [Threshold implementation](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent-summarization/background-summarization.ts#L10-L63), [usage update](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts#L2103-L2118), [eval and self-summary branches](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/summarization-orchestrator.ts#L314-L350). The generic orchestrator can use self-summary at a configurable/eval limit or 90% of the context and has a 1,000-turn condition, but this reconstructed agent passes no self-summarizer factory; do not conflate that generic option with the host's external-background configuration. [Self-summary decision](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/self-summary/self-summary.ts#L51-L95), [constants](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/self-summary/constants.ts#L1-L3), [actual constructor](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/index.ts#L59-L68).

### Start, snapshot, and install

In the reconstructed turn loop, a model/tool stream is created first, then token details can trigger `Background` summarization without waiting for its generation; the model-only path follows the same ordering. A one-step cloud run, stale token details after compaction, or self-summary suppression gates this token-triggered path. Thus an already-started inference request is not rebuilt by a later install; compaction changes the executor's history for subsequent operations. [Tool stream start and trigger](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts#L1961-L1968), [background trigger](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts#L2028-L2055), [model-only ordering](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts#L3967-L4003). The routed provider executor passes its current messages into each stream; the base builder returns a new array but does not deep-clone messages. The exact capture semantics of every provider transport are not established by these lines. [Provider stream](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/extensions/inference/provider-session.ts#L257-L262), [base builder](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/chat-inference/base.ts#L3-L22).

The orchestrator obtains `allMessages`, requires a system message, starts a promise against that captured array, and stores the array, promise, cancellation token, initiating invocation ID and token counts in state. The summary's input excludes system messages and empty assistant messages, with optional leading user-info separation. For a partial summary, the external handler partitions at the last user message (subject to a small-index guard); by default it includes that user message in the summary and also preserves the tail beginning there. Full compaction summarizes the entire filtered input. Replacement consists of system/user-info, summary carrier and preserved original tail. [Snapshot and prefix](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/summarization-orchestrator.ts#L410-L444), [promise and metadata](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/summarization-orchestrator.ts#L506-L543), [state assignment](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/summarization-orchestrator.ts#L583-L590), [filtering](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent-summarization/prepare-messages.ts#L20-L46), [partition](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent-summarization/summarization-handler.ts#L930-L972), [assembly](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent-summarization/summarization-handler.ts#L1113-L1122).

When consumed, the stored whole snapshot must be a prefix of the current message list, compared by role and serialized message value, not a message ID or invocation ID. If valid, the same promise is reused; a changed, removed, or reordered prefix invalidates it and clears the state. Installation archives actually summarized messages, replaces the executor contents with the summary and preserved snapshot tail, then appends `allMessages.slice(snapshot.length)`. This preserves appends already present when the consumer enters `handleSummarization`. Because `allMessages` is captured before awaiting the promise, appends during that await are not included by this splice; whether they can occur depends on loop serialization. It marks token details stale. This supports append-only concurrent progress, but does not merge edits to the old prefix: those invalidate the candidate. The check is performed before awaiting the promise; the shown install path does not repeat the prefix check after the await, so safety against intervening edits while blocked depends on turn-loop serialization or other guarantees not established here. [Bytewise comparison](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/summarization-orchestrator.ts#L243-L258), [reuse or discard](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/summarization-orchestrator.ts#L436-L481), [archive and install](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/summarization-orchestrator.ts#L726-L765).

The partition is based on user-message boundaries, not an explicit tool-call/result ID matching algorithm. In the ordinary partial case the last-user tail keeps its following call/result messages together, and newly appended messages are retained in order. However, the cited full-summary path and append splice do not prove pair safety if an assistant tool call was captured but its result arrived only after that snapshot; no boundary repair or pair-validation guard is evident in these functions. Treat global tool-pair safety as **unverified**, not as a guarantee. [Partition](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent-summarization/summarization-handler.ts#L936-L950), [splice](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/summarization-orchestrator.ts#L750-L765).

### Result consumers, pressure, and failures

`Background` returns immediately. `BackgroundAndPersistIfCompleted` returns if pending and installs if completed. `WaitForCompletion` reuses and awaits a valid candidate, or starts and awaits a new one; `WaitForCompletionIfStarted` returns without starting if none exists. Reuse is based on the whole-prefix test, with **no comparison of candidate coverage to a newly desired full-compaction boundary**: even a mandatory/full or force-external request can reuse a matching in-flight partial/self candidate. If the prefix is invalid, the state is cleared; the next mode may start another promise. [Mode selection](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/summarization-orchestrator.ts#L436-L506), [mode behavior](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/summarization-orchestrator.ts#L593-L615).

At a mid-loop checkpoint, a completed candidate can be installed once the trigger threshold is met with this host's default `requireTriggerThresholdForMidLoopPersist`; notably the stricter persist threshold is calculated for logging but is not the mid-loop decision. If pending and usage exceeds `max + min(25% of max, 50,000)` strictly, the loop waits. At 85 image parts, the loop starts background compaction, and image pressure can cause persistence/waiting. A real input-token or image-limit error invokes blocking `WaitForCompletion`, then retries the step, up to five attempts; it is not simply the same configured early trigger. [Mid-loop consumption and overage](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts#L2405-L2477), [image start](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts#L2478-L2494), [85 constant](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts#L69), [error recovery](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts#L2508-L2545).

At turn end, completed work is installed when the persist or image threshold is met; pending work is awaited under severe token overage or image pressure. Otherwise the result is not installed on that path even if the ordinary persist threshold is met. Remaining work receives a cooperative cancellation flag and a rejection handler; the cited cleanup does not itself clear the stored background state. The external summarizer checks that flag between attempts and after retry delays; the shown token is not passed to the streaming call as an abort signal, so this does not establish immediate cancellation of an in-flight request. [Turn-end decisions](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts#L2731-L2797), [discard/cancel](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts#L2799-L2838), [retry checks](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent-summarization/summarization-handler.ts#L415-L436), [delay check](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent-summarization/summarization-handler.ts#L585-L597).

On thrown generation errors the promise clears background state and rethrows. On a returned error result, default `discardOnError` rejects it for nonblocking persistence and rejects abort errors even in waiting modes; waiting mode can install other error results. In this host the handler defaults to no deterministic fallback and no throw on retry exhaustion, so exhausted retries can return the placeholder `No summary generated` with `hadError: true`; this makes the blocking error path potentially lossy rather than preserving the original old history. This is a code-path observation, not proof that a particular runtime failure happened. [Error handling on promise](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/summarization-orchestrator.ts#L559-L580), [install policy](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/summarization-orchestrator.ts#L680-L714), [host options](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/host/runner/conversation-state.ts#L40-L50), [handler defaults](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent-summarization/summarization-handler.ts#L899-L916), [placeholder](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent-summarization/summarization-handler.ts#L636-L645).

The state setters and completion/failure callbacks shown do not check a generation ID before setting the completion flag or clearing state. Therefore, if an invalidated old promise continues after a replacement starts, the code does not itself demonstrate protection from the old promise marking or clearing the new state. Whether that race is reachable in a particular run requires runtime scheduling analysis; do not assert that it always occurs. Invocation IDs recorded at start and persistence are observability metadata, not the candidate-validity predicate. [State setters](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/state.ts#L2916-L2937), [callbacks](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/summarization-orchestrator.ts#L545-L590), [tracking IDs](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/a9f633e09d49a85829b8236331b9e21f7e612634/source/packages/agent/summarization-orchestrator.ts#L836-L849).

## 3. Comparison and what carries over

| Concern | Pi Durable | Grok reconstruction | Proposed rustX baseline |
| --- | --- | --- | --- |
| Early work | Separate background threshold below blocking threshold | Start threshold; consumers also distinguish persistence and severe pressure | Reuse the automatic proactive trigger as the background threshold |
| Snapshot | Immutable tail and first-kept entry | Captured message array, later prefix equality check | Immutable Resource Read Cut, selected source identities and frozen operation |
| Ready result | Passive write queued until a boundary | Stored promise and completion flag, consumed by the loop | One bounded ready slot; only the Agent Loop may activate |
| Mandatory pressure | Starts a distinct blocking task; cuts arbitrate | Reuses a prefix-matching promise or starts and awaits one | Join useful current work first; bounded replacement if its frozen scope cannot satisfy current admission |
| Competition | Furthest cut; equal cut can replace | One in-flight state; invalid prefix clears it | Compatible strict coverage advance; equal or dominated candidate has no effect |
| New messages | Remain after the head | Appended snapshot suffix is spliced back | Untouched current tail is retained exactly once |
| End/cancel | Background work can outlive ordinary conversation abort | Turn-end work not installed is cancellation-signaled cooperatively | Background operation is owned by this Attempt and supervised through settlement |
| Failure | Blocking failure ends generation; no-op may proceed | Waiting mode can accept error fallback | Invalid summary never activates; optional failure can continue only with admitted old input |

The first two columns summarize the pinned source paths in sections 1 and 2. The last column is a design recommendation. Neither a cut frontier nor a prefix match proves summary quality or request admissibility.

## 4. Existing rustX contracts that determine the design

At the inspected main revision, the Agent Loop already distinguishes a logical model step from its physical requests, retains one accepted context generation through retries, and drains inbound only after a structurally complete model/tool turn. Its mailbox Safe Boundary is specifically an inbound operation, not a generic license for arbitrary mutation. Integrate asynchronous compaction into an explicit adjacent preparation phase; do not turn a completion callback into a new history writer. [Logical-step lifetime](https://github.com/Caismis/rustX/blob/d4645468282dc6df56015fd72d0ad442946694c5/src/agent/execution/step.rs#L32-L109), [turn preparation](https://github.com/Caismis/rustX/blob/d4645468282dc6df56015fd72d0ad442946694c5/src/agent/execution/step.rs#L299-L325), [tool settlement and Safe Boundary](https://github.com/Caismis/rustX/blob/d4645468282dc6df56015fd72d0ad442946694c5/src/agent/execution/step.rs#L721-L848).

A prepared request is a scratch value containing exact request input and Snapshot; only the start transaction publishes it. That transaction currently rejects a Snapshot whose checkpoint differs from the current Projection Head. Therefore, activating a background result between preparation and start would invalidate the prepared request even if its bytes were unchanged. Preserving already-staged work is simplest when activation is prevented throughout that interval and the remainder of the logical turn, including ordinary transient retry. [Prepared and staged request shapes](https://github.com/Caismis/rustX/blob/d4645468282dc6df56015fd72d0ad442946694c5/src/agent/execution/request.rs#L31-L111), [start head check](https://github.com/Caismis/rustX/blob/d4645468282dc6df56015fd72d0ad442946694c5/src/durable/sqlite/request.rs#L145-L151).

Checkpoint construction captures historical resources, includes retained history, validates the assembled primary input and actual historical reduction, then commits atomically. Commit checks the current predecessor and execution owner. Candidate historical authority also requires its predecessor to agree with the head at its Resource Read Cut. These are distinct checks; changing only an old candidate's expected head is invalid. [Capture](https://github.com/Caismis/rustX/blob/d4645468282dc6df56015fd72d0ad442946694c5/src/context/compaction.rs#L129-L171), [candidate and fit checks](https://github.com/Caismis/rustX/blob/d4645468282dc6df56015fd72d0ad442946694c5/src/context/compaction.rs#L371-L425), [historical predecessor validation](https://github.com/Caismis/rustX/blob/d4645468282dc6df56015fd72d0ad442946694c5/src/durable/sqlite/projection.rs#L766-L802), [commit CAS and owner fence](https://github.com/Caismis/rustX/blob/d4645468282dc6df56015fd72d0ad442946694c5/src/durable/sqlite/projection.rs#L918-L949).

## 5. Proposed minimal rustX baseline

### 5.1 Three separate moments

1. **Capture and admit:** at the safe preparation phase between logical turns, capture one finite eligible historical prefix and freeze models, Profile, Schema strategy, capabilities, source authority, work plan and budget. New inbound and request-scoped context remain protected.
2. **Generate:** supervised Auxiliary execution runs the same sequential chunking pipeline proposed in #522, concurrently with subsequent primary requests and tool work. It returns a detached, validated summary result. It cannot commit a checkpoint or mutate the working conversation.
3. **Activate:** the Agent Loop consumes a ready result at a later eligible preparation boundary, composes it with current retained history, validates it and performs the existing atomic commit.

“Between two Logical Model Turns” should specify admission and activation. If generation itself must finish before the next turn starts, it cannot hide summary latency.

Use one deterministic result-consumption point before staging the next historical projection. The loop can first freeze that logical step's accepted context once, so complete fixed input and protected overlays are available for candidate validation; it must not rerun contributors after compaction. Check the ready slot once, not repeatedly until a racing completion wins.

    structurally settle previous turn and tools
      -> observe cancellation; adopt one finite inbound batch
      -> admit next step's context once
      -> consume the ready-slot cut and validate/activate eligible result
      -> evaluate full input; start background work or enter mandatory recovery
      -> stage, preflight and freeze request
      -> ordinary cancellation-versus-start gate
      -> primary model and tools
      -> next Safe Boundary

The first request of an Attempt gets the same safe preparation phase. After the ordinary result-consumption cut, optional completions wait for the following eligible boundary. Mandatory admission/overflow recovery is the explicit exception: that phase may join one specifically selected operation, consume its awaited completion, validate and commit, and then stage the repaired primary request. This does not reopen ordinary ready-slot polling or repeatedly sample racing completions. A ready notification is a wake/result fact, not a command to mutate history.

### 5.2 Automatic thresholds, without more user settings

Keep the distinction already required by #522:

    H = primary context window - primary output budget - automatic margin
    B = approximately 0.90 * H, with exact bounded integer policy settled in #522

    U below B:        run normally
    B <= U <= H:      start one eligible background operation; run admitted primary input
    U > H:            do not start primary; enter mandatory compaction/recovery

Here H is the maximum admissible input under the eventual exact accounting contract; equality behavior must be tested at every actual gate. The 0.90 ratio is a calibration proposal, not a measured optimum. U includes full System Prompt, Tools, media/projection costs, protected inputs and request-only context; summary-model capacity determines fragment size, not H.

Do not add a third “install at 95%” threshold. A valid ready result installs at the first eligible boundary where it makes historical progress and satisfies the full current request. Separating generation and activation is sufficient.

Large tool results or fresh inbound can jump from below B to above H in one turn. Background work is an optimization, not an assurance that mandatory recovery will never block. Provider-reported overflow always enters typed recovery even when a local estimate remains below H.

### 5.3 One owned background slot

Allow at most one proactive operation per Attempt at a time, with one bounded pending result. Mandatory recovery may additionally own its one foreground operation in the existing recovery path; no third competing operation is admitted. Reuse immutable selected-input roots and bounded read capabilities rather than cloning the entire history or holding a database transaction open.

Its local states are idle, running and ready, followed by normal terminal settlement. Every completion carries the native OperationId and admission generation; only a matching slot may be updated. A stale task cannot clear, complete or replace its successor. This is a small working value owned by the existing Agent Loop, not a new durable job scheduler.

The operation's deadline, accepted fragments, physical-start evidence, format downgrade and recovery allowance survive logical-turn changes. The current per-logical-step budget storage must not reset a background operation that spans steps. A later foreground wait changes waiting policy, not operation identity or available retries.

Use two explicit finite envelopes, both owned by the existing Attempt execution: an operation envelope admitted at capture, and a mandatory-recovery envelope created on the first failed primary admission or genuine overflow. At recovery admission, freeze its absolute deadline, aggregate work/start ceiling and exceptional-recovery allowance from the bounded current plan. Charge any imported in-flight background work, including already confirmed or unresolved starts, against the aggregate ceiling; an imported operation's remaining exceptional allowance cannot increase. Each participating operation retains its own original deadline and ceiling. A joined request is limited by both envelopes; a replacement gets at most the recovery envelope's remaining capacity and time. Starting a new Call or operation does not replenish that envelope.

An already-expired or terminal optional operation is not revived or made the deadline origin of a new mandatory episode. Its prior spend remains recorded; optional failure suppression prevents optional retry storms. A mandatory episode ends only when a repaired primary request reaches canonical acceptance, or the Attempt settles. Preparation re-entry, backoff, replacement and a logical-turn counter change are not resets. Later pressure after actual accepted progress may create a new finite episode, subject to #522's rapid-refill rule. Exact caps and deadline derivation belong to the single native policy; these two lifetimes do not introduce user settings.

### 5.4 Coverage order and equal-result policy

Define source comparability before ordering coverage. Candidates must concern the same conversation/history lineage and compatible immutable source versions and projection authority. Capturing more recent messages or finishing later does not by itself dominate another candidate.

For comparable candidates A and B, order their coverage equivalence classes, rather than their generated prose:

    A <= B  iff  every source range retired by A is accounted for by B

“Accounted for” includes the authenticated coverage of an earlier checkpoint summary; it does not mean every original byte was sent again or that semantic summarization is lossless. In the restricted baseline of prefix retirement, this reduces to a monotone retired-through frontier plus validated base/checkpoint lineage. Keep the native bounded provenance witnesses. Do not build an arbitrary interval-merging framework or flatten unlimited checkpoint ancestry.

Activation rules:

- Strictly greater compatible coverage: eligible for validation and activation.
- Equal coverage: keep the current active checkpoint; no second marker or replacement solely for a different generated summary.
- Smaller coverage: settle the candidate as superseded, with no history change.
- Incomparable lineage, changed source semantics, or unprovable dominance: no automatic merge; reject that candidate for installation and replan only if still needed.
- Two not-yet-active equal candidates: use native admission order as the deterministic tie-break; completion timing does not define priority.

Coverage is necessary, not sufficient. A candidate with wider coverage can still be larger, incomplete or inadmissible and must fail the same validation as a fresh result.

Example: background A captured through message 100 and retires through 70. Blocking B retires through 150; late A is superseded. If B retired through 60, A remains explicitly retained and uncancelled, and its original source still proves coverage through 70, A can later advance it. If both retire through 70, the installed result stays. On a linear prefix, the last two outcomes deliberately differ only in the equality case from Pi. Once A is explicitly cancelled, invalidated or terminally superseded, no coverage comparison can revive it.

### 5.5 Install against current history, preserve the new tail

The ready object is a summary result with frozen generation evidence, not an already-authorized checkpoint. At installation, capture current activation authority and build a fresh checkpoint candidate:

    accepted summary over the selected retired prefix
      + retained historical items from that snapshot
      + every eligible append since the snapshot, exactly once
      + protected current-generation input and request-only overlays for validation

Where a competing checkpoint has changed representation, reconstruct only from compatible bounded source references; never append an old whole projection over the live one or resurrect retired input.

Keep the original summary-source cut and actual generation lineage intact. The newly assembled checkpoint has the current expected predecessor and a consistent installation Resource Read Cut; do not relabel old Auxiliary output as generated from the newer checkpoint. The native contract must explicitly represent and validate this separation. Keep the ordinary current-head CAS, execution/source fences, cancellation grant and uncertain-commit receipt reconciliation.

Before commit, prove source coverage, protected-input retention, complete tool associations, complete primary fit and actual historical-size reduction. On successful activation, update hot state from the authoritative current head, retire incompatible provider continuation and invalidate incompatible input measurements through the existing path. Intermediate JSON and summaries remain private, and success still produces one checkpoint.

A completed/staged primary request is never rewritten just because the worker finished. During the ordinary logical-turn lifetime, no async activation occurs. A genuine provider-overflow rejection is the existing explicit semantic-recovery exception: accepted contributors remain frozen, but the rejected request can be replaced only through mandatory compaction and full restaging/preflight.

### 5.6 Mandatory fallback and an insufficient old candidate

Prefer a foreground wait on an existing eligible operation when its fixed source scope can plausibly make the current input admissible. Its accepted fragment progress and remaining allowance are reused. Waits use the existing finite deadline and cancellation supervision.

After it becomes ready, validate the complete current input. New tail material may make an old summary insufficient. A matching prefix or larger retired frontier alone is not permission to start primary, and an inadmissible partial result must not activate.

If the frozen prefix cannot provide enough reduction, or the candidate remains inadmissible, perform one bounded blocking replacement from a fresh current cut under the remaining recovery envelope. A source-invalid, failed or unusable completed candidate is terminally rejected and cannot later install. For a still-valid background operation that is merely too narrow or slow for this recovery, replacement admission alone does not declare it superseded: retain at most that one competitor under its original envelope while the foreground operation runs. The Agent Loop remains the only installer. When one result commits, compare the retained competitor against the committed coverage; cancel and settle equal/dominated work as superseded. A strictly wider compatible candidate may remain eligible for the next ordinary boundary, subject to fit, progress, deadline and cancellation. Its completion cannot clear or mutate the foreground operation's state.

Preserve accounting for both operations and any unresolved physical starts. Do not silently extend the old operation's captured scope, restart its chunk sequence under a new logical-subcall budget, or install an invalid checkpoint first. The baseline may repeat some summarization work on this explicit replacement; cross-operation reuse would require a separately specified provenance contract and is not necessary for correctness.

A new blocking plan still uses #522's normal planned chunk allowance, distinct from its exceptional recovery allowance, subject to the shared finite ceilings. If protected fresh input or fixed prompt/tool load makes even the minimum request impossible, fail the current Attempt with that obstruction. No sequence of fresh plans may avoid the original limits.

This is a small improvement over Pi's automatic competing-task approach and Grok's unconditional prefix-based promise reuse: reuse useful work, but retain the existing admission authority.

### 5.7 Failure, cancellation and Attempt completion

A classified optional summary-service failure leaves the current projection authoritative and suppresses further optional attempts for the current Attempt, as #522 already requires. Primary may continue only through the ordinary gate with a fully admissible frozen request. Mandatory compaction remains available. Cancellation and uncertain durable state cannot be downgraded into optional summary failure.

At Attempt completion or cancellation, actively cancel outstanding work through the existing supervised Auxiliary abort/timeout path, stop future chunk starts and settle native business ownership before the Attempt terminal fact. A healthy Attempt does not wait for optional generation to finish normally. Teardown itself must be bounded: preserve confirmed or unknown usage and every unresolved start, retain any physical cleanup under the executor's existing containment/resident-ownership rules, and never treat cancellation as proof that the remote request did not run. If safe settlement/containment cannot be established, surface the native technical containment failure rather than waiting indefinitely or claiming released ownership.

A ready result may be considered once at its final eligible structural boundary; otherwise discard it. A cleanup-time completion cannot reopen the Attempt, append a late business event or create a later checkpoint. Committed checkpoints remain committed. Late callbacks are fenced by operation identity and never start primary work.

The baseline does not carry unfinished summary work across Attempts or process restarts. Crash recovery keeps the last committed checkpoint and actual request/usage evidence; a later Attempt can make a new bounded plan. Ordinary idle manual compaction keeps its existing coordinator ownership and admission.

### 5.8 Ownership and interface

Keep a small internal interface around capture, detached summary generation and validated installation:

- Context owns budgets, source selection, coverage proofs, candidate assembly and fit/progress validation.
- The Agent Loop owns the one background slot, safe installation phase, mandatory waiting, rapid-refill handling and suppression.
- Auxiliary owns supervised physical starts, chunk execution, cancellation, usage and settlement.
- Durable owns checkpoint activation, identity, fences, receipts and exact historical reconstruction.
- Runtime Client and Web/TUI consume these facts; UI completion callbacks never own activation.

Refactor the existing synchronous pipeline into these phases and make synchronous operation await the same generator. Do not preserve separate old synchronous and new asynchronous engines.

## 6. Required deterministic acceptance evidence

| Scenario | Expected result |
| --- | --- |
| Summary finishes after a request is staged but before its start transaction | Exact old request and Snapshot start unchanged; ready result waits |
| Summary finishes while a primary request, tool batch or transient retry is active | No history activation until the next eligible preparation/recovery phase |
| New user and tool messages arrive after capture | Entire new tail remains in order, once; fresh inbound stays protected |
| A tool result arrives later than its call | Eligible capture/install cannot split the pair; final compiler verifies associations |
| Blocking result has larger coverage, then old background completes | Late result settles superseded and cannot roll back head or clear a new slot |
| Retained, uncancelled older-selected candidate has strictly greater compatible coverage | Bounded proof and full fit permit activation at an eligible boundary; terminal rejection is never revived |
| Equal coverage, reversed finish order | Current active checkpoint remains; no duplicate marker |
| Different fork/reset/source projection authority | No comparison by numeric frontier alone and no automatic merge |
| Mandatory pressure during chunk N | Existing accepted progress is reused when useful; deadline and allowance do not reset |
| Old summary plus growing tail no longer fits | No partial activation; bounded blocking replacement or precise failure |
| Optional transport failure vs cancellation vs uncertain commit | Three distinct continuations; only the classified optional failure can permit admitted old input |
| Cancel/Attempt terminal races with ready delivery and commit grant | No unauthorized chunk or primary start, no post-terminal compaction events, committed receipt wins where authorized |
| Native-to-Prompt downgrade or reasoning exhausts output in background | Same #522 schema and total-output rules; no coverage advancement for invalid output |
| More than twelve normal chunks | Finite normal work is not charged as twelve exhausted recovery attempts |
| Rapid refill after repeated installations | Native progress-based finite detection; no per-turn budget reset or permanent Session disablement |
| Reconnect, cold load and superseded candidates | One true operation lineage, accurate spend, one marker only for each committed checkpoint |

Use barriers, channels and controlled clocks at actual capture, result-delivery, staging, start, commit-grant and commit boundaries. Do not claim race coverage from sleeps or static UI fixtures. Retain composed provider-emulator tests and real persistence/restart tests for any recovery claims.

## 7. Impact on #522 and #525

The current [#522 issue](https://github.com/Caismis/rustX/issues/522) specifies one native compaction kernel, sequential bounded chunks and final atomic activation. Async admission/generation/installation timing would extend its execution contract and should be incorporated coherently before implementation. It can retain its single focused native PR, without a generic background scheduler or a second durable authority. In particular, define the installation cut, cross-turn operation budget ownership, compatible coverage metadata, equal-result rule, current-tail validation and cancellation/terminal ordering.

[#525](https://github.com/Caismis/rustX/issues/525) remains downstream presentation work. Extend its native facts to distinguish generating, ready-for-installation, foreground-waiting and superseded/no-effect outcomes without turning a generated result into a completed checkpoint. Auxiliary spend remains visible for discarded candidates; default Chat still shows only the real operation status and committed summary marker.

The 90% trigger, one blocking replacement, equality policy and Attempt-scoped lifetime in this report are recommendations for review. Exact automatic-budget formulas remain part of #522's calibration and acceptance work.

## Verification scope

This research inspected immutable upstream source, specifications and test definitions, traced result consumers and checked current rustX main. It did not run either external application or its tests, make live model calls, benchmark latency, or validate every reconstructed production/provider path. The Grok tool-pair and stale-callback observations are expressly bounded source inferences, not reproduced failures. Runtime implementation and runtime test outcomes are not claimed.
