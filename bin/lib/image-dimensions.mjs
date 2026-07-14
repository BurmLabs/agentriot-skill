const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

function malformed(format) {
  throw new Error(`Malformed ${format} image`);
}

function positiveDimensions(width, height, format) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    malformed(format);
  }

  return { width, height };
}

function readPngDimensions(buffer) {
  if (buffer.length < 33
    || buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    || buffer.readUInt32BE(8) !== 13
    || buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    malformed("PNG");
  }

  return positiveDimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20), "PNG");
}

function readJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    malformed("JPEG");
  }

  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) malformed("JPEG");
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) malformed("JPEG");

    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) malformed("JPEG");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > buffer.length) malformed("JPEG");

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) malformed("JPEG");

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 8 || segmentLength !== 8 + (3 * buffer[offset + 7])) malformed("JPEG");
      return positiveDimensions(
        buffer.readUInt16BE(offset + 5),
        buffer.readUInt16BE(offset + 3),
        "JPEG",
      );
    }

    offset += segmentLength;
  }

  malformed("JPEG");
}

function readWebpChunkDimensions(buffer, chunkType, dataOffset, chunkSize) {
  if (chunkType === "VP8X") {
    if (chunkSize !== 10) malformed("WebP");
    return positiveDimensions(
      buffer.readUIntLE(dataOffset + 4, 3) + 1,
      buffer.readUIntLE(dataOffset + 7, 3) + 1,
      "WebP",
    );
  }

  if (chunkType === "VP8L") {
    if (chunkSize < 5 || buffer[dataOffset] !== 0x2f) malformed("WebP");
    const dimensions = buffer.readUInt32LE(dataOffset + 1);
    return positiveDimensions(
      (dimensions & 0x3fff) + 1,
      ((dimensions >>> 14) & 0x3fff) + 1,
      "WebP",
    );
  }

  if (chunkType === "VP8 ") {
    if (chunkSize < 10
      || buffer[dataOffset + 3] !== 0x9d
      || buffer[dataOffset + 4] !== 0x01
      || buffer[dataOffset + 5] !== 0x2a) {
      malformed("WebP");
    }
    return positiveDimensions(
      buffer.readUInt16LE(dataOffset + 6) & 0x3fff,
      buffer.readUInt16LE(dataOffset + 8) & 0x3fff,
      "WebP",
    );
  }

  return null;
}

function readWebpDimensions(buffer) {
  if (buffer.length < 12
    || buffer.subarray(0, 4).toString("ascii") !== "RIFF"
    || buffer.subarray(8, 12).toString("ascii") !== "WEBP") {
    malformed("WebP");
  }

  const riffEnd = buffer.readUInt32LE(4) + 8;
  if (riffEnd < 12 || riffEnd > buffer.length) malformed("WebP");

  let offset = 12;
  while (offset < riffEnd) {
    if (offset + 8 > riffEnd) malformed("WebP");
    const chunkType = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkSize;
    const paddedEnd = dataEnd + (chunkSize % 2);
    if (paddedEnd > riffEnd) malformed("WebP");

    const dimensions = readWebpChunkDimensions(buffer, chunkType, dataOffset, chunkSize);
    if (dimensions) return dimensions;

    offset = paddedEnd;
  }

  malformed("WebP");
}

export function readImageDimensions(buffer, contentType) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("image buffer must be a Buffer");

  if (contentType === "image/png") return readPngDimensions(buffer);
  if (contentType === "image/jpeg") return readJpegDimensions(buffer);
  if (contentType === "image/webp") return readWebpDimensions(buffer);

  throw new Error(`Unsupported image content type: ${contentType}`);
}
