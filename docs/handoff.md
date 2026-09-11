# Handoff — continuing this build on another machine

Everything needed to pick this project up cold. Phases 1 and 2 are merged to
`main`. Phases 3 and 4 are both built on `feat/rest-api-cli` and not yet
merged — that branch carries 18 commits ahead of `main`. Phase 5 is built on
`feat/ui` and not yet merged. Phase 5b and Phase 6 are unbuilt.

Read this alongside three files that are the real authorities:

- `docs/superpowers/specs/2026-09-07-standalone-workflow-engine-design.md` — the
  binding design for Phases 1–3. Every plan argues from it, and conflicts
  resolve against it.
- `docs/superpowers/specs/2026-09-09-phase4-plugins-steps-batch-design.md` — the
  Phase 4 design: plugin loading, the expanded step library, definition
  snapshotting, batch jobs.
- `docs/superpowers/carry-forward.md` — known gaps and deferred decisions, each
  tagged with the phase that should deal with it. **Read this before planning
  the next phase.**

---

## 1. What exists today

A standalone, generic workflow engine extracted from a Disney internal monorepo
(`mc/packages/workflow`). npm workspaces + turbo, TypeScript 5.9 CommonJS,
Node ^24, Postgres via TypeORM.

```
packages/sdk/     @wfe/sdk    — zero runtime deps: BaseStep, StepContext,
                                WorkflowStatus, the StepSuspension union
packages/core/    @wfe/core   — entities, repositories, migrations, the
                                sandboxed expression evaluator, WorkflowManager,
                                RunExecutor, step registry, step library,
                                plugin loader, queue drivers, worker
packages/server/  @wfe/server — Express REST API, OpenAPI document, auth
                                provider interface, and the `wfe` CLI; serves
                                the built @wfe/ui at the same origin (§8)
packages/ui/      @wfe/ui     — React 18 + Vite SPA: a generated openapi-fetch
                                client with a byte-for-byte drift guard, MSW
                                and real-stack contract tests, and five
                                screens (step catalog, run tracker, run
                                detail, definitions, batch jobs)
examples/         runnable examples + sample definitions
docs/superpowers/ specs, plans, carry-forward notes
```

**Phase 1 (merged)** — entities and migrations, `WorkflowManager` (create) and
`RunExecutor` (execute), the `isolated-vm` expression sandbox, the step registry
keyed by type name, pessimistic `SELECT … FOR UPDATE` locking on a `revision`
column, and the three duplicate-delivery guards.

**Phase 2 (merged)** — the `QueueDriver` contract and name-keyed registry; three
drivers (in-memory with a virtual clock, RabbitMQ with bucketed TTL holding
queues, SQS with a long-poll loop); executor-owned enqueueing with delay
chaining; callback resumption; `WorkflowWorker`; compose file; delayed example.

**Phase 3 (built, unmerged)** — `@wfe/server`: an Express REST API over definitions, runs
and steps; an OpenAPI 3 document served at `/api/v1/docs`; the `wfe` CLI
(`migrate`, `import`, `serve`, `worker`); a `Dockerfile` and compose
`server`/`worker` services. Auth is deliberately `none` in v1 — the expression
sandbox is the only security boundary.

**Phase 4 (built, unmerged)** — the plugin loader (`WFE_PLUGINS`) plus a
sample plugin package; `core.http`, `core.condition`, `core.subWorkflow` and
`core.emitEvent` steps; `StepContext` gaining `queue` and `startChildWorkflow`;
definition snapshotting onto the run at creation; batch jobs (entity,
repository, migration, controller); and a filter-configuration endpoint.

**Phase 5 (built, unmerged)** — `@wfe/ui`: a React 18 + Vite single-page app
generated from `@wfe/server`'s own OpenAPI document (`openapi-typescript` +
`openapi-fetch`), with a test (`schema-freshness.test.ts`) that regenerates
the client into a temp dir and diffs it byte-for-byte against what's
committed, so a stale client fails the suite instead of silently drifting.
Five screens — step catalog, run tracker, run detail, definitions, batch
jobs — built on shared `DataTable`/`FilterBar`/`ErrorState` (+
`EmptyState`/`NotFoundState`) components, TanStack Query hooks per resource,
and a contract-test layer that drives the real server (Postgres +
testcontainers) in addition to MSW-mocked unit tests. `@wfe/server` gained an
optional `AppDeps.uiRoot`: when set, `createApp` serves the built UI at the
root with an SPA fallback that is guarded to never shadow `/api/v1` — when
unset (every existing server test), the server behaves exactly as it did
before Phase 5. `docker compose up --build` now serves the API and the UI
together on `http://localhost:3000/`. The definition editor was **not**
built in Phase 5 — it is deferred to Phase 5b (see §5).

**Not built:** the definition editor (Phase 5b) and anything release-related
(Phase 6).

### Test state

```
@wfe/core     31 suites / 213 tests
@wfe/sdk       3 suites /  12 tests
@wfe/server    7 suites /  51 tests
@wfe/ui       15 suites /  59 tests
```

Run the suite rather than trusting these; they move every phase.

---

## 2. Setting up the new machine

```bash
git clone git@github.com:sahilsharmafrank/workflow-engine.git
cd workflow-engine
npm install
```

**Requirements:**

- **Node ^24** and **npm >= 11** — enforced by `engines` in the root
  `package.json`. `node -v` was `v24.13.1` and `npm -v` was `11.8.0` on the
  machine this was built on.
- **Docker, running.** The Postgres, RabbitMQ and SQS suites all use
  testcontainers and will fail without it.

**If `npm install` fails with E401 or points at a private registry:** the repo
ships an `.npmrc` pinning `registry=https://registry.npmjs.org/` precisely
because a machine-level `~/.npmrc` (a corporate AWS CodeArtifact config, say)
otherwise makes the build depend on credentials that expire. The repo-local file
takes precedence, so this should just work — but if your global config uses a
mechanism that overrides it, that is the first thing to check.

**Port 5432 is the other common trap.** If a Postgres is already listening
there, a testcontainer can fail to bind and the examples will connect to *your*
database and fail authentication. The README's troubleshooting section covers
this.

### Verify the checkout before changing anything

```bash
npm run build && npm test
```

`npm test` runs every workspace through turbo. To narrow it while iterating:
`npm test -w @wfe/core`, `-w @wfe/sdk`, `-w @wfe/server`.

This takes several minutes — RabbitMQ, LocalStack and Postgres containers all
start. A LocalStack start-timeout is a known environmental flake; rerun before
believing it.

---

## 3. The verification rule that matters most

**Always `npm run build` before `npm test`, and treat that combined command as
the only authoritative result.**

`ts-jest` type-checks `@wfe/sdk` through that package's built `dist`, *not*
through jest's `moduleNameMapper`. So `turbo run test` alone can type-check
against stale output and report green on code that does not compile. This
actually happened — a task shipped a broken fixture reporting a green suite.

Corollaries learned the hard way over roughly eight fix rounds:

- **A test that has never failed is not evidence.** The dominant defect in this
  project has been tests that name a behaviour they cannot detect: a timeout
  test whose infinite loop was a syntax error so the loop never ran; a
  "sandbox has no `require`" test that passed trivially because `require` is
  undefined in that context anyway; a merge test whose fixture made both
  branches produce the same value. Before trusting a test, break the thing it
  covers and watch it go red.
- **Suite output should be pristine.** A stray `console.error` in every run is
  how a real warning gets missed later.
- Full untruncated `Test Suites:` / `Tests:` lines, not a summary.

Suite output is currently clean. It did not used to be: a `pg`
`DeprecationWarning` about `client.query()` on a busy client rode along for two
phases before Phase 3 traced it — with `node --trace-deprecation` — to
`RunExecutor.restartFromStep`, where a single cascading `save(run)` handed
TypeORM several UPDATE subjects that it fired concurrently on one `pg` client.
Worth remembering as a method: the warning was real, it named a genuine
concurrency mistake, and it sat unexamined because it was only ever noise in a
passing run.

---

## 4. How the work has been run

Each phase followed the same loop, using the **superpowers** plugin skills:

1. `superpowers:brainstorming` → a spec in `docs/superpowers/specs/`.
2. `superpowers:writing-plans` → a plan in `docs/superpowers/plans/`, broken
   into numbered tasks, each with complete code and its own test cycle.
3. `superpowers:subagent-driven-development` → a fresh subagent implements each
   task, a reviewer gates it, fixes loop until clean, then one whole-branch
   review at the end.
4. `superpowers:finishing-a-development-branch` → merge.

**If the superpowers plugin is not installed on the new machine**, the loop
still works run by hand: write the spec, write a plan with one task per
independently testable deliverable, implement each task test-first, review each
diff against its task before moving on, and do one review of the whole branch
before merging. The plugin automates the bookkeeping, not the judgement.

**Execution ledgers do not travel.** They live in `.superpowers/`, which is
git-ignored. That is why `carry-forward.md` exists and is committed — anything
that must outlive a phase goes there, in git.

### Two process facts worth carrying forward

- **The whole-branch review earns its keep.** Phase 2's most serious bug — the
  engine consuming its own external-task dispatches and completing those steps
  with empty outputs, silently — passed nine task-scoped reviews and was caught
  only by the final broad review. Do not skip it.
- **Ordering a test for an uncovered option can entrench a bug.** In Phase 2 a
  test was added for `WorkflowWorker`'s `services` option precisely because it
  was uncovered; it used a mocked executor and a hand-built message, so it
  pinned the broken wiring in place without exercising real behaviour. Coverage
  of a *wiring* is not coverage of a *behaviour*.

### Git conventions

Feature branch per phase (`feat/<phase-name>`), merged to `main`. Commits are
conventional (`feat:`, `fix:`, `docs:`, `test:`) and scoped (`feat(core):`).

---

## 5. What is left

From the spec's §14 build order:

| Phase | Work | Milestone |
|---|---|---|
| 3 ✅ | `@wfe/server`: REST, OpenAPI, CLI | `docker compose up`, then curl starts a run |
| 4 ✅ | Plugin loader, built-in step library, example plugin package | A third-party step package loads and runs |
| 5 ✅ | `@wfe/ui`: step catalog, run tracker, run detail, definitions, batch jobs; served same-origin from `@wfe/server` | `docker compose up`, then watch a run in the tracker |
| 5b | Definition editor | Author a definition in the UI |
| 6 | Docs, examples, publish | Someone else can install it |

**Phase 5b — the definition editor.** The one screen spec §11 called for that
Phase 5 deliberately did not build: a port of the original
`WorkflowStepsEditor` (491 lines in the source monorepo), which lets an
operator author or edit a workflow definition's steps in the browser rather
than hand-writing JSON and calling `POST /definitions/import`. It is the
densest single piece of UI in the spec, which is exactly why Phase 5 scoped
it out on its own rather than risk it destabilizing the other five screens.
Everything it needs already exists on the wire: `GET`/`PUT
/api/v1/definitions/:id`, `POST /api/v1/definitions/:id/publish`, and
`GET /api/v1/step-types` (backing the step catalog Phase 5 already built,
which the editor's step picker can reuse directly). Two schema gaps are worth
closing before or during this phase — see `carry-forward.md`: `PUT
/batch-jobs/:id/cancel`'s undeclared 409, and the optional-vs-required drift
on `WorkflowRun.updatedDate`/`.stepRuns` — neither blocks the editor, but the
editor is the next screen likely to hit the same class of "declared optional,
actually required" gap on `WorkflowDefinition`, so it's worth checking that
schema for the same issue before writing the editor's types.

**Phase 6** — packaging and publishing.

### Open items

`carry-forward.md` holds the current list. The Phase 2 items that once blocked
Phase 3 — the outbound service-request contract, the spec's self-contradiction
about service-queue consumers, and the `pg` deprecation warning — were all
resolved during Phase 3 and are struck through there, with the resolutions
recorded.

Several small deferred items accumulated across Phase 4 (an untested async
plugin-register path, `EmitEventStep` not validating an empty queue input,
`ConditionStep` silently skipping on unknown action values, and a shallow
rather than deep definition snapshot). None blocked the UI; all are recorded
in the Phase 4 ledger and worth a cleanup pass when those files are next
touched.

Worth knowing before Phase 5b — all recorded in `carry-forward.md`'s Phase 5
section with full detail:

- **A batch job's own `status` is never set to `"complete"`** — an engine
  gap (`packages/server/src/controllers/batch-jobs.ts`), not a UI one. A
  finished batch job stays `"running"` forever and remains cancellable.
  Worth fixing before Phase 5b or Phase 6 ships this to anyone who will
  notice.
- **The OpenAPI document can drift from the actual Express routes** with no
  test catching it — the drift guard only proves the generated client
  matches the spec, not that the spec matches the routes. Phase 5 found 26
  of 29 operations undocumented this way and had to insert a task to fix the
  twelve the UI needed. Worth a route-table-vs-spec test before Phase 5b
  adds more routes to get this wrong on.
- **No list screen paginates.** Fine today; will silently truncate results
  the first time a deployment has more than 50 runs, definitions, or batch
  jobs.
- **`schema-freshness.test.ts` leaks a temp directory every run.** Trivial
  two-line fix, not yet made.

---

## 6. Starting the next session

On the new machine, from the repo root, something like:

> Continuing the standalone workflow engine. Read `docs/handoff.md`, then
> `docs/superpowers/specs/2026-09-07-standalone-workflow-engine-design.md` and
> `docs/superpowers/carry-forward.md`. Phases 1–5 are done. I want to build
> Phase 5b (`@wfe/ui`'s definition editor, spec §11) — the one screen Phase 5
> deliberately deferred. Write the Phase 5b plan.

Verify the suite is green before starting — that separates a real problem from
an environment problem, and it takes one command.
