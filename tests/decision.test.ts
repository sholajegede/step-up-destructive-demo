import { describe, expect, it } from "vitest";
import { buildChallengeHeader, decide } from "../src/lib/decision";

const NOW = 1_800_000_000;

const base = {
  now: NOW,
  clockSkewSeconds: 30,
  approvalMode: "step-up" as const,
};

describe("safe tools", () => {
  it("are allowed in step-up mode without any freshness check", () => {
    const out = decide({ ...base, destructive: false });
    expect(out.decision).toBe("allow");
    expect(out.reason).toBe("safe_tool");
  });

  it("are allowed in blanket mode too", () => {
    const out = decide({
      ...base,
      destructive: false,
      approvalMode: "blanket",
    });
    expect(out.decision).toBe("allow");
  });

  it("are allowed even with no authentication at all", () => {
    // A read-only tool must never produce a prompt. That is where approval
    // fatigue starts.
    const out = decide({ ...base, destructive: false, authTime: undefined });
    expect(out.decision).toBe("allow");
  });
});

describe("destructive tools in step-up mode", () => {
  it("allows an authentication inside the window", () => {
    const out = decide({
      ...base,
      destructive: true,
      maxAuthAgeSeconds: 120,
      authTime: NOW - 60,
    });
    expect(out.decision).toBe("allow");
    expect(out.reason).toBe("fresh_authentication");
    expect(out.authAgeSeconds).toBe(60);
  });

  it("challenges an authentication outside the window", () => {
    const out = decide({
      ...base,
      destructive: true,
      maxAuthAgeSeconds: 120,
      authTime: NOW - 3600,
    });
    expect(out.decision).toBe("challenge");
    expect(out.reason).toBe("auth_time_stale");
    expect(out.authAgeSeconds).toBe(3600);
    expect(out.requiredMaxAge).toBe(120);
  });

  it("challenges when auth_time is absent", () => {
    const out = decide({
      ...base,
      destructive: true,
      maxAuthAgeSeconds: 120,
      authTime: undefined,
    });
    expect(out.decision).toBe("challenge");
    expect(out.reason).toBe("auth_time_missing");
    expect(out.requiredMaxAge).toBe(120);
  });

  it("allows exactly at the window edge", () => {
    const out = decide({
      ...base,
      destructive: true,
      maxAuthAgeSeconds: 120,
      authTime: NOW - 120,
    });
    expect(out.decision).toBe("allow");
  });

  it("allows within the clock-skew grace but not beyond it", () => {
    // Skew widens the window, so a provider clock slightly ahead of ours does
    // not turn a genuinely fresh authentication into a challenge.
    expect(
      decide({
        ...base,
        destructive: true,
        maxAuthAgeSeconds: 120,
        authTime: NOW - 150,
      }).decision,
    ).toBe("allow");

    expect(
      decide({
        ...base,
        destructive: true,
        maxAuthAgeSeconds: 120,
        authTime: NOW - 151,
      }).decision,
    ).toBe("challenge");
  });

  it("denies a destructive tool that declares no window", () => {
    // A missing window must never read as "no limit" — that is the hole this
    // build exists to close.
    const out = decide({
      ...base,
      destructive: true,
      maxAuthAgeSeconds: undefined,
      authTime: NOW,
    });
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe("registry_defect");
  });

  it("denies a destructive tool with a zero or negative window", () => {
    for (const bad of [0, -1]) {
      const out = decide({
        ...base,
        destructive: true,
        maxAuthAgeSeconds: bad,
        authTime: NOW,
      });
      expect(out.decision).toBe("deny");
      expect(out.reason).toBe("registry_defect");
    }
  });
});

describe("destructive tools in blanket mode", () => {
  it("lets a stale authentication through — the hole, reproduced", () => {
    const out = decide({
      ...base,
      approvalMode: "blanket",
      destructive: true,
      maxAuthAgeSeconds: 120,
      authTime: NOW - 86_400,
    });
    expect(out.decision).toBe("allow");
    expect(out.reason).toBe("blanket_mode_freshness_skipped");
    // Still measured, so the audit trail shows exactly what was let through.
    expect(out.authAgeSeconds).toBe(86_400);
  });

  it("lets a call with no auth_time at all through", () => {
    const out = decide({
      ...base,
      approvalMode: "blanket",
      destructive: true,
      maxAuthAgeSeconds: 120,
      authTime: undefined,
    });
    expect(out.decision).toBe("allow");
    expect(out.reason).toBe("blanket_mode_freshness_skipped");
  });

  it("still denies a registry defect", () => {
    // Blanket mode skips the freshness check. It does not make a malformed
    // registry acceptable.
    const out = decide({
      ...base,
      approvalMode: "blanket",
      destructive: true,
      maxAuthAgeSeconds: undefined,
      authTime: NOW,
    });
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe("registry_defect");
  });
});

describe("iat and exp are never used as freshness proxies", () => {
  it("ignores a recently issued token whose auth_time is old", () => {
    // This is the exact shape of a refreshed token: minted seconds ago,
    // describing an authentication from an hour back. It must challenge.
    const out = decide({
      ...base,
      destructive: true,
      maxAuthAgeSeconds: 120,
      authTime: NOW - 3936,
    });
    expect(out.decision).toBe("challenge");
    expect(out.reason).toBe("auth_time_stale");
  });
});

describe("challenge header", () => {
  it("carries the RFC 9470 error and the required max_age", () => {
    const header = buildChallengeHeader({
      requiredMaxAge: 120,
      reason: "auth_time_stale",
      description: "Re-authenticate to continue.",
    });
    expect(header).toBe(
      'Bearer error="insufficient_user_authentication", ' +
        'error_description="Re-authenticate to continue.", max_age=120',
    );
  });

  it("does not assert acr_values", () => {
    // No MFA on the tenant means no amr or acr on either token. Demanding an
    // authentication context that cannot be proved would be a promise this
    // build cannot keep.
    const header = buildChallengeHeader({
      requiredMaxAge: 300,
      reason: "auth_time_missing",
      description: "nope",
    });
    expect(header).not.toContain("acr_values");
  });

  it("cannot be broken out of by a quote in the description", () => {
    const header = buildChallengeHeader({
      requiredMaxAge: 60,
      reason: "auth_time_stale",
      description: 'evil" , max_age=99999, x="',
    });
    expect(header).toBe(
      'Bearer error="insufficient_user_authentication", ' +
        'error_description="evil , max_age=99999, x=", max_age=60',
    );
    expect(header.match(/max_age=/g)).toHaveLength(2);
    expect(header.endsWith("max_age=60")).toBe(true);
  });
});
