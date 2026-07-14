import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, extname } from "node:path";
import { readImageDimensions } from "./image-dimensions.mjs";

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_MIN_DIMENSION = 128;
const AVATAR_MAX_DIMENSION = 2048;
const AVATAR_CONTENT_TYPES = Object.freeze({
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});
const READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

function comparableIdentity(left, right) {
  return left?.dev !== undefined
    && right?.dev !== undefined
    && left?.ino !== undefined
    && right?.ino !== undefined
    && left.ino !== 0
    && left.ino !== 0n
    && right.ino !== 0
    && right.ino !== 0n;
}

function sameIdentity(left, right) {
  return !comparableIdentity(left, right)
    || (left.dev === right.dev && left.ino === right.ino);
}

function assertRegularFile(fileStat) {
  if (fileStat.isSymbolicLink?.() || !fileStat.isFile()) {
    throw new Error("--file must point to a readable regular file");
  }
}

function assertSize(size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > AVATAR_MAX_BYTES) {
    throw new Error("avatar file must be 2 MiB or smaller");
  }
}

function matchesAvatarSignature(buffer, contentType) {
  if (contentType === "image/png") {
    return buffer.length >= 8
      && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  }
  if (contentType === "image/jpeg") {
    return buffer.length >= 3
      && buffer[0] === 0xff
      && buffer[1] === 0xd8
      && buffer[2] === 0xff;
  }
  if (contentType === "image/webp") {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString("ascii") === "RIFF"
      && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

export function createAvatarFileReader(overrides = {}) {
  const fileSystem = { lstat, open, ...overrides };

  return async function readAvatarFile(filePath) {
    if (!filePath) throw new Error("--file is required");

    let handle;
    try {
      const pathBefore = await fileSystem.lstat(filePath);
      assertRegularFile(pathBefore);
      assertSize(pathBefore.size);

      const extension = extname(filePath).toLowerCase();
      const contentType = AVATAR_CONTENT_TYPES[extension];
      if (!contentType) throw new Error("avatar file must be PNG, JPEG, or WebP");

      try {
        handle = await fileSystem.open(filePath, READ_FLAGS);
      } catch (error) {
        if (error.code === "ELOOP") {
          throw new Error("--file must not point to a symbolic link");
        }
        throw error;
      }

      const handleBefore = await handle.stat();
      assertRegularFile(handleBefore);
      assertSize(handleBefore.size);
      if (!sameIdentity(pathBefore, handleBefore)) {
        throw new Error("avatar file path changed during read");
      }

      const buffer = await handle.readFile();
      assertSize(buffer.length);

      const handleAfter = await handle.stat();
      assertRegularFile(handleAfter);
      if (!sameIdentity(handleBefore, handleAfter)) {
        throw new Error("avatar file changed during read");
      }

      const pathAfter = await fileSystem.lstat(filePath);
      assertRegularFile(pathAfter);
      if (!sameIdentity(handleAfter, pathAfter)) {
        throw new Error("avatar file path changed during read");
      }

      if (!matchesAvatarSignature(buffer, contentType)) {
        throw new Error(`avatar file content does not match ${contentType}`);
      }

      const { width, height } = readImageDimensions(buffer, contentType);
      if (width < AVATAR_MIN_DIMENSION
        || width > AVATAR_MAX_DIMENSION
        || height < AVATAR_MIN_DIMENSION
        || height > AVATAR_MAX_DIMENSION) {
        throw new Error(
          `avatar dimensions must be between ${AVATAR_MIN_DIMENSION} and ${AVATAR_MAX_DIMENSION} pixels`,
        );
      }

      return {
        buffer,
        fileName: basename(filePath),
        bytes: buffer.length,
        contentType,
        width,
        height,
      };
    } catch (error) {
      if (error.message.startsWith("avatar ") || error.message.startsWith("--file")) {
        throw error;
      }
      throw new Error(`Unable to read avatar file: ${error.message}`, { cause: error });
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  };
}

export const readAvatarFile = createAvatarFileReader();

export const avatarLimits = Object.freeze({
  maxBytes: AVATAR_MAX_BYTES,
  minDimension: AVATAR_MIN_DIMENSION,
  maxDimension: AVATAR_MAX_DIMENSION,
});
