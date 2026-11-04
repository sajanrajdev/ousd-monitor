// Fixed anchors on the methodology page, so parallel units agree on every definition link.
export const DEFINITION_ANCHORS = [
  "verdict",
  "minted-burned",
  "issuer-inventory",
  "venue-supply",
  "placed-supply",
  "free-floating",
  "circulating-supply",
  "headline-volume",
  "clean-volume",
  "everyday-large",
  "venue-flow",
  "tempo-fee",
  "velocity",
  "active-wallets",
  "concentration",
  "implied-reserve-income",
  "chain-roles",
  "reconciliation",
  "known-limits",
  "source-legend",
  "named-labels",
  "unnamed-clusters",
  "fact-estimate-opinion",
] as const;

export type DefinitionAnchor = (typeof DEFINITION_ANCHORS)[number];

// With the trailing slash, as a static host serves this page there.
export function definitionHref(anchor: DefinitionAnchor): string {
  return `/methodology/#${anchor}`;
}

export const REQUIRED_CHAINS = ["tempo", "ethereum", "base", "solana"] as const;

export const CHAIN_NAMES: Record<(typeof REQUIRED_CHAINS)[number], string> = {
  tempo: "Tempo",
  ethereum: "Ethereum",
  base: "Base",
  solana: "Solana",
};

// OUSD's first day. All-chain flows run from here.
export const DAY_ZERO = "2026-09-30";

// The documented defaults. A dataset built with anything else isn't release grade.
export const DEFAULT_DEFINITIONS = {
  placed_days: 14,
  placed_min_base_units: "1000000000000",
  large_transfer_base_units: "1000000000000",
  active_dust_base_units: "1000000",
  active_secondary_base_units: "100000000",
  clean_tx_min_base_units: "1000000",
  journey_first_day: "2026-10-14",
  velocity: {
    velocity_bps: { numerator: "clean_7d / 7", denominator: "circulating_supply" },
    velocity_everyday_bps: {
      numerator: "clean_everyday_7d / 7",
      denominator: "circulating_supply",
    },
    headline_velocity_bps: { numerator: "headline_7d / 7", denominator: "total_supply" },
  },
} as const;

// The seven blocking checks, with the site's own label. A check's `detail` is never reader copy.
export const CHECK_LABELS = {
  chain_supply: "Each chain's mints minus burns equal its reported supply",
  cross_chain_supply: "Supply across chains agrees with the issuer's reported total",
  sampled_balances: "Sampled wallet balances match the chain",
  dbt_tests: "The data model's tests pass",
  volume_waterfall: "Volume parts add up to headline volume",
  reconciliation_gate: "A full reconciliation run passed",
  freshness: "Every chain's data is recent",
} as const;

export type CheckName = keyof typeof CHECK_LABELS;

// The only wallet-shaped strings a page may show, and only on the methodology page.
export const TOKEN_CONTRACTS = {
  tempo: "0x20c0000000000000000000006a37da5c996874be",
  ethereum: "0x9f6f3991d525015a6f8caf062c83b62fd3ac4436",
  base: "0xb2000000000000000000002feb517dfec7415344",
  solana: "ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB",
} as const;
