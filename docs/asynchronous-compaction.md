# Independent asynchronous compaction

The active ConversationRuntime owns one Session-scoped proactive Compaction
Operation, including any completed result awaiting installation. One blocking
recovery or idle manual operation may compete with it. The triggering Attempt
is attribution; an Attempt waiting for a result is a consumer. Neither owns
the asynchronous operation's lifetime.

## Execution and installation

All modes share the Context capture, sequential generation and activation
kernel. Capture freezes a finite historical prefix, Resource Read Cut,
invocation, Profile, media rendering, source identities and cumulative work
allowance. Generation accepts ordered, fully priced source fragments and
returns a detached result. Intermediate JSON grants no projection authority.

The Agent Loop accepts next-step contributors once, takes one ready-result
consumption cut, validates any selected result, decides pressure and then
stages and freezes the primary request. Later optional completions wait for
the next boundary. They cannot change a staged request, streaming/tool turn
or transient replay. Structurally incomplete tool history is never captured
or installed. The idle coordinator may install a ready result in its existing
serialized maintenance slot without starting an Attempt.

The automatic trigger remains `floor(0.9 * H)`, where
`H = primary window - primary output - automatic margin`. An admissible
request can proceed while its background summary runs. Mandatory admission
or actual provider overflow may consume useful existing work in the recovery
phase, then restage through the ordinary start gate. If that frozen prefix
cannot provide enough reduction, one bounded blocking replacement uses a
fresh current cut. It does not renew an earlier operation's allowance.

## Coverage and current authority

Native coverage identifies a continuous logical prefix within an immutable
root: either the conversation's original history or one exact opaque
checkpoint. A prior authenticated summary represents its complete covered
prefix. Its logical coordinate can advance across later summaries without
comparing message counts from different projections. Different roots remain
incomparable. Clone, Fork and artifact remapping start an owned opaque root;
imported coverage does not carry source installation authority.

The validated ChunkPlan cursor mints an in-process complete-source witness
only after accepting every captured range. A sealed proof binds the original
cut and source prefix, frozen rendered roles/offsets, accepted generated
summary and actual generation dependency. Serialized coverage metadata cannot
recreate that proof or authorize a write.

At activation, the current owner reads a coherent current projection and cut,
compares authenticated coverage and constructs a fresh candidate. Compatible
strict advancement is eligible; equal coverage keeps the installed result;
smaller coverage is superseded; unprovable or incomparable coverage is refused.
Completion time does not decide precedence. Current retained history and all
later appends survive in order exactly once, with remapped tool occurrences.

The complete current primary request must fit and historical size must
decrease before the existing atomic checkpoint, activation, completion and
receipt transaction. Fresh input and accepted request-only context remain
protected. Current owner/source fences, cancellation authorization and Head
CAS still apply. A proven CAS loss permits a bounded reread/comparison;
corruption, lost fencing and uncertain commit retain distinct handling.
Exact receipt reconciliation precedes any interpretation of a write failure.

## Limits, timing and lifecycle

The shared generator retains the source/resource limits, at most 256 normal
fragment starts, twelve shared exceptional recovery actions and at most three
input reductions. Accepted fragments are not replayed on ordinary re-entry.
Each physical Call retains frozen strategy, actual request/usage settlement
and its preceding-Call chain.

Asynchronous work retains the original Auxiliary scope deadline and existing
request, retry/backoff and EOF supervision. Its source plan adds no overall
compaction deadline; a fully accepted ready result has no age TTL. Joining,
retrying and a new Attempt do not refresh its Auxiliary scope. Newly admitted
blocking/manual work retains the plan-derived absolute deadline described in
[Context Engine](context-engine.md#auxiliary-summary-retry-allowance).

Proactive inference uses ordinary Auxiliary capacity; blocking and manual
compaction retain protected capacity. The existing conversation/process total
and general limits remain 4/3 and 32/24.

Attempt completion/cancellation stops its own primary work and waiters, while
independent generation continues. Proven supersession revokes future starts
without reclaiming physically held permits. Drain, deletion, authoritative
durability failure and native cancellation retain physical join ownership.
An already granted commit remains committed after cancellation.

Automatic Session configuration commits retain the existing foreground
boundary. A prepared generation may commit between Attempts while an
independent Summary keeps its original resources. Idle installation validates
against the newly committed generation. Residency still sees active background
work, and drain waits for its real cleanup.

## Native observations and restart

OperationId and admission generation identify every status and completion.
Trigger attribution, foreground waiter, accepted-fragment count and current
phase are separate bounded facts. Ready is distinct from committed. Only an
actual committed checkpoint creates the durable summary marker; chunks and
superseded results do not. Late callbacks cannot complete or clear another
operation's progress.

Runtime Client retains at most two operation records and operation-matched
foreground progress. Indexed frozen-cut reads recover historical observations
without replaying work. Process-local generation and ready bodies are not a
persistent queue. Reopening reconciles an actual committed receipt or records
interruption without asserting that unresolved provider work never executed.
Primary occupancy and separately attributed Auxiliary usage retain their
measurement provenance; absent usage is unknown.

App Server v74, Runtime Client 85 and SQLite 87 carry the new contract. Child
IPC remains 38 because its control/activity messages do not carry these DTOs.
Web and TUI consume the same native facts; presentation owns no policy,
retry decision or installation permission.
