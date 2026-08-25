# herdr-mesh-safe

A safety-scoped MCP bridge for coordinating coding agents in
[Herdr](https://herdr.dev).

This repository is a fork of
[`runchr-works/herdr-mesh`](https://github.com/runchr-works/herdr-mesh). It keeps
the upstream MCP/Herdr integration and replaces unrestricted terminal lifecycle
with semantic waits and lease-scoped reviewers and writers.

Current package version: `0.1.0-safe.5`.

## Why this fork exists

An orchestration agent needs to inspect workers, send tasks, wait for results,
and reclaim completed capacity. Giving that agent arbitrary terminal commands,
raw key injection, or unscoped pane deletion creates unnecessary authority.

This bridge exposes the operations the coordinator needs while retaining these
invariants:

- no arbitrary shell execution;
- no raw `send-keys`;
- no unscoped pane, tab, workspace, or session deletion;
- a blocked or working agent is never closed automatically;
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
   ├── reviewer leases
   ├── writer lane leases
   └── read-only Git preflight
          │
          ▼
      Herdr CLI → Herdr socket → managed panes and agents
```

Lease records are stored outside Git with mode `0600` under:

```text
${HERDR_MESH_STATE_DIR:-~/.local/state/herdr-mesh}/reviewer-leases
${HERDR_MESH_STATE_DIR:-~/.local/state/herdr-mesh}/writer-leases
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

### Coordination

| Tool | Purpose |
| --- | --- |
| `herdr_relay` | Submit a prompt to an existing agent. |
| `herdr_handoff` | Prompt, wait, and read back a result. |
| `herdr_agent_list/get/read` | Inspect agents and their terminal output. |
| `herdr_agent_wait` | Wait for one exact Herdr state. |
| `herdr_agent_wait_settled` | Wait for `idle`, `done`, or `blocked`, then return state and output. |
| `herdr_agent_wait_any` | Wait for the first of up to 16 agents to settle; cancel losing waits. |
| `herdr_wait_output` | Wait for a pane output match. |

`after_seq` on the settled waits prevents a terminal state from earlier work
from satisfying a new wait. A single long MCP request replaces repeated
client-side polling; an SSE side channel is not required.

### Reviewer lifecycle

| Tool | Purpose |
| --- | --- |
| `herdr_owned_reviewer_start` | Create a no-focus reviewer pane and persistent lease. |
| `herdr_owned_reviewer_list` | List reviewer leases. |
| `herdr_owned_reviewer_close` | Capture and close one identity-matched idle/done reviewer. |
| `herdr_owned_reviewer_cleanup` | Dry-run or clean eligible leased reviewers for one controller. |

Reviewer identity includes controller, agent name and kind, pane, and working
directory. `working`, `blocked`, unleased, or identity-drifted panes are
preserved.

### Writer lifecycle

| Tool | Purpose |
| --- | --- |
| `herdr_owned_worker_start` | Validate and reserve a manifest-scoped writer lane, then start its agent. |
| `herdr_owned_worker_list` | List writer lane leases. |
| `herdr_owned_worker_release` | Revalidate a checkpoint, capture output, and release the pane. |

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

### Read-only topology and discovery

The safe profile also exposes read-only session, pane, tab, workspace, and
integration inspection. Raw lifecycle tools remain filtered by the allow-list in
[`src/server.ts`](src/server.ts).

## Requirements

- Linux or macOS with Node.js 18 or newer;
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
Create a leased Claude reviewer in the ticket worktree, ask it to review the
exact PR head against Standards and Spec, wait for its result, then reclaim the
reviewer pane if it is idle or done.
```

The expected sequence is:

1. `herdr_owned_reviewer_start`
2. `herdr_relay`
3. `herdr_agent_wait_settled`
4. `herdr_owned_reviewer_close`

### Start a writer lane

The coordinator first validates the accepted ticket/spec, dependencies,
ownership, locks, and integration order against durable project state. It then
collects the exact local evidence, including:

```bash
git -C /absolute/worktree rev-parse HEAD
git -C /absolute/worktree status --porcelain=v1 --untracked-files=all | sha256sum
```

It calls `herdr_owned_worker_start` with that evidence. The tool independently
re-reads Git, reserves ownership, creates the pane, starts the agent, and verifies
its identity before returning an active lease.

The bridge does not confine filesystem writes to the declared scopes. The
coordinator must still compare the final changed paths and diff with the lease,
ticket, and repository contract.

### Release a writer

Before release, record a content-free durable checkpoint containing the current
branch, HEAD, dirty-state digest, completed proof, blockers, and next action.
Then call `herdr_owned_worker_release` with the checkpoint reference and digest
plus freshly observed Git values.

Release closes only the leased pane. It does not commit, stash, reset, clean,
delete, or modify the worktree.

## Deliberate limitations

- Independent clones are not accepted as writer lanes in this version; use
  linked Git worktrees.
- Existing workers created before leases are not automatically adopted.
- The bridge cannot prove that a GitHub Issue grants authority.
- Ownership is checked at admission and during final coordination; it is not an
  operating-system filesystem sandbox.
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
reviewer leases, writer ownership conflicts, protected branches, Git-state
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
