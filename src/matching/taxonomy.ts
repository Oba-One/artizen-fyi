import type { MatchFacet, MatchFacetCategory } from '../artizen/types';
import { normalizeTerms } from './engine';

type FacetDefinition = MatchFacet & {
  aliases: string[];
  narrow?: boolean;
};

export const MATCH_TAXONOMY_VERSION = '2026-08-23.1';

const facet = (
  id: string,
  label: string,
  category: MatchFacetCategory,
  aliases: string[],
  narrow = false,
): FacetDefinition => ({ id, label, category, aliases, narrow });

export const MATCH_FACET_DEFINITIONS: FacetDefinition[] = [
  facet('domain:arts-media', 'Arts and media', 'domain', ['art', 'artist', 'visual art', 'creative media', 'creator']),
  facet('medium:film-storytelling', 'Film and storytelling', 'medium', ['film', 'cinema', 'documentary', 'storytelling', 'storyteller', 'screenwriter'], true),
  facet('medium:music-performance', 'Music and performance', 'medium', ['music', 'musician', 'sound art', 'performance', 'dance', 'theater', 'theatre', 'dj'], true),
  facet('domain:science-research', 'Science and research', 'domain', ['science', 'scientific', 'scientific research', 'desci', 'biology', 'biotech', 'laboratory', 'citizen science'], true),
  facet('domain:ai-technology', 'AI and technology', 'domain', ['artificial intelligence', 'machine learning', 'ai', 'robot', 'robotics', 'software', 'technology', 'developer', 'coding'], true),
  facet('domain:open-infrastructure', 'Open infrastructure', 'domain', ['open source', 'open-source', 'infrastructure', 'protocol', 'internet', 'network layer', 'privacy preserving', 'peer to peer'], true),
  facet('domain:climate-ecology', 'Climate and ecology', 'domain', ['climate', 'ecology', 'ecological', 'environment', 'environmental', 'biodiversity', 'conservation', 'restoration']),
  facet('domain:marine-ocean', 'Marine and ocean', 'domain', ['ocean', 'marine', 'sea', 'reef', 'coral', 'coastal', 'aquatic'], true),
  facet('domain:agriculture-land', 'Agriculture and land', 'domain', ['agriculture', 'agroforestry', 'farm', 'farming', 'food forest', 'land stewardship', 'permaculture', 'soil', 'seed'], true),
  facet('domain:education', 'Education and learning', 'domain', ['education', 'educational', 'learning', 'school', 'teaching', 'curriculum', 'training']),
  facet('domain:health-wellness', 'Health and wellness', 'domain', ['health', 'wellness', 'mental health', 'healing', 'care', 'neurodivergent', 'neurotech'], true),
  facet('domain:community-economy', 'Community and shared economy', 'domain', ['community', 'local action', 'cooperative', 'collective', 'solidarity economy', 'social economy', 'mutual aid']),
  facet('domain:culture-identity', 'Culture and identity', 'domain', ['culture', 'cultural', 'heritage', 'ancestral', 'identity', 'language preservation']),
  facet('approach:public-goods', 'Public goods', 'approach', ['public good', 'public goods', 'commons', 'shared benefit']),
  facet('approach:regenerative', 'Regenerative practice', 'approach', ['regenerative', 'regeneration', 'refi', 'solarpunk', 'greenpill']),
  facet('approach:decentralized', 'Decentralized coordination', 'approach', ['decentralized', 'decentralised', 'web3', 'blockchain', 'dao', 'onchain']),
  facet('audience:women', 'Women creators', 'audience', ['women', 'woman', 'female-led'], true),
  facet('audience:queer', 'Queer creators', 'audience', ['queer', 'lgbt', 'lgbtq'], true),
  facet('audience:indigenous', 'Indigenous and First Nations', 'audience', ['indigenous', 'first nations', 'native creators'], true),
  facet('audience:youth', 'Young people', 'audience', ['youth', 'young people', 'children', 'childhood', 'students']),
  facet('audience:african', 'African creators', 'audience', ['african creators', 'africa-based', 'across africa'], true),
  facet('audience:latin', 'Latin American creators', 'audience', ['latin american', 'latam', 'latin storytellers'], true),
  facet('place:africa', 'Africa', 'place', ['africa', 'african', 'nigeria', 'ghana', 'kenya', 'uganda'], true),
  facet('place:latin-america', 'Latin America', 'place', ['latin america', 'latam', 'mexico', 'brazil', 'argentina', 'colombia'], true),
];

export const MATCH_FACETS: MatchFacet[] = MATCH_FACET_DEFINITIONS.map(({ id, label, category }) => ({
  id,
  label,
  category,
}));

const FACETS_BY_ID = new Map(MATCH_FACET_DEFINITIONS.map((definition) => [definition.id, definition]));

function containsAlias(textTerms: string[], alias: string): boolean {
  const aliasTerms = normalizeTerms(alias);
  if (aliasTerms.length === 0) return false;
  if (aliasTerms.length === 1) return textTerms.includes(aliasTerms[0]);
  const haystack = ` ${textTerms.join(' ')} `;
  return haystack.includes(` ${aliasTerms.join(' ')} `);
}

export function extractFacetIds(...values: Array<string | undefined>): string[] {
  const terms = values.flatMap((value) => normalizeTerms(value || ''));
  if (terms.length === 0) return [];
  return MATCH_FACET_DEFINITIONS.filter((definition) =>
    definition.aliases.some((alias) => containsAlias(terms, alias)),
  )
    .map((definition) => definition.id)
    .sort((a, b) => a.localeCompare(b));
}

export function extractFundFocusFacetIds(...values: Array<string | undefined>): string[] {
  const found = new Set(extractFacetIds(...values));
  return [...found]
    .filter((id) => FACETS_BY_ID.get(id)?.narrow)
    .sort((a, b) => a.localeCompare(b));
}

export function facetLabel(id: string): string {
  return FACETS_BY_ID.get(id)?.label || id;
}

export function facetCategory(id: string): MatchFacetCategory | undefined {
  return FACETS_BY_ID.get(id)?.category;
}

export function isNarrowFacet(id: string): boolean {
  return FACETS_BY_ID.get(id)?.narrow === true;
}

const GENERIC_CONCEPTS = new Set([
  'action',
  'art',
  'artist',
  'build',
  'builder',
  'community',
  'creat',
  'creative',
  'creator',
  'culture',
  'future',
  'fund',
  'funding',
  'help',
  'human',
  'impact',
  'initiative',
  'innovation',
  'local',
  'new',
  'open',
  'people',
  'public',
  'research',
  'researcher',
  'seek',
  'support',
  'supporting',
  'technology',
  'world',
]);

export function conceptCandidates(...values: Array<string | undefined>): string[] {
  const terms = values
    .flatMap((value) => normalizeTerms(value || ''))
    .filter((term) => term.length > 2 && !GENERIC_CONCEPTS.has(term));
  const concepts = new Set<string>(terms);
  for (let index = 0; index < terms.length - 1; index += 1) {
    const left = terms[index];
    const right = terms[index + 1];
    if (!GENERIC_CONCEPTS.has(left) && !GENERIC_CONCEPTS.has(right)) concepts.add(`${left} ${right}`);
  }
  return [...concepts];
}
