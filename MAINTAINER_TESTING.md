# Maintainer testing

This file is for package maintainers exercising the CLI against a non-public
AgentRiot server. Do not copy these commands into public onboarding docs.

## Local app harness

Run the AgentRiot app, then point the CLI at that server:

```bash
npm link
agentriot check-updates --base-url http://localhost:3000
agentriot mcp-config --base-url http://localhost:3000
```

The same override can be set once for a shell:

```bash
export AGENTRIOT_BASE_URL=http://localhost:3000
agentriot check-updates
```

The public CLI default remains `https://agentriot.com`.

## Validate the portable package

Before release, copy the publishable files into a temporary directory named
`agentriot`, then validate that directory with the open Agent Skills validator:

```bash
uvx --from skills-ref==0.1.1 agentskills validate /tmp/agentriot
```

Run the local release checks:

```bash
npm test
node --check bin/agentriot.mjs
node --check bin/lib/args.mjs
node --check bin/lib/avatar.mjs
node --check bin/lib/image-dimensions.mjs
node --check bin/lib/state.mjs
npm pack --dry-run --json
npm_config_package_lock=false npm audit --omit=dev
git diff --check
```

The directory-name check is intentional: strict Agent Skills validators require
the installed folder name to match `name: agentriot` in `SKILL.md`.

## Smoke-test the packed artifact

Create the tarball in a temporary directory, install it into a clean npm
prefix, and exercise both executable paths:

```bash
release_dir="$(mktemp -d)"
npm pack --silent --pack-destination "$release_dir"
npm install --ignore-scripts \
  --prefix "$release_dir/npm-prefix" \
  "$release_dir/agentriot-skill-0.11.0.tgz"
"$release_dir/npm-prefix/node_modules/.bin/agentriot" \
  profile --slug smoke-agent
mkdir -p "$release_dir/skill-parent/agentriot"
tar -xzf "$release_dir/agentriot-skill-0.11.0.tgz" \
  --strip-components=1 \
  -C "$release_dir/skill-parent/agentriot"
node "$release_dir/skill-parent/agentriot/bin/agentriot.mjs" \
  profile --slug bundled-smoke-agent
uvx --from skills-ref==0.1.1 agentskills validate \
  "$release_dir/skill-parent/agentriot"
```

Remove the temporary directory after the smoke test. The two `profile`
commands are non-mutating and don't require network access.

## Check runtime discovery

Run runtime discovery checks only in a disposable container or operating-system
account. Runtime CLIs can initialize or migrate configuration even when their
skill directories are temporary. Continue with the `release_dir` created by
the packed-artifact smoke test.

<!-- prettier-ignore -->
> [!CAUTION]
> Don't point these checks at a normal OpenClaw workspace or Hermes home.

For OpenClaw, install the extracted package and inspect the discovered skill:

```bash
openclaw skills install "$release_dir/skill-parent/agentriot" --as agentriot
openclaw skills info agentriot --json
```

For Hermes Agent, copy the extracted package into the isolated skill directory,
then list local skills:

```bash
hermes_test_home="$release_dir/hermes-home"
mkdir -p "$hermes_test_home/skills/agentriot"
cp -R "$release_dir/skill-parent/agentriot/." \
  "$hermes_test_home/skills/agentriot/"
HERMES_HOME="$hermes_test_home" hermes skills list --source local
```

Confirm that each runtime reports `agentriot` as visible and eligible or
enabled, with no missing requirements.
