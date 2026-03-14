/**
 * Model pricing table for cost estimation.
 * Prices are in USD per million tokens.
 * When costUsd is not provided by OpenClaw (e.g. no models.providers config),
 * we estimate cost from token counts using this table.
 */

export interface ModelPricing {
  input: number;      // $ per 1M input tokens
  output: number;     // $ per 1M output tokens
  cacheRead: number;  // $ per 1M cache-read tokens
  cacheWrite: number; // $ per 1M cache-write tokens
}

// Anthropic models
const ANTHROPIC_OPUS_4: ModelPricing = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const ANTHROPIC_SONNET_4: ModelPricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const ANTHROPIC_HAIKU_4: ModelPricing = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
const ANTHROPIC_HAIKU_3: ModelPricing = { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 };

// OpenAI models
const OPENAI_GPT4O: ModelPricing = { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 };
const OPENAI_GPT4O_MINI: ModelPricing = { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 };
const OPENAI_O1: ModelPricing = { input: 15, output: 60, cacheRead: 7.5, cacheWrite: 15 };
const OPENAI_O1_MINI: ModelPricing = { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 };
const OPENAI_O3: ModelPricing = { input: 2, output: 8, cacheRead: 1, cacheWrite: 2 };
const OPENAI_O3_MINI: ModelPricing = { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 };
const OPENAI_O4_MINI: ModelPricing = { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 };
const OPENAI_GPT41: ModelPricing = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 };
const OPENAI_GPT41_MINI: ModelPricing = { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 };
const OPENAI_GPT41_NANO: ModelPricing = { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 };

// Google models
const GOOGLE_GEMINI_25_PRO: ModelPricing = { input: 1.25, output: 10, cacheRead: 0.315, cacheWrite: 1.25 };
const GOOGLE_GEMINI_25_FLASH: ModelPricing = { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0.15 };
const GOOGLE_GEMINI_20_PRO: ModelPricing = { input: 1.25, output: 10, cacheRead: 0.315, cacheWrite: 1.25 };
const GOOGLE_GEMINI_20_FLASH: ModelPricing = { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 };

/**
 * Pricing lookup table. Keys are model identifiers as they appear in spans.
 * We match both full "provider/model" and bare model names.
 */
const PRICING_TABLE: Record<string, ModelPricing> = {
  // Anthropic — full provider/model format
  "anthropic/claude-opus-4-6": ANTHROPIC_OPUS_4,
  "anthropic/claude-opus-4-5": ANTHROPIC_OPUS_4,
  "anthropic/claude-opus-4": ANTHROPIC_OPUS_4,
  "anthropic/claude-sonnet-4-6": ANTHROPIC_SONNET_4,
  "anthropic/claude-sonnet-4-5": ANTHROPIC_SONNET_4,
  "anthropic/claude-sonnet-4": ANTHROPIC_SONNET_4,
  "anthropic/claude-haiku-4-5": ANTHROPIC_HAIKU_4,
  "anthropic/claude-haiku-4": ANTHROPIC_HAIKU_4,
  "anthropic/claude-haiku-3-5": ANTHROPIC_HAIKU_4,  // same tier
  "anthropic/claude-3-haiku-20240307": ANTHROPIC_HAIKU_3,

  // Anthropic — bare model names (as seen in some diagnostic events)
  "claude-opus-4-6": ANTHROPIC_OPUS_4,
  "claude-opus-4-5": ANTHROPIC_OPUS_4,
  "claude-opus-4": ANTHROPIC_OPUS_4,
  "claude-sonnet-4-6": ANTHROPIC_SONNET_4,
  "claude-sonnet-4-5": ANTHROPIC_SONNET_4,
  "claude-sonnet-4": ANTHROPIC_SONNET_4,
  "claude-haiku-4-5": ANTHROPIC_HAIKU_4,
  "claude-haiku-4": ANTHROPIC_HAIKU_4,
  "claude-haiku-3-5": ANTHROPIC_HAIKU_4,
  "claude-3-haiku-20240307": ANTHROPIC_HAIKU_3,

  // Anthropic — with date suffixes
  "anthropic/claude-opus-4-6-20250610": ANTHROPIC_OPUS_4,
  "anthropic/claude-opus-4-5-20250220": ANTHROPIC_OPUS_4,
  "anthropic/claude-sonnet-4-6-20250610": ANTHROPIC_SONNET_4,
  "anthropic/claude-sonnet-4-5-20250514": ANTHROPIC_SONNET_4,
  "anthropic/claude-haiku-4-5-20250514": ANTHROPIC_HAIKU_4,
  "claude-opus-4-6-20250610": ANTHROPIC_OPUS_4,
  "claude-opus-4-5-20250220": ANTHROPIC_OPUS_4,
  "claude-sonnet-4-6-20250610": ANTHROPIC_SONNET_4,
  "claude-sonnet-4-5-20250514": ANTHROPIC_SONNET_4,
  "claude-haiku-4-5-20250514": ANTHROPIC_HAIKU_4,

  // OpenAI — full provider/model format
  "openai/gpt-4o": OPENAI_GPT4O,
  "openai/gpt-4o-2024-11-20": OPENAI_GPT4O,
  "openai/gpt-4o-mini": OPENAI_GPT4O_MINI,
  "openai/o1": OPENAI_O1,
  "openai/o1-mini": OPENAI_O1_MINI,
  "openai/o3": OPENAI_O3,
  "openai/o3-mini": OPENAI_O3_MINI,
  "openai/o4-mini": OPENAI_O4_MINI,
  "openai/gpt-4.1": OPENAI_GPT41,
  "openai/gpt-4.1-mini": OPENAI_GPT41_MINI,
  "openai/gpt-4.1-nano": OPENAI_GPT41_NANO,

  // OpenAI — bare model names
  "gpt-4o": OPENAI_GPT4O,
  "gpt-4o-2024-11-20": OPENAI_GPT4O,
  "gpt-4o-mini": OPENAI_GPT4O_MINI,
  "o1": OPENAI_O1,
  "o1-mini": OPENAI_O1_MINI,
  "o3": OPENAI_O3,
  "o3-mini": OPENAI_O3_MINI,
  "o4-mini": OPENAI_O4_MINI,
  "gpt-4.1": OPENAI_GPT41,
  "gpt-4.1-mini": OPENAI_GPT41_MINI,
  "gpt-4.1-nano": OPENAI_GPT41_NANO,

  // Google — full provider/model format
  "google/gemini-2.5-pro": GOOGLE_GEMINI_25_PRO,
  "google/gemini-2.5-pro-preview-06-05": GOOGLE_GEMINI_25_PRO,
  "google/gemini-2.5-flash": GOOGLE_GEMINI_25_FLASH,
  "google/gemini-2.5-flash-preview-05-20": GOOGLE_GEMINI_25_FLASH,
  "google/gemini-2.0-pro": GOOGLE_GEMINI_20_PRO,
  "google/gemini-2.0-flash": GOOGLE_GEMINI_20_FLASH,

  // Google — bare model names
  "gemini-2.5-pro": GOOGLE_GEMINI_25_PRO,
  "gemini-2.5-pro-preview-06-05": GOOGLE_GEMINI_25_PRO,
  "gemini-2.5-flash": GOOGLE_GEMINI_25_FLASH,
  "gemini-2.5-flash-preview-05-20": GOOGLE_GEMINI_25_FLASH,
  "gemini-2.0-pro": GOOGLE_GEMINI_20_PRO,
  "gemini-2.0-flash": GOOGLE_GEMINI_20_FLASH,
};

/**
 * Look up pricing for a model. Tries exact match first,
 * then strips date suffixes for fuzzy matching.
 */
export function lookupPricing(model: string | null | undefined): ModelPricing | null {
  if (!model) return null;

  const normalized = model.trim().toLowerCase();

  // Exact match
  const exact = PRICING_TABLE[normalized];
  if (exact) return exact;

  // Try stripping date suffix (e.g. "claude-sonnet-4-5-20250514" -> "claude-sonnet-4-5")
  const dateStripped = normalized.replace(/-\d{8}$/, "");
  if (dateStripped !== normalized) {
    const match = PRICING_TABLE[dateStripped];
    if (match) return match;
  }

  // Try prefix matching for versioned models (e.g. "gemini-2.5-pro-exp-0827")
  for (const [key, pricing] of Object.entries(PRICING_TABLE)) {
    if (normalized.startsWith(key) || key.startsWith(normalized)) {
      return pricing;
    }
  }

  return null;
}

/**
 * Estimate cost in USD from token counts and model name.
 * Returns null if pricing is unknown for the model.
 */
export function estimateCost(params: {
  model: string | null | undefined;
  tokensIn: number | null | undefined;
  tokensOut: number | null | undefined;
  cacheRead?: number | null;
  cacheWrite?: number | null;
}): number | null {
  const pricing = lookupPricing(params.model);
  if (!pricing) return null;

  const input = params.tokensIn ?? 0;
  const output = params.tokensOut ?? 0;
  const cacheRead = params.cacheRead ?? 0;
  const cacheWrite = params.cacheWrite ?? 0;

  const cost =
    (input * pricing.input +
      output * pricing.output +
      cacheRead * pricing.cacheRead +
      cacheWrite * pricing.cacheWrite) /
    1_000_000;

  return Number.isFinite(cost) ? cost : null;
}
