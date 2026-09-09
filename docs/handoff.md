# Handoff — continuing this build on another machine

Everything needed to pick this project up cold. Phases 1 and 2 are merged to
`main`. Phases 3 and 4 are both built on `feat/rest-api-cli` and not yet
merged — that branch carries 18 commits ahead of `main`. Phases 5–6 are
unbuilt.

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
                                provider interface, and the `wfe` CLI
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

**Not built:** the React UI (Phase 5) and anything release-related (Phase 6).

### Test state

```
@wfe/core     30 suites / 176 tests
@wfe/sdk       3 suites /  12 tests
@wfe/server    6 suites /  42 tests
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
| 5 | `@wfe/ui`: five screens | Author a definition in the UI, run it, watch it in the tracker |
| 6 | Docs, examples, publish | Someone else can install it |

**Phase 5** — spec §11. Vite, React 18, TypeScript, MUI 5, TanStack Query, with
the client generated from the OpenAPI document Phase 3 produces
(`/api/v1/docs`). Five screens: Definitions, Definition editor, Run tracker,
Run detail, Step catalog. The editor is the densest port — the original
`WorkflowStepsEditor` was 491 lines.

The API surface Phase 5 consumes already exists, including the
`/filter-configuration` endpoint added in Phase 4, which exists specifically so
the UI's filter controls are driven by the registry rather than hardcoded.

**Phase 6** — packaging and publishing.

### Open items

`carry-forward.md` holds the current list. The Phase 2 items that once blocked
Phase 3 — the outbound service-request contract, the spec's self-contradiction
about service-queue consumers, and the `pg` deprecation warning — were all
resolved during Phase 3 and are struck through there, with the resolutions
recorded.

Worth knowing before Phase 5: several small deferred items accumulated across
Phase 4 (an untested async plugin-register path, `EmitEventStep` not validating
an empty queue input, `ConditionStep` silently skipping on unknown action
values, and a shallow rather than deep definition snapshot). None block the UI;
all are recorded in the Phase 4 ledger and worth a cleanup pass when those
files are next touched.

---

## 6. Starting the next session

On the new machine, from the repo root, something like:

> Continuing the standalone workflow engine. Read `docs/handoff.md`, then
> `docs/superpowers/specs/2026-09-07-standalone-workflow-engine-design.md` and
> `docs/superpowers/carry-forward.md`. Phases 1–4 are done. I want to build
> Phase 5 (`@wfe/ui`: the five screens, spec §11). Generate the client from the
> OpenAPI document the server already serves, and write the Phase 5 plan.

Verify the suite is green before starting — that separates a real problem from
an environment problem, and it takes one command.
