import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { manifest } from "../src/manifest";

describe("manifest permissions", () => {
  it("requests only tabCapture and no host permissions", () => {
    expect(manifest.permissions).toEqual(["tabCapture"]);
    expect(manifest.host_permissions).toEqual([]);
  });

  const built = resolve(__dirname, "../dist/chrome-mv3/manifest.json");
  it.runIf(existsSync(built))("built manifest stays minimal", () => {
    const m = JSON.parse(readFileSync(built, "utf8"));
    expect(m.manifest_version).toBe(3);
    expect(m.permissions ?? []).toEqual(["tabCapture"]);
    expect(m.host_permissions ?? []).toEqual([]);
    expect(m.content_scripts).toBeUndefined();
  });
});
