# Governance integration contract

Read this document before using `herdr_owned_worker_start` or integrating the
bridge with a tracker or control plane.

`herdr-mesh-safe` is an execution guard, not a project authority. A governance
adapter must decide which work is accepted and must produce a complete lane
manifest. The bridge then verifies local Git and Herdr facts and prevents
conflicting leased writers.

## Responsibility boundary

```text
Governance adapter
  accepts destination, ticket, ownership, dependencies, locks, and authority
          │
          │ lane manifest + accepted authority digest
          ▼
herdr-mesh-safe
  verifies Git/Herdr state and reserves a writer lease
          │
          │ identity-checked writer pane
          ▼
Worker
  changes bytes and produces tests, reviews, and a durable checkpoint
          │
          ▼
Governance adapter
  validates the result and decides commit, integration, closure, or reroute
```

The tracker can be GitHub, GitLab, Jira, Linear, or another durable system. The
bridge treats `ticket_ref`, `authority_ref`, and `authority_sha256` as opaque
evidence. It stores them but does not fetch or interpret them.

## Adapter obligations

Before requesting a writer, the governance adapter must establish:

1. **Accepted destination.** Identify the exact accepted spec or work order and
   define its canonical byte representation before computing a stable digest.
   The same accepted revision must produce the same digest after restart.
2. **Executable ticket.** Confirm the ticket is open, implementation-ready,
   derived from that accepted destination, and not superseded.
3. **Dependency frontier.** Confirm every blocker is complete or explicitly
   waived by the authority that owns the destination.
4. **Single ownership.** Assign one writer, branch, linked worktree, and set of
   literal path scopes. Resolve semantic or generated-artifact coupling even
   when paths do not overlap.
5. **Locks.** Include shared files and contracts that the writer must preserve.
6. **Delivery boundary.** Record whether the coordinator may commit, push, open
   a PR, or merge. These actions remain outside this bridge.
7. **Current evidence.** Read branch, base, HEAD, and the complete porcelain Git
   status immediately before calling the tool.

Admission is ready only when every item has one durable answer. Missing or
ambiguous authority is a governance blocker, not a value for the bridge to
infer.

## Writer manifest

The tool input is the machine-readable lane manifest. See
[`examples/manifest.json`](examples/manifest.json) for a complete example.

### Authority fields

| Field | Governance meaning |
| --- | --- |
| `controller_id` | Stable project/control-plane identity that owns the lease. |
| `purpose` | Short human-readable lane outcome. |
| `ticket_ref` | Durable identifier for the executable ticket. |
| `authority_ref` | Durable identifier for the accepted spec or work order. |
| `authority_sha256` | Digest of the exact accepted authority revision. |

The bridge checks the SHA-256 shape but cannot prove that the referenced bytes
were accepted. The adapter must fetch and hash the authoritative representation
without including credentials or private content in logs.

### Git identity fields

| Field | Bridge validation |
| --- | --- |
| `worktree` | Absolute path, repository root, and linked Git worktree. |
| `branch` | Exact currently checked-out branch. |
| `base_commit` | Full object id and ancestor of the current HEAD. |
| `expected_head` | Full object id equal to the current HEAD. |
| `expected_status_sha256` | SHA-256 of the exact porcelain status bytes. |
| `protected_branches` | The adapter must include at least the project's default branch. The bridge rejects the selected branch when it appears in this list, but cannot identify the project's default branch itself. |

The writer tool rejects a primary checkout. This protects canonical checkouts
but means independent clones are not writer lanes in the current profile.

Compute the status digest from exact bytes, including the final newline:

```bash
git -C /absolute/worktree status --porcelain=v1 --untracked-files=all | sha256sum
```

Recompute it immediately before admission. Do not reuse a digest after any file,
index, branch, or HEAD change.

### Ownership fields

| Field | Meaning |
| --- | --- |
| `owned_scopes` | Repository-relative files or directories the lane may change. |
| `locked_scopes` | Repository-relative files or directories the lane must preserve. |

Scopes use literal path segments. Globs, absolute paths, backslashes, and `..`
are rejected. Two scopes overlap when they are equal or when one is a parent
directory of the other.

Examples:

```text
docs/adr                     overlaps docs/adr/0032-example.md
docs/adr/0031-example.md     does not overlap docs/adr/0032-example.md
```

Use file-level ownership when a directory also contains locked shared files.
The bridge detects overlap between active leases, but the governance adapter
must also identify contract coupling that is invisible from paths, such as a
schema migration and all callers that depend on it.

### Herdr fields

| Field | Meaning |
| --- | --- |
| `parent_pane_id` | Existing pane that receives the no-focus split. |
| `name` | Unique Herdr agent name for the lane. |
| `kind` | Installed Herdr integration, such as `codex` or `claude`. |
| `direction` | Optional split direction: `right` or `down`. |
| `start_timeout_ms` | Optional readiness timeout, at most 300 seconds. |

## Admission sequence

The governance adapter performs these steps in order:

1. Recover tracker, Git, and Herdr state.
2. Validate the authority and complete the manifest.
3. Call `herdr_owned_worker_list` and reconcile every retained lease with the
   durable tracker. Preserve unexplained leases.
4. Call `herdr_owned_worker_start` once.
5. Store the returned lease id with the lane's durable, content-free dispatch
   record.
6. Send the implementation prompt through `herdr_relay`.
7. Monitor with `herdr_agent_wait_settled` or `herdr_agent_wait_any`, using the
   last `state_change_seq` as `after_seq` for new work.

Admission completes only when the bridge returns an `active` lease whose agent
name, kind, pane, and worktree match the manifest. A failed admission creates no
authority to retry with changed evidence; the adapter must explain and reconcile
the mismatch first.

## What reservation guarantees

The persistent lease blocks another leased writer from using the same:

- linked worktree;
- branch;
- overlapping owned scope;
- scope locked by a retained lease.

The reservation is serialized across bridge processes with an atomic local
store lock. A crash can leave `provisioning`, `orphaned`, `releasing`, or
`release_failed` state. These states retain ownership until a human or a
reviewed recovery procedure reconciles the actual agent, pane, Git state, and
durable tracker.

The lease does not sandbox filesystem writes. Final changed paths and behavior
must still be compared with the manifest and accepted ticket.

## Checkpoint and release

Before releasing a writer, the governance adapter records a durable,
content-free checkpoint (identifiers, digests, status, and commands, but no
source content, customer content, credentials, or object locators) containing:

- ticket and accepted authority revision;
- lease id, branch, worktree identity, and current HEAD;
- dirty-path inventory or digest to preserve;
- checks and reviews actually completed;
- blockers and unresolved human decisions;
- exact next safe action.

Compute a digest of that exact checkpoint and call
`herdr_owned_worker_release` with:

- the lease and controller ids;
- freshly observed HEAD and Git-status digest;
- checkpoint reference and SHA-256 digest.

The bridge releases only an identity-matched `idle` or `done` writer. It captures
visible terminal output and closes the leased pane. The worktree, branch, index,
and files remain unchanged.

Release completes when the lease is `released` and the governance adapter has
re-read Git, Herdr, and the tracker. Commit, push, PR, merge, ticket closure, and
spec archival remain separate governance actions.

## Recovery

At coordinator startup or after context loss:

1. List writer and reviewer leases.
2. List live Herdr agents and panes.
3. Inspect every referenced worktree and branch read-only.
4. Reconcile leases with the durable tracker and accepted authority digest.
5. Treat unexplained agents, missing panes, changed identities, and retained
   non-terminal leases as blockers.
6. Resume or reroute only after each active lane has one evidenced owner.

Existing agents created without leases are legacy topology. The bridge refuses
to start another writer in an occupied worktree and does not silently adopt or
close the existing agent.

## Adapter completion criteria

A governance adapter is safe to use with writer tools only when it can
demonstrate all of these properties:

- accepted authority is durable and revision-addressable;
- every dispatch has one complete manifest and one writer;
- ownership and locks are reconciled across all active lanes;
- state changes are observed using current cursors;
- every release has a durable checkpoint;
- delivery and runtime effects have separate explicit authority;
- recovery succeeds without conversational memory.

The [GitHub control-plane example](examples/github-control-plane.md) shows one
implementation of this contract. It is an adapter example, not a bridge
dependency.

The optional
[`agent-control-skills`](https://github.com/nativestrider/agent-control-skills)
bundle implements reusable coordinator instructions for this boundary. It is
not bridge authority and remains subordinate to the target project's contract.
