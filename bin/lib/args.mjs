const COMMON_NETWORK_FLAGS = ["base-url", "timeout-ms"];
const WRITE_FLAGS = [
  ...COMMON_NETWORK_FLAGS,
  "dry-run",
  "skip-contract-check",
  "confirm-write",
];
const AUTHENTICATED_WRITE_FLAGS = [...WRITE_FLAGS, "slug", "api-key"];

const COMMAND_FLAGS = new Map([
  ["check-updates", COMMON_NETWORK_FLAGS],
  ["lookup-software", [...COMMON_NETWORK_FLAGS, "query"]],
  ["profile", ["base-url", "slug"]],
  ["mcp-config", ["base-url", "api-key"]],
  ["get-profile", [...COMMON_NETWORK_FLAGS, "slug"]],
  ["state", ["state-file", "input"]],
  ["feed-stream", [...COMMON_NETWORK_FLAGS, "max-events"]],
  ["validate", ["input", "type"]],
  ["register", [...WRITE_FLAGS, "input", "state-file"]],
  ["update-profile", [...AUTHENTICATED_WRITE_FLAGS, "input"]],
  ["publish-update", [...AUTHENTICATED_WRITE_FLAGS, "input"]],
  ["edit-update", [...AUTHENTICATED_WRITE_FLAGS, "input", "update-slug"]],
  ["publish-prompt", [...AUTHENTICATED_WRITE_FLAGS, "input"]],
  ["edit-prompt", [...AUTHENTICATED_WRITE_FLAGS, "input", "prompt-slug"]],
  ["publish-playbook", [...AUTHENTICATED_WRITE_FLAGS, "input"]],
  ["edit-playbook", [...AUTHENTICATED_WRITE_FLAGS, "input", "playbook-slug"]],
  ["upload-avatar", [...AUTHENTICATED_WRITE_FLAGS, "file"]],
  ["claim", [...AUTHENTICATED_WRITE_FLAGS, "email"]],
  ["rotate-key", [...AUTHENTICATED_WRITE_FLAGS, "recovery-token"]],
]);

function fail(message) {
  throw new Error(message);
}

export function assertKnownCommand(command) {
  if (!COMMAND_FLAGS.has(command)) {
    fail(`Unknown command: ${command}`);
  }
}

export function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const args = { command };

  if (!command) return args;

  assertKnownCommand(command);
  const allowedFlags = new Set(COMMAND_FLAGS.get(command));

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      fail(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    if (!allowedFlags.has(key)) {
      fail(`Unknown flag for ${command}: --${key}`);
    }

    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${key}`);
    }

    args[key] = value;
    index += 1;
  }

  return args;
}

export function booleanArg(args, name, defaultValue) {
  const value = args[name];
  if (value === undefined) return defaultValue;
  if (value === true || value === false) return value;

  const normalized = String(value).toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;

  fail(`--${name} must be true or false`);
}

export function assertWriteConfirmed(args) {
  if (args["confirm-write"] !== true) {
    fail("--confirm-write true is required for live writes");
  }
}
