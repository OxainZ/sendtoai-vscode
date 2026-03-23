export interface CostEstimate {
  haiku: string;
  sonnet: string;
  opus: string;
  haikuRaw: number;
}

const PRICE_PER_M = { haiku: 1.0, sonnet: 3.0, opus: 5.0 };

function fmt(tokens: number, pricePerM: number): string {
  const cost = (tokens / 1_000_000) * pricePerM;
  if (cost < 0.001) { return '<$0.001'; }
  return `$${cost.toFixed(3)}`;
}

export function estimateCost(tokens: number): CostEstimate {
  return {
    haiku:    fmt(tokens, PRICE_PER_M.haiku),
    sonnet:   fmt(tokens, PRICE_PER_M.sonnet),
    opus:     fmt(tokens, PRICE_PER_M.opus),
    haikuRaw: (tokens / 1_000_000) * PRICE_PER_M.haiku,
  };
}
