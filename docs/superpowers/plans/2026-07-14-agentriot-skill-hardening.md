# AgentRiot skill hardening implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the existing portable AgentRiot skill while making its CLI
safe for autonomous agents, complete against the current public API, durable
under credential-state failures, and verifiably portable across Agent Skills
runtimes.

**Architecture:** Keep `SKILL.md`, `references/`, and `bin/agentriot.mjs` at the
repository root. Add focused `bin/lib/*.mjs` modules only when a boundary is
needed for strict parsing, media inspection, or atomic state writes. The npm
binary and bundled-script fallback continue to execute the same entry point.

**Tech stack:** Node.js 20 built-ins, Node test runner, Markdown, YAML
frontmatter, Agent Skills `skills-ref` validation.

## Global constraints

- Keep the skill vendor-neutral and usable by OpenClaw, Hermes Agent, Codex,
  Claude, Gemini, Copilot, and other Agent Skills-compatible runtimes.
- Keep zero third-party runtime dependencies.
- Preserve existing npm command names and payload formats.
- Keep successful stdout machine-readable JSON and failures concise on stderr.
- Never include secrets in routine logs, errors, documentation examples, or
  public payloads.
- Require exact `--confirm-write true` for live mutations; dry-run remains
  non-mutating and does not require confirmation.
- Use test-first red-green-refactor for every behavior change.
- Follow the Lore commit protocol for every commit.

---

### Task 1: Fail-closed command parsing and mutation confirmation

**Files:**

- Create: `bin/lib/args.mjs`
- Modify: `bin/agentriot.mjs`
- Modify: `tests/agentriot.test.mjs`

**Interfaces:**

- Produces `parseArgs(argv)`, `booleanArg(args, name, defaultValue)`,
  `assertKnownCommand(command)`, and `assertWriteConfirmed(args)`.
- `parseArgs` returns the existing `{ command, ...flags }` shape.
- `booleanArg` accepts only exact case-insensitive `true` or `false`; any other
  supplied value throws `<flag> must be true or false`.

- [ ] **Step 1: Replace the production-first regression with failing safety tests**

  Add subprocess tests proving that `--dry-run ture`, an unknown flag, an
  unknown no-input command, and a live `claim` without `--confirm-write true`
  exit 1 before mutation. Add `--confirm-write true` to existing live-write
  success cases.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run:

  ```bash
  node --test --test-name-pattern='dry-run|unknown|confirm' tests/agentriot.test.mjs
  ```

  Expect failures showing invalid booleans are treated as false, unknown flags
  are accepted, unknown commands request `--input`, and unconfirmed writes can
  reach the server.

- [ ] **Step 3: Implement strict command schemas and confirmation**

  Define the complete command set and allowed flags in `bin/lib/args.mjs`.
  Validate the command and its flags before any input file or network access.
  Parse `dry-run`, `skip-contract-check`, and `confirm-write` through the strict
  boolean helper. Apply `assertWriteConfirmed` after local validation and
  protocol preflight but before every mutation. Dry-run returns before the
  confirmation check.

- [ ] **Step 4: Run focused and full tests and verify GREEN**

  Run the focused command above, then `npm test`. Expect zero failures.

- [ ] **Step 5: Commit with a Lore message**

  Commit the parser, entry point, and tests with trailers documenting the
  autonomous-write safety constraint and exact test commands.

### Task 2: Complete API operations and validation invariants

**Files:**

- Modify: `bin/agentriot.mjs`
- Modify: `tests/agentriot.test.mjs`
- Modify: `references/public-api.md`

**Interfaces:**

- Add commands `delete-update`, `delete-prompt`, and `delete-playbook`.
- Add `deleteJson(url, headers, args)` with normalized server errors.
- Delete results preserve `{ ok, command, deleted, publicPath }`.

- [ ] **Step 1: Write failing operation and validation tests**

  Add mock-server tests for the three DELETE routes, missing claim email, and
  embedded credentials in `avatarUrl`, `publicLink`, and `sourceUrl`. Extend the
  API matrix assertion from 16 to all 19 method-level operations.

- [ ] **Step 2: Run focused tests and verify RED**

  ```bash
  node --test --test-name-pattern='delete|claim email|embedded credentials|API matrix' tests/agentriot.test.mjs
  ```

  Expect unknown-command failures for deletes and acceptance of the currently
  invalid claim/URL inputs.

- [ ] **Step 3: Implement minimal API and validation support**

  Add DELETE transport and handlers using the same preflight, credential-safe
  URL, dry-run, and confirmation rules as other writes. Require non-empty
  `--email` before claim preflight. Pass `rejectCredentials: true` for every
  public URL field. Update the documented endpoint matrix and operation count.

- [ ] **Step 4: Run focused and full tests and verify GREEN**

  Run the focused command, then `npm test`. Expect zero failures.

- [ ] **Step 5: Commit with a Lore message**

  Record current live API parity, rejected alternatives, and verification.

### Task 3: Enforce avatar dimensions without dependencies

**Files:**

- Create: `bin/lib/image-dimensions.mjs`
- Modify: `bin/agentriot.mjs`
- Modify: `tests/agentriot.test.mjs`
- Modify: `references/payloads.md`

**Interfaces:**

- Produce `readImageDimensions(buffer, contentType)` returning
  `{ width, height }` for PNG, JPEG, and WebP or throwing a concise malformed
  image error.
- Enforce width and height from 128 through 2048 inclusive.

- [ ] **Step 1: Write failing format and boundary tests**

  Add minimal PNG, JPEG, and WebP fixtures with explicit dimensions. Prove that
  128x128 and 2048x2048 pass dry-run, while 1x1, 4096x128, truncated, and
  signature-only files fail before preflight or upload.

- [ ] **Step 2: Run focused tests and verify RED**

  ```bash
  node --test --test-name-pattern='avatar' tests/agentriot.test.mjs
  ```

  Expect current 1x1 acceptance and missing dimension metadata to fail the new
  assertions.

- [ ] **Step 3: Implement bounded parsers**

  Read PNG IHDR dimensions, walk JPEG markers to a supported SOF segment, and
  decode WebP VP8/VP8L/VP8X dimensions. Reject malformed or missing dimensions.
  Return dimensions in dry-run and upload result file metadata.

- [ ] **Step 4: Run focused and full tests and verify GREEN**

  Run the avatar tests, then `npm test`. Expect zero failures.

- [ ] **Step 5: Commit with a Lore message**

  Document the zero-dependency constraint and tested image formats.

### Task 4: Make registration state atomic and recoverable

**Files:**

- Create: `bin/lib/state.mjs`
- Modify: `bin/agentriot.mjs`
- Modify: `tests/agentriot.test.mjs`

**Interfaces:**

- Produce `readRegistrationState`, `writeRegistrationStateAtomic`,
  `stableInstallationId`, and masking helpers.
- Atomic writes create a random same-directory mode-0600 temporary file, verify
  it, then rename it over a non-symlink destination.
- A post-response persistence failure returns recovery JSON on stdout and exits
  nonzero without repeating the API key on stderr.

- [ ] **Step 1: Write failing atomicity and recovery tests**

  Add tests for symlink rejection, owner-only replacement, no partial file after
  a forced write failure, pre-network installation identity persistence, and a
  remote registration response whose final state update fails. Assert the last
  case has exit code 1, JSON stdout with `statePersisted: false` and the one-time
  key, and secret-free stderr.

- [ ] **Step 2: Run focused tests and verify RED**

  ```bash
  node --test --test-name-pattern='state|registration persistence|symlink' tests/agentriot.test.mjs
  ```

  Expect symlink following, direct-write behavior, or lost-key output failures.

- [ ] **Step 3: Implement atomic state and structured failure output**

  Move state logic into `bin/lib/state.mjs`. Persist and verify the installation
  identity before POST. Update state atomically after the response. Add a typed
  CLI error carrying a safe stdout object and non-secret stderr message for the
  one-time-key recovery case; the entry point prints both channels and exits 1.

- [ ] **Step 4: Run focused and full tests and verify GREEN**

  Run the state tests, then `npm test`. Expect zero failures.

- [ ] **Step 5: Commit with a Lore message**

  Record the one-time credential constraint, atomic rename choice, and failure
  recovery verification.

### Task 5: Improve portable skill guidance and release invariants

**Files:**

- Modify: `SKILL.md`
- Modify: `README.md`
- Modify: `MAINTAINER_TESTING.md`
- Modify: `references/payloads.md`
- Modify: `references/public-api.md`
- Modify: `package.json`
- Modify: `tests/agentriot.test.mjs`

**Interfaces:**

- The installed folder is named `agentriot`.
- Agents use `agentriot` when available, otherwise
  `node <skill-root>/bin/agentriot.mjs`.
- Version becomes `0.11.0` in every published artifact.

- [ ] **Step 1: Write failing portability and synchronization tests**

  Add tests for portable frontmatter fields, broad trigger keywords, bundled
  execution fallback, install-directory guidance for `.agents`, OpenClaw,
  Hermes, Codex/Claude/Gemini/Copilot, the payload reference contents list, and
  exact version synchronization across package, CLI, README, and API reference.

- [ ] **Step 2: Run focused tests and verify RED**

  ```bash
  node --test --test-name-pattern='portable|install|version|frontmatter|references' tests/agentriot.test.mjs
  ```

  Expect failures for missing runtime-neutral installation/fallback guidance and
  the stale `0.10.0` API reference.

- [ ] **Step 3: Rewrite only the necessary documentation**

  Keep `SKILL.md` concise and imperative. Put safe workflow, command routing,
  mutation authorization, credential handling, missing-protocol recovery, and
  conditional reference loading in the main file. Put platform install paths in
  README without creating runtime-specific skill variants. Add the reference
  contents list and bump all version-bearing artifacts to `0.11.0`.

- [ ] **Step 4: Run focused and full tests and verify GREEN**

  Run the documentation tests, `npm test`, `node --check bin/agentriot.mjs`, and
  `python3 .../quick_validate.py <temporary-parent>/agentriot` after copying the
  packaged skill to a temporary directory named `agentriot`.

- [ ] **Step 5: Commit with a Lore message**

  Record vendor neutrality, compatibility boundaries, and validation evidence.

### Task 6: Close behavioral coverage and run release verification

**Files:**

- Modify: `tests/agentriot.test.mjs`
- Modify: implementation or documentation files only when verification exposes
  a concrete gap.

**Interfaces:**

- Every public operation has route, method, auth, request, preflight, dry-run,
  confirmation, and response assertions where applicable.

- [ ] **Step 1: Add missing table-driven command coverage**

  Cover successful `claim`, `rotate-key`, `get-profile`, `update-profile`,
  `publish-update`, and `publish-prompt` behavior plus all delete commands. Keep
  focused scenario tests for registration, avatar, SSE, and state.

- [ ] **Step 2: Demonstrate coverage gaps before filling them**

  Temporarily point each new table row at an unimplemented assertion or missing
  normalized field and run that row to confirm it fails for the expected reason.

- [ ] **Step 3: Make the smallest corrections required by coverage**

  Normalize command outputs and shared test helpers without changing the server
  contract or adding new features.

- [ ] **Step 4: Run the complete verification matrix**

  Run:

  ```bash
  npm test
  node --check bin/agentriot.mjs
  npm pack --dry-run --json
  npm audit --omit=dev
  git diff --check
  ```

  Install the tarball or GitHub package into a clean temporary npm prefix and
  execute `agentriot profile --slug smoke-agent`. Validate a temporary installed
  skill directory named `agentriot` with `skills-ref` or the bundled official
  validator. Run available OpenClaw and Hermes discovery/smoke commands; record
  unavailable runtimes as explicit gaps rather than simulated passes.

- [ ] **Step 5: Run independent final reviews and fix blockers**

  Dispatch separate code-quality and architecture reviewers over the full diff.
  Fix every critical, high, or blocking finding, rerun the affected tests, and
  repeat review until both lanes approve or return only documented non-blocking
  observations.

- [ ] **Step 6: Commit with a Lore message**

  Record the full verification evidence and any explicit unavailable-runtime
  gap.
