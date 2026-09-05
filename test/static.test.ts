import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveDashboardFile } from "../src/static.ts";

const sibling = join(import.meta.dir, "..", "public-escape-fixture");

afterEach(() => rmSync(sibling, { recursive: true, force: true }));

describe("static dashboard serving", () => {
  test("rejects a sibling path whose name shares the public prefix", async () => {
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "secret.txt"), "must-not-escape");

    const response = await serveDashboardFile("../public-escape-fixture/secret.txt");

    expect(response).toBeNull();
  });

  test("directory without an index file is not reported as a static success", () => {
    expect(serveDashboardFile("/assets/")).toBeNull();
  });

  test("serves the dashboard index with its content type", async () => {
    const response = await serveDashboardFile("/");

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response?.text()).toContain("Fast 9Router");
  });
});
