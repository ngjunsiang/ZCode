# Draft: membership-cache over-invalidation — minimal patch for v3.15.1  {investigated 2026-10-14}

Status: **investigated, not landed**. Targets `upstream/main` (aac47556 = v3.15.1).
Would become U44 if landed on a `patch/<release>` branch. Upstream has no intake
channel (issues disabled, zero PRs ever, no CONTRIBUTING) — fork patch is the
only route unless that changes.

## The defect (present identically in v3.14.3 and v3.15.1)

`fetchTaskListMembershipSetsForEndpointsCached` (`taskListMembershipSets.ts`) was
built so membership refetches are driven by `membershipVersion` — its own comment:
"membership 只随 membershipVersion 变化，按版本缓存避免每次内容帧都重拉".
But the caller wedges the full sessions-index version into the cache key
(`useWorkspaceTaskLists.ts:536`):

```
membershipCacheKey: `${membershipVersion}::workspace::${shard.shardKey}::${shardConfigs
  .map((config) => `${config.workspaceKey}@${taskListVersionSignature}`)
  .join("|")}`
```

`taskListVersion` bumps on every bot broadcast that arrives without taskMeta
(`useBotBroadcastEffects.ts` `shouldRefreshBotTaskList`: `updated`/`completed`/
`error` without meta → bump), i.e. ~1 Hz+ while any task streams. Each bump:
new key → cache miss → 4 RPCs (`listTasks`/`listArchivedTasks`/
`listPinnedTasks`/`listDeletedTaskIds`) per shard endpoint + merge + rebuild +
sidebar re-render. Measured on the user's real workload: 80 RPCs in one 15 s
stream (3.14.3 dev build); installed 3.14.5 journal shows the same 4-RPC bursts
~1/s. Byte-identical code in 3.15.1 (verified via `git show upstream/main:…`).

Upstream's event policy already covers the real invalidation needs
(`shouldRefetchTaskListMembershipForWorkspaceEvent`: membership ops +
`task_created` + `task_deleted` + `task_meta_changed` → membershipVersion);
status/updatedAt churn is deliberately incremental (taskMeta-carrying events)
or live via sessions-index. The version-in-key contradicts the stated design —
likely leftover from the era when query keys carried the full-tab signature
(the sibling comment in the same function documents fixing queryKey to
per-workspace but the membership key kept the whole signature).

## Minimal patch (2 files, ~10 lines)

1. **Drop the version from the key** — `useWorkspaceTaskLists.ts:536-539`:

```diff
-              membershipCacheKey: `${membershipVersion}::workspace::${shard.shardKey}::${shardConfigs
-                .map((config) => `${config.workspaceKey}@${taskListVersionSignature}`)
-                .join("|")}`,
+              membershipCacheKey: `${membershipVersion}::workspace::${shard.shardKey}::${shardConfigs
+                .map((config) => config.workspaceKey)
+                .join("|")}`,
```

2. **TTL backstop** — `taskListMembershipSets.ts`, bound staleness from any
   bump path that no longer invalidates the key:

```diff
-const membershipPromiseByCacheKey = new Map<string, Promise<TaskListMembershipSets>>();
+const membershipPromiseByCacheKey = new Map<
+  string,
+  { promise: Promise<TaskListMembershipSets>; at: number }
+>();
 const MEMBERSHIP_CACHE_MAX_KEYS = 8;
+// key 不携带 sessions-index 版本后，未覆盖的失效路径最多滞后一个 TTL 窗口。
+const MEMBERSHIP_CACHE_TTL_MS = 30_000;
...
-  const cached = membershipPromiseByCacheKey.get(fullCacheKey);
-  if (cached) {
-    return cached.promise;
-  }
+  const cached = membershipPromiseByCacheKey.get(fullCacheKey);
+  if (cached && Date.now() - cached.at < MEMBERSHIP_CACHE_TTL_MS) {
+    return cached.promise;
+  }
   const promise = fetchTaskListMembershipSetsForEndpoints(params.endpoints);
-  membershipPromiseByCacheKey.set(fullCacheKey, promise);
+  membershipPromiseByCacheKey.set(fullCacheKey, { promise, at: Date.now() });
```

## Expected effect & residual risk

- Effect: membership RPC rounds drop from ~1.3 Hz to ≤1/30 s per endpoint while
  streaming (≈40× against the 80-RPC/15 s trace); merge/rebuild/re-render
  rounds collapse equally. Composes with U42/U43 coalescing (landed 61189ba7),
  which smooths the renderer-side remainder.
- Residual risk: tasks-index row freshness (sort keys, terminalStatus,
  unreadAt collected from the lists) can lag ≤30 s for events that arrive
  without taskMeta. Display rows stay live via sessions-index enrichment, so
  the practical exposure is stale *ordering/terminal styling* in edge cases,
  bounded by the TTL. The "proper" fix (key on a tasks-index revision surfaced
  from the controller registry's logEpoch/seq) removes even that but needs a
  new renderer data path — documented in
  `bench/2026-10-14-project-switch-perf/README.md`.
- Tests to add when landing: cache hit under repeated version bumps with
  unchanged membershipVersion; TTL expiry; membershipVersion bump → miss.
