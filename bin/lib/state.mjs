import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

function stateError(action, error) {
  return new Error(`${action}: ${error.message}`, { cause: error });
}

async function registrationStateStat(filePath, options = {}) {
  try {
    const fileStat = await lstat(filePath);
    if (fileStat.isSymbolicLink()) {
      throw new Error(`Registration state path must not be a symbolic link: ${filePath}`);
    }
    return fileStat;
  } catch (error) {
    if (error.code === "ENOENT" && options.allowMissing) return null;
    throw error;
  }
}

export async function readRegistrationState(filePath, options = {}) {
  try {
    const fileStat = await registrationStateStat(filePath, { allowMissing: true });
    if (!fileStat) {
      if (options.required) {
        throw new Error(`Registration state file not found: ${filePath}`);
      }
      return {};
    }
    if (!fileStat.isFile()) {
      throw new Error(`Registration state path must be a regular file: ${filePath}`);
    }

    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.message.startsWith("Registration state ")) throw error;
    throw stateError("Unable to read registration state", error);
  }
}

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

export async function writeRegistrationStateAtomic(filePath, state) {
  const directory = dirname(filePath);
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${randomUUID()}.tmp`,
  );
  let handle;
  let temporaryExists = false;

  try {
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    await mkdir(directory, { recursive: true });
    await registrationStateStat(filePath, { allowMissing: true });

    handle = await open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    await handle.writeFile(serialized, "utf8");
    await handle.sync();

    const temporaryStat = await handle.stat();
    if (!temporaryStat.isFile() || (temporaryStat.mode & 0o777) !== 0o600) {
      throw new Error("Registration state temporary file failed mode-0600 verification");
    }

    await handle.close();
    handle = undefined;
    const readback = await readRegistrationState(temporaryPath, { required: true });
    if (JSON.stringify(readback) !== JSON.stringify(state)) {
      throw new Error("Registration state temporary file failed readback verification");
    }

    await registrationStateStat(filePath, { allowMissing: true });
    await rename(temporaryPath, filePath);
    temporaryExists = false;

    const finalStat = await registrationStateStat(filePath);
    if (!finalStat.isFile() || (finalStat.mode & 0o777) !== 0o600) {
      throw new Error("Registration state file failed mode-0600 verification");
    }
    return await readRegistrationState(filePath, { required: true });
  } catch (error) {
    throw stateError("Unable to persist registration state", error);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (temporaryExists) await rm(temporaryPath, { force: true }).catch(() => {});
  }
}
