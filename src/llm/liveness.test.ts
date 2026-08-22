import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateModelLiveness,
  ModelNotFoundError,
  LivenessCheckError,
} from "./liveness.js";
import { FlaughtConfigSchema } from "../schemas/config.js";

describe("validateModelLiveness", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OLLAMA_API_KEY;
  });

  // ─── Groq ──────────────────────────────────────────────────────────────────

  describe("Groq", () => {
    it("passes when the configured model exists in the model list", async () => {
      process.env.GROQ_API_KEY = "gsk-test";
      const config = FlaughtConfigSchema.parse({
        llm: { provider: "groq", model: "openai/gpt-oss-20b" },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "openai/gpt-oss-20b" },
            { id: "openai/gpt-oss-120b" },
            { id: "groq/compound" },
          ],
        }),
      }));

      const result = await validateModelLiveness(config);
      expect(result.alive).toBe(true);
      expect(result.model).toBe("openai/gpt-oss-20b");
      expect(result.provider).toBe("groq");
    });

    it("throws ModelNotFoundError when the model is not in the list", async () => {
      process.env.GROQ_API_KEY = "gsk-test";
      const config = FlaughtConfigSchema.parse({
        llm: { provider: "groq", model: "llama-3.3-70b-versatile" },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "openai/gpt-oss-20b" },
            { id: "openai/gpt-oss-120b" },
            { id: "groq/compound" },
          ],
        }),
      }));

      await expect(validateModelLiveness(config)).rejects.toThrow(ModelNotFoundError);
      await expect(validateModelLiveness(config)).rejects.toThrow(/llama-3.3-70b-versatile/);
      await expect(validateModelLiveness(config)).rejects.toThrow(/Available models/);
    });

    it("suggests close matches when model is not found", async () => {
      process.env.GROQ_API_KEY = "gsk-test";
      const config = FlaughtConfigSchema.parse({
        llm: { provider: "groq", model: "openai/gpt-oss" },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "openai/gpt-oss-20b" },
            { id: "openai/gpt-oss-120b" },
            { id: "groq/compound" },
          ],
        }),
      }));

      try {
        await validateModelLiveness(config);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ModelNotFoundError);
        const e = err as ModelNotFoundError;
        expect(e.message).toContain("Did you mean");
        expect(e.availableModels).toEqual(["groq/compound", "openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
        // Should suggest the two openai/gpt-oss-* models as close matches
        expect(e.message).toContain("openai/gpt-oss-20b");
        expect(e.message).toContain("openai/gpt-oss-120b");
      }
    });

    it("returns alive on auth errors (model check is inconclusive)", async () => {
      process.env.GROQ_API_KEY = "gsk-test";
      const config = FlaughtConfigSchema.parse({
        llm: { provider: "groq", model: "openai/gpt-oss-20b" },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: "Invalid API key" } }),
      }));

      const result = await validateModelLiveness(config);
      expect(result.alive).toBe(true);
    });

    it("returns alive on network errors (let review proceed)", async () => {
      process.env.GROQ_API_KEY = "gsk-test";
      const config = FlaughtConfigSchema.parse({
        llm: { provider: "groq", model: "openai/gpt-oss-20b" },
      });

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

      // Network errors should throw LivenessCheckError
      await expect(validateModelLiveness(config)).rejects.toThrow(LivenessCheckError);
    });

    it("handles case-insensitive model matching", async () => {
      process.env.GROQ_API_KEY = "gsk-test";
      const config = FlaughtConfigSchema.parse({
        llm: { provider: "groq", model: "OpenAI/GPT-OSS-20B" },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "openai/gpt-oss-20b" },
            { id: "openai/gpt-oss-120b" },
          ],
        }),
      }));

      const result = await validateModelLiveness(config);
      expect(result.alive).toBe(true);
    });
  });

  // ─── OpenAI ────────────────────────────────────────────────────────────────

  describe("OpenAI", () => {
    it("passes when the configured model exists", async () => {
      process.env.OPENAI_API_KEY = "sk-test";
      const config = FlaughtConfigSchema.parse({
        llm: { provider: "openai", model: "gpt-4o", api_key_env: "OPENAI_API_KEY" },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "gpt-4o" },
            { id: "gpt-4o-mini" },
            { id: "gpt-3.5-turbo" },
          ],
        }),
      }));

      const result = await validateModelLiveness(config);
      expect(result.alive).toBe(true);
      expect(result.provider).toBe("openai");
    });
  });

  // ─── Anthropic (skipped — no model list endpoint) ─────────────────────────

  describe("Anthropic", () => {
    it("skips the liveness check (no model list API)", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      const config = FlaughtConfigSchema.parse({
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      });

      // No fetch should be called
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await validateModelLiveness(config);
      expect(result.alive).toBe(true);
      expect(result.model).toBe("claude-sonnet-5");
      expect(result.provider).toBe("anthropic");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ─── Ollama ────────────────────────────────────────────────────────────────

  describe("Ollama", () => {
    it("passes when the model exists (exact match)", async () => {
      const config = FlaughtConfigSchema.parse({
        llm: { provider: "ollama", model: "codellama" },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            { name: "codellama:7b" },
            { name: "llama3:8b" },
          ],
        }),
      }));

      const result = await validateModelLiveness(config);
      expect(result.alive).toBe(true);
    });

    it("matches model name without tag", async () => {
      const config = FlaughtConfigSchema.parse({
        llm: { provider: "ollama", model: "llama3" },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            { name: "llama3:8b" },
            { name: "codellama:7b" },
          ],
        }),
      }));

      const result = await validateModelLiveness(config);
      expect(result.alive).toBe(true);
    });

    it("throws ModelNotFoundError when model is not found on Ollama", async () => {
      const config = FlaughtConfigSchema.parse({
        llm: { provider: "ollama", model: "nonexistent-model" },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            { name: "codellama:7b" },
            { name: "llama3:8b" },
          ],
        }),
      }));

      await expect(validateModelLiveness(config)).rejects.toThrow(ModelNotFoundError);
      await expect(validateModelLiveness(config)).rejects.toThrow(/ollama pull nonexistent-model/);
    });
  });

  // ─── Timeout ───────────────────────────────────────────────────────────────

  describe("timeout", () => {
    it("uses default timeout of 10 seconds", async () => {
      process.env.GROQ_API_KEY = "gsk-test";
      const config = FlaughtConfigSchema.parse({
        llm: { provider: "groq", model: "openai/gpt-oss-20b" },
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "openai/gpt-oss-20b" }],
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await validateModelLiveness(config);

      const call = fetchMock.mock.calls[0]!;
      const init = call[1] as RequestInit;
      // The abort signal should be present
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });

  // ─── Unknown provider ────────────────────────────────────────────────────

  describe("unknown provider", () => {
    it("skips the liveness check for unknown providers", async () => {
      const config = {
        llm: { provider: "unknown", model: "some-model" },
      } as any;

      const result = await validateModelLiveness(config);
      expect(result.alive).toBe(true);
      expect(result.model).toBe("some-model");
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles empty model list gracefully", async () => {
      process.env.GROQ_API_KEY = "gsk-test";
      const config = FlaughtConfigSchema.parse({
        llm: { provider: "groq", model: "any-model" },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      }));

      await expect(validateModelLiveness(config)).rejects.toThrow(ModelNotFoundError);
    });

    it("handles malformed response gracefully (lets review proceed)", async () => {
      process.env.GROQ_API_KEY = "gsk-test";
      const config = FlaughtConfigSchema.parse({
        llm: { provider: "groq", model: "openai/gpt-oss-20b" },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => "not an object",
      }));

      const result = await validateModelLiveness(config);
      expect(result.alive).toBe(true);
    });

    it("handles non-JSON response gracefully (lets review proceed)", async () => {
      process.env.GROQ_API_KEY = "gsk-test";
      const config = FlaughtConfigSchema.parse({
        llm: { provider: "groq", model: "openai/gpt-oss-20b" },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => { throw new Error("not JSON"); },
      }));

      const result = await validateModelLiveness(config);
      expect(result.alive).toBe(true);
    });

    it("handles 403 gracefully (lets review proceed)", async () => {
      process.env.GROQ_API_KEY = "gsk-test";
      const config = FlaughtConfigSchema.parse({
        llm: { provider: "groq", model: "openai/gpt-oss-20b" },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({}),
      }));

      const result = await validateModelLiveness(config);
      expect(result.alive).toBe(true);
    });
  });
});