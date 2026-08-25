# herdr-mesh-safe

A safety-scoped MCP bridge for coordinating coding agents in
[Herdr](https://herdr.dev).

This repository is a fork of
[`runchr-works/herdr-mesh`](https://github.com/runchr-works/herdr-mesh). It keeps
the upstream MCP/Herdr integration and replaces unrestricted terminal lifecycle
with semantic waits and lease-scoped reviewers and writers.

Current package version: `0.1.0-safe.13`.

## Why this fork exists

An orchestration agent needs to inspect workers, send tasks, wait for results,
and reclaim completed capacity. Giving that agent arbitrary terminal commands,
raw key injection, or unscoped pane deletion creates unnecessary authority.

This bridge exposes the operations the coordinator needs while retaining these
invariants:

- no caller-supplied shell command or unrestricted terminal execution;
- no raw `send-keys`;
- no unscoped pane, tab, workspace, or session deletion;
- controller credentials are checked immediately before bridge prompts and lifecycle requests;
- every prompt to a retained agent is admitted only while all lifecycle and handoff-receipt stores are locked;
- result collection is bound to the exact leased pane and the accepted prompt cursor;
- automatic close requires an idle/done observation and an unchanged state cursor during output capture;
- a reviewer can be closed only through the lease created with it;
- a writer starts only in a linked Git worktree on a non-protected branch;
- concurrent writers cannot lease overlapping path scopes;
- releasing a writer preserves its branch, worktree, and bytes.

The bridge is a technical safety boundary. It does not decide whether a GitHub
Issue, spec, ownership declaration, commit, merge, migration, or deployment is
authorized. The coordinator and the target repository contract remain
authoritative.

## Architecture

```text
MCP client
   │ stdio
   ▼
herdr-mesh-safe
   ├── semantic Herdr waits and prompts
   ├── exclusive controller lease and fence
   ├── reviewer leases
   ├── writer lane leases
   ├── content-free handoff receipts
   └── read-only Git preflight
          │
          ▼
      Herdr CLI → Herdr socket → managed panes and agents
```

Lease records are stored outside Git with mode `0600` under:

```text
${HERDR_MESH_STATE_DIR:-~/.local/state/herdr-mesh}/reviewer-leases
${HERDR_MESH_STATE_DIR:-~/.local/state/herdr-mesh}/writer-leases
${HERDR_MESH_STATE_DIR:-~/.local/state/herdr-mesh}/adopted-pane-leases
${HERDR_MESH_STATE_DIR:-~/.local/state/herdr-mesh}/controller-leases
${HERDR_MESH_STATE_DIR:-~/.local/state/herdr-mesh}/handoff-receipts
```

## Governance adapters

Writer tools require an external governance process that accepts the work,
declares ownership, and records durable checkpoints. Read the
[`governance integration contract`](docs/governance-integration.md) before
enabling writers.

The [`GitHub control-plane example`](docs/examples/github-control-plane.md)
shows one practical adapter using Issues, a GitHub Project, PRs, and content-free
checkpoints. GitHub is an example, not a bridge dependency. A complete tool input
is available in [`manifest.json`](docs/examples/manifest.json).

The optional [`agent-control-skills`](https://github.com/nativestrider/agent-control-skills)
bundle provides reusable coordinator instructions for this governance boundary.
The bridge does not install those skills or inherit authority from them.

## Exposed tools

### Controller lifecycle

| Tool | Purpose |
| --- | --- |
| `herdr_controller_acquire` | Acquire the first controller generation from the caller's managed Herdr pane. |
| `herdr_controller_resume` | Rotate credentials after clear or MCP restart from the same agent identity. |
| `herdr_controller_takeover` | Transfer an expired lease after the predecessor is missing, done, or blocked. |
| `herdr_controller_renew` | Extend the current generation before it expires. |
| `herdr_controller_release` | Invalidate the generation after a durable checkpoint. |
| `herdr_controller_list` | Inspect controller identity and expiry without exposing fence tokens. |

Acquire or resume the project controller before any prompt, reviewer, writer, or cleanup mutation. The returned
lease id and fence token are ephemeral capabilities: pass them to mutating tools, but do not publish them in a
tracker, commit, log, or handoff. Read-only inventory and wait tools remain available without a controller lease.
The default lease lasts 15 minutes and must be renewed during long coordination turns.
`herdr_bridge_status` also reports each reservation lock as `absent`, `active`, `stale`, or `indeterminate`
without exposing its owner PID, lock id, or controller credentials. A foreign-host lock is deliberately
`indeterminate`; the bridge does not steal it on a time-to-live guess.

### Coordination

| Tool | Purpose |
| --- | --- |
| `herdr_relay` | Submit to one active leased agent and return a durable receipt. |
| `herdr_handoff` | Prompt and collect the exact receipt-bound result. |
| `herdr_batch_handoff` | Submit up to eight independent prompts and collect all results or the first result. |
| `herdr_collect_handoffs` | Collect one or more pending receipts without submitting a new prompt. |
| `herdr_handoff_receipt_list` | Inspect content-free receipt state. |
| `herdr_handoff_receipt_abandon` | Explicitly release an ambiguous barrier after the exact agent is settled. |
| `herdr_agent_list/get/read` | Inspect agents and their terminal output. |
| `herdr_agent_wait` | Wait for one exact Herdr state. |
| `herdr_agent_wait_settled` | Wait for `idle`, `done`, or `blocked`, then return state and output. |
| `herdr_agent_wait_any` | Wait for the first of up to 16 agents to settle; cancel losing waits. |
| `herdr_wait_output` | Wait for a pane output match. |

`after_seq` on the settled waits prevents a terminal state from earlier work
from satisfying a new wait. A single long MCP request replaces repeated
client-side polling; an SSE side channel is not required.
For a leased agent, prompt admission first requires an exact settled identity, then records the pre-delivery
cursor before submission. The receipt binds pane, name, agent kind, working directory, lifecycle lease, and
cursor. Relay returns only after Herdr confirms that exact identity entered `working` at the next
cursor. The resulting receipt is an opaque lookup key; it contains no fence, prompt, or output. Until that
receipt is completed, failed, or explicitly abandoned, every later prompt to that target is rejected. A lease
already in `closing` or `releasing` also rejects new prompts.

Batch handoff validates every target under the same controller fence and lifecycle reservations before it
submits any prompt. Every batch target must have one active retained lease; unleased legacy targets are rejected.
`mode=all` returns results in request order. `mode=first` cancels only the losing CLI waits; the other agents
continue working and are returned as `pendingReceipts`. Collection requires those tokens, waits strictly after
the accepted `working` cursor, and re-reads identity and sequence after output capture. A later task's output is
therefore rejected rather than mislabeled. A completed receipt may be replayed after a caller crash only while
its exact settled identity and cursor are still current. An ambiguous delivery remains a blocking `reserved` receipt. An
operator may release it only with `herdr_handoff_receipt_abandon`, valid controller authority, and a fresh
observation that the exact leased agent is settled.

### Controller CLI

`herdr-agent-control` is a local CLI for a named coordinator already holding the active controller lease. The
launcher must set `AGENT_CONTROL_CONTROLLER_ID` to that controller's stable id in the managed coordinator
environment. `status` and `receipts` are read-only and do not load the fence. Mutating commands load the lease
only after matching the current Herdr pane, agent name, kind, working directory, and Linux process ancestry to
the controller process recorded at acquire/resume. The fence never appears in arguments or output.

```text
herdr-agent-control status
herdr-agent-control receipts
herdr-agent-control ask TARGET -- MESSAGE
herdr-agent-control ask-many --request TARGET=MESSAGE --mode first
herdr-agent-control collect --receipt TOKEN
herdr-agent-control abandon --receipt TOKEN
```

`ask` and `ask-many` use the receipt-bound batch protocol. `collect` never submits a prompt. `abandon` never
stops a process; it only releases the admission barrier after the exact target is observed settled. Controller
leases created before process binding was introduced must be resumed once before the mutating CLI can use them.
The CLI does not start, close, stop, delete, commit, or execute arbitrary terminal commands.

The current controller lease is deliberately bound to a named agent in a managed Herdr pane. MCP clients
outside Herdr may use read-only inventory and wait tools, but they cannot acquire or exercise coordination
authority in this version. Supporting an external coordinator requires a separate authenticated caller
identity; it must not impersonate a pane or pass a self-declared identity.
Process ancestry is a fail-closed caller binding for the cooperative single-user host model, not isolation from
a hostile process with the same Unix account and permission to rewrite the mode-`0600` state files.

### Reviewer lifecycle

| Tool | Purpose |
| --- | --- |
| `herdr_owned_reviewer_start` | Create a dedicated no-focus reviewer tab and persistent lease. |
| `herdr_owned_reviewer_list` | List reviewer leases. |
| `herdr_owned_reviewer_close` | Capture and close one identity-matched idle/done reviewer. |
| `herdr_owned_reviewer_cleanup` | Dry-run or clean eligible leased reviewers for one controller. |

Reviewer identity includes controller, agent name and kind, pane, and working
directory. `working`, `blocked`, unleased, or identity-drifted panes are
preserved when observed. A newly created tab can exist before its root shell accepts an agent;
the bridge retries only the exact `agent_pane_busy` readiness condition in that
same leased pane for a bounded window. Other startup errors fail closed.
For Claude reviewers, the start manifest may pass an explicit `model` and `effort`; these values become native
Claude CLI arguments after `--`. Other agent kinds reject explicit model arguments until they have a reviewed
provider adapter.

### Writer lifecycle

| Tool | Purpose |
| --- | --- |
| `herdr_owned_worker_start` | Validate and reserve a manifest-scoped writer lane, then start its agent in a dedicated tab. |
| `herdr_owned_worker_list` | List writer lane leases. |
| `herdr_owned_worker_release` | Revalidate a checkpoint, capture output, and release the pane. |

### Host verification

| Tool | Purpose |
| --- | --- |
| `herdr_owned_worker_verification_snapshot` | Freeze the settled writer, Git-status, and worktree digests without executing repository code. |
| `herdr_owned_worker_verify` | Run the selected fixed recipe: `check-docs`, `check-authority`, or `check-fast`. |
| `herdr_owned_worker_verification_list` | List content-free verification records. |

Verification recipes are code from the leased repository. They run in a Linux Bubblewrap sandbox with fixed
arguments and no network. They are not a security boundary against an agent that already has the same host user.
The optional web bootstrap uses the committed lockfile, allows package downloads, and disables package lifecycle
scripts. A Python bootstrap may warm the run-local `uv` cache from explicitly named `requirements.lock` files;
each lock must be a regular, non-symlink file whose bytes match the accepted base commit and whose complete
dependency graph has SHA-256 hashes. The bridge mounts a base-derived copy read-only, ignores lane-local `uv`
configuration, disables source builds, and uses `uv pip` without starting Python while network is available. The
final gate remains offline and uses the same isolated cache. When the host resolver is a symlink outside `/etc`, a network-enabled bootstrap
mounts only its resolved file read-only; offline gates still use a separate network namespace.

### Legacy pane leases

Legacy agents created outside the bridge remain unowned until a coordinator adopts them through a cleanup-only
lease. Adoption verifies the exact named agent, pane, kind, working directory, settled state cursor, durable
authority, and protected panes. It grants no Git ownership or implementation authority.

| Tool | Purpose |
| --- | --- |
| `herdr_lease_inventory` | Classify live agents as lease-matched, identity-drifted, or unleased. |
| `herdr_lease_reconcile` | Dry-run or terminalize a failed lease only after the exact pane is confirmed absent. |
| `herdr_owned_pane_adopt` | Create a cleanup-only lease for one idle/done legacy agent. |
| `herdr_owned_pane_list` | List cleanup-only leases. |
| `herdr_owned_pane_close` | Capture and close one adopted pane after a fresh cursor and durable checkpoint. |

Writer admission requires:

- durable ticket and authority references plus an accepted SHA-256 digest;
- an absolute linked Git worktree, not the repository's primary checkout;
- exact branch, base commit, HEAD, and Git-status digest;
- at least one protected branch, normally the configured default branch;
- literal repository-relative owned scopes without globs or `..`;
- explicit locked scopes;
- no existing Herdr agent in the worktree;
- no retained lease for the branch, worktree, overlapping ownership, or locked
  scope.

Reservations and releases use an atomic store lock. A crash may deliberately
leave a retained reservation that requires inspection; it must never admit two
writers merely to recover automatically.
On Linux, new reservation locks include the boot id and process start time, so a reboot or reused PID is
recognized as stale. `herdr_bridge_status` exposes ambiguous legacy or foreign-host locks as `indeterminate`;
inspect those before any manual recovery instead of deleting them by age.

### Read-only topology and discovery

The safe profile also exposes read-only session, pane, tab, workspace, and
integration inspection. Raw lifecycle tools remain filtered by the allow-list in
[`src/server.ts`](src/server.ts).

## Requirements

- Linux or macOS with Node.js 18 or newer; host verification additionally requires Linux and Bubblewrap;
- Git;
- [Herdr](https://herdr.dev) installed and running;
- the Herdr integration for each agent kind you plan to launch;
- an MCP-capable client such as Codex, Claude Code, or OpenCode.

Check Herdr before installation:

```bash
herdr status
herdr integration status
```

Install missing integrations, for example:

```bash
herdr integration install codex
herdr integration install claude
```

## Install from source

```bash
git clone https://github.com/nativestrider/herdr-mesh-safe.git
cd herdr-mesh-safe
npm ci
npm test
npm run build
```

The compiled MCP entrypoint is `dist/index.js`.

### Codex

Add this to `~/.codex/config.toml`, using the absolute clone path:

```toml
[mcp_servers.herdr-mesh]
command = "node"
args = ["/absolute/path/to/herdr-mesh-safe/dist/index.js"]
```

### Claude Code

```bash
claude mcp add -s user herdr-mesh node /absolute/path/to/herdr-mesh-safe/dist/index.js
```

### OpenCode or another MCP client

Register a local stdio MCP server named `herdr-mesh` with:

```text
command: node
arguments: /absolute/path/to/herdr-mesh-safe/dist/index.js
```

Restart the MCP client after installation or every bridge update. `/clear` or a
new conversation inside the same process does not reload an already running MCP
server.

## Optional environment

| Variable | Meaning |
| --- | --- |
| `HERDR_BIN` | Absolute Herdr executable when `herdr` is not on `PATH`. |
| `HERDR_MESH_STATE_DIR` | Parent directory for persistent lease stores. |

The MCP process must be able to reach the same Herdr socket as the managed
workspace. A coordinator already running inside Herdr can use the Herdr CLI, but
the bridge still provides narrower authority, event-style waits, and verified
lifecycle.

## How to use it

Users normally speak to the coordinator rather than invoking tool names.

### Wait for several agents

```text
Wait for the first active worker to become idle, done, or blocked. Use each
worker's last state-change sequence so an old idle state is not accepted.
```

The coordinator uses `herdr_agent_wait_any` and receives the first terminal
state plus visible output in one result.

### Run a read-only external review

```text
Create a leased Claude reviewer in a dedicated tab rooted at the ticket worktree, ask it to review the
exact PR head against Standards and Spec, wait for its result, then reclaim the
reviewer pane if it is idle or done.
```

The expected sequence is:

1. `herdr_controller_acquire` or `herdr_controller_resume`
2. `herdr_owned_reviewer_start` with the controller lease/fence and, for Claude, the exact model/effort
3. `herdr_relay` with the same controller lease/fence and retain its receipt
4. `herdr_collect_handoffs` with that receipt
5. `herdr_owned_reviewer_close` with the same controller lease/fence

### Start a writer lane

The coordinator first validates the accepted ticket/spec, dependencies,
ownership, locks, and integration order against durable project state. It then
collects the exact local evidence, including:

```bash
git -C /absolute/worktree rev-parse HEAD
git -C /absolute/worktree status --porcelain=v1 --untracked-files=all | sha256sum
```

It calls `herdr_owned_worker_start` with that evidence. The tool independently
re-reads Git, reserves ownership, creates a dedicated no-focus tab, starts the agent in its root pane, and verifies
its identity before returning an active lease.

The bridge does not confine filesystem writes to the declared scopes. The
coordinator must still compare the final changed paths and diff with the lease,
ticket, and repository contract.

### Release a writer

Before release, record a content-free durable checkpoint containing the current
branch, HEAD, dirty-state digest, completed proof, blockers, and next action.
Then call `herdr_owned_worker_release` with the checkpoint reference and digest
plus the freshly observed agent state cursor and Git values.

Release closes only the leased pane. It does not commit, stash, reset, clean,
delete, or modify the worktree.

Herdr's current `pane close` command does not accept an expected agent state or cursor. The bridge therefore
checks identity, settled status, cursor stability, and controller authority immediately before requesting the
close, but the final check and Herdr close are not one atomic operation. Do not send a manual Herdr prompt or
otherwise reuse that pane after close begins. Conditional close requires support in Herdr itself.

## Deliberate limitations

- Independent clones are not accepted as writer lanes in this version; use
  linked Git worktrees.
- Existing workers created before leases are not automatically adopted.
- The bridge cannot prove that a GitHub Issue grants authority.
- Ownership is checked at admission and during final coordination; it is not an
  operating-system filesystem sandbox.
- Controller fencing and cursor checks prevent stale bridge operations, but Herdr does not atomically combine
  those checks with prompt delivery or pane close. Same-user direct CLI activity remains outside this boundary.
- Human dialogs and `blocked` agents remain human decisions.
- Commit, push, PR, merge, deployment, migration, and runtime authority remain
  outside this bridge.

## Development

```bash
npm ci
npm test
npm run build
npm audit --omit=dev
```

Tests cover the installed Herdr CLI argument contract, cursor-aware waits,
controller fencing and takeover, batch lease identity, sandbox resolver binding, reviewer leases, writer
ownership conflicts, protected branches, Git-state
digests, and checkpointed release.

The built `dist/` directory is committed so clients can run the bridge without a
TypeScript toolchain. Change source first, run the full commands above, and
commit source, tests, lockfile, and generated output together.

## Upstream and license

Based on `runchr-works/herdr-mesh` at upstream commit `54adef5`. Upstream remains
the source for the generic Herdr MCP transport and installer; this fork owns the
safe allow-list, semantic waits, and lease lifecycle.

Licensed under the MIT License. See [`LICENSE`](LICENSE); the upstream copyright
notice is preserved.
