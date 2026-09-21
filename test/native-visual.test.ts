import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertExactVisualFreshness,
  bindNormalizedVisualPoint,
  compareExactVisualFreshness,
  createOpaqueVisualGrid,
  requireSingleCuaImageBlock,
  validateCuaWindowScreenshot,
  validateCuaZoomScreenshot,
  type NativeVisualCapture,
} from "../src/native/visual.js";

function png(width: number, height: number, suffix = "fixture"): Buffer {
  const bytes = Buffer.alloc(24 + Buffer.byteLength(suffix));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.write(suffix, 24, "utf8");
  return bytes;
}

function response(width = 640, height = 480) {
  return {
    pid: 123,
    window_id: 456,
    screenshot_frame_valid: true,
    screenshot_width: width,
    screenshot_height: height,
    screenshot_mime_type: "image/png",
    screenshot_file_path: null,
  };
}

function image(width = 640, height = 480, suffix = "fixture") {
  return {
    type: "image",
    mimeType: "image/png",
    data: png(width, height, suffix).toString("base64"),
  };
}

function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
}

test("validates an in-memory Cua window PNG and computes its exact digest", () => {
  const bytes = png(640, 480);
  const capture = validateCuaWindowScreenshot(response(), {
    type: "image",
    mimeType: "image/png",
    data: bytes.toString("base64"),
  });

  assert.deepEqual(capture, {
    pid: 123,
    windowId: 456,
    width: 640,
    height: 480,
    byteLength: bytes.length,
    mimeType: "image/png",
    digest: createHash("sha256").update(bytes).digest("hex"),
    image: {
      type: "image",
      mimeType: "image/png",
      data: bytes.toString("base64"),
    },
  });
  assert.equal("bytes" in capture, false);
  assert.equal("filePath" in capture, false);
});

test("validates an in-memory Cua zoom JPEG and exact dimensions", () => {
  const bytes = jpeg(276, 489);
  const capture = validateCuaZoomScreenshot(
    { format: "jpeg", mime_type: "image/jpeg", width: 276, height: 489 },
    { type: "image", mimeType: "image/jpeg", data: bytes.toString("base64") },
  );
  assert.equal(capture.width, 276);
  assert.equal(capture.height, 489);
  assert.equal(
    capture.digest,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.throws(
    () =>
      validateCuaZoomScreenshot(
        { format: "jpeg", mime_type: "image/jpeg", width: 277, height: 489 },
        {
          type: "image",
          mimeType: "image/jpeg",
          data: bytes.toString("base64"),
        },
      ),
    /dimensions disagree/u,
  );
});

test("selects exactly one PNG image block without copying other content", () => {
  const selected = requireSingleCuaImageBlock([
    { type: "text", text: "ignored diagnostic" },
    image(),
  ]);
  assert.equal(selected.type, "image");
  assert.equal(selected.mimeType, "image/png");
  assert.throws(
    () => requireSingleCuaImageBlock([{ type: "text", text: "none" }]),
    /exactly one image/u,
  );
  assert.throws(
    () => requireSingleCuaImageBlock([image(), image()]),
    /exactly one image/u,
  );
  assert.throws(
    () => requireSingleCuaImageBlock([{ ...image(), mimeType: "image/jpeg" }]),
    /malformed/u,
  );
});

test("rejects untrusted, mismatched, file-backed, and oversized screenshots", () => {
  assert.throws(
    () =>
      validateCuaWindowScreenshot(
        { ...response(), screenshot_frame_valid: false },
        image(),
      ),
    /metadata/u,
  );
  assert.throws(
    () =>
      validateCuaWindowScreenshot(
        { ...response(), screenshot_file_path: "/tmp/private.png" },
        image(),
      ),
    /metadata/u,
  );
  assert.throws(
    () => validateCuaWindowScreenshot(response(), image(641, 480)),
    /dimensions disagree/u,
  );
  assert.throws(
    () =>
      validateCuaWindowScreenshot(response(), {
        ...image(),
        mimeType: "image/jpeg",
      }),
    /image block/u,
  );
  assert.throws(
    () =>
      validateCuaWindowScreenshot(response(), {
        type: "image",
        mimeType: "image/png",
        data: "not base64",
      }),
    /base64/u,
  );
  assert.throws(
    () =>
      validateCuaWindowScreenshot(response(), image(), {
        maxBytes: 8,
        maxWidth: 640,
        maxHeight: 480,
        maxPixels: 640 * 480,
      }),
    /base64/u,
  );
  assert.throws(
    () =>
      validateCuaWindowScreenshot(response(), image(), {
        maxBytes: 1_024,
        maxWidth: 639,
        maxHeight: 480,
        maxPixels: 640 * 480,
      }),
    /dimensions exceed/u,
  );
  const corrupt = png(640, 480);
  corrupt[0] = 0;
  assert.throws(
    () =>
      validateCuaWindowScreenshot(response(), {
        type: "image",
        mimeType: "image/png",
        data: corrupt.toString("base64"),
      }),
    /supported PNG/u,
  );
});

test("binds normalized points to bounded screenshot pixels", () => {
  const capture = validateCuaWindowScreenshot(response(4, 3), image(4, 3));
  assert.deepEqual(bindNormalizedVisualPoint(capture, { x: 0, y: 0 }), {
    captureDigest: capture.digest,
    width: 4,
    height: 3,
    xPx: 0,
    yPx: 0,
  });
  assert.deepEqual(bindNormalizedVisualPoint(capture, { x: 1, y: 1 }), {
    captureDigest: capture.digest,
    width: 4,
    height: 3,
    xPx: 3,
    yPx: 2,
  });
  assert.deepEqual(bindNormalizedVisualPoint(capture, { x: 0.75, y: 0.5 }), {
    captureDigest: capture.digest,
    width: 4,
    height: 3,
    xPx: 3,
    yPx: 1,
  });
  for (const point of [
    { x: -0.01, y: 0 },
    { x: 1.01, y: 0 },
    { x: 0, y: Number.NaN },
    { x: Number.POSITIVE_INFINITY, y: 0 },
  ]) {
    assert.throws(
      () => bindNormalizedVisualPoint(capture, point),
      /normalized/u,
    );
  }
});

test("creates an opaque 8x8 public grid whose coordinates stay private", () => {
  const digest = createHash("sha256").update("capture").digest("hex");
  const grid = createOpaqueVisualGrid(digest, Buffer.alloc(32, 7));
  assert.equal(grid.descriptor.rows, 8);
  assert.equal(grid.descriptor.columns, 8);
  assert.equal(grid.descriptor.cells.length, 64);
  assert.equal(
    new Set(grid.descriptor.cells.map((cell) => cell.cellRef)).size,
    64,
  );
  assert.deepEqual(
    [grid.descriptor.cells[0]?.label, grid.descriptor.cells.at(-1)?.label],
    ["A1", "H8"],
  );
  assert.match(grid.descriptor.cells[0]!.cellRef, /^vcell_[A-Za-z0-9_-]{22}$/u);

  for (const cell of grid.descriptor.cells) {
    assert.deepEqual(Object.keys(cell).sort(), ["cellRef", "label"]);
  }
  assert.equal(JSON.stringify(grid.descriptor).includes(digest), false);
  assert.deepEqual(grid.resolveCell(grid.descriptor.cells[0]!.cellRef), {
    x: 1 / 16,
    y: 1 / 16,
  });
  assert.deepEqual(grid.resolveCell(grid.descriptor.cells.at(-1)!.cellRef), {
    x: 15 / 16,
    y: 15 / 16,
  });
  assert.throws(() => grid.resolveCell("vcell_unknown"), /invalid/u);

  const repeated = createOpaqueVisualGrid(digest, Buffer.alloc(32, 7));
  assert.deepEqual(repeated.descriptor, grid.descriptor);
  const other = createOpaqueVisualGrid(
    createHash("sha256").update("other capture").digest("hex"),
    Buffer.alloc(32, 7),
  );
  assert.notEqual(
    other.descriptor.cells[0]!.cellRef,
    grid.descriptor.cells[0]!.cellRef,
  );
});

test("compares exact target, MIME, dimensions, and capture digest freshness", () => {
  const original = validateCuaWindowScreenshot(response(), image());
  const identical = validateCuaWindowScreenshot(response(), image());
  assert.deepEqual(compareExactVisualFreshness(original, identical), {
    fresh: true,
    mismatches: [],
  });
  assert.doesNotThrow(() => assertExactVisualFreshness(original, identical));

  const changed = {
    ...identical,
    pid: 999,
    mimeType: "image/jpeg",
    width: 639,
    digest: createHash("sha256").update("changed").digest("hex"),
  } as unknown as NativeVisualCapture;
  assert.deepEqual(compareExactVisualFreshness(original, changed), {
    fresh: false,
    mismatches: ["target", "mime_type", "dimensions", "digest"],
  });
  assert.throws(
    () => assertExactVisualFreshness(original, changed),
    /target, mime_type, dimensions, digest/u,
  );
});
