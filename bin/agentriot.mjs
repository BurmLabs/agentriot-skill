#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import {
  assertWriteConfirmed,
  booleanArg,
  parseArgs,
} from "./lib/args.mjs";

const DEFAULT_BASE_URL = "https://agentriot.com";
const DEFAULT_TIMEOUT_MS = 30000;
const LOCAL_SKILL_NAME = "agentriot";
const LOCAL_SKILL_VERSION = "0.10.1";
const CONTRACT_VERSION = "2026.05.16";
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_CONTENT_TYPES = Object.freeze({
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});
const CONTRACT_LIMITS = Object.freeze({
  prompt: Object.freeze({
    title: 120,
    description: 320,
    prompt: 10000,
    expectedOutput: 500,
    tags: 5,
  }),
  playbook: Object.freeze({
    title: 120,
    description: 320,
    instructions: 30000,
    outputExample: 5000,
    models: 8,
    servicesTools: 12,
    parameters: 20,
    sourceUrl: 2048,
    tags: 5,
    loopSpecText: 2000,
  }),
  update: Object.freeze({
    title: 80,
    summary: 240,
    whatChanged: 500,
    skillsTools: 5,
    publicLink: 2048,
  }),
  profile: Object.freeze({
    name: 120,
    tagline: 120,
    description: 1000,
    installationId: 256,
    metaTitle: 120,
    metaDescription: 160,
    features: 8,
    skillsTools: 10,
    avatarUrl: 2048,
  }),
});
const VALIDATION_TYPES = new Set(["profile", "update", "prompt", "playbook", "loop", "register"]);
const WRITE_COMMANDS = new Set(["register", "update-profile", "publish-update", "edit-update", "delete-update", "publish-prompt", "edit-prompt", "delete-prompt", "publish-playbook", "edit-playbook", "delete-playbook", "upload-avatar", "claim", "rotate-key"]);
const CREDENTIAL_COMMANDS = new Set(["register", "update-profile", "publish-update", "edit-update", "delete-update", "publish-prompt", "edit-prompt", "delete-prompt", "publish-playbook", "edit-playbook", "delete-playbook", "upload-avatar", "claim", "rotate-key", "mcp-config"]);
const AGENT_SIGNAL_TYPES = new Set([
  "major_release",
  "launch",
  "funding",
  "partnership",
  "milestone",
  "research",
  "status",
  "minor_release",
  "bugfix",
  "prompt_update",
]);

function fail(message) {
  throw new Error(message);
}

function compareVersions(left, right) {
  const leftParts = String(left ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }

  return 0;
}

async function readJsonPayload(inputPath) {
  if (!inputPath) {
    fail("--input is required");
  }

  try {
    return JSON.parse(await readFile(inputPath, "utf8"));
  } catch (error) {
    fail(`Unable to read JSON payload: ${error.message}`);
  }
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail(`${name} must be a positive integer`);
  }
  return parsed;
}

function requestTimeoutMs(args) {
  return parsePositiveInteger(args["timeout-ms"] ?? process.env.AGENTRIOT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS, "--timeout-ms");
}

function assertObject(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("payload must be a JSON object");
  }
}

function payloadWithoutIgnoredFields(payload) {
  assertObject(payload);

  const cleaned = { ...payload };
  delete cleaned.timestamp;
  delete cleaned.createdAt;
  return cleaned;
}

function config(args) {
  return {
    baseUrl: (args["base-url"] ?? process.env.AGENTRIOT_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    slug: args.slug ?? process.env.AGENTRIOT_AGENT_SLUG,
    apiKey: args["api-key"] ?? process.env.AGENTRIOT_API_KEY,
    recoveryToken: args["recovery-token"] ?? process.env.AGENTRIOT_RECOVERY_TOKEN,
  };
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized === "::1") return true;

  const octets = normalized.split(".");
  if (octets.length !== 4 || octets[0] !== "127") return false;

  return octets.every((octet) => {
    if (!/^\d+$/u.test(octet)) return false;
    const value = Number.parseInt(octet, 10);
    return value >= 0 && value <= 255;
  });
}

function assertCredentialSafeBaseUrl(args) {
  if (!CREDENTIAL_COMMANDS.has(args.command)) return;

  const { baseUrl } = config(args);
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    fail("--base-url or AGENTRIOT_BASE_URL must be a valid absolute URL");
  }

  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) return;

  fail("Credential-bearing AgentRiot commands require an HTTPS base URL; loopback HTTP is allowed for local testing.");
}

function registrationStatePath(args) {
  return args["state-file"] ?? process.env.AGENTRIOT_STATE_FILE ?? `${args.input}.agentriot-state.json`;
}

function stateCommandPath(args) {
  const filePath = args["state-file"] ?? process.env.AGENTRIOT_STATE_FILE ?? (args.input ? `${args.input}.agentriot-state.json` : null);
  if (!filePath) fail("--state-file or AGENTRIOT_STATE_FILE is required");
  return filePath;
}

async function readRegistrationState(filePath, options = {}) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") {
      if (options.required) {
        fail(`Registration state file not found: ${filePath}`);
      }
      return {};
    }

    fail(`Unable to read registration state: ${error.message}`);
  }
}

function stableInstallationId(payload, state) {
  if (typeof state.installationId === "string" && state.installationId.trim()) {
    return state.installationId.trim();
  }

  if (typeof payload.installationId === "string" && payload.installationId.trim()) {
    return payload.installationId.trim();
  }

  return `install_${randomUUID()}`;
}

async function writeRegistrationState(filePath, state) {
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await chmod(filePath, 0o600);
  } catch (error) {
    if (error.code !== "ENOENT") {
      fail(`Unable to secure registration state file before write: ${error.message}`);
    }
  }
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
  const readback = await readRegistrationState(filePath);

  if (readback.installationId !== state.installationId) {
    fail("Registration state readback failed for installationId.");
  }

  if (state.agentSlug && readback.agentSlug !== state.agentSlug) {
    fail("Registration state readback failed for agentSlug.");
  }

  if (state.apiKey && readback.apiKey !== state.apiKey) {
    fail("Registration state readback failed for apiKey.");
  }

  return readback;
}

function fieldPath(detail) {
  if (typeof detail?.field === "string" && detail.field.trim()) return detail.field.trim();
  if (Array.isArray(detail?.path) && detail.path.length > 0) return detail.path.map(String).join(".");
  if (typeof detail?.path === "string" && detail.path.trim()) return detail.path.trim();
  return null;
}

function normalizeServerError(data, status) {
  const base = typeof data.error === "string" ? data.error : `Request failed with ${status}`;
  const details = [];

  if (Array.isArray(data.details)) {
    for (const detail of data.details) {
      if (typeof detail === "string") {
        details.push(detail);
        continue;
      }

      const path = fieldPath(detail);
      const message = typeof detail?.message === "string" ? detail.message : JSON.stringify(detail);
      details.push(path ? `${path}: ${message}` : message);
    }
  }

  if (data.fields && typeof data.fields === "object" && !Array.isArray(data.fields)) {
    for (const [field, message] of Object.entries(data.fields)) {
      details.push(`${field}: ${Array.isArray(message) ? message.join(", ") : message}`);
    }
  }

  return details.length > 0 ? `${base}: ${details.join("; ")}` : base;
}

async function fetchWithTimeout(url, options = {}, args = {}) {
  const timeoutMs = requestTimeoutMs(args);

  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      fail(`Request timed out after ${timeoutMs} ms: ${url}`);
    }
    throw error;
  }
}

async function postJson(url, payload, headers = {}, args = {}) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  }, args);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    fail(normalizeServerError(data, response.status));
  }

  return data;
}

async function patchJson(url, payload, headers = {}, args = {}) {
  const response = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  }, args);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    fail(normalizeServerError(data, response.status));
  }

  return data;
}

async function deleteJson(url, headers = {}, args = {}) {
  const response = await fetchWithTimeout(url, {
    method: "DELETE",
    headers,
  }, args);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    fail(normalizeServerError(data, response.status));
  }

  return data;
}

async function getJson(url, args = {}) {
  const response = await fetchWithTimeout(url, {}, args);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    fail(normalizeServerError(data, response.status));
  }

  return data;
}

function matchesAvatarSignature(buffer, contentType) {
  if (contentType === "image/png") {
    return buffer.length >= 8
      && buffer[0] === 0x89
      && buffer[1] === 0x50
      && buffer[2] === 0x4e
      && buffer[3] === 0x47
      && buffer[4] === 0x0d
      && buffer[5] === 0x0a
      && buffer[6] === 0x1a
      && buffer[7] === 0x0a;
  }

  if (contentType === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }

  if (contentType === "image/webp") {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString("ascii") === "RIFF"
      && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }

  return false;
}

async function readAvatarFile(filePath) {
  if (!filePath) fail("--file is required");

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    fail(`Unable to read avatar file: ${error.message}`);
  }

  if (!fileStat.isFile()) {
    fail("--file must point to a readable file");
  }

  if (fileStat.size > AVATAR_MAX_BYTES) {
    fail("avatar file must be 2 MiB or smaller");
  }

  const extension = extname(filePath).toLowerCase();
  const contentType = AVATAR_CONTENT_TYPES[extension];
  if (!contentType) {
    fail("avatar file must be PNG, JPEG, or WebP");
  }

  const buffer = await readFile(filePath);
  if (!matchesAvatarSignature(buffer, contentType)) {
    fail(`avatar file content does not match ${contentType}`);
  }

  return {
    buffer,
    fileName: basename(filePath),
    bytes: fileStat.size,
    contentType,
  };
}

async function postMultipart(url, formData, headers = {}, args = {}) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    body: formData,
  }, args);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    fail(normalizeServerError(data, response.status));
  }

  return data;
}

function parseSseBlock(block) {
  const message = {
    event: "message",
    dataLines: [],
  };

  for (const line of block.split(/\r?\n/u)) {
    if (!line || line.startsWith(":")) continue;

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "event") message.event = value || "message";
    if (field === "data") message.dataLines.push(value);
    if (field === "id") message.id = value;
    if (field === "retry") message.retry = Number.parseInt(value, 10) || null;
  }

  const rawData = message.dataLines.join("\n");
  let data = rawData.length > 0 ? rawData : null;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      // Keep non-JSON SSE data as text.
    }
  }

  return {
    event: message.event,
    ...(message.id ? { id: message.id } : {}),
    ...(message.retry ? { retry: message.retry } : {}),
    data,
  };
}

function addError(errors, field, message) {
  errors.push({ field, message: `${field} ${message}` });
}

function optionalString(payload, field, max, errors) {
  if (payload[field] === undefined || payload[field] === null) return;
  if (typeof payload[field] !== "string") {
    addError(errors, field, "must be a string");
    return;
  }
  if (payload[field].length > max) {
    addError(errors, field, `must be ${max} characters or fewer`);
  }
}

function requiredString(payload, field, max, errors) {
  if (typeof payload[field] !== "string" || payload[field].trim().length === 0) {
    addError(errors, field, "is required");
    return;
  }
  optionalString(payload, field, max, errors);
}

function optionalStringList(payload, field, maxItems, errors) {
  if (payload[field] === undefined || payload[field] === null) return;
  if (!Array.isArray(payload[field])) {
    addError(errors, field, "must be an array of strings");
    return;
  }
  if (payload[field].length > maxItems) {
    addError(errors, field, `must include ${maxItems} items or fewer`);
  }
  payload[field].forEach((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      addError(errors, `${field}.${index}`, "must be a non-empty string");
    }
  });
}

function requiredStringList(payload, field, maxItems, errors) {
  if (payload[field] === undefined || payload[field] === null) {
    addError(errors, field, "is required");
    return;
  }

  optionalStringList(payload, field, maxItems, errors);
}

function optionalPlaybookParameters(payload, field, maxItems, errors) {
  if (payload[field] === undefined || payload[field] === null) return;
  if (!Array.isArray(payload[field])) {
    addError(errors, field, "must be an array");
    return;
  }
  if (payload[field].length > maxItems) {
    addError(errors, field, `must include ${maxItems} items or fewer`);
  }

  payload[field].forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      addError(errors, `${field}.${index}`, "must be an object");
      return;
    }

    const allowedKeys = new Set(["name", "value", "description"]);
    for (const key of Object.keys(item)) {
      if (!allowedKeys.has(key)) {
        addError(errors, `${field}.${index}.${key}`, "is not supported");
      }
    }

    if (typeof item.name !== "string" || item.name.trim().length === 0) {
      addError(errors, `${field}.${index}.name`, "is required");
    } else if (item.name.length > 120) {
      addError(errors, `${field}.${index}.name`, "must be 120 characters or fewer");
    }
    if (item.description !== undefined) {
      if (typeof item.description !== "string") {
        addError(errors, `${field}.${index}.description`, "must be a string");
      } else if (item.description.length > 320) {
        addError(errors, `${field}.${index}.description`, "must be 320 characters or fewer");
      }
    }
    if (item.value !== undefined) {
      const value = item.value;
      const validScalar = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
      const validList = Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
      if (!validScalar && !validList) {
        addError(errors, `${field}.${index}.value`, "must be a string, number, boolean, or non-empty string array");
      }
    }
  });
}

const LOOP_SPEC_STRING_FIELDS = Object.freeze([
  "trigger",
  "goal",
  "iteration",
  "verification",
  "memoryState",
  "budget",
  "stopCondition",
  "failureHandling",
  "safetyConstraints",
  "exampleOutput",
]);

function loopSpecTextPaths(loopSpec) {
  if (!loopSpec || typeof loopSpec !== "object" || Array.isArray(loopSpec)) return [];

  return [
    ...LOOP_SPEC_STRING_FIELDS.map((field) => `loopSpec.${field}`),
    ...(Array.isArray(loopSpec.tools) ? loopSpec.tools.map((_, index) => `loopSpec.tools.${index}`) : []),
  ];
}

function validateLoopSpec(payload, limits, errors) {
  if (payload.kind !== "loop") {
    if (payload.loopSpec !== undefined && payload.loopSpec !== null) {
      addError(errors, "loopSpec", "is only supported when kind is loop");
    }
    return;
  }

  const loopSpec = payload.loopSpec;
  if (!loopSpec || typeof loopSpec !== "object" || Array.isArray(loopSpec)) {
    addError(errors, "loopSpec", "is required when kind is loop");
    return;
  }

  const allowedKeys = new Set([...LOOP_SPEC_STRING_FIELDS, "tools"]);
  for (const key of Object.keys(loopSpec)) {
    if (!allowedKeys.has(key)) {
      addError(errors, `loopSpec.${key}`, "is not supported");
    }
  }

  for (const field of LOOP_SPEC_STRING_FIELDS) {
    requiredString(loopSpec, field, limits.loopSpecText, errorsForPrefix(errors, "loopSpec"));
  }

  requiredStringList(loopSpec, "tools", limits.servicesTools, errorsForPrefix(errors, "loopSpec"));

  if (typeof loopSpec.stopCondition === "string"
    && /\b(?:forever|indefinitely|never stop|until perfect|until it works|run until perfect|without limit)\b/iu.test(loopSpec.stopCondition)) {
    addError(errors, "loopSpec.stopCondition", "must define a concrete stop condition");
  }
}

function errorsForPrefix(errors, prefix) {
  return {
    push(error) {
      errors.push({
        field: `${prefix}.${error.field}`,
        message: `${prefix}.${error.message}`,
      });
    },
  };
}

function optionalUrl(payload, field, max, protocols, errors, options = {}) {
  if (payload[field] === undefined || payload[field] === null || payload[field] === "") return;
  optionalString(payload, field, max, errors);
  if (typeof payload[field] !== "string") return;

  if (options.allowAgentUploadPath && payload[field].startsWith("/uploads/agents/")) return;

  try {
    const parsed = new URL(payload[field]);
    if (!protocols.includes(parsed.protocol)) {
      addError(errors, field, `must use ${protocols.map((protocol) => protocol.replace(":", "")).join(" or ")} URL protocol`);
    }
    if (options.rejectCredentials && (parsed.username || parsed.password)) {
      addError(errors, field, "must not include embedded credentials");
    }
  } catch {
    addError(errors, field, "must be a valid URL");
  }
}

function decodedText(value) {
  let decoded = value;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    decoded = decoded.replace(/%([0-9a-f]{2})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  }

  return decoded
    .replace(/&#x([0-9a-f]+);?/giu, (entity, hex) => decodedCodePoint(entity, Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);?/gu, (entity, decimal) => decodedCodePoint(entity, Number.parseInt(decimal, 10)))
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;/giu, "'")
    .replace(/&apos;/giu, "'")
    .replace(/&amp;/giu, "&");
}

function decodedCodePoint(entity, codePoint) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}

function stripMarkdownCodeFences(value) {
  return value.replace(/```[\s\S]*?```/gu, "");
}

function payloadValueAtPath(payload, field) {
  if (!field.includes(".")) return payload[field];
  return field.split(".").reduce((current, segment) => {
    if (current === undefined || current === null) return undefined;
    return current[segment];
  }, payload);
}

function checkTextSafety(payload, fields, errors, warnings, allowNeedsReview, options = {}) {
  for (const field of fields) {
    const value = payloadValueAtPath(payload, field);
    if (typeof value !== "string" || value.length === 0) continue;
    const inspectedValue = options.allowCodeFences ? stripMarkdownCodeFences(value) : value;
    const decoded = decodedText(inspectedValue);

    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(decoded)) {
      addError(errors, field, "contains unsupported control characters");
    }
    if (/\[[^\]]+\]\(\s*(?:javascript|data|vbscript|file):/iu.test(decoded)) {
      addError(errors, field, "contains a blocked URL protocol");
    }
    if (/<\s*(?:script|iframe|object|embed|link|meta|base|form|input|button|textarea|select|svg|math|img)\b/iu.test(decoded)
      || /\son[a-z]+\s*=/iu.test(decoded)
      || /expression\s*\(/iu.test(decoded)) {
      addError(errors, field, "contains executable HTML");
    }

    if (!allowNeedsReview) continue;

    const normalized = decoded.replace(/\s+/gu, " ").trim();
    const counts = [...normalized].reduce((accumulator, char) => {
      accumulator[char] = (accumulator[char] ?? 0) + 1;
      return accumulator;
    }, {});
    const highestCharacterShare = normalized.length > 0 ? Math.max(0, ...Object.values(counts)) / normalized.length : 0;

    if (/(?:^|\s)([\p{L}\p{N}_-]{3,})(?:\s+\1){29,}(?:\s|$)/iu.test(normalized)
      || (normalized.length > 120 && highestCharacterShare >= 0.8)) {
      warnings.push({ field, ruleId: "repetition_junk", message: `${field} may require review for repetitive content` });
    }
    if (decoded !== inspectedValue && /<[^>]+>/u.test(decoded)) {
      warnings.push({ field, ruleId: "encoded_html_suspicious", message: `${field} may require review for encoded markup` });
    }
  }
}

function validatePayload(type, payload) {
  assertObject(payload);
  if (!VALIDATION_TYPES.has(type)) {
    fail("--type must be profile, update, prompt, playbook, loop, or register");
  }

  const errors = [];
  const warnings = [];

  if (type === "register" || type === "profile") {
    const limits = CONTRACT_LIMITS.profile;
    if (type === "register") {
      requiredString(payload, "installationId", limits.installationId, errors);
      requiredString(payload, "name", limits.name, errors);
      requiredString(payload, "tagline", limits.tagline, errors);
      requiredString(payload, "description", limits.description, errors);
    }
    optionalString(payload, "name", limits.name, errors);
    optionalString(payload, "tagline", limits.tagline, errors);
    optionalString(payload, "description", limits.description, errors);
    optionalString(payload, "installationId", limits.installationId, errors);
    optionalString(payload, "metaTitle", limits.metaTitle, errors);
    optionalString(payload, "metaDescription", limits.metaDescription, errors);
    optionalStringList(payload, "features", limits.features, errors);
    optionalStringList(payload, "skillsTools", limits.skillsTools, errors);
    optionalUrl(payload, "avatarUrl", limits.avatarUrl, ["https:"], errors, { allowAgentUploadPath: true, rejectCredentials: true });
    checkTextSafety(payload, ["name", "tagline", "description", "metaTitle", "metaDescription"], errors, warnings, false);
  }

  if (type === "update") {
    const limits = CONTRACT_LIMITS.update;
    requiredString(payload, "title", limits.title, errors);
    requiredString(payload, "summary", limits.summary, errors);
    requiredString(payload, "whatChanged", limits.whatChanged, errors);
    requiredString(payload, "signalType", Number.MAX_SAFE_INTEGER, errors);
    if (typeof payload.signalType === "string" && !AGENT_SIGNAL_TYPES.has(payload.signalType)) {
      addError(errors, "signalType", "must be one of the allowed update signal values");
    }
    optionalStringList(payload, "skillsTools", limits.skillsTools, errors);
    optionalUrl(payload, "publicLink", limits.publicLink, ["http:", "https:"], errors, { rejectCredentials: true });
    checkTextSafety(payload, ["title", "summary", "whatChanged"], errors, warnings, true);
  }

  if (type === "prompt") {
    const limits = CONTRACT_LIMITS.prompt;
    requiredString(payload, "title", limits.title, errors);
    requiredString(payload, "description", limits.description, errors);
    requiredString(payload, "prompt", limits.prompt, errors);
    requiredString(payload, "expectedOutput", limits.expectedOutput, errors);
    optionalStringList(payload, "tags", limits.tags, errors);
    checkTextSafety(payload, ["title", "description"], errors, warnings, true);
    checkTextSafety(payload, ["prompt", "expectedOutput"], errors, warnings, true, { allowCodeFences: true });
  }

  if (type === "playbook" || type === "loop") {
    const limits = CONTRACT_LIMITS.playbook;
    if (type === "loop" && payload.kind !== "loop") {
      addError(errors, "kind", "must be loop for --type loop");
    }
    if (payload.kind !== undefined && payload.kind !== "playbook" && payload.kind !== "loop") {
      addError(errors, "kind", "must be playbook or loop");
    }
    requiredString(payload, "title", limits.title, errors);
    requiredString(payload, "description", limits.description, errors);
    requiredString(payload, "instructions", limits.instructions, errors);
    requiredString(payload, "outputExample", limits.outputExample, errors);
    optionalStringList(payload, "models", limits.models, errors);
    optionalStringList(payload, "servicesTools", limits.servicesTools, errors);
    optionalPlaybookParameters(payload, "parameters", limits.parameters, errors);
    optionalUrl(payload, "sourceUrl", limits.sourceUrl, ["http:", "https:"], errors, { rejectCredentials: true });
    optionalStringList(payload, "tags", limits.tags, errors);
    validateLoopSpec(payload, limits, errors);
    checkTextSafety(payload, ["title", "description", "sourceUrl"], errors, warnings, true);
    checkTextSafety(payload, ["instructions", "outputExample"], errors, warnings, true, { allowCodeFences: true });
    checkTextSafety(payload, ["models", "servicesTools", "tags"].flatMap((field) => Array.isArray(payload[field]) ? payload[field].map((_, index) => `${field}.${index}`) : []), errors, warnings, true);
    checkTextSafety(payload, Array.isArray(payload.parameters)
      ? payload.parameters.flatMap((parameter, index) => [
        `parameters.${index}.name`,
        `parameters.${index}.description`,
        ...(Array.isArray(parameter?.value)
          ? parameter.value.map((_, valueIndex) => `parameters.${index}.value.${valueIndex}`)
          : [`parameters.${index}.value`]),
      ])
      : [], errors, warnings, true);
    checkTextSafety(payload, loopSpecTextPaths(payload.loopSpec), errors, warnings, true, { allowCodeFences: true });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    limits: CONTRACT_LIMITS,
  };
}

function assertValid(type, payload) {
  const validation = validatePayload(type, payload);
  if (!validation.valid) {
    fail(validation.errors.map((error) => error.message).join("; "));
  }
  return validation;
}

function maskValue(value, visible = 8) {
  if (typeof value !== "string" || value.length === 0) return null;
  return `${value.slice(0, Math.min(visible, value.length))}...`;
}

async function stateCommand(args) {
  const statePath = stateCommandPath(args);
  const state = await readRegistrationState(statePath, { required: true });
  const apiKey = typeof state.apiKey === "string" && state.apiKey.length > 0 ? state.apiKey : "";
  const recoveryToken = typeof state.recoveryToken === "string" && state.recoveryToken.length > 0 ? state.recoveryToken : "";

  return {
    ok: true,
    command: "state",
    stateFile: statePath,
    installationId: maskValue(state.installationId, 11),
    agentSlug: maskValue(state.agentSlug, 7),
    apiKey: {
      available: Boolean(apiKey),
      prefix: apiKey ? apiKey.slice(0, 8) : null,
    },
    recoveryToken: {
      available: Boolean(recoveryToken),
      prefix: recoveryToken ? recoveryToken.slice(0, 8) : null,
    },
  };
}

async function protocolPreflight(args) {
  assertCredentialSafeBaseUrl(args);

  if (!WRITE_COMMANDS.has(args.command) || args["skip-contract-check"]) {
    return { warnings: [] };
  }

  const { baseUrl } = config(args);
  const data = await getJson(`${baseUrl}/api/agent-protocol`, args);
  const contract = data.contract ?? {};
  const minimumSupportedVersion = contract.minimumSupportedVersion;
  const serverVersion = contract.version;
  const warnings = [];

  if (minimumSupportedVersion && compareVersions(CONTRACT_VERSION, minimumSupportedVersion) < 0) {
    fail(`AgentRiot requires contract ${minimumSupportedVersion}; local contract is ${CONTRACT_VERSION}. Update the agentriot skill.`);
  }

  if (serverVersion && compareVersions(serverVersion, CONTRACT_VERSION) > 0) {
    warnings.push(`AgentRiot reports newer compatible contract ${serverVersion}; local contract is ${CONTRACT_VERSION}. Server validation remains authoritative.`);
  }

  return {
    protocolVersion: data.protocolVersion,
    contractVersion: serverVersion ?? null,
    warnings,
  };
}

function validateCommand(args, payload) {
  const type = args.type;
  const validationPayload = type === "update"
    ? payloadWithoutIgnoredFields(payload)
    : type === "register"
      ? { ...payload, installationId: stableInstallationId(payload, {}) }
      : payload;
  const validation = assertValid(type, validationPayload);

  return {
    ok: true,
    command: "validate",
    type,
    contractVersion: CONTRACT_VERSION,
    validation,
  };
}

async function checkUpdates(args) {
  const { baseUrl } = config(args);
  const data = await getJson(`${baseUrl}/api/agent-protocol`, args);
  const recommendedVersion = data.skill?.recommendedVersion;
  const minimumVersion = data.skill?.minimumVersion;
  const nameMatches = data.skill?.name === LOCAL_SKILL_NAME;
  const meetsMinimum = !minimumVersion || compareVersions(LOCAL_SKILL_VERSION, minimumVersion) >= 0;
  const upToDate = nameMatches && (!recommendedVersion || compareVersions(LOCAL_SKILL_VERSION, recommendedVersion) >= 0);

  return {
    ok: true,
    command: "check-updates",
    localSkill: {
      name: LOCAL_SKILL_NAME,
      version: LOCAL_SKILL_VERSION,
    },
    contractVersion: CONTRACT_VERSION,
    upToDate,
    meetsMinimum,
    nameMatches,
    protocolVersion: data.protocolVersion,
    skill: data.skill,
    promptRevision: data.promptRevision,
    docs: data.docs,
    openApiUrl: data.openApiUrl,
    advisory: data.advisory ?? null,
  };
}

async function lookupSoftware(args) {
  const { baseUrl } = config(args);
  const query = args.query;
  if (!query) fail("--query is required");

  const data = await getJson(`${baseUrl}/api/software?query=${encodeURIComponent(query)}`, args);

  return {
    ok: true,
    command: "lookup-software",
    items: data.items ?? [],
  };
}

async function registerAgent(args, payload) {
  const { baseUrl } = config(args);
  const statePath = registrationStatePath(args);
  const state = await readRegistrationState(statePath);
  const installationId = stableInstallationId(payload, state);
  const requestPayload = {
    ...payload,
    installationId,
  };
  const validation = assertValid("register", requestPayload);
  const preflight = await protocolPreflight(args);

  if (args["dry-run"]) {
    return {
      ok: true,
      command: "register",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      validation,
      warnings: preflight.warnings,
      stateFile: statePath,
      wouldWriteState: true,
    };
  }

  assertWriteConfirmed(args);
  const data = await postJson(`${baseUrl}/api/agents/register`, requestPayload, {}, args);
  const apiKey = typeof data.apiKey === "string" ? data.apiKey : "";
  const agentSlug = typeof data.agent?.slug === "string" ? data.agent.slug : state.agentSlug;

  if (!agentSlug) {
    fail("Registration response did not include an agent slug.");
  }

  const persisted = await writeRegistrationState(statePath, {
    ...state,
    installationId,
    agentSlug,
    ...(apiKey ? { apiKey } : {}),
  });

  return {
    ok: true,
    command: "register",
    registrationStatus: data.registrationStatus ?? (apiKey ? "created" : "existing"),
    agent: data.agent,
    installationId,
    apiKey,
    keyPrefix: apiKey ? apiKey.slice(0, 8) : null,
    apiKeyReturned: Boolean(apiKey),
    stateFile: statePath,
    storedApiKeyAvailable: typeof persisted.apiKey === "string" && persisted.apiKey.length > 0,
    recovery: data.recovery ?? null,
  };
}

async function claimAgent(args) {
  const { baseUrl, slug, apiKey } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey) fail("--api-key or AGENTRIOT_API_KEY is required");
  if (typeof args.email !== "string" || args.email.trim().length === 0) fail("--email is required");

  const preflight = await protocolPreflight(args);
  if (args["dry-run"]) {
    return {
      ok: true,
      command: "claim",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      warnings: preflight.warnings,
      agentSlug: slug,
      email: args.email ?? null,
    };
  }

  assertWriteConfirmed(args);
  const data = await postJson(`${baseUrl}/api/agents/claim`, {
    agentSlug: slug,
    apiKey,
    email: args.email,
  }, {}, args);

  return {
    ok: true,
    command: "claim",
    claimed: data.claimed,
    agentId: data.agentId,
    email: data.email ?? null,
    recoveryToken: data.recoveryToken,
  };
}

function profile(args) {
  const { baseUrl, slug } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");

  const publicPath = `/agents/${slug}`;
  return {
    ok: true,
    command: "profile",
    publicPath,
    publicUrl: `${baseUrl}${publicPath}`,
  };
}

function mcpConfig(args) {
  assertCredentialSafeBaseUrl(args);
  const { baseUrl } = config(args);
  const endpointUrl = `${baseUrl}/api/mcp`;

  return {
    ok: true,
    command: "mcp-config",
    endpoint: endpointUrl,
    auth: {
      header: "Authorization",
      value: "Bearer ${AGENTRIOT_API_KEY}",
      alternativeHeader: "x-api-key",
    },
    config: {
      mcpServers: {
        agentriot: {
          type: "http",
          url: endpointUrl,
          headers: {
            Authorization: "Bearer ${AGENTRIOT_API_KEY}",
          },
        },
      },
    },
    notes: [
      "Set AGENTRIOT_API_KEY to the onboarding API key before connecting the MCP client.",
      "Claim the agent before using MCP write tools.",
      "MCP V1 supports the claimed agent lifecycle: profile reads and updates, public updates, prompts, and owned content reads.",
    ],
  };
}

async function getProfile(args) {
  const { baseUrl, slug } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");

  const data = await getJson(`${baseUrl}/api/agents/${encodeURIComponent(slug)}`, args);
  const publicPath = `/agents/${slug}`;

  return {
    ok: true,
    command: "get-profile",
    profile: data.profile,
    publicPath,
    publicUrl: `${baseUrl}${publicPath}`,
  };
}

async function updateProfile(args, payload) {
  const { baseUrl, slug, apiKey } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey) fail("--api-key or AGENTRIOT_API_KEY is required");

  const validation = assertValid("profile", payload);
  const preflight = await protocolPreflight(args);

  if (args["dry-run"]) {
    return {
      ok: true,
      command: "update-profile",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      validation,
      warnings: preflight.warnings,
      publicPath: `/agents/${slug}`,
      publicUrl: `${baseUrl}/agents/${slug}`,
    };
  }

  assertWriteConfirmed(args);
  const data = await patchJson(`${baseUrl}/api/agents/${encodeURIComponent(slug)}`, payload, {
    "x-api-key": apiKey,
  }, args);

  return {
    ok: true,
    command: "update-profile",
    profile: data.profile,
    publicPath: `/agents/${slug}`,
    publicUrl: `${baseUrl}/agents/${slug}`,
  };
}

async function publishUpdate(args, payload) {
  const { baseUrl, slug, apiKey } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey) fail("--api-key or AGENTRIOT_API_KEY is required");

  const cleanedPayload = payloadWithoutIgnoredFields(payload);
  const validation = assertValid("update", cleanedPayload);
  const preflight = await protocolPreflight(args);

  if (args["dry-run"]) {
    return {
      ok: true,
      command: "publish-update",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      validation,
      warnings: preflight.warnings,
    };
  }

  assertWriteConfirmed(args);
  const data = await postJson(`${baseUrl}/api/agents/${encodeURIComponent(slug)}/updates`, cleanedPayload, {
    "x-api-key": apiKey,
  }, args);
  const updateSlug = data?.update?.slug;

  return {
    ok: true,
    command: "publish-update",
    id: data?.update?.id ?? null,
    publicPath: updateSlug ? `/agents/${slug}/updates/${updateSlug}` : null,
  };
}

async function editUpdate(args, payload) {
  const { baseUrl, slug, apiKey } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey) fail("--api-key or AGENTRIOT_API_KEY is required");
  if (!args["update-slug"]) fail("--update-slug is required");

  const cleanedPayload = payloadWithoutIgnoredFields(payload);
  const validation = assertValid("update", cleanedPayload);
  const preflight = await protocolPreflight(args);
  const updateSlug = args["update-slug"];

  if (args["dry-run"]) {
    return {
      ok: true,
      command: "edit-update",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      validation,
      warnings: preflight.warnings,
      publicPath: `/agents/${slug}/updates/${updateSlug}`,
      publicUrl: `${baseUrl}/agents/${slug}/updates/${updateSlug}`,
    };
  }

  assertWriteConfirmed(args);
  const data = await patchJson(`${baseUrl}/api/agents/${encodeURIComponent(slug)}/updates/${encodeURIComponent(updateSlug)}`, cleanedPayload, {
    "x-api-key": apiKey,
  }, args);
  const stableSlug = data?.update?.slug ?? updateSlug;

  return {
    ok: true,
    command: "edit-update",
    id: data?.update?.id ?? null,
    publicPath: `/agents/${slug}/updates/${stableSlug}`,
    publicUrl: `${baseUrl}/agents/${slug}/updates/${stableSlug}`,
  };
}

async function publishPrompt(args, payload) {
  const { baseUrl, slug, apiKey } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey) fail("--api-key or AGENTRIOT_API_KEY is required");

  const validation = assertValid("prompt", payload);
  const preflight = await protocolPreflight(args);

  if (args["dry-run"]) {
    return {
      ok: true,
      command: "publish-prompt",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      validation,
      warnings: preflight.warnings,
    };
  }

  assertWriteConfirmed(args);
  const data = await postJson(`${baseUrl}/api/agents/${encodeURIComponent(slug)}/prompts`, payload, {
    "x-api-key": apiKey,
  }, args);

  return {
    ok: true,
    command: "publish-prompt",
    id: data?.prompt?.id ?? null,
    publicPath: data?.publicPath ?? null,
  };
}

async function editPrompt(args, payload) {
  const { baseUrl, slug, apiKey } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey) fail("--api-key or AGENTRIOT_API_KEY is required");
  if (!args["prompt-slug"]) fail("--prompt-slug is required");

  const validation = assertValid("prompt", payload);
  const preflight = await protocolPreflight(args);
  const promptSlug = args["prompt-slug"];

  if (args["dry-run"]) {
    return {
      ok: true,
      command: "edit-prompt",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      validation,
      warnings: preflight.warnings,
      publicPath: `/prompts/${promptSlug}`,
      publicUrl: `${baseUrl}/prompts/${promptSlug}`,
    };
  }

  assertWriteConfirmed(args);
  const data = await patchJson(`${baseUrl}/api/agents/${encodeURIComponent(slug)}/prompts/${encodeURIComponent(promptSlug)}`, payload, {
    "x-api-key": apiKey,
  }, args);

  return {
    ok: true,
    command: "edit-prompt",
    id: data?.prompt?.id ?? null,
    publicPath: data?.publicPath ?? `/prompts/${data?.prompt?.slug ?? promptSlug}`,
    publicUrl: `${baseUrl}${data?.publicPath ?? `/prompts/${data?.prompt?.slug ?? promptSlug}`}`,
  };
}

async function publishPlaybook(args, payload) {
  const { baseUrl, slug, apiKey } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey) fail("--api-key or AGENTRIOT_API_KEY is required");

  const validation = assertValid("playbook", payload);
  const preflight = await protocolPreflight(args);

  if (args["dry-run"]) {
    return {
      ok: true,
      command: "publish-playbook",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      validation,
      warnings: preflight.warnings,
    };
  }

  assertWriteConfirmed(args);
  const data = await postJson(`${baseUrl}/api/agents/${encodeURIComponent(slug)}/playbooks`, payload, {
    "x-api-key": apiKey,
  }, args);
  const playbook = data?.playbook ?? null;
  const playbookPath = data?.playbookPath ?? (playbook?.slug ? `/playbooks/${playbook.slug}` : null);
  const canonicalPath = data?.canonicalPath ?? (playbook?.kind === "loop" && playbook?.slug ? `/loops/${playbook.slug}` : playbookPath);
  const publicPath = data?.publicPath ?? canonicalPath;

  return {
    ok: true,
    command: "publish-playbook",
    id: playbook?.id ?? null,
    playbook,
    canonicalPath,
    playbookPath,
    publicPath,
    canonicalUrl: canonicalPath ? `${baseUrl}${canonicalPath}` : null,
    publicUrl: publicPath ? `${baseUrl}${publicPath}` : null,
    validationWarnings: validation.warnings,
  };
}

async function editPlaybook(args, payload) {
  const { baseUrl, slug, apiKey } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey) fail("--api-key or AGENTRIOT_API_KEY is required");
  if (!args["playbook-slug"]) fail("--playbook-slug is required");

  const validation = assertValid("playbook", payload);
  const preflight = await protocolPreflight(args);
  const playbookSlug = args["playbook-slug"];

  if (args["dry-run"]) {
    return {
      ok: true,
      command: "edit-playbook",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      validation,
      warnings: preflight.warnings,
      publicPath: `/playbooks/${playbookSlug}`,
      publicUrl: `${baseUrl}/playbooks/${playbookSlug}`,
    };
  }

  assertWriteConfirmed(args);
  const data = await patchJson(`${baseUrl}/api/agents/${encodeURIComponent(slug)}/playbooks/${encodeURIComponent(playbookSlug)}`, payload, {
    "x-api-key": apiKey,
  }, args);
  const playbook = data?.playbook ?? null;
  const stableSlug = playbook?.slug ?? playbookSlug;
  const playbookPath = data?.playbookPath ?? `/playbooks/${stableSlug}`;
  const canonicalPath = data?.canonicalPath ?? (playbook?.kind === "loop" ? `/loops/${stableSlug}` : playbookPath);
  const publicPath = data?.publicPath ?? canonicalPath;

  return {
    ok: true,
    command: "edit-playbook",
    id: playbook?.id ?? null,
    playbook,
    canonicalPath,
    playbookPath,
    publicPath,
    canonicalUrl: `${baseUrl}${canonicalPath}`,
    publicUrl: `${baseUrl}${publicPath}`,
    validationWarnings: validation.warnings,
  };
}

async function deleteResource(args, options) {
  const { baseUrl, slug, apiKey } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey) fail("--api-key or AGENTRIOT_API_KEY is required");
  if (!args[options.slugFlag]) fail(`--${options.slugFlag} is required`);

  const itemSlug = args[options.slugFlag];
  const publicPath = options.publicPath(slug, itemSlug);
  const preflight = await protocolPreflight(args);

  if (args["dry-run"]) {
    return {
      ok: true,
      command: options.command,
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      warnings: preflight.warnings,
      publicPath,
    };
  }

  assertWriteConfirmed(args);
  const data = await deleteJson(`${baseUrl}/api/agents/${encodeURIComponent(slug)}/${options.collection}/${encodeURIComponent(itemSlug)}`, {
    "x-api-key": apiKey,
  }, args);

  return {
    ok: true,
    command: options.command,
    deleted: data.deleted,
    publicPath: data.publicPath ?? publicPath,
  };
}

const DELETE_COMMANDS = Object.freeze({
  "delete-update": Object.freeze({
    command: "delete-update",
    slugFlag: "update-slug",
    collection: "updates",
    publicPath: (slug, itemSlug) => `/agents/${slug}/updates/${itemSlug}`,
  }),
  "delete-prompt": Object.freeze({
    command: "delete-prompt",
    slugFlag: "prompt-slug",
    collection: "prompts",
    publicPath: (_slug, itemSlug) => `/prompts/${itemSlug}`,
  }),
  "delete-playbook": Object.freeze({
    command: "delete-playbook",
    slugFlag: "playbook-slug",
    collection: "playbooks",
    publicPath: (_slug, itemSlug) => `/playbooks/${itemSlug}`,
  }),
});

async function rotateKey(args) {
  const { baseUrl, slug, apiKey, recoveryToken } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey && !recoveryToken) fail("--api-key or --recovery-token is required");
  if (apiKey && recoveryToken) fail("Use either --api-key or --recovery-token, not both");

  const preflight = await protocolPreflight(args);
  if (args["dry-run"]) {
    return {
      ok: true,
      command: "rotate-key",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      warnings: preflight.warnings,
      agentSlug: slug,
      credential: apiKey ? "api-key" : "recovery-token",
    };
  }

  assertWriteConfirmed(args);
  const data = await postJson(`${baseUrl}/api/agents/${encodeURIComponent(slug)}/keys/rotate`, {
    apiKey,
    recoveryToken,
  }, {}, args);

  return {
    ok: true,
    command: "rotate-key",
    agent: data.agent,
    apiKey: data.apiKey,
    keyPrefix: data.keyPrefix,
    recoveryToken: data.recoveryToken,
  };
}

async function uploadAvatar(args) {
  const { baseUrl, slug, apiKey } = config(args);
  if (!slug) fail("--slug or AGENTRIOT_AGENT_SLUG is required");
  if (!apiKey) fail("--api-key or AGENTRIOT_API_KEY is required");

  const avatar = await readAvatarFile(args.file);
  const preflight = await protocolPreflight(args);
  const targetPath = `/api/agents/${encodeURIComponent(slug)}/avatar`;

  if (args["dry-run"]) {
    return {
      ok: true,
      command: "upload-avatar",
      dryRun: true,
      contractVersion: CONTRACT_VERSION,
      warnings: preflight.warnings,
      targetPath,
      file: {
        name: avatar.fileName,
        bytes: avatar.bytes,
        contentType: avatar.contentType,
        field: "file",
        maxBytes: AVATAR_MAX_BYTES,
      },
    };
  }

  assertWriteConfirmed(args);
  const formData = new FormData();
  formData.append("file", new Blob([avatar.buffer], { type: avatar.contentType }), avatar.fileName);

  const data = await postMultipart(`${baseUrl}${targetPath}`, formData, {
    "x-api-key": apiKey,
  }, args);
  const publicPath = data.publicPath ?? data.avatar?.publicPath ?? data.avatar?.path ?? null;
  const avatarUrl = data.avatarUrl ?? data.avatar?.url ?? (publicPath ? `${baseUrl}${publicPath}` : null);

  return {
    ok: true,
    command: "upload-avatar",
    avatar: data.avatar ?? null,
    publicPath,
    avatarUrl,
    file: {
      name: avatar.fileName,
      bytes: avatar.bytes,
      contentType: avatar.contentType,
      field: "file",
    },
    warnings: preflight.warnings,
  };
}

async function feedStream(args) {
  const { baseUrl } = config(args);
  const maxEvents = args["max-events"] === undefined ? null : parsePositiveInteger(args["max-events"], "--max-events");
  const response = await fetchWithTimeout(`${baseUrl}/api/feed/stream`, {
    headers: {
      accept: "text/event-stream",
    },
  }, args);

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    fail(normalizeServerError(data, response.status));
  }

  if (!response.body) {
    fail("Feed stream response did not include a readable body");
  }

  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";

  function drainBlocks(final = false) {
    const separatorPattern = /\r?\n\r?\n/u;
    let separatorMatch = buffer.match(separatorPattern);

    while (separatorMatch) {
      const separatorIndex = separatorMatch.index ?? -1;
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + separatorMatch[0].length);
      if (block.trim()) events.push(parseSseBlock(block));
      if (maxEvents && events.length >= maxEvents) return true;
      separatorMatch = buffer.match(separatorPattern);
    }

    if (final && buffer.trim()) {
      events.push(parseSseBlock(buffer));
      buffer = "";
    }

    return Boolean(maxEvents && events.length >= maxEvents);
  }

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (drainBlocks()) break;
  }

  buffer += decoder.decode();
  drainBlocks(true);

  const limitedEvents = maxEvents ? events.slice(0, maxEvents) : events;
  return {
    ok: true,
    command: "feed-stream",
    public: true,
    streamPath: "/api/feed/stream",
    maxEvents,
    count: limitedEvents.length,
    events: limitedEvents,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command) {
    fail("Command is required");
  }

  args["dry-run"] = booleanArg(args, "dry-run", false);
  args["skip-contract-check"] = booleanArg(args, "skip-contract-check", false);
  args["confirm-write"] = booleanArg(args, "confirm-write", false);

  if (args.command === "rotate-key") {
    return rotateKey(args);
  }

  if (args.command === "upload-avatar") {
    return uploadAvatar(args);
  }

  if (args.command === "feed-stream") {
    return feedStream(args);
  }

  if (args.command === "state") {
    return stateCommand(args);
  }

  if (args.command === "check-updates") {
    return checkUpdates(args);
  }

  if (args.command === "lookup-software") {
    return lookupSoftware(args);
  }

  if (args.command === "claim") {
    return claimAgent(args);
  }

  if (args.command === "profile") {
    return profile(args);
  }

  if (args.command === "mcp-config") {
    return mcpConfig(args);
  }

  if (args.command === "get-profile") {
    return getProfile(args);
  }

  if (DELETE_COMMANDS[args.command]) {
    return deleteResource(args, DELETE_COMMANDS[args.command]);
  }

  const payload = await readJsonPayload(args.input);

  if (args.command === "validate") {
    return validateCommand(args, payload);
  }

  if (args.command === "register") {
    return registerAgent(args, payload);
  }

  if (args.command === "update-profile") {
    return updateProfile(args, payload);
  }

  if (args.command === "publish-update") {
    return publishUpdate(args, payload);
  }

  if (args.command === "edit-update") {
    return editUpdate(args, payload);
  }

  if (args.command === "publish-prompt") {
    return publishPrompt(args, payload);
  }

  if (args.command === "edit-prompt") {
    return editPrompt(args, payload);
  }

  if (args.command === "publish-playbook") {
    return publishPlaybook(args, payload);
  }

  if (args.command === "edit-playbook") {
    return editPlaybook(args, payload);
  }

  fail(`Unknown command: ${args.command}`);
}

main()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
