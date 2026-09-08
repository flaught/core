import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sanitizedSpawnEnv } from "./env.js";

describe("sanitizedSpawnEnv", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Snapshot env vars we mutate so tests are hermetic.
    for (const k of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "MY_API_KEY",
      "FOO_TOKEN",
      "SOME_SECRET",
      "DB_PASSWORD",
      "PATH",
      "HOME",
      "LANG",
      "CI",
      "INNOCENT_VAR",
    ]) {
      saved[k] = process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("drops well-known CI/LLM/cloud secret names", () => {
    process.env.GITHUB_TOKEN = "ghp_abc";
    process.env.GH_TOKEN = "ghp_def";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.NPM_TOKEN = "npm_ghi";

    const env = sanitizedSpawnEnv();

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
  });

  it("drops variables whose name contains a secret-y substring", () => {
    process.env.MY_API_KEY = "k";
    process.env.FOO_TOKEN = "t";
    process.env.SOME_SECRET = "s";
    process.env.DB_PASSWORD = "p";
    process.env.STRIPE_PRIVATE_KEY = "pk";

    const env = sanitizedSpawnEnv();

    expect(env.MY_API_KEY).toBeUndefined();
    expect(env.FOO_TOKEN).toBeUndefined();
    expect(env.SOME_SECRET).toBeUndefined();
    expect(env.DB_PASSWORD).toBeUndefined();
    expect(env.STRIPE_PRIVATE_KEY).toBeUndefined();
  });

  it("preserves non-secret variables the spawned tool needs", () => {
    process.env.PATH = "/usr/bin:/bin";
    process.env.HOME = "/home/user";
    process.env.LANG = "en_US.UTF-8";
    process.env.CI = "true";
    process.env.INNOCENT_VAR = "ok";

    const env = sanitizedSpawnEnv();

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.CI).toBe("true");
    expect(env.INNOCENT_VAR).toBe("ok");
  });

  it("returns a copy (mutating it does not affect process.env)", () => {
    process.env.INNOCENT_VAR = "v";
    const env = sanitizedSpawnEnv();
    env.INNOCENT_VAR = "changed";
    expect(process.env.INNOCENT_VAR).toBe("v");
  });

  it("honors extraAllow to keep an otherwise-stripped secret", () => {
    process.env.GITHUB_TOKEN = "ghp_abc";
    const env = sanitizedSpawnEnv(new Set(["GITHUB_TOKEN"]));
    expect(env.GITHUB_TOKEN).toBe("ghp_abc");
  });
});