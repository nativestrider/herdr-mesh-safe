# GitHub control-plane example

This example shows how a coordinator can use GitHub Issues and a GitHub Project
as the durable governance adapter for `herdr-mesh-safe`.

GitHub is optional. The bridge itself makes no GitHub API call. Read the generic
[`governance integration contract`](../governance-integration.md) first.

## Example project

Assume the project has:

- repository `example-org/research-app`;
- default branch `main`;
- one open destination spec in Issue `#74`;
- one implementation ticket in Issue `#85`;
- linked worktree `/srv/work/research-app-wt-0085`;
- branch `codex/0085-evidence-contract`;
- coordinator id `research-app`.

The project uses these GitHub artifacts:

| Artifact | Role |
| --- | --- |
| Spec Issue `#74` | Editable accepted destination and revision history. |
| Ticket Issue `#85` | Small executable lane derived from the spec. |
| Native dependencies | Blocker graph and ready frontier. |
| Project fields | Status, stage, type, and human-facing overview. |
| Issue comments | Content-free dispatch, proof, checkpoint, and blocker records. |
| Pull request | Reviewable delivery candidate for the exact lane head. |

Code and tests remain the source of truth for implemented behavior. Closed
Issues are historical governance evidence, not a live description of the code.

## 1. Accept the destination revision

The coordinator reads the spec body, comments that amend it, and current code.
A human accepts one revision. The control plane records a stable digest of the
canonical accepted representation, for example:

```text
authority_ref: https://github.com/example-org/research-app/issues/74
authority_sha256: 8b1d…64-hex-characters…c931
```

The digest identifies the accepted revision used to derive tickets. It does not
prove that the revision is correct or that a human accepted it; the GitHub
workflow must preserve that evidence. The adapter must define the exact UTF-8
bytes included in the representation, including how accepted amendments are
ordered, so recovery produces the same digest.

## 2. Admit the ticket to the frontier

Before dispatch, the coordinator confirms Issue `#85`:

- is open and marked ready for an agent;
- links to spec `#74` and its accepted digest;
- has no incomplete blockers;
- declares owned paths, locked paths, branch, worktree, and integration order;
- has no active writer or conflicting lane;
- requires no unresolved product or authority decision.

Then it assigns the ticket, moves its Project status to `In Progress`, and adds a
content-free dispatch comment. A useful comment identifies the ticket, accepted
digest, agent name, branch, worktree label, base, ownership, locks, and lease id;
it contains no credential, customer data, private content, or object locator.

## 3. Build the bridge manifest

The coordinator re-reads Git immediately before calling the bridge:

```bash
git -C /srv/work/research-app-wt-0085 rev-parse HEAD
git -C /srv/work/research-app-wt-0085 status --porcelain=v1 --untracked-files=all | sha256sum
```

It fills the manifest from
[`manifest.json`](manifest.json), replacing every illustrative value with current
evidence. `protected_branches` contains at least `main`.

The call to `herdr_owned_worker_start` is valid only while those exact Git values
remain current. If the bridge reports a different branch, HEAD, status digest,
occupant, lock, or ownership lease, the coordinator returns to recovery. It does
not copy the reported value into a retry without explaining the change.

## 4. Dispatch and monitor

After the bridge returns an active lease, the coordinator adds its id to the
dispatch comment and sends one ticket-scoped prompt through `herdr_relay`.

The prompt contains:

- ticket and accepted spec references;
- branch, worktree, and exact base;
- owned and locked scopes;
- required repository contracts;
- focused checks during implementation;
- final gate and review requirements;
- forbidden external effects;
- checkpoint and reporting format.

The coordinator records the worker's current `state_change_seq` and waits for new
work with `herdr_agent_wait_settled`. For several independent lanes it uses
`herdr_agent_wait_any` with one cursor per worker.

Terminal states mean:

| State | Governance action |
| --- | --- |
| `idle` | Read the result and validate whether the requested step completed. |
| `done` | Read the result and begin proof/release reconciliation. |
| `blocked` | Surface the exact human decision; continue other independent lanes. |

Dispatch is not completion. The coordinator retains ownership until proof,
review, integration, tracking, and the next frontier agree.

## 5. Prove the lane

The writer stabilizes its bytes and runs the repository-selected checks. The
coordinator then obtains independent reviews along two axes:

- **Standards:** the diff follows repository contracts and coding standards.
- **Spec:** the diff implements Issue `#85` and the accepted revision of spec
  `#74` without missing behavior or scope creep.

Corrections invalidate affected proof. The coordinator re-runs the required
checks and reviews on the final digest.

Before delivery, compare every changed and untracked path with `owned_scopes`
and confirm every `locked_scope` is unchanged. The bridge lease records the
declared boundary but does not enforce filesystem writes.

## 6. Record the checkpoint

When the writer can safely stop, the coordinator writes a content-free Issue
comment containing:

```text
Ticket: #85 — implement the evidence contract
Accepted spec: #74 at digest <sha256>
Lease: <writer lease id>
Branch and HEAD: codex/0085-evidence-contract at <full object id>
Preserved state: <dirty-path inventory or digest>
Proof: <commands actually run and results>
Reviews: Standards <result>; Spec <result>
Blockers: <none or exact unresolved decision>
Next safe action: <one concrete action and owner>
```

Hash the exact published checkpoint representation and retain its GitHub comment
URL. These become `checkpoint_sha256` and `checkpoint_ref` for release.

## 7. Release the writer

Re-read HEAD and the porcelain status digest, then call
`herdr_owned_worker_release`. The tool verifies:

- controller and lease identity;
- agent name, kind, pane, and worktree;
- agent state is `idle` or `done`;
- branch, base ancestry, HEAD, and status digest;
- checkpoint reference and digest are present.

Successful release closes the pane and marks the lease `released`. It preserves
the Git worktree and all bytes.

## 8. Deliver outside the bridge

Commit, push, PR creation, hosted checks, merge, Issue closure, and Project state
changes follow the project's separate delivery authority. For example:

- a human-gated project pauses before each external mutation;
- a through-merge project may commit and merge a proven lane when its exact
  policy conditions pass;
- protection bypass, force push, deployment, migration, and runtime effects
  remain separate human gates.

After every delivery mutation, re-read GitHub and Git. A changed head or base
invalidates affected evidence.

Close Issue `#85` only after its implementation and proof are complete. Archive
spec `#74` only when every accepted ticket and applicable end-to-end proof is
complete.

## Recovery after context loss

A fresh coordinator session reconstructs state from:

1. repository and Project identity;
2. open spec and accepted digest;
3. tickets, dependencies, assignments, Project status, and comments;
4. branches, worktrees, heads, and dirty paths;
5. Herdr agents and panes;
6. bridge reviewer and writer leases;
7. PR heads, checks, reviews, and merge state.

If GitHub says a lane is active but no matching lease or agent exists, preserve
the worktree and investigate. If a lease is retained but GitHub has no matching
active lane, preserve the lease and investigate. Recovery never resolves a
disagreement by deleting state.

## GitHub permissions

Separate observation from delivery:

- a read-only evidence role reads repository, Issues, PRs, Actions/statuses, and
  Project state using narrowly scoped credentials;
- a delivery role performs only the GitHub mutations allowed by project policy;
- ordinary subagents remain offline unless their bounded task requires an
  explicitly reviewed network profile.

No token is stored in the bridge repository or lane manifest. The bridge needs
no GitHub credential.
