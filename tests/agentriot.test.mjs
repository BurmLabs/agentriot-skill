import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { assertWriteConfirmed } from "../bin/lib/args.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = new URL("../bin/agentriot.mjs", import.meta.url);

async function readRequestBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function writePayload(name, payload) {
  const dir = await mkdtemp(join(tmpdir(), "agentriot-"));
  const filePath = join(dir, name);
  await writeFile(filePath, JSON.stringify(payload), "utf8");
  return filePath;
}

async function writeTempFile(name, contents) {
  const dir = await mkdtemp(join(tmpdir(), "agentriot-"));
  const filePath = join(dir, name);
  await writeFile(filePath, contents);
  return filePath;
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function runCli(args) {
  const { stdout } = await execFileAsync("node", [scriptPath.pathname, ...args]);
  return JSON.parse(stdout);
}

async function runCliFailure(args, options = {}) {
  try {
    await execFileAsync("node", [scriptPath.pathname, ...args], {
      ...options,
      env: {
        ...process.env,
        ...options.env,
      },
    });
  } catch (error) {
    return {
      code: error.code,
      stderr: error.stderr.trim(),
      stdout: error.stdout.trim(),
    };
  }

  assert.fail("CLI command unexpectedly succeeded");
}

function pngFixture(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpegFixture(width, height) {
  const startOfFrame = Buffer.from([
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    0x00, 0x00,
    0x00, 0x00,
    0x01,
    0x01, 0x11, 0x00,
  ]);
  startOfFrame.writeUInt16BE(height, 5);
  startOfFrame.writeUInt16BE(width, 7);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
    startOfFrame,
  ]);
}

function webpRiff(chunkType, chunkData) {
  const buffer = Buffer.alloc(20 + chunkData.length + (chunkData.length % 2));
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write(chunkType, 12, "ascii");
  buffer.writeUInt32LE(chunkData.length, 16);
  chunkData.copy(buffer, 20);
  return buffer;
}

function webpVp8xFixture(width, height, options = {}) {
  const chunkData = Buffer.alloc(10);
  chunkData[0] = options.flags ?? 0;
  Buffer.from(options.reservedBytes ?? [0, 0, 0]).copy(chunkData, 1);
  chunkData.writeUIntLE(width - 1, 4, 3);
  chunkData.writeUIntLE(height - 1, 7, 3);
  return webpRiff("VP8X", chunkData);
}

function webpVp8Fixture(width, height, options = {}) {
  const chunkData = Buffer.from([
    options.frameTag ?? 0x00, 0x00, 0x00,
    0x9d, 0x01, 0x2a,
    0x00, 0x00,
    0x00, 0x00,
  ]);
  chunkData.writeUInt16LE(width, 6);
  chunkData.writeUInt16LE(height, 8);
  return webpRiff("VP8 ", chunkData);
}

function webpVp8lFixture(width, height, options = {}) {
  const chunkData = Buffer.alloc(5);
  chunkData[0] = 0x2f;
  const dimensions = BigInt(width - 1)
    | (BigInt(height - 1) << 14n)
    | (BigInt(options.version ?? 0) << 29n);
  chunkData.writeUInt32LE(Number(dimensions), 1);
  return webpRiff("VP8L", chunkData);
}

function validPlaybookPayload(overrides = {}) {
  return {
    title: "Daily launch review",
    description: "A repeatable release-readiness workflow for agent operators.",
    instructions: "Review open blockers, check telemetry, summarize launch risk, and publish the decision.",
    outputExample: "Decision: ship. Risks: low. Follow-ups: monitor onboarding metrics.",
    models: ["gpt-5.5"],
    servicesTools: ["GitHub", "Playwright"],
    parameters: [
      {
        name: "repository",
        value: "owner/repo",
        description: "Repository to inspect before launch.",
      },
    ],
    sourceUrl: "https://example.com/playbooks/daily-launch-review",
    tags: ["release", "ops"],
    ...overrides,
  };
}

function validLoopPayload(overrides = {}) {
  return validPlaybookPayload({
    kind: "loop",
    title: "Launch evidence loop",
    description: "A bounded loop for launch-readiness evidence.",
    instructions: "Collect launch evidence, evaluate gaps, retry once, and publish the final decision.",
    outputExample: "Decision: hold. Proof: uptime check failed. Next action: fix health check.",
    loopSpec: {
      trigger: "Run before each public launch checkpoint.",
      goal: "Produce a launch decision backed by public-safe evidence.",
      iteration: "Collect evidence, evaluate against the checklist, fix one blocker, and retry.",
      verification: "Attach test, benchmark, checklist, or reviewer proof.",
      memoryState: "Read the last launch decision and write the current outcome.",
      tools: ["GitHub", "Playwright"],
      budget: "Two iterations or 30 minutes, whichever comes first.",
      stopCondition: "Stop when the checklist passes or a named blocker remains.",
      failureHandling: "Escalate to the operator after repeated failures or unavailable tools.",
      safetyConstraints: "Do not expose secrets, private repo data, or production credentials.",
      exampleOutput: "Decision, evidence, risks, and next action.",
    },
    tags: ["launch", "loop"],
    ...overrides,
  });
}

function protocolResponse(overrides = {}) {
  return {
    protocolVersion: "2026.05.16",
    skill: {
      name: "agentriot",
      recommendedVersion: "0.10.1",
      minimumVersion: "0.10.1",
    },
    contract: {
      version: "2026.05.16",
      minimumSupportedVersion: "2026.05.16",
      limits: {},
    },
    ...overrides,
  };
}

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("check-updates compares local skill version to protocol metadata", async () => {
  await withServer((request, response) => {
    assert.equal(request.url, "/api/agent-protocol");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      protocolVersion: "2026.05.01",
      skill: {
        name: "agentriot",
        recommendedVersion: "0.10.1",
        minimumVersion: "0.10.1",
      },
      promptRevision: "agentriot-onboarding-2026-05-01",
      docs: {
        install: "/docs/install",
        apiReference: "/docs/api-reference",
      },
      openApiUrl: "/api/openapi",
    }));
  }, async (baseUrl) => {
    const result = await runCli(["check-updates", "--base-url", baseUrl]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "check-updates");
    assert.equal(result.upToDate, true);
    assert.equal(result.meetsMinimum, true);
    assert.equal(result.localSkill.version, "0.11.0");
  });
});

test("network calls fail with a bounded timeout", async () => {
  await withServer(() => {
    // Intentionally leave the request open to exercise the CLI timeout path.
  }, async (baseUrl) => {
    const result = await runCliFailure([
      "check-updates",
      "--base-url",
      baseUrl,
      "--timeout-ms",
      "50",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Request timed out after 50 ms/u);
  });
});

test("package version stays synced with check-updates local skill version", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  await withServer((request, response) => {
    assert.equal(request.url, "/api/agent-protocol");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(protocolResponse()));
  }, async (baseUrl) => {
    const result = await runCli(["check-updates", "--base-url", baseUrl]);

    assert.equal(result.localSkill.version, packageJson.version);
  });
});

test("mcp-config emits remote hosted MCP config without echoing raw keys", async () => {
  const result = await runCli([
    "mcp-config",
    "--api-key",
    "agrt_secret_key",
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.command, "mcp-config");
  assert.equal(result.endpoint, "https://agentriot.com/api/mcp");
  assert.equal(result.config.mcpServers.agentriot.type, "http");
  assert.equal(result.config.mcpServers.agentriot.url, "https://agentriot.com/api/mcp");
  assert.equal(
    result.config.mcpServers.agentriot.headers.Authorization,
    "Bearer ${AGENTRIOT_API_KEY}",
  );
  assert.equal(JSON.stringify(result).includes("agrt_secret_key"), false);
});

test("CLI defaults to AgentRiot production for static commands", async () => {
  const result = await runCli(["profile", "--slug", "my-research-agent"]);

  assert.equal(result.ok, true);
  assert.equal(result.publicUrl, "https://agentriot.com/agents/my-research-agent");
});

test("dry-run rejects invalid boolean values before network access", async () => {
  let requests = 0;

  await withServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(protocolResponse()));
  }, async (baseUrl) => {
    const result = await runCliFailure([
      "claim",
      "--slug",
      "lifecycle-agent",
      "--api-key",
      "agrt_secret_key",
      "--email",
      "owner@example.com",
      "--base-url",
      baseUrl,
      "--dry-run",
      "ture",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--dry-run must be true or false/u);
    assert.equal(requests, 0);
  });
});

test("write confirmation helper rejects raw false strings", () => {
  assert.throws(
    () => assertWriteConfirmed({ "confirm-write": "false" }),
    /--confirm-write true is required for live writes/u,
  );
});

test("skip-contract-check rejects malformed values before network access", async () => {
  let requests = 0;

  await withServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(protocolResponse()));
  }, async (baseUrl) => {
    const result = await runCliFailure([
      "claim",
      "--slug",
      "lifecycle-agent",
      "--api-key",
      "agrt_secret_key",
      "--base-url",
      baseUrl,
      "--skip-contract-check",
      "truthy",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--skip-contract-check must be true or false/u);
    assert.equal(requests, 0);
  });
});

test("confirm-write rejects malformed values before network access", async () => {
  let requests = 0;

  await withServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(protocolResponse()));
  }, async (baseUrl) => {
    const result = await runCliFailure([
      "claim",
      "--slug",
      "lifecycle-agent",
      "--api-key",
      "agrt_secret_key",
      "--base-url",
      baseUrl,
      "--confirm-write",
      "yes",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--confirm-write must be true or false/u);
    assert.equal(requests, 0);
  });
});

test("unknown flags fail closed", async () => {
  const result = await runCliFailure([
    "profile",
    "--slug",
    "lifecycle-agent",
    "--unknown",
    "value",
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown flag for profile: --unknown/u);
});

test("unknown no-input commands are rejected as unknown", async () => {
  const result = await runCliFailure(["unknown-command"]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown command: unknown-command/u);
  assert.doesNotMatch(result.stderr, /--input is required/u);
});

test("live claim requires explicit write confirmation before mutation", async () => {
  let mutationRequests = 0;

  await withServer((request, response) => {
    if (request.url === "/api/agent-protocol") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    mutationRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ claimed: true, agentId: "agt_1" }));
  }, async (baseUrl) => {
    const result = await runCliFailure([
      "claim",
      "--slug",
      "lifecycle-agent",
      "--api-key",
      "agrt_secret_key",
      "--email",
      "owner@example.com",
      "--base-url",
      baseUrl,
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--confirm-write true is required for live writes/u);
    assert.equal(mutationRequests, 0);
  });
});

test("claim email is required before protocol preflight", async () => {
  let requests = 0;

  await withServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(protocolResponse()));
  }, async (baseUrl) => {
    const result = await runCliFailure([
      "claim",
      "--slug",
      "lifecycle-agent",
      "--api-key",
      "agrt_secret_key",
      "--base-url",
      baseUrl,
      "--dry-run",
      "true",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--email is required/u);
    assert.equal(requests, 0);
  });
});

test("lookup-software calls the AgentRiot software API", async () => {
  await withServer((request, response) => {
    assert.equal(request.url, "/api/software?query=OpenClaw");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      items: [{ id: "software_openclaw", slug: "openclaw", name: "OpenClaw" }],
    }));
  }, async (baseUrl) => {
    const result = await runCli([
      "lookup-software",
      "--query",
      "OpenClaw",
      "--base-url",
      baseUrl,
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.items[0].slug, "openclaw");
  });
});

test("register generates and persists a stable installation identity with returned credentials", async () => {
  const inputPath = await writePayload("register.json", {
    name: "Lifecycle Agent",
    tagline: "Uses AgentRiot.",
    description: "Exercises registration.",
  });
  const statePath = `${inputPath}.agentriot-state.json`;
  let seenBody = null;
  let preflightRequests = 0;
  let mutationRequests = 0;

  await withServer(async (request, response) => {
    if (request.url === "/api/agent-protocol") {
      preflightRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    mutationRequests += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/agents/register");
    assert.equal(request.headers["x-api-key"], undefined);
    const body = JSON.parse(await readRequestBody(request));
    seenBody = body;

    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      registrationStatus: "created",
      agent: { id: "agt_1", slug: "lifecycle-agent", name: "Lifecycle Agent" },
      apiKey: "agrt_secret",
    }));
  }, async (baseUrl) => {
    const result = await runCli(["register", "--input", inputPath, "--base-url", baseUrl, "--confirm-write", "true"]);

    assert.equal(typeof seenBody.installationId, "string");
    assert.ok(seenBody.installationId.length > 20);
    assert.deepEqual(seenBody, {
      name: "Lifecycle Agent",
      tagline: "Uses AgentRiot.",
      description: "Exercises registration.",
      installationId: seenBody.installationId,
    });
    assert.deepEqual(result, {
      ok: true,
      command: "register",
      registrationStatus: "created",
      agent: { id: "agt_1", slug: "lifecycle-agent", name: "Lifecycle Agent" },
      installationId: seenBody.installationId,
      apiKey: "agrt_secret",
      keyPrefix: "agrt_sec",
      apiKeyReturned: true,
      stateFile: statePath,
      storedApiKeyAvailable: true,
      recovery: null,
    });
    assert.equal(preflightRequests, 1);
    assert.equal(mutationRequests, 1);

    const state = await readJsonFile(statePath);
    assert.equal(state.installationId, result.installationId);
    assert.equal(state.agentSlug, "lifecycle-agent");
    assert.equal(state.apiKey, "agrt_secret");
  });
});

test("state atomic writes reject symlink destinations", async () => {
  const { writeRegistrationStateAtomic } = await import("../bin/lib/state.mjs");
  const dir = await mkdtemp(join(tmpdir(), "agentriot-state-"));
  const targetPath = join(dir, "target.json");
  const statePath = join(dir, "state.json");
  const original = '{"installationId":"install_target"}\n';
  await writeFile(targetPath, original, "utf8");
  await symlink(targetPath, statePath);

  await assert.rejects(
    writeRegistrationStateAtomic(statePath, {
      installationId: "install_replacement",
    }),
    /symbolic link/u,
  );

  assert.equal(await readFile(targetPath, "utf8"), original);
});

test("state atomic writes replace permissive files with owner-only permissions", async () => {
  const { writeRegistrationStateAtomic } = await import("../bin/lib/state.mjs");
  const dir = await mkdtemp(join(tmpdir(), "agentriot-state-"));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, '{"installationId":"install_old"}\n', {
    encoding: "utf8",
    mode: 0o644,
  });

  await writeRegistrationStateAtomic(statePath, {
    installationId: "install_new",
    agentSlug: "lifecycle-agent",
  });

  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.deepEqual(await readJsonFile(statePath), {
    installationId: "install_new",
    agentSlug: "lifecycle-agent",
  });
});

test("state atomic writes chmod to exact 0600 under a restrictive umask", async () => {
  const { writeRegistrationStateAtomic } = await import("../bin/lib/state.mjs");
  const dir = await mkdtemp(join(tmpdir(), "agentriot-state-"));
  const statePath = join(dir, "state.json");
  const previousUmask = process.umask(0o777);

  try {
    await writeRegistrationStateAtomic(statePath, {
      installationId: "install_restrictive_umask",
    });
  } finally {
    process.umask(previousUmask);
  }

  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
});

test("state atomic writes fsync the parent directory before success", async () => {
  const { createRegistrationStateIO } = await import("../bin/lib/state.mjs");
  const realFileSystem = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "agentriot-state-"));
  const statePath = join(dir, "state.json");
  let directorySyncs = 0;
  const order = [];
  const stateIO = createRegistrationStateIO({
    rename: async (...args) => {
      order.push("rename");
      return rename(...args);
    },
    open: async (filePath, flags, mode) => {
      if (filePath === dir) {
        return {
          async close() {},
          async sync() {
            order.push("directory-sync");
            directorySyncs += 1;
          },
        };
      }
      if (filePath === statePath) order.push("final-open");
      return realFileSystem.open(filePath, flags, mode);
    },
  });

  await stateIO.writeRegistrationStateAtomic(statePath, {
    installationId: "install_directory_sync",
  });

  assert.equal(directorySyncs, 1);
  assert.deepEqual(order, ["rename", "directory-sync", "final-open"]);
});

test("state atomic writes fail closed when directory fsync is unsupported", async () => {
  const { createRegistrationStateIO } = await import("../bin/lib/state.mjs");
  const realFileSystem = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "agentriot-state-"));
  const statePath = join(dir, "state.json");
  const unsupported = Object.assign(new Error("directory sync unsupported"), {
    code: "ENOTSUP",
  });
  const stateIO = createRegistrationStateIO({
    open: async (filePath, flags, mode) => {
      if (filePath === dir) throw unsupported;
      return realFileSystem.open(filePath, flags, mode);
    },
  });

  await assert.rejects(
    stateIO.writeRegistrationStateAtomic(statePath, {
      installationId: "install_directory_sync_required",
    }),
    /directory durability sync is required.*ENOTSUP/u,
  );
});

test("state file opens use no-follow protection when the platform provides it", async () => {
  const { createRegistrationStateIO } = await import("../bin/lib/state.mjs");
  const realFileSystem = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "agentriot-state-"));
  const statePath = join(dir, "state.json");
  const openedStateFlags = [];
  const stateIO = createRegistrationStateIO({
    open: async (filePath, flags, mode) => {
      if (filePath === statePath) openedStateFlags.push(flags);
      return realFileSystem.open(filePath, flags, mode);
    },
  });

  await stateIO.writeRegistrationStateAtomic(statePath, {
    installationId: "install_no_follow",
  });
  await stateIO.readRegistrationState(statePath, { required: true });

  if (fsConstants.O_NOFOLLOW) {
    assert.ok(openedStateFlags.length >= 2);
    for (const flags of openedStateFlags) {
      assert.equal(flags & fsConstants.O_NOFOLLOW, fsConstants.O_NOFOLLOW);
    }
  }
});

test("state atomic post-temp failure removes temp and preserves prior state", async () => {
  const { createRegistrationStateIO } = await import("../bin/lib/state.mjs");
  const dir = await mkdtemp(join(tmpdir(), "agentriot-state-"));
  const statePath = join(dir, "state.json");
  const original = '{"installationId":"install_existing"}\n';
  let renameCalls = 0;
  await writeFile(statePath, original, { encoding: "utf8", mode: 0o600 });
  const stateIO = createRegistrationStateIO({
    rename: async () => {
      renameCalls += 1;
      throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
    },
  });

  await assert.rejects(
    stateIO.writeRegistrationStateAtomic(statePath, {
      installationId: "install_replacement",
    }),
    /injected rename failure/u,
  );

  assert.equal(renameCalls, 1);
  assert.equal(await readFile(statePath, "utf8"), original);
  assert.deepEqual(await readdir(dir), ["state.json"]);
});

test("state atomic write failure preserves the complete prior file", async () => {
  const { writeRegistrationStateAtomic } = await import("../bin/lib/state.mjs");
  const dir = await mkdtemp(join(tmpdir(), "agentriot-state-"));
  const statePath = join(dir, "state.json");
  const original = '{"installationId":"install_existing"}\n';
  await writeFile(statePath, original, { encoding: "utf8", mode: 0o600 });
  await chmod(dir, 0o500);

  try {
    await assert.rejects(
      writeRegistrationStateAtomic(statePath, {
        installationId: "install_replacement",
      }),
      /Unable to persist registration state/u,
    );
  } finally {
    await chmod(dir, 0o700);
  }

  assert.equal(await readFile(statePath, "utf8"), original);
  assert.deepEqual(await readdir(dir), ["state.json"]);
});

test("registration persistence stores installation identity before network access", async () => {
  const inputPath = await writePayload("register.json", {
    name: "Lifecycle Agent",
    tagline: "Uses AgentRiot.",
    description: "Exercises registration.",
  });
  const statePath = `${inputPath}.agentriot-state.json`;
  let persistedBeforeFirstRequest = null;
  let registrationInstallationId = null;

  await withServer(async (request, response) => {
    if (persistedBeforeFirstRequest === null) {
      try {
        persistedBeforeFirstRequest = await readJsonFile(statePath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }

    if (request.url === "/api/agent-protocol") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    assert.equal(request.url, "/api/agents/register");
    const body = JSON.parse(await readRequestBody(request));
    registrationInstallationId = body.installationId;
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      registrationStatus: "created",
      agent: { id: "agt_1", slug: "lifecycle-agent", name: "Lifecycle Agent" },
      apiKey: "agrt_one_time_key",
    }));
  }, async (baseUrl) => {
    await runCli([
      "register",
      "--input",
      inputPath,
      "--base-url",
      baseUrl,
      "--confirm-write",
      "true",
    ]);
  });

  assert.equal(typeof persistedBeforeFirstRequest.installationId, "string");
  assert.ok(persistedBeforeFirstRequest.installationId.length > 20);
  assert.equal(registrationInstallationId, persistedBeforeFirstRequest.installationId);
});

test("registration persistence failure returns the one-time key only in recovery stdout", async () => {
  const inputPath = await writePayload("register.json", {
    name: "Lifecycle Agent",
    tagline: "Uses AgentRiot.",
    description: "Exercises registration.",
  });
  const statePath = `${inputPath}.agentriot-state.json`;
  const symlinkTarget = join(tmpdir(), `agentriot-recovery-${Date.now()}.json`);
  const oneTimeKey = "agrt_one_time_recovery_key";

  await withServer(async (request, response) => {
    if (request.url === "/api/agent-protocol") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    assert.equal(request.url, "/api/agents/register");
    await writeFile(symlinkTarget, '{"untouched":true}\n', "utf8");
    await symlink(symlinkTarget, `${statePath}.replacement`);
    await rename(`${statePath}.replacement`, statePath);
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      registrationStatus: "created",
      agent: { id: "agt_1", slug: "lifecycle-agent", name: "Lifecycle Agent" },
      apiKey: oneTimeKey,
    }));
  }, async (baseUrl) => {
    const failure = await runCliFailure([
      "register",
      "--input",
      inputPath,
      "--base-url",
      baseUrl,
      "--confirm-write",
      "true",
    ]);
    const recovery = JSON.parse(failure.stdout);

    assert.equal(failure.code, 1);
    assert.equal(recovery.ok, false);
    assert.equal(recovery.command, "register");
    assert.equal(recovery.statePersisted, false);
    assert.equal(recovery.apiKey, oneTimeKey);
    assert.equal(recovery.stateFile, statePath);
    assert.match(failure.stderr, /Registration succeeded, but credential state could not be persisted/u);
    assert.equal(failure.stderr.includes(oneTimeKey), false);
  });

  assert.deepEqual(await readJsonFile(symlinkTarget), { untouched: true });
});

test("registration response shape failure recovers a returned one-time key on stdout", async () => {
  const inputPath = await writePayload("register.json", {
    name: "Lifecycle Agent",
    tagline: "Uses AgentRiot.",
    description: "Exercises registration.",
  });
  const statePath = `${inputPath}.agentriot-state.json`;
  const oneTimeKey = "agrt_missing_slug_recovery_key";

  await withServer((request, response) => {
    if (request.url === "/api/agent-protocol") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    assert.equal(request.url, "/api/agents/register");
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      registrationStatus: "created",
      agent: { id: "agt_1", name: "Lifecycle Agent" },
      apiKey: oneTimeKey,
    }));
  }, async (baseUrl) => {
    const failure = await runCliFailure([
      "register",
      "--input",
      inputPath,
      "--base-url",
      baseUrl,
      "--confirm-write",
      "true",
    ]);
    const recovery = JSON.parse(failure.stdout);

    assert.equal(failure.code, 1);
    assert.equal(recovery.statePersisted, false);
    assert.equal(recovery.apiKey, oneTimeKey);
    assert.equal(recovery.stateFile, statePath);
    assert.equal(failure.stderr.includes(oneTimeKey), false);
    assert.match(failure.stderr, /Registration succeeded, but credential state could not be persisted/u);
  });
});

test("register writes credential state with owner-only permissions", async () => {
  const previousUmask = process.umask(0o022);

  try {
    const inputPath = await writePayload("register.json", {
      name: "Lifecycle Agent",
      tagline: "Uses AgentRiot.",
      description: "Exercises registration.",
    });
    const statePath = `${inputPath}.agentriot-state.json`;

    await withServer(async (request, response) => {
      if (request.url === "/api/agent-protocol") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(protocolResponse()));
        return;
      }

      assert.equal(request.url, "/api/agents/register");
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({
        registrationStatus: "created",
        agent: { id: "agt_1", slug: "lifecycle-agent", name: "Lifecycle Agent" },
        apiKey: "agrt_secret",
      }));
    }, async (baseUrl) => {
      await runCli(["register", "--input", inputPath, "--base-url", baseUrl, "--confirm-write", "true"]);

      const mode = (await stat(statePath)).mode & 0o777;
      assert.equal(mode, 0o600);
    });
  } finally {
    process.umask(previousUmask);
  }
});

test("register reuses the persisted installation identity on repeat registration", async () => {
  const inputPath = await writePayload("register.json", {
    name: "Lifecycle Agent",
    tagline: "Uses AgentRiot.",
    description: "Exercises registration.",
  });
  const statePath = `${inputPath}.agentriot-state.json`;
  await writeFile(statePath, JSON.stringify({
    installationId: "install_existing_1234567890",
    agentSlug: "lifecycle-agent",
    apiKey: "agrt_existing",
  }), "utf8");
  let seenBody = null;

  await withServer(async (request, response) => {
    if (request.url === "/api/agent-protocol") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    assert.equal(request.url, "/api/agents/register");
    const body = JSON.parse(await readRequestBody(request));
    seenBody = body;

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      registrationStatus: "existing",
      agent: { id: "agt_1", slug: "lifecycle-agent", name: "Lifecycle Agent" },
      apiKey: null,
    }));
  }, async (baseUrl) => {
    const result = await runCli(["register", "--input", inputPath, "--base-url", baseUrl, "--confirm-write", "true"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "register");
    assert.equal(seenBody.installationId, "install_existing_1234567890");
    assert.equal(result.registrationStatus, "existing");
    assert.equal(result.apiKeyReturned, false);
    assert.equal(result.storedApiKeyAvailable, true);

    const state = await readJsonFile(statePath);
    assert.equal(state.installationId, "install_existing_1234567890");
    assert.equal(state.apiKey, "agrt_existing");
  });
});

test("validate accepts register payloads before register injects installation identity", async () => {
  const inputPath = await writePayload("register.json", {
    name: "Lifecycle Agent",
    tagline: "Uses AgentRiot.",
    description: "Exercises registration.",
  });

  const result = await runCli(["validate", "--type", "register", "--input", inputPath]);

  assert.equal(result.ok, true);
  assert.equal(result.command, "validate");
  assert.equal(result.type, "register");
  assert.equal(result.validation.valid, true);
});

test("credential-bearing commands reject non-HTTPS non-loopback base URLs even when contract checks are skipped", async () => {
  const inputPath = await writePayload("update.json", {
    title: "Launched pipeline",
    summary: "New pipeline processes research notes.",
    whatChanged: "Published a public update.",
    signalType: "status",
  });

  const result = await runCliFailure([
    "publish-update",
    "--input",
    inputPath,
    "--slug",
    "lifecycle-agent",
    "--api-key",
    "agrt_secret_key",
    "--base-url",
    "http://agentriot.example",
    "--skip-contract-check",
    "true",
    "--dry-run",
    "true",
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Credential-bearing AgentRiot commands require an HTTPS base URL/u);
});

test("register rejects non-HTTPS non-loopback base URLs because it can return credentials", async () => {
  const inputPath = await writePayload("register.json", {
    name: "Lifecycle Agent",
    tagline: "Uses AgentRiot.",
    description: "Exercises registration.",
  });

  const result = await runCliFailure([
    "register",
    "--input",
    inputPath,
    "--base-url",
    "http://agentriot.example",
    "--skip-contract-check",
    "true",
    "--dry-run",
    "true",
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Credential-bearing AgentRiot commands require an HTTPS base URL/u);
});

test("credential base URL loopback exception rejects hostnames that only resemble loopback", async () => {
  const inputPath = await writePayload("update.json", {
    title: "Launched pipeline",
    summary: "New pipeline processes research notes.",
    whatChanged: "Published a public update.",
    signalType: "status",
  });

  const result = await runCliFailure([
    "publish-update",
    "--input",
    inputPath,
    "--slug",
    "lifecycle-agent",
    "--api-key",
    "agrt_secret_key",
    "--base-url",
    "http://127.evil.example",
    "--skip-contract-check",
    "true",
    "--dry-run",
    "true",
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Credential-bearing AgentRiot commands require an HTTPS base URL/u);
});

test("validate accepts a 10000 character prompt and rejects a 10001 character prompt locally", async () => {
  const validPath = await writePayload("prompt.json", {
    title: "Research brief prompt",
    description: "Summarizes public research notes into a reusable brief.",
    prompt: "p".repeat(10000),
    expectedOutput: "A concise brief.",
    tags: ["research", "brief"],
  });
  const invalidPath = await writePayload("prompt.json", {
    title: "Research brief prompt",
    description: "Summarizes public research notes into a reusable brief.",
    prompt: "p".repeat(10001),
  });

  const valid = await runCli(["validate", "--type", "prompt", "--input", validPath]);
  assert.equal(valid.ok, true);
  assert.equal(valid.contractVersion, "2026.05.16");
  assert.equal(valid.validation.valid, true);
  assert.equal(valid.validation.limits.prompt.prompt, 10000);

  const invalid = await runCliFailure(["validate", "--type", "prompt", "--input", invalidPath]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /prompt must be 10000 characters or fewer/u);
});

test("validate rejects blocked update links locally", async () => {
  const invalidPath = await writePayload("update.json", {
    title: "Launched pipeline",
    summary: "New pipeline processes research notes.",
    whatChanged: "Published a public update.",
    signalType: "status",
    publicLink: "data:text/html,<h1>bad</h1>",
  });

  const invalid = await runCliFailure(["validate", "--type", "update", "--input", invalidPath]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /publicLink must use http or https URL protocol/u);
});

test("validate rejects embedded credentials in avatarUrl", async () => {
  const inputPath = await writePayload("profile.json", {
    avatarUrl: "https://user:pass@example.com/avatar.png",
  });

  const invalid = await runCliFailure(["validate", "--type", "profile", "--input", inputPath]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /avatarUrl must not include embedded credentials/u);
});

test("validate rejects embedded credentials in publicLink", async () => {
  const inputPath = await writePayload("update.json", {
    title: "Launched pipeline",
    summary: "New pipeline processes research notes.",
    whatChanged: "Published a public update.",
    signalType: "status",
    publicLink: "https://user:pass@example.com/launch",
  });

  const invalid = await runCliFailure(["validate", "--type", "update", "--input", inputPath]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /publicLink must not include embedded credentials/u);
});

test("validate rejects embedded credentials in sourceUrl", async () => {
  const inputPath = await writePayload("playbook.json", validPlaybookPayload({
    sourceUrl: "https://user:pass@example.com/playbook",
  }));

  const invalid = await runCliFailure(["validate", "--type", "playbook", "--input", inputPath]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /sourceUrl must not include embedded credentials/u);
});

test("validate accepts safe prompt code fences with literal script tags", async () => {
  const inputPath = await writePayload("prompt.json", {
    title: "Safe code prompt",
    description: "Documents unsafe HTML without executing it.",
    prompt: "```html\n<script>alert(1)</script>\n```",
    expectedOutput: "Explain why this snippet is unsafe when rendered.",
  });

  const valid = await runCli(["validate", "--type", "prompt", "--input", inputPath]);
  assert.equal(valid.ok, true);
  assert.equal(valid.validation.valid, true);
});

test("validate accepts playbook payloads and exposes playbook limits", async () => {
  const inputPath = await writePayload("playbook.json", validPlaybookPayload());

  const valid = await runCli(["validate", "--type", "playbook", "--input", inputPath]);

  assert.equal(valid.ok, true);
  assert.equal(valid.command, "validate");
  assert.equal(valid.type, "playbook");
  assert.equal(valid.contractVersion, "2026.05.16");
  assert.equal(valid.validation.valid, true);
  assert.equal(valid.validation.limits.playbook.instructions, 30000);
  assert.equal(valid.validation.limits.playbook.outputExample, 5000);
});

test("validate accepts loop payloads and exposes loop limits", async () => {
  const inputPath = await writePayload("loop.json", validLoopPayload());

  const valid = await runCli(["validate", "--type", "loop", "--input", inputPath]);

  assert.equal(valid.ok, true);
  assert.equal(valid.command, "validate");
  assert.equal(valid.type, "loop");
  assert.equal(valid.contractVersion, "2026.05.16");
  assert.equal(valid.validation.valid, true);
  assert.equal(valid.validation.limits.playbook.loopSpecText, 2000);
  assert.equal(valid.validation.limits.playbook.servicesTools, 12);
});

test("validate accepts loop payloads through the playbook validator", async () => {
  const inputPath = await writePayload("loop.json", validLoopPayload());

  const valid = await runCli(["validate", "--type", "playbook", "--input", inputPath]);

  assert.equal(valid.ok, true);
  assert.equal(valid.validation.valid, true);
});

test("validate rejects invalid playbook payloads locally", async () => {
  const cases = [
    ["missing title", { title: "" }, /title is required/u],
    ["long instructions", { instructions: "i".repeat(30001) }, /instructions must be 30000 characters or fewer/u],
    ["long output example", { outputExample: "o".repeat(5001) }, /outputExample must be 5000 characters or fewer/u],
    ["too many models", { models: Array.from({ length: 9 }, (_, index) => `model-${index}`) }, /models must include 8 items or fewer/u],
    ["too many services", { servicesTools: Array.from({ length: 13 }, (_, index) => `tool-${index}`) }, /servicesTools must include 12 items or fewer/u],
    ["too many parameters", { parameters: Array.from({ length: 21 }, (_, index) => ({ name: `param-${index}` })) }, /parameters must include 20 items or fewer/u],
    ["too many tags", { tags: ["a", "b", "c", "d", "e", "f"] }, /tags must include 5 items or fewer/u],
    ["empty array string", { models: [""] }, /models\.0 must be a non-empty string/u],
    ["non object parameter", { parameters: ["repository"] }, /parameters\.0 must be an object/u],
    ["non string parameter description", { parameters: [{ name: "repository", description: 42 }] }, /parameters\.0\.description must be a string/u],
    ["unsupported parameter value", { parameters: [{ name: "repository", value: { slug: "owner\/repo" } }] }, /parameters\.0\.value must be a string, number, boolean, or non-empty string array/u],
    ["unsafe parameter value", { parameters: [{ name: "repository", value: "<script>alert(1)</script>" }] }, /parameters\.0\.value contains executable HTML/u],
    ["javascript source", { sourceUrl: "javascript:alert(1)" }, /sourceUrl must use http or https URL protocol/u],
    ["file source", { sourceUrl: "file:\/\/\/tmp\/playbook.md" }, /sourceUrl must use http or https URL protocol/u],
    ["credentialed source", { sourceUrl: "https:\/\/user:pass@example.com\/playbook" }, /sourceUrl must not include embedded credentials/u],
    ["encoded executable source", { sourceUrl: "https://example.com/%3Cscript%3Ealert(1)%3C/script%3E" }, /sourceUrl contains executable HTML/u],
    ["mixed malformed encoded executable source", { sourceUrl: "https://example.com/%E0%A4%A/%3Cscript%3Ealert(1)%3C/script%3E" }, /sourceUrl contains executable HTML/u],
    ["executable html", { description: "<script>alert(1)</script>" }, /description contains executable HTML/u],
    ["numeric entity executable html", { description: "&#x3c;script&#x3e;alert(1)&#x3c;/script&#x3e;" }, /description contains executable HTML/u],
    ["control junk", { instructions: "hello\u0000world" }, /instructions contains unsupported control characters/u],
  ];

  for (const [name, overrides, matcher] of cases) {
    const inputPath = await writePayload("playbook.json", validPlaybookPayload(overrides));
    const invalid = await runCliFailure(["validate", "--type", "playbook", "--input", inputPath]);
    assert.equal(invalid.code, 1, name);
    assert.match(invalid.stderr, matcher, name);
  }
});

test("validate rejects invalid loop payloads locally", async () => {
  const cases = [
    ["missing kind", { kind: undefined }, /kind must be loop/u],
    ["invalid kind", { kind: "workflow" }, /kind must be loop/u],
    ["missing loopSpec", { loopSpec: undefined }, /loopSpec is required when kind is loop/u],
    ["missing tools", { loopSpec: { ...validLoopPayload().loopSpec, tools: undefined } }, /loopSpec\.tools is required/u],
    ["too many tools", { loopSpec: { ...validLoopPayload().loopSpec, tools: Array.from({ length: 13 }, (_, index) => `tool-${index}`) } }, /loopSpec\.tools must include 12 items or fewer/u],
    ["long trigger", { loopSpec: { ...validLoopPayload().loopSpec, trigger: "t".repeat(2001) } }, /loopSpec\.trigger must be 2000 characters or fewer/u],
    ["unsupported loop field", { loopSpec: { ...validLoopPayload().loopSpec, cadence: "daily" } }, /loopSpec\.cadence is not supported/u],
    ["vague stop condition", { loopSpec: { ...validLoopPayload().loopSpec, stopCondition: "Run forever" } }, /loopSpec\.stopCondition must define a concrete stop condition/u],
    ["unsafe loop text", { loopSpec: { ...validLoopPayload().loopSpec, verification: "<script>alert(1)</script>" } }, /loopSpec\.verification contains executable HTML/u],
  ];

  for (const [name, overrides, matcher] of cases) {
    const inputPath = await writePayload("loop.json", validLoopPayload(overrides));
    const invalid = await runCliFailure(["validate", "--type", "loop", "--input", inputPath]);
    assert.equal(invalid.code, 1, name);
    assert.match(invalid.stderr, matcher, name);
  }
});

test("validate rejects loopSpec on regular playbooks", async () => {
  const inputPath = await writePayload("playbook.json", validPlaybookPayload({
    loopSpec: validLoopPayload().loopSpec,
  }));

  const invalid = await runCliFailure(["validate", "--type", "playbook", "--input", inputPath]);

  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /loopSpec is only supported when kind is loop/u);
});

test("validate handles out-of-range numeric HTML entities without internal decoder errors", async () => {
  const inputPath = await writePayload("playbook.json", validPlaybookPayload({
    description: "Review notes with &#9999999999999999999999999999999; and &#xFFFFFFFFFFFFFFFF; markers.",
  }));

  const valid = await runCli(["validate", "--type", "playbook", "--input", inputPath]);

  assert.equal(valid.ok, true);
  assert.equal(valid.validation.valid, true);
});

test("write command dry-run validates locally and skips server mutation", async () => {
  const inputPath = await writePayload("update.json", {
    title: "Launched automated literature review pipeline",
    summary: "New pipeline processes 100 papers per hour with structured output.",
    whatChanged: "Built ingestion, citation extraction, and summarization.",
    skillsTools: ["NLP", "Python"],
    signalType: "launch",
    publicLink: "https://example.com/blog/lit-review-pipeline",
  });
  let requests = 0;

  await withServer(async (request, response) => {
    requests += 1;
    assert.equal(request.url, "/api/agent-protocol");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(protocolResponse({
      contract: {
        version: "2026.05.17",
        minimumSupportedVersion: "2026.05.16",
        limits: {},
      },
    })));
  }, async (baseUrl) => {
    const result = await runCli([
      "publish-update",
      "--input",
      inputPath,
      "--slug",
      "lifecycle-agent",
      "--api-key",
      "agrt_secret_key",
      "--base-url",
      baseUrl,
      "--dry-run",
      "true",
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "publish-update");
    assert.equal(result.dryRun, true);
    assert.equal(result.validation.valid, true);
    assert.match(result.warnings[0], /newer compatible contract/u);
    assert.equal(requests, 1);
  });
});

test("write command protocol preflight rejects incompatible contracts before mutation", async () => {
  const inputPath = await writePayload("profile.json", {
    tagline: "Updated public tagline",
  });
  let requests = 0;

  await withServer(async (request, response) => {
    requests += 1;
    assert.equal(request.url, "/api/agent-protocol");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(protocolResponse({
      contract: {
        version: "2026.06.01",
        minimumSupportedVersion: "2026.06.01",
        limits: {},
      },
    })));
  }, async (baseUrl) => {
    const result = await runCliFailure([
      "update-profile",
      "--input",
      inputPath,
      "--slug",
      "lifecycle-agent",
      "--api-key",
      "agrt_secret_key",
      "--base-url",
      baseUrl,
      "--confirm-write",
      "true",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /requires contract 2026\.06\.01/u);
    assert.equal(requests, 1);
  });
});

test("upload-avatar dry-run validates file metadata and preflights without upload", async () => {
  const avatarPath = await writeTempFile("avatar.png", pngFixture(128, 128));
  let requests = 0;

  await withServer((request, response) => {
    requests += 1;
    assert.equal(request.url, "/api/agent-protocol");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(protocolResponse()));
  }, async (baseUrl) => {
    const result = await runCli([
      "upload-avatar",
      "--file",
      avatarPath,
      "--slug",
      "lifecycle-agent",
      "--api-key",
      "agrt_secret_key",
      "--base-url",
      baseUrl,
      "--dry-run",
      "true",
    ]);
    const serialized = JSON.stringify(result);

    assert.equal(result.ok, true);
    assert.equal(result.command, "upload-avatar");
    assert.equal(result.dryRun, true);
    assert.equal(result.targetPath, "/api/agents/lifecycle-agent/avatar");
    assert.equal(result.file.field, "file");
    assert.equal(result.file.contentType, "image/png");
    assert.equal(result.file.width, 128);
    assert.equal(result.file.height, 128);
    assert.equal(result.file.maxBytes, 2 * 1024 * 1024);
    assert.equal(requests, 1);
    assert.equal(serialized.includes("agrt_secret_key"), false);
  });
});

test("upload-avatar posts multipart form data with API key header", async () => {
  const avatarPath = await writeTempFile("avatar.png", pngFixture(256, 256));
  const seen = {};
  let preflightRequests = 0;
  let mutationRequests = 0;

  await withServer(async (request, response) => {
    if (request.url === "/api/agent-protocol") {
      preflightRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    mutationRequests += 1;
    assert.equal(request.url, "/api/agents/lifecycle-agent/avatar");
    assert.equal(request.method, "POST");
    assert.equal(request.headers["x-api-key"], "agrt_secret_key");
    assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/u);
    seen.body = await readRequestBody(request);

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      avatar: {
        id: "avatar_1",
        path: "/uploads/agents/lifecycle-agent/avatar.png",
      },
      publicPath: "/uploads/agents/lifecycle-agent/avatar.png",
    }));
  }, async (baseUrl) => {
    const result = await runCli([
      "upload-avatar",
      "--file",
      avatarPath,
      "--slug",
      "lifecycle-agent",
      "--api-key",
      "agrt_secret_key",
      "--base-url",
      baseUrl,
      "--confirm-write",
      "true",
    ]);
    const serialized = JSON.stringify(result);

    assert.deepEqual(result, {
      ok: true,
      command: "upload-avatar",
      avatar: {
        id: "avatar_1",
        path: "/uploads/agents/lifecycle-agent/avatar.png",
      },
      publicPath: "/uploads/agents/lifecycle-agent/avatar.png",
      avatarUrl: `${baseUrl}/uploads/agents/lifecycle-agent/avatar.png`,
      file: {
        name: "avatar.png",
        bytes: 33,
        contentType: "image/png",
        width: 256,
        height: 256,
        field: "file",
      },
      warnings: [],
    });
    assert.match(seen.body, /name="file"; filename="avatar\.png"/u);
    assert.match(seen.body, /Content-Type: image\/png/u);
    assert.equal(preflightRequests, 1);
    assert.equal(mutationRequests, 1);
    assert.equal(serialized.includes("agrt_secret_key"), false);
  });
});

test("upload-avatar rejects invalid inputs before mutation", async () => {
  const validAvatarPath = await writeTempFile("avatar.png", pngFixture(256, 256));
  const avatarPath = await writeTempFile("avatar.gif", Buffer.from("GIF89a", "ascii"));

  const missingSlug = await runCliFailure([
    "upload-avatar",
    "--file",
    validAvatarPath,
    "--api-key",
    "agrt_secret_key",
  ]);
  assert.equal(missingSlug.code, 1);
  assert.match(missingSlug.stderr, /--slug or AGENTRIOT_AGENT_SLUG is required/u);

  const missingKey = await runCliFailure([
    "upload-avatar",
    "--slug",
    "lifecycle-agent",
    "--file",
    validAvatarPath,
  ]);
  assert.equal(missingKey.code, 1);
  assert.match(missingKey.stderr, /--api-key or AGENTRIOT_API_KEY is required/u);

  const unsupported = await runCliFailure([
    "upload-avatar",
    "--file",
    avatarPath,
    "--slug",
    "lifecycle-agent",
    "--api-key",
    "agrt_secret_key",
  ]);
  assert.equal(unsupported.code, 1);
  assert.match(unsupported.stderr, /PNG, JPEG, or WebP/u);

  const missingFile = await runCliFailure([
    "upload-avatar",
    "--file",
    `${validAvatarPath}.missing`,
    "--slug",
    "lifecycle-agent",
    "--api-key",
    "agrt_secret_key",
  ]);
  assert.equal(missingFile.code, 1);
  assert.match(missingFile.stderr, /Unable to read avatar file/u);

  const oversize = await writeTempFile("avatar.png", Buffer.alloc((2 * 1024 * 1024) + 1));
  const tooLarge = await runCliFailure([
    "upload-avatar",
    "--file",
    oversize,
    "--slug",
    "lifecycle-agent",
    "--api-key",
    "agrt_secret_key",
  ]);
  assert.equal(tooLarge.code, 1);
  assert.match(tooLarge.stderr, /2 MiB or smaller/u);

  const badSignature = await writeTempFile("avatar.png", Buffer.from("not a png", "utf8"));
  const invalidContent = await runCliFailure([
    "upload-avatar",
    "--file",
    badSignature,
    "--slug",
    "lifecycle-agent",
    "--api-key",
    "agrt_secret_key",
  ]);
  assert.equal(invalidContent.code, 1);
  assert.match(invalidContent.stderr, /does not match image\/png/u);
});

test("upload-avatar accepts PNG, JPEG, and WebP dimensions at inclusive boundaries", async () => {
  const fixtures = [
    ["avatar.png", pngFixture(128, 128), "image/png", 128, 128],
    ["avatar.jpg", jpegFixture(2048, 2048), "image/jpeg", 2048, 2048],
    ["avatar-vp8.webp", webpVp8Fixture(512, 768), "image/webp", 512, 768],
    ["avatar-vp8l.webp", webpVp8lFixture(640, 480), "image/webp", 640, 480],
    ["avatar-vp8x.webp", webpVp8xFixture(1024, 1536), "image/webp", 1024, 1536],
  ];

  await withServer((request, response) => {
    assert.equal(request.url, "/api/agent-protocol");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(protocolResponse()));
  }, async (baseUrl) => {
    for (const [name, contents, contentType, width, height] of fixtures) {
      const avatarPath = await writeTempFile(name, contents);
      const result = await runCli([
        "upload-avatar",
        "--file",
        avatarPath,
        "--slug",
        "lifecycle-agent",
        "--api-key",
        "agrt_secret_key",
        "--base-url",
        baseUrl,
        "--dry-run",
        "true",
      ]);

      assert.equal(result.file.contentType, contentType);
      assert.equal(result.file.width, width);
      assert.equal(result.file.height, height);
    }
  });
});

test("upload-avatar rejects malformed and out-of-range dimensions before preflight", async (t) => {
  const fixtures = [
    ["too-small.png", pngFixture(1, 1), /between 128 and 2048 pixels/u],
    ["too-wide.jpg", jpegFixture(4096, 128), /between 128 and 2048 pixels/u],
    ["truncated.webp", webpVp8xFixture(256, 256).subarray(0, 24), /Malformed WebP image/u],
    ["vp8-inter-frame.webp", webpVp8Fixture(256, 256, { frameTag: 0x01 }), /Malformed WebP image/u],
    ["vp8l-version.webp", webpVp8lFixture(256, 256, { version: 1 }), /Malformed WebP image/u],
    ["vp8x-reserved-flag.webp", webpVp8xFixture(256, 256, { flags: 0x01 }), /Malformed WebP image/u],
    ["vp8x-reserved-byte.webp", webpVp8xFixture(256, 256, { reservedBytes: [0x01, 0x00, 0x00] }), /Malformed WebP image/u],
    ["signature-only.png", Buffer.from("89504e470d0a1a0a", "hex"), /Malformed PNG image/u],
    ["signature-only.jpg", Buffer.from("ffd8ff", "hex"), /Malformed JPEG image/u],
    ["signature-only.webp", Buffer.from("524946460000000057454250", "hex"), /Malformed WebP image/u],
  ];
  let requests = 0;

  await withServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(protocolResponse()));
  }, async (baseUrl) => {
    for (const [name, contents, expectedError] of fixtures) {
      await t.test(name, async () => {
        const avatarPath = await writeTempFile(name, contents);
        const result = await runCliFailure([
          "upload-avatar",
          "--file",
          avatarPath,
          "--slug",
          "lifecycle-agent",
          "--api-key",
          "agrt_secret_key",
          "--base-url",
          baseUrl,
          "--dry-run",
          "true",
        ]);

        assert.equal(result.code, 1);
        assert.match(result.stderr, expectedError);
      });
    }
  });

  assert.equal(requests, 0);
});

test("feed-stream reads public SSE events and exits after max events", async () => {
  await withServer((request, response) => {
    assert.equal(request.url, "/api/feed/stream");
    assert.equal(request.headers["x-api-key"], undefined);
    assert.equal(request.headers.authorization, undefined);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: ready\ndata: {\"ok\":true}\n\n");
    response.write("event: heartbeat\ndata: {\"ts\":\"2026-05-26T20:00:00Z\"}\n\n");
    response.end("event: feed-update\ndata: {\"agentSlug\":\"lifecycle-agent\",\"title\":\"Launch\"}\n\n");
  }, async (baseUrl) => {
    const result = await runCli([
      "feed-stream",
      "--base-url",
      baseUrl,
      "--max-events",
      "3",
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "feed-stream");
    assert.equal(result.public, true);
    assert.equal(result.streamPath, "/api/feed/stream");
    assert.equal(result.count, 3);
    assert.deepEqual(result.events.map((event) => event.event), ["ready", "heartbeat", "feed-update"]);
    assert.equal(result.events[2].data.agentSlug, "lifecycle-agent");
  });
});

test("state command masks persisted credentials and identifiers", async () => {
  const inputPath = await writePayload("register.json", {
    name: "Lifecycle Agent",
  });
  const statePath = `${inputPath}.agentriot-state.json`;
  await writeFile(statePath, JSON.stringify({
    installationId: "install_existing_1234567890",
    agentSlug: "lifecycle-agent",
    apiKey: "agrt_secret_key_value",
    recoveryToken: "recovery_secret_token",
  }), "utf8");

  const result = await runCli(["state", "--state-file", statePath]);
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.command, "state");
  assert.equal(result.stateFile, statePath);
  assert.equal(result.installationId, "install_exi...");
  assert.equal(result.agentSlug, "lifecyc...");
  assert.equal(result.apiKey.available, true);
  assert.equal(result.apiKey.prefix, "agrt_sec");
  assert.equal(result.recoveryToken.available, true);
  assert.equal(result.recoveryToken.prefix, "recovery");
  assert.equal(serialized.includes("agrt_secret_key_value"), false);
  assert.equal(serialized.includes("recovery_secret_token"), false);
  assert.equal(serialized.includes("install_existing_1234567890"), false);
  assert.equal(serialized.includes("lifecycle-agent"), false);
});

test("state command fails when the requested state file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentriot-"));
  const missingPath = join(dir, "missing-state.json");

  const result = await runCliFailure(["state", "--state-file", missingPath]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Registration state file not found/u);
});

const SUCCESS_COMMAND_CASES = [
  {
    command: "claim",
    method: "POST",
    route: "/api/agents/claim",
    args: ["--slug", "lifecycle-agent", "--api-key", "agrt_test_key", "--email", "owner@example.com"],
    requestBody: {
      agentSlug: "lifecycle-agent",
      apiKey: "agrt_test_key",
      email: "owner@example.com",
    },
    response: {
      claimed: true,
      agentId: "agt_1",
      email: "owner@example.com",
      recoveryToken: "recovery_test_token",
    },
    expected: {
      ok: true,
      command: "claim",
      claimed: true,
      agentId: "agt_1",
      email: "owner@example.com",
      recoveryToken: "recovery_test_token",
    },
  },
  {
    command: "rotate-key",
    method: "POST",
    route: "/api/agents/lifecycle-agent/keys/rotate",
    args: ["--slug", "lifecycle-agent", "--api-key", "agrt_test_key"],
    requestBody: { apiKey: "agrt_test_key" },
    response: {
      agent: { id: "agt_1", slug: "lifecycle-agent" },
      apiKey: "agrt_rotated_key",
      keyPrefix: "agrt_rot",
      recoveryToken: "recovery_rotated_token",
    },
    expected: {
      ok: true,
      command: "rotate-key",
      agent: { id: "agt_1", slug: "lifecycle-agent" },
      apiKey: "agrt_rotated_key",
      keyPrefix: "agrt_rot",
      recoveryToken: "recovery_rotated_token",
    },
  },
  {
    command: "get-profile",
    method: "GET",
    route: "/api/agents/lifecycle-agent",
    args: ["--slug", "lifecycle-agent"],
    response: {
      profile: { slug: "lifecycle-agent", name: "Lifecycle Agent" },
    },
    expected: {
      ok: true,
      command: "get-profile",
      profile: { slug: "lifecycle-agent", name: "Lifecycle Agent" },
      publicPath: "/agents/lifecycle-agent",
    },
  },
  {
    command: "update-profile",
    method: "PATCH",
    route: "/api/agents/lifecycle-agent",
    args: ["--slug", "lifecycle-agent", "--api-key", "agrt_test_key"],
    payload: { tagline: "Updated lifecycle profile" },
    response: {
      profile: { slug: "lifecycle-agent", tagline: "Updated lifecycle profile" },
    },
    expected: {
      ok: true,
      command: "update-profile",
      profile: { slug: "lifecycle-agent", tagline: "Updated lifecycle profile" },
      publicPath: "/agents/lifecycle-agent",
    },
  },
  {
    command: "publish-update",
    method: "POST",
    route: "/api/agents/lifecycle-agent/updates",
    args: ["--slug", "lifecycle-agent", "--api-key", "agrt_test_key"],
    payload: {
      title: "Lifecycle launch",
      summary: "Published the lifecycle release.",
      whatChanged: "Added portable release verification.",
      signalType: "launch",
    },
    response: {
      update: { id: "update_1", slug: "lifecycle-launch" },
    },
    expected: {
      ok: true,
      command: "publish-update",
      id: "update_1",
      publicPath: "/agents/lifecycle-agent/updates/lifecycle-launch",
    },
  },
  {
    command: "publish-prompt",
    method: "POST",
    route: "/api/agents/lifecycle-agent/prompts",
    args: ["--slug", "lifecycle-agent", "--api-key", "agrt_test_key"],
    payload: {
      title: "Lifecycle summary",
      description: "Summarizes lifecycle evidence.",
      prompt: "Summarize the lifecycle evidence.",
      expectedOutput: "A concise lifecycle summary.",
    },
    response: {
      prompt: { id: "prompt_1", slug: "lifecycle-summary" },
      publicPath: "/prompts/lifecycle-summary",
    },
    expected: {
      ok: true,
      command: "publish-prompt",
      id: "prompt_1",
      publicPath: "/prompts/lifecycle-summary",
    },
  },
];

test("core public commands preserve their route, auth, request, preflight, and response contracts", async (t) => {
  for (const commandCase of SUCCESS_COMMAND_CASES) {
    await t.test(commandCase.command, async () => {
      const inputPath = commandCase.payload
        ? await writePayload(`${commandCase.command}.json`, commandCase.payload)
        : null;
      let preflightRequests = 0;
      let operationRequests = 0;

      await withServer(async (request, response) => {
        if (request.url === "/api/agent-protocol") {
          preflightRequests += 1;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(protocolResponse()));
          return;
        }

        operationRequests += 1;
        assert.equal(request.method, commandCase.method);
        assert.equal(request.url, commandCase.route);
        assert.equal(
          request.headers["x-api-key"],
          ["update-profile", "publish-update", "publish-prompt"].includes(commandCase.command)
            ? "agrt_test_key"
            : undefined,
        );
        if (commandCase.requestBody || commandCase.payload) {
          assert.deepEqual(
            JSON.parse(await readRequestBody(request)),
            commandCase.requestBody ?? commandCase.payload,
          );
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(commandCase.response));
      }, async (baseUrl) => {
        const result = await runCli([
          commandCase.command,
          ...commandCase.args,
          ...(inputPath ? ["--input", inputPath] : []),
          "--base-url",
          baseUrl,
          ...(["get-profile"].includes(commandCase.command) ? [] : ["--confirm-write", "true"]),
        ]);

        assert.deepEqual(result, {
          ...commandCase.expected,
          ...("publicPath" in commandCase.expected
            ? { publicUrl: `${baseUrl}${commandCase.expected.publicPath}` }
            : {}),
        });
        assert.equal(preflightRequests, commandCase.command === "get-profile" ? 0 : 1);
        assert.equal(operationRequests, 1);
      });
    });
  }
});

test("core public writes support dry-run and reject missing confirmation without mutation", async (t) => {
  const writeCases = SUCCESS_COMMAND_CASES.filter(({ command }) => command !== "get-profile");

  for (const commandCase of writeCases) {
    await t.test(commandCase.command, async () => {
      const inputPath = commandCase.payload
        ? await writePayload(`${commandCase.command}.json`, commandCase.payload)
        : null;
      const baseArgs = [
        commandCase.command,
        ...commandCase.args,
        ...(inputPath ? ["--input", inputPath] : []),
      ];

      for (const phase of ["dry-run", "missing-confirmation"]) {
        let preflightRequests = 0;
        let operationRequests = 0;

        await withServer((request, response) => {
          if (request.url === "/api/agent-protocol") {
            preflightRequests += 1;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(protocolResponse()));
            return;
          }

          operationRequests += 1;
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "unexpected mutation" }));
        }, async (baseUrl) => {
          const args = [...baseArgs, "--base-url", baseUrl];
          if (phase === "dry-run") {
            const result = await runCli([...args, "--dry-run", "true"]);
            assert.equal(result.ok, true);
            assert.equal(result.command, commandCase.command);
            assert.equal(result.dryRun, true);
            assert.equal(result.contractVersion, "2026.05.16");
          } else {
            const result = await runCliFailure(args);
            assert.match(result.stderr, /--confirm-write true is required for live writes/u);
          }
        });

        assert.equal(preflightRequests, 1, `${commandCase.command} ${phase} preflight`);
        assert.equal(operationRequests, 0, `${commandCase.command} ${phase} mutation`);
      }
    });
  }
});

test("remaining public writes independently preflight dry-run and missing-confirmation phases", async (t) => {
  const registerPath = await writePayload("register-guards.json", {
    name: "Lifecycle Agent",
    tagline: "Uses AgentRiot.",
    description: "Exercises registration guards.",
  });
  const registerStatePath = `${registerPath}.explicit-state.json`;
  const seededRegisterState = '{"installationId":"install_seeded_1234567890","agentSlug":"seeded-agent","apiKey":"agrt_seeded_key"}\n';
  await writeFile(registerStatePath, seededRegisterState, "utf8");
  const updatePath = await writePayload("edit-update-guards.json", {
    title: "Updated launch note",
    summary: "Clarifies the public launch summary.",
    whatChanged: "Corrected the public-safe details.",
    signalType: "status",
  });
  const promptPath = await writePayload("edit-prompt-guards.json", {
    title: "Updated research brief",
    description: "Clarifies when to use the prompt.",
    prompt: "Summarize the notes into findings and risks.",
    expectedOutput: "Findings and risks.",
  });
  const playbookPath = await writePayload("playbook-guards.json", validPlaybookPayload());
  const avatarPath = await writeTempFile("avatar-guards.png", pngFixture(256, 256));
  const cases = [
    {
      command: "register",
      args: ["--input", registerPath, "--state-file", registerStatePath],
      statePath: registerStatePath,
    },
    {
      command: "edit-update",
      args: ["--input", updatePath, "--slug", "lifecycle-agent", "--update-slug", "launch-update", "--api-key", "agrt_test_key"],
    },
    {
      command: "edit-prompt",
      args: ["--input", promptPath, "--slug", "lifecycle-agent", "--prompt-slug", "research-brief", "--api-key", "agrt_test_key"],
    },
    {
      command: "publish-playbook",
      args: ["--input", playbookPath, "--slug", "lifecycle-agent", "--api-key", "agrt_test_key"],
    },
    {
      command: "edit-playbook",
      args: ["--input", playbookPath, "--slug", "lifecycle-agent", "--playbook-slug", "daily-launch-review", "--api-key", "agrt_test_key"],
    },
    {
      command: "upload-avatar",
      args: ["--file", avatarPath, "--slug", "lifecycle-agent", "--api-key", "agrt_test_key"],
    },
  ];

  for (const commandCase of cases) {
    await t.test(commandCase.command, async () => {
      for (const phase of ["dry-run", "missing-confirmation"]) {
        let preflightRequests = 0;
        let mutationRequests = 0;
        const stateBefore = commandCase.statePath
          ? await readFile(commandCase.statePath, "utf8")
          : null;

        await withServer((request, response) => {
          if (request.url === "/api/agent-protocol") {
            preflightRequests += 1;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(protocolResponse()));
            return;
          }

          mutationRequests += 1;
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "unexpected mutation" }));
        }, async (baseUrl) => {
          const args = [commandCase.command, ...commandCase.args, "--base-url", baseUrl];
          if (phase === "dry-run") {
            const result = await runCli([...args, "--dry-run", "true"]);
            assert.equal(result.ok, true);
            assert.equal(result.command, commandCase.command);
            assert.equal(result.dryRun, true);
            assert.equal(result.contractVersion, "2026.05.16");
          } else {
            const result = await runCliFailure(args);
            assert.match(result.stderr, /--confirm-write true is required for live writes/u);
          }
        });

        const expectedPreflights = commandCase.command === "register" && phase === "missing-confirmation"
          ? 0
          : 1;
        assert.equal(preflightRequests, expectedPreflights, `${commandCase.command} ${phase} preflight`);
        assert.equal(mutationRequests, 0, `${commandCase.command} ${phase} mutation`);
        if (commandCase.statePath) {
          const stateAfter = await readFile(commandCase.statePath, "utf8");
          assert.equal(stateAfter, stateBefore, `${commandCase.command} ${phase} state bytes`);
        }
      }
    });
  }
});

test("server validation errors include field-specific details", async () => {
  const inputPath = await writePayload("prompt.json", {
    title: "Research brief prompt",
    description: "Summarizes public research notes into a reusable brief.",
    prompt: "Summarize these notes.",
    expectedOutput: "A concise brief.",
  });

  await withServer(async (request, response) => {
    if (request.url === "/api/agent-protocol") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    assert.equal(request.url, "/api/agents/lifecycle-agent/prompts");
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: "Validation failed",
      details: [
        { field: "prompt", message: "prompt must be unique" },
        { path: ["tags", 0], message: "tag is not allowed" },
      ],
    }));
  }, async (baseUrl) => {
    const result = await runCliFailure([
      "publish-prompt",
      "--input",
      inputPath,
      "--slug",
      "lifecycle-agent",
      "--api-key",
      "agrt_secret_key",
      "--base-url",
      baseUrl,
      "--confirm-write",
      "true",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Validation failed/u);
    assert.match(result.stderr, /prompt: prompt must be unique/u);
    assert.match(result.stderr, /tags\.0: tag is not allowed/u);
  });
});

test("edit-update patches an existing timeline update", async () => {
  const inputPath = await writePayload("update.json", {
    title: "Updated launch note",
    summary: "Clarifies the public launch summary.",
    whatChanged: "Corrected the public-safe details.",
    signalType: "status",
    skillsTools: ["release"],
  });
  let preflightRequests = 0;
  let mutationRequests = 0;

  await withServer(async (request, response) => {
    if (request.url === "/api/agent-protocol") {
      preflightRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    mutationRequests += 1;
    assert.equal(request.method, "PATCH");
    assert.equal(request.url, "/api/agents/lifecycle-agent/updates/launch-update");
    assert.equal(request.headers["x-api-key"], "agrt_test_key");
    assert.deepEqual(JSON.parse(await readRequestBody(request)), {
      title: "Updated launch note",
      summary: "Clarifies the public launch summary.",
      whatChanged: "Corrected the public-safe details.",
      signalType: "status",
      skillsTools: ["release"],
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      update: {
        id: "update_1",
        slug: "launch-update",
        title: "Updated launch note",
      },
    }));
  }, async (baseUrl) => {
    const result = await runCli([
      "edit-update",
      "--input",
      inputPath,
      "--slug",
      "lifecycle-agent",
      "--update-slug",
      "launch-update",
      "--api-key",
      "agrt_test_key",
      "--base-url",
      baseUrl,
      "--confirm-write",
      "true",
    ]);

    assert.deepEqual(result, {
      ok: true,
      command: "edit-update",
      id: "update_1",
      publicPath: "/agents/lifecycle-agent/updates/launch-update",
      publicUrl: `${baseUrl}/agents/lifecycle-agent/updates/launch-update`,
    });
    assert.equal(preflightRequests, 1);
    assert.equal(mutationRequests, 1);
  });
});

test("edit-prompt patches an existing shared prompt", async () => {
  const payload = {
    title: "Updated research brief",
    description: "Clarifies when to use the prompt.",
    prompt: "Summarize the notes into findings and risks.",
    expectedOutput: "Findings and risks.",
    tags: ["research"],
  };
  const inputPath = await writePayload("prompt.json", payload);
  let preflightRequests = 0;
  let mutationRequests = 0;

  await withServer(async (request, response) => {
    if (request.url === "/api/agent-protocol") {
      preflightRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    mutationRequests += 1;
    assert.equal(request.method, "PATCH");
    assert.equal(request.url, "/api/agents/lifecycle-agent/prompts/research-brief");
    assert.equal(request.headers["x-api-key"], "agrt_test_key");
    assert.deepEqual(JSON.parse(await readRequestBody(request)), payload);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      prompt: {
        id: "prompt_1",
        slug: "research-brief",
        title: "Updated research brief",
      },
      publicPath: "/prompts/research-brief",
    }));
  }, async (baseUrl) => {
    const result = await runCli([
      "edit-prompt",
      "--input",
      inputPath,
      "--slug",
      "lifecycle-agent",
      "--prompt-slug",
      "research-brief",
      "--api-key",
      "agrt_test_key",
      "--base-url",
      baseUrl,
      "--confirm-write",
      "true",
    ]);

    assert.deepEqual(result, {
      ok: true,
      command: "edit-prompt",
      id: "prompt_1",
      publicPath: "/prompts/research-brief",
      publicUrl: `${baseUrl}/prompts/research-brief`,
    });
    assert.equal(preflightRequests, 1);
    assert.equal(mutationRequests, 1);
  });
});

test("publish-playbook posts a public playbook with API key header", async () => {
  const payload = validPlaybookPayload();
  const inputPath = await writePayload("playbook.json", payload);
  let seenBody = null;
  let preflightRequests = 0;
  let mutationRequests = 0;

  await withServer(async (request, response) => {
    if (request.url === "/api/agent-protocol") {
      preflightRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    mutationRequests += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/agents/lifecycle-agent/playbooks");
    assert.equal(request.headers["x-api-key"], "agrt_secret_key");
    seenBody = JSON.parse(await readRequestBody(request));
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      playbook: {
        id: "playbook_1",
        slug: "daily-launch-review",
        title: payload.title,
      },
      publicPath: "/playbooks/daily-launch-review",
    }));
  }, async (baseUrl) => {
    const result = await runCli([
      "publish-playbook",
      "--input",
      inputPath,
      "--slug",
      "lifecycle-agent",
      "--api-key",
      "agrt_secret_key",
      "--base-url",
      baseUrl,
      "--confirm-write",
      "true",
    ]);
    const serialized = JSON.stringify(result);

    assert.deepEqual(result, {
      ok: true,
      command: "publish-playbook",
      id: "playbook_1",
      playbook: {
        id: "playbook_1",
        slug: "daily-launch-review",
        title: payload.title,
      },
      canonicalPath: "/playbooks/daily-launch-review",
      playbookPath: "/playbooks/daily-launch-review",
      publicPath: "/playbooks/daily-launch-review",
      canonicalUrl: `${baseUrl}/playbooks/daily-launch-review`,
      publicUrl: `${baseUrl}/playbooks/daily-launch-review`,
      validationWarnings: [],
    });
    assert.deepEqual(seenBody, payload);
    assert.equal(preflightRequests, 1);
    assert.equal(mutationRequests, 1);
    assert.equal(serialized.includes("agrt_secret_key"), false);
  });
});

test("publish-playbook posts an Agent Loop and reports canonical loop paths", async () => {
  const payload = validLoopPayload();
  const inputPath = await writePayload("loop.json", payload);
  let seenBody = null;

  await withServer(async (request, response) => {
    if (request.url === "/api/agent-protocol") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/agents/lifecycle-agent/playbooks");
    assert.equal(request.headers["x-api-key"], "agrt_secret_key");
    seenBody = JSON.parse(await readRequestBody(request));
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      playbook: {
        id: "loop_1",
        slug: "launch-evidence-loop",
        kind: "loop",
        title: payload.title,
      },
      canonicalPath: "/loops/launch-evidence-loop",
      playbookPath: "/playbooks/launch-evidence-loop",
    }));
  }, async (baseUrl) => {
    const result = await runCli([
      "publish-playbook",
      "--input",
      inputPath,
      "--slug",
      "lifecycle-agent",
      "--api-key",
      "agrt_secret_key",
      "--base-url",
      baseUrl,
      "--confirm-write",
      "true",
    ]);
    const serialized = JSON.stringify(result);

    assert.equal(result.ok, true);
    assert.equal(result.command, "publish-playbook");
    assert.equal(result.playbook.kind, "loop");
    assert.equal(result.canonicalPath, "/loops/launch-evidence-loop");
    assert.equal(result.playbookPath, "/playbooks/launch-evidence-loop");
    assert.equal(result.publicPath, "/loops/launch-evidence-loop");
    assert.equal(result.canonicalUrl, `${baseUrl}/loops/launch-evidence-loop`);
    assert.equal(result.publicUrl, `${baseUrl}/loops/launch-evidence-loop`);
    assert.deepEqual(seenBody, payload);
    assert.equal(serialized.includes("agrt_secret_key"), false);
  });
});

test("edit-playbook patches an existing public playbook", async () => {
  const payload = validPlaybookPayload({ title: "Updated daily launch review" });
  const inputPath = await writePayload("playbook.json", payload);
  let seenBody = null;
  let preflightRequests = 0;
  let mutationRequests = 0;

  await withServer(async (request, response) => {
    if (request.url === "/api/agent-protocol") {
      preflightRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    mutationRequests += 1;
    assert.equal(request.method, "PATCH");
    assert.equal(request.url, "/api/agents/lifecycle-agent/playbooks/daily-launch-review");
    assert.equal(request.headers["x-api-key"], "agrt_secret_key");
    seenBody = JSON.parse(await readRequestBody(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      playbook: {
        id: "playbook_1",
        slug: "daily-launch-review",
        title: payload.title,
      },
      publicPath: "/playbooks/daily-launch-review",
    }));
  }, async (baseUrl) => {
    const result = await runCli([
      "edit-playbook",
      "--input",
      inputPath,
      "--slug",
      "lifecycle-agent",
      "--playbook-slug",
      "daily-launch-review",
      "--api-key",
      "agrt_secret_key",
      "--base-url",
      baseUrl,
      "--confirm-write",
      "true",
    ]);

    assert.deepEqual(result, {
      ok: true,
      command: "edit-playbook",
      id: "playbook_1",
      playbook: {
        id: "playbook_1",
        slug: "daily-launch-review",
        title: payload.title,
      },
      canonicalPath: "/playbooks/daily-launch-review",
      playbookPath: "/playbooks/daily-launch-review",
      publicPath: "/playbooks/daily-launch-review",
      canonicalUrl: `${baseUrl}/playbooks/daily-launch-review`,
      publicUrl: `${baseUrl}/playbooks/daily-launch-review`,
      validationWarnings: [],
    });
    assert.deepEqual(seenBody, payload);
    assert.equal(preflightRequests, 1);
    assert.equal(mutationRequests, 1);
  });
});

test("edit-playbook patches an Agent Loop and keeps canonical loop path", async () => {
  const payload = validLoopPayload({ title: "Updated launch evidence loop" });
  const inputPath = await writePayload("loop.json", payload);
  let seenBody = null;

  await withServer(async (request, response) => {
    if (request.url === "/api/agent-protocol") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    assert.equal(request.method, "PATCH");
    assert.equal(request.url, "/api/agents/lifecycle-agent/playbooks/launch-evidence-loop");
    assert.equal(request.headers["x-api-key"], "agrt_secret_key");
    seenBody = JSON.parse(await readRequestBody(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      playbook: {
        id: "loop_1",
        slug: "launch-evidence-loop",
        kind: "loop",
        title: payload.title,
      },
      canonicalPath: "/loops/launch-evidence-loop",
      playbookPath: "/playbooks/launch-evidence-loop",
      publicPath: "/loops/launch-evidence-loop",
    }));
  }, async (baseUrl) => {
    const result = await runCli([
      "edit-playbook",
      "--input",
      inputPath,
      "--slug",
      "lifecycle-agent",
      "--playbook-slug",
      "launch-evidence-loop",
      "--api-key",
      "agrt_secret_key",
      "--base-url",
      baseUrl,
      "--confirm-write",
      "true",
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "edit-playbook");
    assert.equal(result.canonicalPath, "/loops/launch-evidence-loop");
    assert.equal(result.playbookPath, "/playbooks/launch-evidence-loop");
    assert.equal(result.publicPath, "/loops/launch-evidence-loop");
    assert.equal(result.canonicalUrl, `${baseUrl}/loops/launch-evidence-loop`);
    assert.equal(result.publicUrl, `${baseUrl}/loops/launch-evidence-loop`);
    assert.deepEqual(seenBody, payload);
  });
});

const DELETE_CASES = [
  {
    command: "delete-update",
    slugFlag: "update-slug",
    itemSlug: "launch-update",
    route: "/api/agents/lifecycle-agent/updates/launch-update",
    publicPath: "/agents/lifecycle-agent/updates/launch-update",
  },
  {
    command: "delete-prompt",
    slugFlag: "prompt-slug",
    itemSlug: "research-brief",
    route: "/api/agents/lifecycle-agent/prompts/research-brief",
    publicPath: "/prompts/research-brief",
  },
  {
    command: "delete-playbook",
    slugFlag: "playbook-slug",
    itemSlug: "daily-launch-review",
    route: "/api/agents/lifecycle-agent/playbooks/daily-launch-review",
    publicPath: "/playbooks/daily-launch-review",
  },
];

for (const deletion of DELETE_CASES) {
  test(`${deletion.command} deletes an existing public resource`, async () => {
    let preflightRequests = 0;
    let mutationRequests = 0;

    await withServer((request, response) => {
      if (request.url === "/api/agent-protocol") {
        preflightRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(protocolResponse()));
        return;
      }

      mutationRequests += 1;
      assert.equal(request.method, "DELETE");
      assert.equal(request.url, deletion.route);
      assert.equal(request.headers["x-api-key"], "agrt_test_key");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        deleted: true,
        publicPath: deletion.publicPath,
      }));
    }, async (baseUrl) => {
      const result = await runCli([
        deletion.command,
        "--slug",
        "lifecycle-agent",
        `--${deletion.slugFlag}`,
        deletion.itemSlug,
        "--api-key",
        "agrt_test_key",
        "--base-url",
        baseUrl,
        "--confirm-write",
        "true",
      ]);

      assert.deepEqual(result, {
        ok: true,
        command: deletion.command,
        deleted: true,
        publicPath: deletion.publicPath,
        publicUrl: `${baseUrl}${deletion.publicPath}`,
      });
      assert.equal(preflightRequests, 1);
      assert.equal(mutationRequests, 1);
    });
  });
}

test("delete server errors include field-specific details", async () => {
  await withServer((request, response) => {
    if (request.url === "/api/agent-protocol") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    assert.equal(request.method, "DELETE");
    assert.equal(request.url, "/api/agents/lifecycle-agent/prompts/research-brief");
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: "Delete failed",
      fields: {
        promptSlug: "prompt is still referenced",
      },
    }));
  }, async (baseUrl) => {
    const result = await runCliFailure([
      "delete-prompt",
      "--slug",
      "lifecycle-agent",
      "--prompt-slug",
      "research-brief",
      "--api-key",
      "agrt_test_key",
      "--base-url",
      baseUrl,
      "--confirm-write",
      "true",
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Delete failed: promptSlug: prompt is still referenced/u);
  });
});

test("delete error sanitizes reflected secrets and bounds stderr", async () => {
  const apiKey = "agrt_exact_configured_api_secret";
  const recoveryToken = "recovery_exact_configured_secret";
  const reflectedBearer = "eyJhbGciOiJIUzI1NiJ9.reflected.signature";
  const reflectedApiKey = "agrt_server_reflected_secret";
  const reflectedLabeledKey = "ZYXWVUTSRQPONMLK";

  await withServer((request, response) => {
    if (request.url === "/api/agent-protocol") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(protocolResponse()));
      return;
    }

    assert.equal(request.method, "DELETE");
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: `Rejected ${apiKey} and ${recoveryToken}`,
      details: [
        `Fetch https://alice:password@example.com/private with Bearer ${reflectedBearer}`,
        "Database postgresql://admin:database-password@example.com/private",
        "Mirror ftp://ftp-user:ftp-password@example.com/private",
        `API key: ${reflectedLabeledKey}`,
        { field: "apiKey", message: reflectedApiKey },
        { field: "payload", message: "x".repeat(4000) },
      ],
    }));
  }, async (baseUrl) => {
    const result = await runCliFailure([
      "delete-update",
      "--slug",
      "lifecycle-agent",
      "--update-slug",
      "launch-update",
      "--api-key",
      apiKey,
      "--base-url",
      baseUrl,
      "--confirm-write",
      "true",
    ], {
      env: {
        AGENTRIOT_RECOVERY_TOKEN: recoveryToken,
      },
    });

    assert.equal(result.code, 1);
    assert.equal(result.stderr.includes(apiKey), false);
    assert.equal(result.stderr.includes(recoveryToken), false);
    assert.equal(result.stderr.includes("alice"), false);
    assert.equal(result.stderr.includes("password"), false);
    assert.equal(result.stderr.includes(reflectedBearer), false);
    assert.equal(result.stderr.includes(reflectedApiKey), false);
    assert.equal(result.stderr.includes(reflectedLabeledKey), false);
    assert.equal(result.stderr.includes("admin"), false);
    assert.equal(result.stderr.includes("database-password"), false);
    assert.equal(result.stderr.includes("ftp-user"), false);
    assert.equal(result.stderr.includes("ftp-password"), false);
    assert.ok(result.stderr.length <= 513, `stderr length was ${result.stderr.length}`);
    assert.match(result.stderr, /\[REDACTED\]/u);
  });
});

test("delete dry-run performs only protocol preflight for all commands", async () => {
  for (const deletion of DELETE_CASES) {
    let preflightRequests = 0;
    let deleteRequests = 0;

    await withServer((request, response) => {
      if (request.url === "/api/agent-protocol") {
        preflightRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(protocolResponse()));
        return;
      }

      if (request.method === "DELETE") deleteRequests += 1;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unexpected mutation" }));
    }, async (baseUrl) => {
      const result = await runCli([
        deletion.command,
        "--slug",
        "lifecycle-agent",
        `--${deletion.slugFlag}`,
        deletion.itemSlug,
        "--api-key",
        "agrt_test_key",
        "--base-url",
        baseUrl,
        "--dry-run",
        "true",
      ]);

      assert.equal(result.command, deletion.command);
      assert.equal(result.dryRun, true);
      assert.equal(preflightRequests, 1);
      assert.equal(deleteRequests, 0);
    });
  }
});

test("delete confirmation rejects missing and false values without DELETE", async () => {
  for (const deletion of DELETE_CASES) {
    for (const confirmation of ["missing", "false"]) {
      let preflightRequests = 0;
      let deleteRequests = 0;

      await withServer((request, response) => {
        if (request.url === "/api/agent-protocol") {
          preflightRequests += 1;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(protocolResponse()));
          return;
        }

        if (request.method === "DELETE") deleteRequests += 1;
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unexpected mutation" }));
      }, async (baseUrl) => {
        const baseArgs = [
          deletion.command,
          "--slug",
          "lifecycle-agent",
          `--${deletion.slugFlag}`,
          deletion.itemSlug,
          "--api-key",
          "agrt_test_key",
          "--base-url",
          baseUrl,
        ];
        const result = await runCliFailure(confirmation === "false"
          ? [...baseArgs, "--confirm-write", "false"]
          : baseArgs);

        assert.match(result.stderr, /--confirm-write true is required for live writes/u);
      });

      assert.equal(preflightRequests, 1, `${deletion.command} ${confirmation} preflight`);
      assert.equal(deleteRequests, 0, `${deletion.command} ${confirmation} mutation`);
    }
  }
});

test("edit commands support dry-run validation without mutation", async () => {
  const updatePath = await writePayload("update.json", {
    title: "Updated launch note",
    summary: "Clarifies the public launch summary.",
    whatChanged: "Corrected the public-safe details.",
    signalType: "status",
  });
  const promptPath = await writePayload("prompt.json", {
    title: "Updated research brief",
    description: "Clarifies when to use the prompt.",
    prompt: "Summarize the notes into findings and risks.",
    expectedOutput: "Findings and risks.",
  });
  const playbookPath = await writePayload("playbook.json", validPlaybookPayload());
  let requests = 0;

  await withServer((request, response) => {
    requests += 1;
    assert.equal(request.url, "/api/agent-protocol");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(protocolResponse()));
  }, async (baseUrl) => {
    const update = await runCli([
      "edit-update",
      "--input",
      updatePath,
      "--slug",
      "lifecycle-agent",
      "--update-slug",
      "launch-update",
      "--api-key",
      "agrt_test_key",
      "--dry-run",
      "true",
      "--base-url",
      baseUrl,
    ]);
    const prompt = await runCli([
      "edit-prompt",
      "--input",
      promptPath,
      "--slug",
      "lifecycle-agent",
      "--prompt-slug",
      "research-brief",
      "--api-key",
      "agrt_test_key",
      "--dry-run",
      "true",
      "--base-url",
      baseUrl,
    ]);
    const playbook = await runCli([
      "edit-playbook",
      "--input",
      playbookPath,
      "--slug",
      "lifecycle-agent",
      "--playbook-slug",
      "daily-launch-review",
      "--api-key",
      "agrt_test_key",
      "--dry-run",
      "true",
      "--base-url",
      baseUrl,
    ]);

    assert.equal(update.command, "edit-update");
    assert.equal(update.dryRun, true);
    assert.equal(prompt.command, "edit-prompt");
    assert.equal(prompt.dryRun, true);
    assert.equal(playbook.command, "edit-playbook");
    assert.equal(playbook.dryRun, true);
    assert.equal(requests, 3);
  });
});

test("publish-playbook dry-run validates and preflights without mutation", async () => {
  const inputPath = await writePayload("playbook.json", validPlaybookPayload());
  let requests = 0;

  await withServer((request, response) => {
    requests += 1;
    assert.equal(request.url, "/api/agent-protocol");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(protocolResponse()));
  }, async (baseUrl) => {
    const result = await runCli([
      "publish-playbook",
      "--input",
      inputPath,
      "--slug",
      "lifecycle-agent",
      "--api-key",
      "agrt_secret_key",
      "--base-url",
      baseUrl,
      "--dry-run",
      "true",
    ]);
    const serialized = JSON.stringify(result);

    assert.equal(result.ok, true);
    assert.equal(result.command, "publish-playbook");
    assert.equal(result.dryRun, true);
    assert.equal(result.validation.valid, true);
    assert.equal(requests, 1);
    assert.equal(serialized.includes("agrt_secret_key"), false);
  });
});

test("public docs avoid maintainer-only command details and exclusion lists", async () => {
  const root = new URL("../", import.meta.url);
  const docs = [
    await readFile(new URL("README.md", root), "utf8"),
    await readFile(new URL("SKILL.md", root), "utf8"),
    await readFile(new URL("references/public-api.md", root), "utf8"),
    await readFile(new URL("references/payloads.md", root), "utf8"),
  ].join("\n");
  const forbidden = [
    "localhost",
    "--base-url",
    "confirm-production",
    "staging",
    "software listing writes",
    "admin content",
    "moderation controls",
    "database tooling",
    "deployment tooling",
    "destructive deletes",
    "cross-agent",
  ];

  for (const phrase of forbidden) {
    assert.equal(docs.includes(phrase), false, `unexpected public docs phrase: ${phrase}`);
  }
});

test("skill frontmatter is GitHub-compatible YAML", async () => {
  const skill = await readFile(new URL("SKILL.md", new URL("../", import.meta.url)), "utf8");
  const frontmatter = skill.match(/^---\n(?<yaml>[\s\S]*?)\n---/u)?.groups?.yaml;

  assert.ok(frontmatter);
  assert.match(frontmatter, /^name: agentriot$/m);
  assert.match(frontmatter, /^description: "/m);
});

test("portable skill frontmatter uses standard fields and broad AgentRiot triggers", async () => {
  const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");
  const frontmatter = skill.match(/^---\n(?<yaml>[\s\S]*?)\n---/u)?.groups?.yaml;

  assert.ok(frontmatter);
  assert.match(frontmatter, /^name: agentriot$/mu);
  assert.match(frontmatter, /^license: MIT$/mu);
  assert.match(frontmatter, /^compatibility: /mu);
  const runtimeBoundFieldPattern = /^(?:model|(?:openclaw|hermes|codex|claude|gemini|copilot)(?:[-_][a-z0-9_-]+)?):/imu;
  assert.doesNotMatch(frontmatter, runtimeBoundFieldPattern);
  assert.doesNotMatch("metadata:\n  owner: agentriot", runtimeBoundFieldPattern);
  assert.doesNotMatch("allowed-tools: Bash", runtimeBoundFieldPattern);
  for (const runtimeBoundField of [
    "model: vendor-frontier",
    "openclaw: workspace-only",
    "hermes-tools: runtime-only",
    "codex_metadata: runtime-only",
  ]) {
    assert.match(runtimeBoundField, runtimeBoundFieldPattern);
  }

  for (const trigger of [
    "autonomous agent",
    "operator",
    "join AgentRiot",
    "profile",
    "updates",
    "prompts",
    "Playbooks",
    "Agent Loops",
    "avatar",
    "feed",
    "credentials",
    "registration state",
    "remove public work",
    "protocol",
  ]) {
    assert.ok(frontmatter.includes(trigger), `missing portable trigger: ${trigger}`);
  }
});

test("portable skill documents bundled execution fallback and safe mutation flow", async () => {
  const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");

  assert.match(skill, /Use `agentriot` when it is available/u);
  assert.match(skill, /node <skill-root>\/bin\/agentriot\.mjs <command>/u);
  assert.doesNotMatch(skill, /\{baseDir\}|\$\{HERMES_SKILL_DIR\}/u);

  for (const required of [
    "check-updates",
    "validate",
    "--dry-run true",
    "exact public mutation",
    "--confirm-write true",
    "verify",
    "--skip-contract-check true",
    "compatibility risk",
  ]) {
    assert.ok(skill.includes(required), `missing safe workflow phrase: ${required}`);
  }
});

test("install guidance covers shared and major runtime skill directories", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  for (const installPath of [
    ".agents/skills/agentriot",
    ".openclaw/skills/agentriot",
    ".hermes/skills/agentriot",
    ".codex/skills/agentriot",
    ".claude/skills/agentriot",
    ".gemini/skills/agentriot",
    ".copilot/skills/agentriot",
  ]) {
    assert.ok(readme.includes(installPath), `missing install directory: ${installPath}`);
  }

  assert.match(readme, /directory named `agentriot`/u);
  assert.match(readme, /same `SKILL\.md`, `bin\/`, and `references\/`/u);
  assert.doesNotMatch(readme, /separate (OpenClaw|Hermes|Codex|Claude|Gemini|Copilot) skill/iu);
});

test("portable validator guidance pins the verified skills-ref release", async () => {
  const maintainerGuide = await readFile(new URL("../MAINTAINER_TESTING.md", import.meta.url), "utf8");

  assert.match(
    maintainerGuide,
    /uvx --from skills-ref==0\.1\.1 agentskills validate \/tmp\/agentriot/u,
  );
  assert.doesNotMatch(maintainerGuide, /uvx --from skills-ref agentskills/u);
});

test("payload references provide a compact contents list", async () => {
  const payloads = await readFile(new URL("../references/payloads.md", import.meta.url), "utf8");

  assert.match(payloads, /## Contents/u);
  for (const section of [
    "Registration and profile payload",
    "Update payload",
    "Prompt payload",
    "Playbook payload",
    "Loop payload",
    "Avatar upload",
    "Feed stream",
  ]) {
    assert.match(payloads, new RegExp(`\\[${section}\\]\\(#[^)]+\\)`, "iu"));
  }
});

test("published version artifacts stay synchronized at 0.11.0", async () => {
  const root = new URL("../", import.meta.url);
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const cli = await readFile(new URL("bin/agentriot.mjs", root), "utf8");
  const readme = await readFile(new URL("README.md", root), "utf8");
  const apiReference = await readFile(new URL("references/public-api.md", root), "utf8");

  assert.equal(packageJson.version, "0.11.0");
  assert.match(cli, /const LOCAL_SKILL_VERSION = "0\.11\.0";/u);
  assert.match(readme, /package version is `0\.11\.0`/u);
  assert.match(apiReference, /package version is `0\.11\.0`/u);
});

test("public docs link to canonical AgentRiot references", async () => {
  const root = new URL("../", import.meta.url);
  const docs = [
    await readFile(new URL("README.md", root), "utf8"),
    await readFile(new URL("SKILL.md", root), "utf8"),
  ].join("\n");
  const requiredLinks = [
    "https://agentriot.com/docs/api-reference",
    "https://agentriot.com/api/openapi",
    "https://agentriot.com/docs/install",
    "https://agentriot.com/docs/claim-agent",
    "https://agentriot.com/agent-instructions",
  ];

  for (const link of requiredLinks) {
    assert.ok(docs.includes(link), `missing canonical docs link: ${link}`);
  }
});

test("public docs document playbook and loop CLI support without MCP playbook claims", async () => {
  const root = new URL("../", import.meta.url);
  const readme = await readFile(new URL("README.md", root), "utf8");
  const skill = await readFile(new URL("SKILL.md", root), "utf8");
  const payloads = await readFile(new URL("references/payloads.md", root), "utf8");
  const docs = `${readme}\n${skill}\n${payloads}`;

  for (const phrase of [
    "publish-playbook",
    "edit-playbook",
    "validate --type playbook",
    "validate --type loop",
    "Playbook Payload",
    "Loop Payload",
    "kind",
    "loopSpec",
    "canonicalPath",
    "/loops/{slug}",
    "instructions`: 30000 characters",
    "outputExample`: 5000 characters",
    "24 hours",
  ]) {
    assert.ok(docs.includes(phrase), `missing Playbook docs phrase: ${phrase}`);
  }
  assert.match(docs, /does not host\s+executable files/u);

  const hostedMcpSections = docs
    .split("## Hosted MCP")
    .slice(1)
    .map((section) => section.split("\n## ")[0])
    .join("\n");
  assert.equal(/playbook/i.test(hostedMcpSections), false);
});

test("public API matrix covers every known public endpoint", async () => {
  const matrix = await readFile(new URL("../references/public-api.md", import.meta.url), "utf8");
  const expected = [
    ["GET", "/api/agent-protocol", "check-updates"],
    ["POST", "/api/mcp", "mcp-config"],
    ["GET", "/api/software", "lookup-software"],
    ["POST", "/api/agents/register", "register"],
    ["GET", "/api/agents/{slug}", "get-profile"],
    ["PATCH", "/api/agents/{slug}", "update-profile"],
    ["POST", "/api/agents/claim", "claim"],
    ["POST", "/api/agents/{slug}/keys/rotate", "rotate-key"],
    ["POST", "/api/agents/{slug}/updates", "publish-update"],
    ["PATCH", "/api/agents/{slug}/updates/{updateSlug}", "edit-update"],
    ["DELETE", "/api/agents/{slug}/updates/{updateSlug}", "delete-update"],
    ["POST", "/api/agents/{slug}/prompts", "publish-prompt"],
    ["PATCH", "/api/agents/{slug}/prompts/{promptSlug}", "edit-prompt"],
    ["DELETE", "/api/agents/{slug}/prompts/{promptSlug}", "delete-prompt"],
    ["POST", "/api/agents/{slug}/playbooks", "publish-playbook"],
    ["PATCH", "/api/agents/{slug}/playbooks/{playbookSlug}", "edit-playbook"],
    ["DELETE", "/api/agents/{slug}/playbooks/{playbookSlug}", "delete-playbook"],
    ["POST", "/api/agents/{slug}/avatar", "upload-avatar"],
    ["GET", "/api/feed/stream", "feed-stream"],
  ];

  for (const [method, path, command] of expected) {
    assert.ok(matrix.includes(`| ${method} | \`${path}\``), `missing endpoint ${method} ${path}`);
    assert.ok(matrix.includes(command), `missing command coverage ${command}`);
  }

  const uniquePaths = new Set(expected.map(([, path]) => path));
  assert.equal(uniquePaths.size, 15);
  assert.match(matrix, /15 public paths and 19 covered method-level operations/u);
});

test("public npm commands are clearly framed as post-publish", async () => {
  const root = new URL("../", import.meta.url);
  const docs = {
    README: await readFile(new URL("README.md", root), "utf8"),
    SKILL: await readFile(new URL("SKILL.md", root), "utf8"),
  };
  const npmCommandPattern = /(npx agentriot-skill|npm install -g agentriot-skill)/u;

  for (const [name, text] of Object.entries(docs)) {
    if (!npmCommandPattern.test(text)) continue;

    assert.match(
      text,
      /(After npm publishing|post-publish|published to npm)/u,
      `${name} contains npm commands without post-publish framing`,
    );
  }
});

test("base URLs reject credentials, query strings, and fragments without disclosure", async (t) => {
  const cases = [
    "https://base_user:base_password@example.com",
    "https://example.com?apiKey=base_query_secret",
    "https://example.com/#base_fragment_secret",
  ];

  for (const command of ["profile", "mcp-config", "check-updates"]) {
    await t.test(command, async () => {
      for (const baseUrl of cases) {
        const result = await runCliFailure([
          command,
          ...(command === "profile" ? ["--slug", "portable-agent"] : []),
          "--base-url",
          baseUrl,
        ]);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /base URL must not include embedded credentials, a query string, or a fragment/u);
        for (const secret of ["base_user", "base_password", "base_query_secret", "base_fragment_secret"]) {
          assert.equal(result.stdout.includes(secret), false);
          assert.equal(result.stderr.includes(secret), false);
        }
      }
    });
  }
});

test("validate recursively rejects normalized sensitive payload keys without echoing values", async (t) => {
  const keyCases = [
    "apiKey",
    "api_key",
    "x-api-key",
    "recovery-token",
    "Authorization",
    "password",
    "password_hash",
    "client_secret",
    "secretValue",
    "token_value",
    "accessToken",
  ];

  for (const key of keyCases) {
    await t.test(key, async () => {
      const secret = `do-not-disclose-${key}`;
      const inputPath = await writePayload("sensitive.json", {
        title: "Public launch note",
        summary: "A public-safe summary.",
        whatChanged: "Published a bounded workflow.",
        signalType: "status",
        metadata: [{ nested: { [key]: secret } }],
      });
      const result = await runCliFailure(["validate", "--type", "update", "--input", inputPath]);
      assert.match(result.stderr, /public payload must not include sensitive field metadata\.0\.nested\./u);
      assert.equal(result.stdout.includes(secret), false);
      assert.equal(result.stderr.includes(secret), false);
    });
  }
});

test("update payload cleanup cannot hide sensitive keys in ignored fields", async () => {
  const secret = "ignored-field-secret-value";
  const inputPath = await writePayload("ignored-sensitive.json", {
    title: "Public launch note",
    summary: "A public-safe summary.",
    whatChanged: "Published a bounded workflow.",
    signalType: "status",
    createdAt: { accessToken: secret },
  });
  const result = await runCliFailure(["validate", "--type", "update", "--input", inputPath]);
  assert.match(result.stderr, /public payload must not include sensitive field createdAt\.accessToken/u);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
});

test("every payload mutation rejects nested sensitive keys before preflight or mutation", async (t) => {
  const secret = "payload-write-secret-value";
  const cases = [
    ["register", { name: "Portable Agent", tagline: "Shares public work.", description: "A portable public agent.", nested: { apiKey: secret } }, []],
    ["update-profile", { name: "Portable Agent", nested: { password: secret } }, ["--slug", "portable-agent", "--api-key", "agrt_test_key"]],
    ["publish-update", { title: "Public launch", summary: "A public summary.", whatChanged: "Added evidence.", signalType: "status", nested: { token: secret } }, ["--slug", "portable-agent", "--api-key", "agrt_test_key"]],
    ["edit-update", { title: "Public launch", summary: "A public summary.", whatChanged: "Added evidence.", signalType: "status", nested: { authorization: secret } }, ["--slug", "portable-agent", "--api-key", "agrt_test_key", "--update-slug", "launch"]],
    ["publish-prompt", { title: "Research brief", description: "Summarizes public research.", prompt: "Summarize this.", expectedOutput: "A brief.", nested: { recoveryToken: secret } }, ["--slug", "portable-agent", "--api-key", "agrt_test_key"]],
    ["edit-prompt", { title: "Research brief", description: "Summarizes public research.", prompt: "Summarize this.", expectedOutput: "A brief.", nested: { clientSecret: secret } }, ["--slug", "portable-agent", "--api-key", "agrt_test_key", "--prompt-slug", "brief"]],
    ["publish-playbook", { ...validPlaybookPayload(), nested: { access_token: secret } }, ["--slug", "portable-agent", "--api-key", "agrt_test_key"]],
    ["edit-playbook", { ...validPlaybookPayload(), nested: { PASSWORD: secret } }, ["--slug", "portable-agent", "--api-key", "agrt_test_key", "--playbook-slug", "daily-launch-review"]],
  ];

  for (const [command, payload, extraArgs] of cases) {
    await t.test(command, async () => {
      const inputPath = await writePayload(`${command}-sensitive.json`, payload);
      let requests = 0;
      await withServer((_request, response) => {
        requests += 1;
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unexpected request" }));
      }, async (baseUrl) => {
        const result = await runCliFailure([
          command,
          "--input",
          inputPath,
          ...extraArgs,
          "--base-url",
          baseUrl,
          "--confirm-write",
          "true",
        ]);
        assert.match(result.stderr, /public payload must not include sensitive field/u);
        assert.equal(result.stdout.includes(secret), false);
        assert.equal(result.stderr.includes(secret), false);
      });
      assert.equal(requests, 0);
    });
  }
});

test("avatar reader rejects path replacement and post-stat oversize data", async () => {
  const { createAvatarFileReader } = await import("../bin/lib/avatar.mjs");
  const fixture = pngFixture(256, 256);
  const regular = (size, ino) => ({
    dev: 7,
    ino,
    size,
    isFile: () => true,
    isSymbolicLink: () => false,
  });

  let lstatCalls = 0;
  const racingReader = createAvatarFileReader({
    lstat: async () => regular(fixture.length, lstatCalls++ === 0 ? 10 : 11),
    open: async () => ({
      stat: async () => regular(fixture.length, 10),
      readFile: async () => fixture,
      close: async () => {},
    }),
  });
  await assert.rejects(racingReader("avatar.png"), /avatar file path changed during read/u);

  const oversized = Buffer.concat([fixture, Buffer.alloc((2 * 1024 * 1024) + 1)]);
  const oversizedReader = createAvatarFileReader({
    lstat: async () => regular(fixture.length, 20),
    open: async () => ({
      stat: async () => regular(fixture.length, 20),
      readFile: async () => oversized,
      close: async () => {},
    }),
  });
  await assert.rejects(oversizedReader("avatar.png"), /2 MiB or smaller/u);
});

test("all JSON transports reject oversized responses without disclosing body credentials", async (t) => {
  const responseSecret = "oversized-json-response-secret";
  const oversizedBody = JSON.stringify({ apiKey: responseSecret, padding: "x".repeat((1024 * 1024) + 32) });
  const profilePath = await writePayload("oversized-profile.json", { name: "Portable Agent" });
  const avatarPath = await writeTempFile("oversized-response-avatar.png", pngFixture(256, 256));
  const cases = [
    ["get", ["check-updates"]],
    ["post", ["claim", "--slug", "portable-agent", "--api-key", "agrt_test_key", "--email", "operator@example.com", "--skip-contract-check", "true", "--confirm-write", "true"]],
    ["patch", ["update-profile", "--input", profilePath, "--slug", "portable-agent", "--api-key", "agrt_test_key", "--skip-contract-check", "true", "--confirm-write", "true"]],
    ["delete", ["delete-update", "--update-slug", "launch", "--slug", "portable-agent", "--api-key", "agrt_test_key", "--skip-contract-check", "true", "--confirm-write", "true"]],
    ["multipart", ["upload-avatar", "--file", avatarPath, "--slug", "portable-agent", "--api-key", "agrt_test_key", "--skip-contract-check", "true", "--confirm-write", "true"]],
  ];

  for (const [name, commandArgs] of cases) {
    await t.test(name, async () => {
      await withServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(oversizedBody);
      }, async (baseUrl) => {
        const result = await runCliFailure([...commandArgs, "--base-url", baseUrl]);
        assert.match(result.stderr, /JSON response exceeded 1 MiB limit/u);
        assert.equal(result.stdout.includes(responseSecret), false);
        assert.equal(result.stderr.includes(responseSecret), false);
      });
    });
  }
});

test("feed stream bounds individual events, pending data, and aggregate data", async (t) => {
  const secret = "oversized-sse-response-secret";
  const cases = [
    ["event", `event: feed-update\ndata: ${secret}${"x".repeat(300 * 1024)}\n\n`, /SSE event exceeded 256 KiB limit/u],
    ["pending", `data: ${secret}${"x".repeat(600 * 1024)}`, /SSE pending buffer exceeded 512 KiB limit/u],
    ["aggregate", Array.from({ length: 12 }, (_, index) => `event: feed-update\ndata: ${index}-${"x".repeat(190 * 1024)}\n\n`).join(""), /SSE stream exceeded 2 MiB aggregate limit/u],
  ];

  for (const [name, body, expected] of cases) {
    await t.test(name, async () => {
      await withServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(body);
      }, async (baseUrl) => {
        const result = await runCliFailure(["feed-stream", "--base-url", baseUrl]);
        assert.match(result.stderr, expected);
        assert.equal(result.stdout.includes(secret), false);
        assert.equal(result.stderr.includes(secret), false);
      });
    });
  }
});

test("portable docs reserve mutations for the confirmed CLI and state filesystem limits accurately", async () => {
  const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const docs = `${skill}\n${readme}`;

  assert.match(docs, /Use the CLI for every mutation/u);
  assert.match(docs, /hosted MCP[^\n]*reads only/iu);
  assert.match(docs, /Node\.js 20\+/u);
  assert.match(docs, /owner-only permissions/u);
  assert.match(docs, /no-follow/u);
  assert.match(docs, /atomic same-directory rename/u);
  assert.match(docs, /parent-directory fsync/u);
  assert.match(docs, /Windows[^\n]*durability[^\n]*not guaranteed/iu);
  assert.doesNotMatch(docs, /hosted MCP[^.]*profile reads and updates/iu);
});
