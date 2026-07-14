# Task 4 implementation report

Task 4 hardens registration state persistence and preserves a one-time API key
when the remote registration succeeds but the final local state update fails.

## Scope

The implementation changes only the files named in the task brief:

- `bin/lib/state.mjs` contains registration-state reads, stable installation ID
  selection, masking helpers, and atomic state writes.
- `bin/agentriot.mjs` persists the installation ID before network access and
  emits a structured recovery result after a post-response write failure.
- `tests/agentriot.test.mjs` covers atomic replacement, symlink refusal,
  interrupted writes, pre-network persistence, and recovery output channels.

No dependency, public documentation, payload validation, or unrelated command
behavior changed.

## TDD evidence

The focused RED command was:

```text
timeout 30s node --test \
  --test-name-pattern='state|registration persistence|symlink' \
  tests/agentriot.test.mjs
```

Before production changes, the five new tests failed for the expected missing
behaviors:

- Three state-module tests failed because `bin/lib/state.mjs` did not exist.
- The pre-network persistence test observed no state at the first request.
- The post-response recovery test observed an incorrect successful exit after
  the old direct writer followed a symlink.

The RED run reported five failed tests and three passing pre-existing focused
tests. The 30-second guard then interrupted one pending test process because an
initial server-side assertion did not close its response after detecting the
missing pre-network state. The test harness was corrected before production
code changed so the intended assertion occurs after the CLI process exits.

After implementation, the focused GREEN command was:

```text
node --test \
  --test-name-pattern='state|registration persistence|symlink' \
  tests/agentriot.test.mjs
```

Result: 8 tests passed, 0 failed, 0 cancelled, and 0 skipped.

## Implementation evidence

`writeRegistrationStateAtomic` performs the following sequence:

1. Reject an existing symbolic-link destination.
2. Create a randomized temporary file in the destination directory with
   exclusive creation and mode `0600`.
3. Write and synchronize the complete JSON payload.
4. Verify that the temporary object is a regular mode-`0600` file and that its
   parsed contents match the requested state.
5. Recheck the destination for a symbolic link immediately before rename.
6. Atomically rename the verified temporary file over the destination.
7. Verify the final file type, mode, and parsed contents.
8. Remove the temporary file on every pre-rename failure.

`readRegistrationState` also refuses symbolic links. Existing missing-file,
required-file, JSON-object, and masked `state` command behavior remains intact.

Live registration now validates the payload and Task 1 write confirmation,
then atomically persists the stable installation ID before protocol preflight
or registration POST. The final credential-bearing state update uses the same
atomic writer.

If the remote response contains an API key and the final update fails, the CLI
throws a typed recovery error. The entry point writes one JSON object to stdout
with `ok: false`, `command: "register"`, `statePersisted: false`, the state
path, registration metadata, and the one-time `apiKey`. It writes only a fixed,
non-secret recovery instruction to stderr and sets exit code 1. The regression
test verifies that the complete key is absent from stderr and that a symlink
target remains untouched.

## Verification evidence

The full regression command was:

```text
npm test
```

Result: 81 tests passed, 0 failed, 0 cancelled, and 0 skipped.

Additional static checks completed successfully:

```text
git diff --check
node --check bin/agentriot.mjs
node --check bin/lib/state.mjs
```

## Remaining risk

Atomic rename and symbolic-link behavior are verified on the Linux filesystem
used by the project test environment. No cross-platform filesystem test was
requested or run.

## Review rework TDD evidence

The durability review identified five root causes in the initial change:

- The writer synchronized file contents but not the parent-directory rename.
- Temporary and final JSON verification reopened paths instead of retaining
  file-handle identity.
- Creation mode was subject to the process umask because the handle was not
  explicitly changed to mode `0600`.
- The missing-agent-slug check occurred outside the API-key recovery boundary.
- The failure test stopped before temporary-file creation and therefore did
  not prove cleanup after a later atomic-write failure.

The second focused RED command was:

```text
node --test \
  --test-name-pattern='state|registration persistence|registration response shape|symlink' \
  tests/agentriot.test.mjs
```

Result before the review fixes: 8 tests passed and 6 tests failed. The failures
were the restrictive-umask mode check, four tests requiring the internal state
I/O seam and its directory-sync, no-follow, and post-temp-failure behavior,
and missing-slug recovery for a returned API key.

The same focused command after the fixes reported 14 tests passed, 0 failed,
0 cancelled, and 0 skipped.

The deterministic failure test injects a failing `rename` operation through
`createRegistrationStateIO`. The injected operation runs only after the open
temporary handle has been written, changed to mode `0600`, synchronized, and
verified. The test confirms one rename attempt, no remaining temporary file,
and byte-for-byte preservation of the prior destination state.

## Durability and path-integrity policy

The final implementation uses the following policy:

1. Open the randomized same-directory temporary file with exclusive creation
   and `O_NOFOLLOW` when the platform exposes that flag.
2. Call `FileHandle.chmod(0o600)` before verifying the exact permission bits.
3. Write, synchronize, inspect, and parse the temporary JSON through the same
   open handle. No path-based temporary-file readback occurs.
4. Rename the verified file and synchronize the parent directory before
   reporting success or allowing registration to proceed to network access.
5. Open the final path with `O_NOFOLLOW` when available, compare its device and
   inode to the temporary handle when those values are meaningful, and compare
   the complete parsed JSON object with the requested state.

Directory durability is fail-closed. If the platform cannot open or synchronize
the parent directory, the write returns an error; there is no silent best-effort
fallback. A rename might already be visible when directory synchronization
fails, but persistence is treated as unconfirmed. Before registration network
access, that error stops the command. After a remote response containing an API
key, it produces the structured nonzero recovery object on stdout and the fixed
secret-free message on stderr.

When `O_NOFOLLOW` is unavailable, the implementation uses a pre-open `lstat`,
an open-handle `stat`, and a post-open `lstat`, and requires matching file
identity when the platform supplies meaningful device and inode values. When
stable device/inode identity is unavailable, regular-file type, exact mode, and
full parsed-content verification still apply, but the implementation does not
claim the same kernel-enforced no-follow or identity guarantee. Same-directory
rename supplies atomic replacement only to the extent supported by the host
filesystem.

## Final verification evidence

After the review fixes, the full regression command was:

```text
npm test
```

Result: 87 tests passed, 0 failed, 0 cancelled, and 0 skipped.

The following checks also completed with exit code 0:

```text
git diff --check
node --check bin/agentriot.mjs
node --check bin/lib/state.mjs
```
