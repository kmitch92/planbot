import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";

describe("YAML Security - Safe Parsing", () => {
  it("rejects YAML with custom tags", () => {
    const maliciousYaml = `
exploit: !!python/object
  module: os
  class: system
  args: ["rm -rf /"]
`;

    expect(() => parseYaml(maliciousYaml)).toThrow();
  });

  it("rejects YAML with JavaScript-specific tags", () => {
    const maliciousYaml = `
exploit: !!js/function >
  function() { return process.env; }
`;

    expect(() => parseYaml(maliciousYaml)).toThrow();
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
