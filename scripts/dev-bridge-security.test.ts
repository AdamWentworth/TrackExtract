import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPathWithin, isTrustedDevRequest, parseByteRange } from "./dev-bridge-security";

describe("development bridge security", () => {
  it("accepts same-origin and non-browser calls but rejects cross-origin browsers", () => {
    expect(isTrustedDevRequest({ headers: { host: "localhost:1420", origin: "http://localhost:1420" } })).toBe(true);
    expect(isTrustedDevRequest({ headers: { host: "localhost:1420" } })).toBe(true);
    expect(isTrustedDevRequest({ headers: { host: "localhost:1420", origin: "https://attacker.example" } })).toBe(
      false,
    );
    expect(isTrustedDevRequest({ headers: { host: "localhost:1420", "sec-fetch-site": "cross-site" } })).toBe(false);
  });

  it("contains paths by components rather than string prefixes", () => {
    const root = path.resolve("project-root");
    expect(isPathWithin(path.join(root, "Song", "stems", "Vocals.wav"), root)).toBe(true);
    expect(isPathWithin(path.resolve("project-root-escape", "Vocals.wav"), root)).toBe(false);
    expect(isPathWithin(root, root)).toBe(false);
  });

  it("parses valid byte ranges and rejects empty suffix ranges", () => {
    expect(parseByteRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
    expect(parseByteRange("bytes=-25", 100)).toEqual({ start: 75, end: 99 });
    expect(() => parseByteRange("bytes=-0", 100)).toThrow("not satisfiable");
  });
});
