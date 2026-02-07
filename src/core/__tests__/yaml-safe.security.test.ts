import { describe, it, expect } from "vitest";
import { parse as parseYaml, parseDocument } from "yaml";

describe("YAML Security - Safe Parsing", () => {
  it("rejects YAML with custom tags", () => {
    const maliciousYaml = `
exploit: !!python/object
  module: os
  class: system
  args: ["rm -rf /"]
`;

    const doc = parseDocument(maliciousYaml);
    const tagWarnings = doc.warnings.filter(
      (w) => w.code === "TAG_RESOLVE_FAILED"
    );

    expect(tagWarnings.length).toBeGreaterThan(0);
    expect(tagWarnings[0].message).toContain("python/object");
  });

  it("rejects YAML with JavaScript-specific tags", () => {
    const maliciousYaml = `
exploit: !!js/function >
  function() { return process.env; }
`;

    const doc = parseDocument(maliciousYaml);
    const tagWarnings = doc.warnings.filter(
      (w) => w.code === "TAG_RESOLVE_FAILED"
    );

    expect(tagWarnings.length).toBeGreaterThan(0);
    expect(tagWarnings[0].message).toContain("js/function");
  });

  it("accepts valid YAML without custom tags", () => {
    const validYaml = `
title: Deploy API
steps:
  - name: Build
    command: npm run build
  - name: Test
    command: npm test
config:
  timeout: 30
  retries: 3
  enabled: true
tags:
  - deployment
  - production
`;

    const doc = parseDocument(validYaml);

    expect(doc.warnings).toHaveLength(0);
    expect(doc.errors).toHaveLength(0);

    const result = parseYaml(validYaml);

    expect(result).toEqual({
      title: "Deploy API",
      steps: [
        { name: "Build", command: "npm run build" },
        { name: "Test", command: "npm test" },
      ],
      config: {
        timeout: 30,
        retries: 3,
        enabled: true,
      },
      tags: ["deployment", "production"],
    });
  });
});
