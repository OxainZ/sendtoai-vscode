export interface CostEstimate {
  haiku: string;
  sonnet: string;
  opus: string;
  haikuRaw: number;
}

// Anthropic list prices, USD per million INPUT tokens (Oct 2026):
// Haiku 5.5 $0.10 (prompts over 100K tokens: $0.50), Sonnet 5.5 $2, Opus 5.5 $4.
// Only the input side is estimated — the reply you get back costs extra.
const PRICE_PER_M = { haiku: 0.10, haikuLong: 0.50, sonnet: 2.0, opus: 4.0 };
const HAIKU_LONG_PROMPT_TOKENS = 100_000;

function fmt(tokens: number, pricePerM: number): string {
  const cost = (tokens / 1_000_000) * pricePerM;
  if (cost < 0.001) { return '<$0.001'; }
  return `$${cost.toFixed(3)}`;
}

export function estimateCost(tokens: number): CostEstimate {
  const haikuPrice = tokens > HAIKU_LONG_PROMPT_TOKENS ? PRICE_PER_M.haikuLong : PRICE_PER_M.haiku;
  return {
    haiku:    fmt(tokens, haikuPrice),
    sonnet:   fmt(tokens, PRICE_PER_M.sonnet),
    opus:     fmt(tokens, PRICE_PER_M.opus),
    haikuRaw: (tokens / 1_000_000) * haikuPrice,
  };
}
