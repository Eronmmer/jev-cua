import { createHash, createHmac } from "node:crypto";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_IHDR_OFFSET = 8;
const PNG_IHDR_LENGTH = 13;
const PNG_IHDR_TYPE = "IHDR";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export const NATIVE_VISUAL_GRID_SIDE = 8 as const;
export const NATIVE_VISUAL_MIME_TYPE = "image/png" as const;
export const NATIVE_VISUAL_ZOOM_MIME_TYPE = "image/jpeg" as const;

export type NativeVisualLimits = Readonly<{
  maxBytes: number;
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
}>;

export const DEFAULT_NATIVE_VISUAL_LIMITS: NativeVisualLimits = Object.freeze({
  maxBytes: 12 * 1024 * 1024,
  maxWidth: 8_192,
  maxHeight: 8_192,
  maxPixels: 32 * 1024 * 1024,
});

export type CuaImageBlock = Readonly<{
  type: "image";
  data: string;
  mimeType: typeof NATIVE_VISUAL_MIME_TYPE;
}>;

export type NativeVisualCapture = Readonly<{
  pid: number;
  windowId: number;
  width: number;
  height: number;
  byteLength: number;
  mimeType: typeof NATIVE_VISUAL_MIME_TYPE;
  digest: string;
  image: CuaImageBlock;
}>;

export type NativeVisualZoomCapture = Readonly<{
  width: number;
  height: number;
  byteLength: number;
  mimeType: typeof NATIVE_VISUAL_ZOOM_MIME_TYPE;
  digest: string;
  image: Readonly<{
    type: "image";
    data: string;
    mimeType: typeof NATIVE_VISUAL_ZOOM_MIME_TYPE;
  }>;
}>;

export type NormalizedVisualPoint = Readonly<{
  x: number;
  y: number;
}>;

export type NativeVisualPointBinding = Readonly<{
  captureDigest: string;
  width: number;
  height: number;
  xPx: number;
  yPx: number;
}>;

export type PublicVisualGridCell = Readonly<{
  cellRef: string;
  label: string;
}>;

export type PublicVisualGridDescriptor = Readonly<{
  rows: typeof NATIVE_VISUAL_GRID_SIDE;
  columns: typeof NATIVE_VISUAL_GRID_SIDE;
  cells: readonly PublicVisualGridCell[];
}>;

export type OpaqueVisualGrid = Readonly<{
  descriptor: PublicVisualGridDescriptor;
  resolveCell: (cellRef: string) => NormalizedVisualPoint;
}>;

export type NativeVisualFreshnessMismatch =
  | "target"
  | "mime_type"
  | "dimensions"
  | "digest";

export type NativeVisualFreshnessComparison = Readonly<{
  fresh: boolean;
  mismatches: readonly NativeVisualFreshnessMismatch[];
}>;

function record(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(message);
  return value as Record<string, unknown>;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validateLimits(limits: NativeVisualLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!positiveSafeInteger(value))
      throw new Error(`native visual ${name} limit is invalid`);
  }
  if (limits.maxPixels > Number.MAX_SAFE_INTEGER)
    throw new Error("native visual maxPixels limit is invalid");
}

function parseCanonicalBase64(value: string, maxBytes: number): Buffer {
  if (
    value.length === 0 ||
    value.length > 4 * Math.ceil(maxBytes / 3) ||
    value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value)
  ) {
    throw new Error("native screenshot image data is not bounded base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > maxBytes ||
    bytes.toString("base64") !== value
  ) {
    throw new Error("native screenshot image data is not canonical base64");
  }
  return bytes;
}

function pngDimensions(
  bytes: Buffer,
): Readonly<{ width: number; height: number }> {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(PNG_IHDR_OFFSET) !== PNG_IHDR_LENGTH ||
    bytes.toString("ascii", 12, 16) !== PNG_IHDR_TYPE
  ) {
    throw new Error("native screenshot is not a supported PNG");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!positiveSafeInteger(width) || !positiveSafeInteger(height))
    throw new Error("native screenshot PNG dimensions are invalid");
  return Object.freeze({ width, height });
}

function jpegDimensions(
  bytes: Buffer,
): Readonly<{ width: number; height: number }> {
  if (
    bytes.length < 12 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    throw new Error("native zoom screenshot is not a supported JPEG");
  }
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  while (offset + 4 <= bytes.length - 2) {
    if (bytes[offset] !== 0xff)
      throw new Error("native zoom JPEG marker stream is malformed");
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length)
      throw new Error("native zoom JPEG segment is truncated");
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length)
      throw new Error("native zoom JPEG segment is malformed");
    if (startOfFrame.has(marker)) {
      if (length < 8) throw new Error("native zoom JPEG frame is malformed");
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (!positiveSafeInteger(width) || !positiveSafeInteger(height))
        throw new Error("native zoom JPEG dimensions are invalid");
      return Object.freeze({ width, height });
    }
    offset += length;
  }
  throw new Error("native zoom JPEG has no supported frame header");
}

/**
 * Select exactly one MCP image content block without retaining any text or
 * resource content that accompanied it.
 */
export function requireSingleCuaImageBlock(
  content: readonly unknown[],
): CuaImageBlock {
  if (!Array.isArray(content))
    throw new Error("native screenshot content is malformed");
  const images = content.filter(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).type === "image",
  );
  if (images.length !== 1)
    throw new Error("native screenshot must contain exactly one image block");
  const image = record(images[0], "native screenshot image block is malformed");
  if (
    Object.keys(image).some(
      (key) =>
        !["type", "data", "mimeType", "annotations", "_meta"].includes(key),
    ) ||
    image.type !== "image" ||
    typeof image.data !== "string" ||
    image.mimeType !== NATIVE_VISUAL_MIME_TYPE
  ) {
    throw new Error("native screenshot image block is malformed");
  }
  return Object.freeze({
    type: "image",
    data: image.data,
    mimeType: NATIVE_VISUAL_MIME_TYPE,
  });
}

/**
 * Validate Cua's structured window screenshot metadata against its MCP image
 * block. The returned image remains in memory only; no file path is accepted.
 */
export function validateCuaWindowScreenshot(
  responseValue: unknown,
  imageValue: unknown,
  limits: NativeVisualLimits = DEFAULT_NATIVE_VISUAL_LIMITS,
): NativeVisualCapture {
  validateLimits(limits);
  const response = record(
    responseValue,
    "native screenshot response is malformed",
  );
  const image = record(
    imageValue,
    "native screenshot image block is malformed",
  );
  if (
    image.type !== "image" ||
    typeof image.data !== "string" ||
    image.mimeType !== NATIVE_VISUAL_MIME_TYPE
  ) {
    throw new Error("native screenshot image block is malformed");
  }
  if (
    !positiveSafeInteger(response.pid) ||
    !positiveSafeInteger(response.window_id) ||
    response.screenshot_frame_valid !== true ||
    !positiveSafeInteger(response.screenshot_width) ||
    !positiveSafeInteger(response.screenshot_height) ||
    response.screenshot_mime_type !== NATIVE_VISUAL_MIME_TYPE ||
    (response.screenshot_file_path !== undefined &&
      response.screenshot_file_path !== null)
  ) {
    throw new Error("native screenshot metadata is malformed or untrusted");
  }

  const width = response.screenshot_width;
  const height = response.screenshot_height;
  if (
    width > limits.maxWidth ||
    height > limits.maxHeight ||
    width * height > limits.maxPixels
  ) {
    throw new Error("native screenshot dimensions exceed their bounds");
  }

  const bytes = parseCanonicalBase64(image.data, limits.maxBytes);
  const encoded = pngDimensions(bytes);
  if (encoded.width !== width || encoded.height !== height)
    throw new Error("native screenshot PNG and metadata dimensions disagree");

  const publicImage: CuaImageBlock = Object.freeze({
    type: "image",
    data: image.data,
    mimeType: NATIVE_VISUAL_MIME_TYPE,
  });
  return Object.freeze({
    pid: response.pid,
    windowId: response.window_id,
    width,
    height,
    byteLength: bytes.length,
    mimeType: NATIVE_VISUAL_MIME_TYPE,
    digest: createHash("sha256").update(bytes).digest("hex"),
    image: publicImage,
  });
}

/** Validate a Cua `zoom` JPEG against its structured dimensions. */
export function validateCuaZoomScreenshot(
  responseValue: unknown,
  imageValue: unknown,
  limits: NativeVisualLimits = DEFAULT_NATIVE_VISUAL_LIMITS,
): NativeVisualZoomCapture {
  validateLimits(limits);
  const response = record(responseValue, "native zoom response is malformed");
  const image = record(imageValue, "native zoom image block is malformed");
  if (
    response.format !== "jpeg" ||
    response.mime_type !== NATIVE_VISUAL_ZOOM_MIME_TYPE ||
    !positiveSafeInteger(response.width) ||
    !positiveSafeInteger(response.height) ||
    image.type !== "image" ||
    image.mimeType !== NATIVE_VISUAL_ZOOM_MIME_TYPE ||
    typeof image.data !== "string"
  ) {
    throw new Error("native zoom metadata or image block is malformed");
  }
  if (
    response.width > limits.maxWidth ||
    response.height > limits.maxHeight ||
    response.width * response.height > limits.maxPixels
  ) {
    throw new Error("native zoom dimensions exceed their bounds");
  }
  const bytes = parseCanonicalBase64(image.data, limits.maxBytes);
  const encoded = jpegDimensions(bytes);
  if (encoded.width !== response.width || encoded.height !== response.height)
    throw new Error("native zoom JPEG and metadata dimensions disagree");
  return Object.freeze({
    width: response.width,
    height: response.height,
    byteLength: bytes.length,
    mimeType: NATIVE_VISUAL_ZOOM_MIME_TYPE,
    digest: createHash("sha256").update(bytes).digest("hex"),
    image: Object.freeze({
      type: "image",
      data: image.data,
      mimeType: NATIVE_VISUAL_ZOOM_MIME_TYPE,
    }),
  });
}

export function bindNormalizedVisualPoint(
  capture: Pick<NativeVisualCapture, "digest" | "width" | "height">,
  point: NormalizedVisualPoint,
): NativeVisualPointBinding {
  if (
    !SHA256_PATTERN.test(capture.digest) ||
    !positiveSafeInteger(capture.width) ||
    !positiveSafeInteger(capture.height)
  ) {
    throw new Error("native visual capture identity is invalid");
  }
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.x > 1 ||
    point.y < 0 ||
    point.y > 1
  ) {
    throw new Error("native visual point must be normalized from zero to one");
  }
  return Object.freeze({
    captureDigest: capture.digest,
    width: capture.width,
    height: capture.height,
    xPx: Math.min(capture.width - 1, Math.floor(point.x * capture.width)),
    yPx: Math.min(capture.height - 1, Math.floor(point.y * capture.height)),
  });
}

/**
 * Produce public A1-H8 cell labels plus opaque refs. The normalized centers
 * remain captured by resolveCell and are absent from the serializable public
 * descriptor.
 */
export function createOpaqueVisualGrid(
  captureDigest: string,
  opaqueKey: Uint8Array,
): OpaqueVisualGrid {
  if (!SHA256_PATTERN.test(captureDigest))
    throw new Error("native visual grid capture digest is invalid");
  if (!(opaqueKey instanceof Uint8Array) || opaqueKey.byteLength < 16)
    throw new Error("native visual grid key is invalid");

  const bindings = new Map<string, NormalizedVisualPoint>();
  const cells: PublicVisualGridCell[] = [];
  for (let row = 0; row < NATIVE_VISUAL_GRID_SIDE; row += 1) {
    for (let column = 0; column < NATIVE_VISUAL_GRID_SIDE; column += 1) {
      const cellRef = `vcell_${createHmac("sha256", opaqueKey)
        .update("jev-cua:native-visual-grid:v1\0", "utf8")
        .update(captureDigest, "utf8")
        .update(Buffer.from([row, column]))
        .digest("base64url")
        .slice(0, 22)}`;
      const point = Object.freeze({
        x: (column + 0.5) / NATIVE_VISUAL_GRID_SIDE,
        y: (row + 0.5) / NATIVE_VISUAL_GRID_SIDE,
      });
      bindings.set(cellRef, point);
      cells.push(
        Object.freeze({
          cellRef,
          label: `${String.fromCharCode(65 + row)}${column + 1}`,
        }),
      );
    }
  }
  const descriptor: PublicVisualGridDescriptor = Object.freeze({
    rows: NATIVE_VISUAL_GRID_SIDE,
    columns: NATIVE_VISUAL_GRID_SIDE,
    cells: Object.freeze(cells),
  });
  return Object.freeze({
    descriptor,
    resolveCell: (cellRef: string): NormalizedVisualPoint => {
      const point = bindings.get(cellRef);
      if (!point)
        throw new Error("native visual grid cell reference is invalid");
      return point;
    },
  });
}

export function compareExactVisualFreshness(
  expected: Pick<
    NativeVisualCapture,
    "pid" | "windowId" | "width" | "height" | "mimeType" | "digest"
  >,
  recaptured: Pick<
    NativeVisualCapture,
    "pid" | "windowId" | "width" | "height" | "mimeType" | "digest"
  >,
): NativeVisualFreshnessComparison {
  const mismatches: NativeVisualFreshnessMismatch[] = [];
  if (
    expected.pid !== recaptured.pid ||
    expected.windowId !== recaptured.windowId
  )
    mismatches.push("target");
  if (expected.mimeType !== recaptured.mimeType) mismatches.push("mime_type");
  if (
    expected.width !== recaptured.width ||
    expected.height !== recaptured.height
  )
    mismatches.push("dimensions");
  if (expected.digest !== recaptured.digest) mismatches.push("digest");
  return Object.freeze({
    fresh: mismatches.length === 0,
    mismatches: Object.freeze(mismatches),
  });
}

export function assertExactVisualFreshness(
  expected: Parameters<typeof compareExactVisualFreshness>[0],
  recaptured: Parameters<typeof compareExactVisualFreshness>[1],
): void {
  const comparison = compareExactVisualFreshness(expected, recaptured);
  if (!comparison.fresh) {
    throw new Error(
      `native visual capture is stale (${comparison.mismatches.join(", ")})`,
    );
  }
}
