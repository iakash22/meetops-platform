import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { manifest } from "../src/manifest";

const EXPECTED = ["offscreen", "storage", "tabCapture"];

describe("manifest permissions", () => {
  it("requests only tabCapture, offscreen, storage and no host permissions", () => {
    expect([...manifest.permissions].sort()).toEqual(EXPECTED);
    expect(manifest.host_permissions).toEqual([]);
  });

  const built = resolve(__dirname, "../dist/chrome-mv3/manifest.json");
  it.runIf(existsSync(built))("built manifest stays minimal", () => {
    const m = JSON.parse(readFileSync(built, "utf8"));
    expect(m.manifest_version).toBe(3);
    expect([...(m.permissions ?? [])].sort()).toEqual(EXPECTED);
    expect(m.host_permissions ?? []).toEqual([]);
    expect(m.content_scripts).toBeUndefined();
    expect(m.optional_permissions).toBeUndefined();
  });
});
