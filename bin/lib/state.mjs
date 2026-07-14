import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const DEFAULT_FILE_SYSTEM = Object.freeze({
  lstat,
  mkdir,
  open,
  rename,
  rm,
});
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const READ_FLAGS = fsConstants.O_RDONLY | NO_FOLLOW;
const CREATE_FLAGS = fsConstants.O_RDWR
  | fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | NO_FOLLOW;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0);

function stateError(action, error) {
  return new Error(`${action}: ${error.message}`, { cause: error });
}

function comparableIdentity(left, right) {
  const leftInodeAvailable = left.ino !== undefined
    && left.ino !== null
    && left.ino !== 0
    && left.ino !== 0n;
  const rightInodeAvailable = right.ino !== undefined
    && right.ino !== null
    && right.ino !== 0
    && right.ino !== 0n;
  return left.dev !== undefined
    && left.dev !== null
    && right.dev !== undefined
    && right.dev !== null
    && leftInodeAvailable
    && rightInodeAvailable;
}

function assertSameIdentity(expected, actual, label) {
  if (comparableIdentity(expected, actual)
    && (expected.dev !== actual.dev || expected.ino !== actual.ino)) {
    throw new Error(`Registration state ${label} changed during verification`);
  }
}

function assertRegularFile(fileStat, label) {
  if (!fileStat.isFile()) {
    throw new Error(`Registration state ${label} must be a regular file`);
  }
}

async function registrationStateStat(fileSystem, filePath, options = {}) {
  try {
    const fileStat = await fileSystem.lstat(filePath);
    if (fileStat.isSymbolicLink()) {
      throw new Error(`Registration state path must not be a symbolic link: ${filePath}`);
    }
    return fileStat;
  } catch (error) {
    if (error.code === "ENOENT" && options.allowMissing) return null;
    throw error;
  }
}

async function readHandleJson(handle, fileStat, label) {
  assertRegularFile(fileStat, label);
  if (!Number.isSafeInteger(fileStat.size) || fileStat.size < 0) {
    throw new Error(`Registration state ${label} has an unsupported size`);
  }

  const buffer = Buffer.alloc(fileStat.size);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }

  return JSON.parse(buffer.subarray(0, offset).toString("utf8"));
}

async function openVerifiedState(fileSystem, filePath, expectedIdentity = null) {
  const beforeOpen = await registrationStateStat(fileSystem, filePath);
  assertRegularFile(beforeOpen, "path");

  let handle;
  try {
    handle = await fileSystem.open(filePath, READ_FLAGS);
  } catch (error) {
    if (error.code === "ELOOP") {
      throw new Error(`Registration state path must not be a symbolic link: ${filePath}`);
    }
    throw error;
  }

  try {
    const handleStat = await handle.stat();
    assertRegularFile(handleStat, "file handle");
    assertSameIdentity(beforeOpen, handleStat, "path");
    if (expectedIdentity) {
      assertSameIdentity(expectedIdentity, handleStat, "file identity");
    }

    const afterOpen = await registrationStateStat(fileSystem, filePath);
    assertRegularFile(afterOpen, "path");
    assertSameIdentity(handleStat, afterOpen, "path");

    return {
      handle,
      stat: handleStat,
      parsed: await readHandleJson(handle, handleStat, "file"),
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function sameState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function syncDirectory(fileSystem, directory) {
  let directoryHandle;
  try {
    directoryHandle = await fileSystem.open(directory, DIRECTORY_FLAGS);
    await directoryHandle.sync();
  } catch (error) {
    const code = error.code ?? "UNKNOWN";
    throw new Error(
      `Registration state directory durability sync is required but unavailable (${code}): ${error.message}`,
      { cause: error },
    );
  } finally {
    if (directoryHandle) await directoryHandle.close().catch(() => {});
  }
}

export function createRegistrationStateIO(overrides = {}) {
  const fileSystem = {
    ...DEFAULT_FILE_SYSTEM,
    ...overrides,
  };

  async function readRegistrationState(filePath, options = {}) {
    let opened;
    try {
      const fileStat = await registrationStateStat(fileSystem, filePath, {
        allowMissing: true,
      });
      if (!fileStat) {
        if (options.required) {
          throw new Error(`Registration state file not found: ${filePath}`);
        }
        return {};
      }

      opened = await openVerifiedState(fileSystem, filePath);
      const parsed = opened.parsed;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch (error) {
      if (error.message.startsWith("Registration state ")) throw error;
      throw stateError("Unable to read registration state", error);
    } finally {
      if (opened) await opened.handle.close().catch(() => {});
    }
  }

  async function writeRegistrationStateAtomic(filePath, state) {
    const directory = dirname(filePath);
    const temporaryPath = join(
      directory,
      `.${basename(filePath)}.${randomUUID()}.tmp`,
    );
    let handle;
    let temporaryExists = false;

    try {
      const serialized = `${JSON.stringify(state, null, 2)}\n`;
      await fileSystem.mkdir(directory, { recursive: true });
      await registrationStateStat(fileSystem, filePath, { allowMissing: true });

      handle = await fileSystem.open(temporaryPath, CREATE_FLAGS, 0o600);
      temporaryExists = true;
      await handle.chmod(0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();

      const temporaryStat = await handle.stat();
      assertRegularFile(temporaryStat, "temporary file");
      if ((temporaryStat.mode & 0o777) !== 0o600) {
        throw new Error(
          "Registration state temporary file failed mode-0600 verification",
        );
      }

      const temporaryReadback = await readHandleJson(
        handle,
        temporaryStat,
        "temporary file",
      );
      if (!sameState(temporaryReadback, state)) {
        throw new Error(
          "Registration state temporary file failed readback verification",
        );
      }

      await handle.close();
      handle = undefined;
      await registrationStateStat(fileSystem, filePath, { allowMissing: true });
      await fileSystem.rename(temporaryPath, filePath);
      temporaryExists = false;
      await syncDirectory(fileSystem, directory);

      const finalFile = await openVerifiedState(
        fileSystem,
        filePath,
        temporaryStat,
      );
      try {
        if ((finalFile.stat.mode & 0o777) !== 0o600) {
          throw new Error("Registration state file failed mode-0600 verification");
        }
        if (!sameState(finalFile.parsed, state)) {
          throw new Error("Registration state file failed readback verification");
        }
        return finalFile.parsed;
      } finally {
        await finalFile.handle.close().catch(() => {});
      }
    } catch (error) {
      throw stateError("Unable to persist registration state", error);
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (temporaryExists) {
        await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
      }
    }
  }

  return Object.freeze({
    readRegistrationState,
    writeRegistrationStateAtomic,
  });
}

const defaultStateIO = createRegistrationStateIO();

export const readRegistrationState = defaultStateIO.readRegistrationState;
export const writeRegistrationStateAtomic = defaultStateIO.writeRegistrationStateAtomic;

export function stableInstallationId(payload, state) {
  if (typeof state.installationId === "string" && state.installationId.trim()) {
    return state.installationId.trim();
  }

  if (typeof payload.installationId === "string" && payload.installationId.trim()) {
    return payload.installationId.trim();
  }

  return `install_${randomUUID()}`;
}

export function maskValue(value, visible = 8) {
  if (typeof value !== "string" || value.length === 0) return null;
  return `${value.slice(0, Math.min(visible, value.length))}...`;
}

export function maskCredential(value, visible = 8) {
  const available = typeof value === "string" && value.length > 0;
  return {
    available,
    prefix: available ? value.slice(0, visible) : null,
  };
}
