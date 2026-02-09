import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { stateManager } from "../state.js";

describe("State Manager Security - Path Traversal Prevention", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-security-test-"));
    await stateManager.init(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("savePlan() path traversal", () => {
    it("rejects ticketId with ..", async () => {
      await expect(
        stateManager.savePlan(testDir, "../etc/passwd", "malicious")
      ).rejects.toThrow(/Invalid ticket ID.*Path traversal not allowed/);
    });

    it("rejects ticketId with forward slash", async () => {
      await expect(
        stateManager.savePlan(testDir, "foo/bar", "content")
      ).rejects.toThrow(/Invalid ticket ID.*Path traversal not allowed/);
    });

    it("rejects ticketId with backslash", async () => {
      await expect(
        stateManager.savePlan(testDir, "foo\\bar", "content")
      ).rejects.toThrow(/Invalid ticket ID.*Path traversal not allowed/);
    });

    it("rejects ticketId with null byte", async () => {
      await expect(
        stateManager.savePlan(testDir, "foo\x00bar", "content")
      ).rejects.toThrow(/Invalid ticket ID.*Only alphanumeric/);
    });

    it("allows valid alphanumeric ticketId", async () => {
      await expect(
        stateManager.savePlan(testDir, "TICKET-123", "plan content")
      ).resolves.toBeDefined();
    });

    it("allows ticketId with hyphens and underscores", async () => {
      await expect(
        stateManager.savePlan(testDir, "TICKET_ABC-123", "plan content")
      ).resolves.toBeDefined();
    });
  });

  describe("loadPlan() path traversal", () => {
    it("rejects ticketId with ..", async () => {
      await expect(
        stateManager.loadPlan(testDir, "../../etc/passwd")
      ).rejects.toThrow(/Invalid ticket ID.*Path traversal not allowed/);
    });

    it("rejects ticketId with slash", async () => {
      await expect(
        stateManager.loadPlan(testDir, "foo/bar")
      ).rejects.toThrow(/Invalid ticket ID/);
    });
  });

  describe("saveSession() path traversal", () => {
    it("rejects ticketId with ..", async () => {
      await expect(
        stateManager.saveSession(testDir, "../../../tmp/evil", "session123")
      ).rejects.toThrow(/Invalid ticket ID.*Path traversal not allowed/);
    });

    it("allows valid ticketId", async () => {
      await expect(
        stateManager.saveSession(testDir, "VALID-TICKET", "session123")
      ).resolves.toBeUndefined();
    });
  });

  describe("loadSession() path traversal", () => {
    it("rejects ticketId with ..", async () => {
      await expect(
        stateManager.loadSession(testDir, "../../root/.ssh/id_rsa")
      ).rejects.toThrow(/Invalid ticket ID.*Path traversal not allowed/);
    });
  });
});
