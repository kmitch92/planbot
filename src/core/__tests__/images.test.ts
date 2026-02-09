import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  isSupportedImageFormat,
  resolveAndValidateImages,
  copyImageToAssets,
  buildImagePromptSection,
} from "../images.js";

vi.mock("../../utils/logger.js");

describe("isSupportedImageFormat", () => {
  it("returns true for supported extensions", () => {
    expect(isSupportedImageFormat("photo.png")).toBe(true);
    expect(isSupportedImageFormat("photo.jpg")).toBe(true);
    expect(isSupportedImageFormat("photo.jpeg")).toBe(true);
    expect(isSupportedImageFormat("photo.gif")).toBe(true);
    expect(isSupportedImageFormat("photo.webp")).toBe(true);
    expect(isSupportedImageFormat("photo.svg")).toBe(true);
    expect(isSupportedImageFormat("photo.bmp")).toBe(true);
    expect(isSupportedImageFormat("photo.tiff")).toBe(true);
  });

  it("returns true for uppercase extensions", () => {
    expect(isSupportedImageFormat("PHOTO.PNG")).toBe(true);
    expect(isSupportedImageFormat("photo.JPG")).toBe(true);
  });

  it("returns false for unsupported extensions", () => {
    expect(isSupportedImageFormat("document.pdf")).toBe(false);
    expect(isSupportedImageFormat("script.js")).toBe(false);
    expect(isSupportedImageFormat("data.json")).toBe(false);
    expect(isSupportedImageFormat("archive.zip")).toBe(false);
  });

  it("returns false for files without extension", () => {
    expect(isSupportedImageFormat("noextension")).toBe(false);
  });

  it("handles paths with directories", () => {
    expect(isSupportedImageFormat("/path/to/image.png")).toBe(true);
    expect(isSupportedImageFormat(".planbot/assets/ticket/shot.jpg")).toBe(true);
  });
});

describe("resolveAndValidateImages", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-images-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("resolves existing image files to absolute paths", async () => {
    await writeFile(join(testDir, "screenshot.png"), "fake-image-data");

    const result = await resolveAndValidateImages(testDir, ["screenshot.png"]);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]).toBe(join(testDir, "screenshot.png"));
    expect(result.warnings).toHaveLength(0);
  });

  it("adds warnings for missing images", async () => {
    const result = await resolveAndValidateImages(testDir, ["nonexistent.png"]);

    expect(result.resolved).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Image not found");
    expect(result.warnings[0]).toContain("nonexistent.png");
  });

  it("handles mix of existing and missing files", async () => {
    await writeFile(join(testDir, "exists.png"), "data");

    const result = await resolveAndValidateImages(testDir, [
      "exists.png",
      "missing.jpg",
    ]);

    expect(result.resolved).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });

  it("returns empty arrays for empty input", async () => {
    const result = await resolveAndValidateImages(testDir, []);

    expect(result.resolved).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("copyImageToAssets", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-copy-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("copies image to .planbot/assets/<ticketId>/ and returns relative path", async () => {
    const sourcePath = join(testDir, "source.png");
    await writeFile(sourcePath, "image-data");

    const relativePath = await copyImageToAssets(testDir, "ticket-1", sourcePath);

    expect(relativePath).toBe(join(".planbot", "assets", "ticket-1", "source.png"));

    const destPath = join(testDir, relativePath);
    const content = await readFile(destPath, "utf-8");
    expect(content).toBe("image-data");
  });

  it("throws for non-existent source file", async () => {
    await expect(
      copyImageToAssets(testDir, "ticket-1", join(testDir, "nonexistent.png"))
    ).rejects.toThrow("Source image does not exist");
  });

  it("throws for unsupported file format", async () => {
    const sourcePath = join(testDir, "doc.pdf");
    await writeFile(sourcePath, "pdf-data");

    await expect(
      copyImageToAssets(testDir, "ticket-1", sourcePath)
    ).rejects.toThrow("Unsupported image format");
  });

  it("creates destination directory if it does not exist", async () => {
    const sourcePath = join(testDir, "photo.jpg");
    await writeFile(sourcePath, "jpg-data");

    const relativePath = await copyImageToAssets(testDir, "new-ticket", sourcePath);
    const destPath = join(testDir, relativePath);
    const content = await readFile(destPath, "utf-8");
    expect(content).toBe("jpg-data");
  });
});

describe("buildImagePromptSection", () => {
  it("returns empty string when no paths and no warnings", () => {
    expect(buildImagePromptSection([], [])).toBe("");
  });

  it("builds section with image paths", () => {
    const result = buildImagePromptSection(
      ["/abs/path/img1.png", "/abs/path/img2.jpg"],
      []
    );

    expect(result).toContain("## Attached Images");
    expect(result).toContain("Read tool");
    expect(result).toContain("- /abs/path/img1.png");
    expect(result).toContain("- /abs/path/img2.jpg");
    expect(result).not.toContain("Warnings");
  });

  it("builds section with warnings only", () => {
    const result = buildImagePromptSection([], ["Image not found: missing.png"]);

    expect(result).toContain("## Attached Images");
    expect(result).toContain("No valid images found");
    expect(result).toContain("**Warnings:**");
    expect(result).toContain("- Image not found: missing.png");
  });

  it("builds section with both paths and warnings", () => {
    const result = buildImagePromptSection(
      ["/path/to/found.png"],
      ["Image not found: missing.png"]
    );

    expect(result).toContain("## Attached Images");
    expect(result).toContain("- /path/to/found.png");
    expect(result).toContain("**Warnings:**");
    expect(result).toContain("- Image not found: missing.png");
    expect(result).not.toContain("No valid images found");
  });
});
