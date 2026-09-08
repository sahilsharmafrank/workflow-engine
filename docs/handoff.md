# Handoff — continuing this build on another machine

Everything needed to pick this project up cold. Phases 1 and 2 are merged to
`main` and pushed; Phases 3–6 are unbuilt.

Read this alongside two files that are the real authorities:

- `docs/superpowers/specs/2026-09-07-standalone-workflow-engine-design.md` — the
  binding design. Every plan argues from it, and conflicts resolve against it.
- `docs/superpowers/carry-forward.md` — known gaps and deferred decisions, each
  tagged with the phase that should deal with it. **Read this before planning
  Phase 3.** Two items in it change what Phase 3 has to build.

---

## 1. What exists today

A standalone, generic workflow engine extracted from a Disney internal monorepo
(`mc/packages/workflow`). npm workspaces + turbo, TypeScript 5.9 CommonJS,
Node ^24, Postgres via TypeORM.

```
packages/sdk/     @wfe/sdk  — zero runtime deps: BaseStep, StepContext,
                              WorkflowStatus, the StepSuspension union
packages/core/    @wfe/core — entities, repositories, migrations, the
                              sandboxed expression evaluator, WorkflowManager,
                              RunExecutor, step registry, queue drivers, worker
examples/         runnable examples + sample definitions
docs/superpowers/ spec, plans, carry-forward notes
```

**Phase 1 (merged)** — entities and migrations, `WorkflowManager` (create) and
`RunExecutor` (execute), the `isolated-vm` expression sandbox, the step registry
keyed by type name, pessimistic `SELECT … FOR UPDATE` locking on a `revision`
column, and the three duplicate-delivery guards.

**Phase 2 (merged)** — the `QueueDriver` contract and name-keyed registry; three
drivers (in-memory with a virtual clock, RabbitMQ with bucketed TTL holding
queues, SQS with a long-poll loop); executor-owned enqueueing with delay
chaining; callback resumption; `WorkflowWorker`; compose file; delayed example.

**Not built:** the REST API, OpenAPI, the CLI, plugin loading, the built-in step
library beyond a handful, the React UI, and anything release-related.

### Test state on `main`

```
@wfe/core   22 suites / 152 tests
@wfe/sdk     3 suites /  12 tests
```

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
npm run build && npm test -w @wfe/core && npm test -w @wfe/sdk
```

Expect the counts in §1. This takes several minutes — RabbitMQ, LocalStack and
Postgres containers all start. A LocalStack start-timeout is a known
environmental flake; rerun before believing it.

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

There is currently one known blemish: a `pg` `DeprecationWarning` about
`client.query()` on a busy client. It predates Phase 2 and is logged in
`carry-forward.md` for Phase 3.

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
| 3 | `@wfe/server`: REST, OpenAPI, CLI | `docker compose up`, then curl starts a run |
| 4 | Plugin loader, built-in step library, example plugin package | A third-party step package loads and runs |
| 5 | `@wfe/ui`: five screens | Author a definition in the UI, run it, watch it in the tracker |
| 6 | Docs, examples, publish | Someone else can install it |

**Phase 3** — spec §10 (REST endpoints), §12 (configuration and the
`wfe migrate | import | serve | worker` CLI). Auth is deliberately **none** in
v1: the expression sandbox is the only security boundary. The worker CLI runs
the existing `WorkflowWorker` (listeners only, no HTTP).

**Phase 4** — spec §7.1. A step registry keyed by type name already exists;
Phase 4 adds boot-time loading from `WFE_PLUGINS` module specifiers, where a
plugin is an npm package default-exporting `(registry: StepRegistry) => void`.

**Phase 5** — spec §11. Vite, React 18, TypeScript, MUI 5, TanStack Query, with
the client generated from the OpenAPI document Phase 3 produces. Five screens.

**Phase 6** — packaging and publishing.

### Before planning Phase 3, settle these

Both are in `carry-forward.md` with full detail:

1. **The outbound service-request contract is undesigned.** The engine publishes
   an external-task dispatch to `wfe-service-<name>` as a `WorkflowMessage` with
   `kind: "resume"` and **no step inputs**. An external service reading it learns
   the tenant, run, step and correlation id, but nothing about the work to do.
   Decide the real request envelope and the reply path before building the API
   that exposes it.
2. **The spec contradicts itself about who consumes service queues** (lines 62-63
   versus 70-71). Phase 2 resolved it in favour of the data-flow diagram —
   `WorkflowWorker` subscribes to the delay and response queues only. Amend the
   spec so Phase 3 does not re-derive the bug.

---

## 6. Starting the next session

On the new machine, from the repo root, something like:

> Continuing the standalone workflow engine. Read `docs/handoff.md`, then
> `docs/superpowers/specs/2026-09-07-standalone-workflow-engine-design.md` and
> `docs/superpowers/carry-forward.md`. Phases 1 and 2 are merged to `main`.
> I want to build Phase 3 (`@wfe/server`: REST, OpenAPI, CLI). Start by
> resolving the two carry-forward items that block it, then write the Phase 3
> plan.

Verify the suite is green before starting — that separates a real problem from
an environment problem, and it takes one command.
