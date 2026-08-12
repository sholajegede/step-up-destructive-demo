import { describe, expect, it } from "vitest";
import { parseMaxAge, parsePrompt, safeReturnTo } from "../src/lib/auth-params";

describe("parseMaxAge", () => {
  it("accepts zero, which demands an interactive authentication now", () => {
    expect(parseMaxAge("0")).toBe(0);
  });

  it("accepts a plain positive integer", () => {
    expect(parseMaxAge("120")).toBe(120);
  });

  it("drops anything that is not a whole, in-range number", () => {
    for (const bad of ["-1", "1.5", "abc", "", "1e9", "999999", "Infinity"]) {
      expect(parseMaxAge(bad), `expected "${bad}" to be dropped`).toBeUndefined();
    }
  });

  it("drops a missing value rather than inventing one", () => {
    expect(parseMaxAge(null)).toBeUndefined();
  });
});

describe("parsePrompt", () => {
  it("accepts only the values the provider understands", () => {
    expect(parsePrompt("login")).toBe("login");
    expect(parsePrompt("none")).toBe("none");
    expect(parsePrompt("consent")).toBe("consent");
  });

  it("drops anything else", () => {
    for (const bad of ["LOGIN", "select_account", "", "../login", null]) {
      expect(parsePrompt(bad)).toBeUndefined();
    }
  });
});

describe("safeReturnTo", () => {
  it("keeps a same-origin path", () => {
    expect(safeReturnTo("/auth-probe")).toBe("/auth-probe");
    expect(safeReturnTo("/runs/abc?tab=audit")).toBe("/runs/abc?tab=audit");
  });

  it("refuses anything that could leave the origin", () => {
    for (const hostile of [
      "//evil.example",
      "https://evil.example",
      "http://evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "evil.example",
    ]) {
      expect(safeReturnTo(hostile), `expected "${hostile}" to be refused`).toBe(
        "/",
      );
    }
  });

  it("falls back to the root when nothing is given", () => {
    expect(safeReturnTo(null)).toBe("/");
  });
});
