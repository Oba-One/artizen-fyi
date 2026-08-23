export type FundProfileOverride = {
  themes?: string[];
  aliases?: string[];
  preferredTerms?: string[];
  excludedTerms?: string[];
  facets?: string[];
  focusFacets?: string[];
  excludedFacets?: string[];
  excludedCoreConcepts?: string[];
};

// Keep editorial corrections small and evidence-based. Keys are Artizen fund slugs.
// These values improve alignment language only; they must not imply eligibility.
export const FUND_PROFILE_OVERRIDES: Record<string, FundProfileOverride> = {};
