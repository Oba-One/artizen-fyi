export type Row = Record<string, unknown>;

export type Constraint = { key: string; constraint_type: string; value?: unknown };

export type BubbleResponse = {
  results?: Row[];
  remaining?: number;
};

export type DriveStat = {
  sales: number;
  venus: number;
  match: number;
  prize?: number;
  bonus?: number;
  sprint?: number;
  raised: number;
  available?: number;
};

export type Season = {
  id: string;
  number: number;
  title: string;
  tag: unknown;
  current: boolean;
  total_raised?: number;
  competition_start: unknown;
  competition_end: unknown;
};

export type PodiumRow = {
  name: string;
  url: string;
  sales_match: number;
  points: number;
  score: number;
  bonus?: number;
};

export type Drive = {
  id: string;
  name: string;
  url: string;
  season_id: unknown;
  season_number?: number | null;
  season?: string | null;
  image?: string | null;
  description?: string | null;
  status: unknown;
  active: boolean;
  number?: number | null;
  start: unknown;
  end: unknown;
  multiple?: number | null;
  match_pot?: number | null;
  prize_projects?: number | null;
  prize_funds?: number | null;
  bonus_projects?: number | null;
  bonus_funds?: number | null;
  goal?: number | null;
  match_per_project?: number | null;
  project_first?: number | null;
  project_second?: number | null;
  project_third?: number | null;
  fund_first?: number | null;
  fund_second?: number | null;
  fund_third?: number | null;
  podium?: PodiumRow[];
  fund_podium?: PodiumRow[];
};

export type ProjectRow = {
  name: string;
  url: string;
  creator?: string;
  logline?: string;
  sales: number;
  venus: number;
  match: number;
  prize: number;
  bonus?: number;
  sprint?: number;
  raised: number;
};

export type FundRow = {
  name: string;
  subtitle?: string;
  url: string;
  season_total: number;
  last_contribution: unknown;
  created_at?: unknown;
  active: unknown;
  unlocked?: number;
  available?: number;
  raised?: number;
};

export type DetailPreview = {
  name: string;
  lead?: string;
  created_at?: unknown;
};

export type Leaderboard = {
  seasons: Season[];
  season: Season | null;
  drives: Drive[];
  projects: ProjectRow[];
  funds: FundRow[];
  error: boolean;
};

export type MatchingFund = {
  name: string;
  url: string;
  drive?: string | null;
  drive_active?: boolean | null;
  drive_number?: number | null;
  drive_multiple?: number | null;
  season?: string | null;
  season_number?: number | null;
  available: number;
  unlocked: number;
  cap: number;
};

export type ProjectDriveDetail = DriveStat & {
  name: string;
  status: unknown;
  active?: boolean | null;
  number?: number | null;
  url?: string | null;
  multiple?: number | null;
  season?: string | null;
  season_id: unknown;
  season_number?: number | null;
  funds?: MatchingFund[];
};

export type ProjectFundingSeason = {
  number?: number | null;
  title: string;
  sales: number;
  venus: number;
  match: number;
  prize: number;
  bonus?: number;
  sprint?: number;
  raised: number;
  available?: number;
  drives?: ProjectDriveDetail[];
};

export type ProjectSubmission = {
  name: string;
  url: string;
  status?: string;
  season?: string | null;
  season_number?: number | null;
  created_at: unknown;
};

export type ProjectSibling = {
  name: string;
  url: string;
  logline?: string;
  funds: { name: string; url: string }[];
};

export type ProjectSiblingFund = {
  name: string;
  url: string;
  available?: number;
  siblings: { name: string; url: string }[];
};

export type ProjectPage = {
  id: string;
  slug: string;
  name: string;
  artizen_url: string;
  creator?: string;
  logline?: string;
  image?: string | null;
  tags: string[];
  seasons: ProjectFundingSeason[];
  submissions: ProjectSubmission[];
  siblings: ProjectSibling[];
  sibling_funds: ProjectSiblingFund[];
};

export type FundMatchedProject = {
  name: string;
  url: string;
  creator?: string | null;
  hidden?: unknown;
  drive?: string | null;
  drive_url?: string | null;
  drive_active?: boolean | null;
  drive_number?: number | null;
  drive_multiple?: number | null;
  season?: string | null;
  season_number?: number | null;
  available: number;
  unlocked: number;
};

export type FundDriveNest = {
  name: string;
  url?: string | null;
  active?: boolean | null;
  adjustment?: boolean;
  number?: number | null;
  multiple?: number | null;
  unlocked: number;
  available: number;
  projects: FundMatchedProject[];
};

export type FundFundingSeason = {
  number?: number | null;
  title: string;
  total: number;
  count: number;
  unlocked?: number;
  available?: number;
  drives?: FundDriveNest[];
};

export type FundPage = {
  name: string;
  artizen_url: string;
  image?: string | null;
  subtitle?: string;
  for_title?: string;
  sponsor?: string;
  created_at?: unknown;
  available: number;
  unlocked: number;
  prize_art?: number;
  prize_usd?: number;
  active: unknown;
  contrib_total: number;
  seasons: FundFundingSeason[];
};

export type MatchRelationshipKind = 'submitted' | 'curated' | 'funded';

export type MatchFit = 'strong' | 'good' | 'exploratory' | 'limited';

export type MatchReason = {
  kind:
    | 'content'
    | 'tag'
    | 'facet'
    | 'core-concept'
    | 'semantic'
    | 'similar-project'
    | 'relationship'
    | 'limited-evidence';
  label: string;
};

export type ProjectMatchInput = {
  projectId?: string;
  title?: string;
  description: string;
  tags: string[];
};

export type ProjectProfile = {
  id: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
};

export type FundProfile = {
  id: string;
  slug: string;
  name: string;
  subtitle?: string;
  forTitle?: string;
  active: boolean;
  available?: number;
  themes: string[];
  derivedThemes: string[];
  aliases: string[];
  preferredTerms: string[];
  excludedTerms: string[];
};

export type ProjectFundRelationship = {
  projectId: string;
  fundId: string;
  kind: MatchRelationshipKind;
  seasonNumber?: number;
  createdAt?: string;
};

export type ScoringConfig = {
  contentWeight: number;
  tagWeight: number;
  graphWeight: number;
  directRelationshipShare: number;
  similarProjectLimit: number;
  fundHistoryLimit: number;
};

export type MatchIndexV1 = {
  schemaVersion: 1;
  indexVersion: string;
  generatedAt: string;
  projects: ProjectProfile[];
  funds: FundProfile[];
  relationships: ProjectFundRelationship[];
  scoring: ScoringConfig;
};

export type FundRecommendation = {
  fundId: string;
  score: number;
  fit: MatchFit;
  reasons: MatchReason[];
  knownRelationship?: MatchRelationshipKind;
  active: boolean;
  available?: number;
};

export type SemanticReranker = {
  rerank(
    input: ProjectMatchInput,
    candidates: FundRecommendation[],
    index: MatchIndexV1,
  ): Promise<FundRecommendation[]>;
};

export type MatchIndexSource = {
  kind: 'artizen-api' | 'fixture';
  projects: number;
  funds: number;
  relationships: number;
};

export type MatchFacetCategory = 'domain' | 'medium' | 'approach' | 'audience' | 'place';

export type MatchFacet = {
  id: string;
  label: string;
  category: MatchFacetCategory;
};

/**
 * A project's fund history, as compact tuples rather than full relationship rows.
 *
 * Only the fund and the kind are read at match time; season and creation date exist to dedupe at
 * build time. Carrying the pair per project instead of a flat table of every project's rows is
 * what lets the browser download one project's history rather than all 9,000.
 */
export type ProjectHistory = Array<[fundId: string, kind: MatchRelationshipKind]>;

export type ProjectProfileV2 = ProjectProfile & {
  facets: string[];
  image?: string;
  history?: ProjectHistory;
};

export type FundProfileV2 = Omit<FundProfile, 'derivedThemes'> & {
  profileText: string;
  profileHash: string;
  facets: string[];
  focusFacets: string[];
  coreConcepts: string[];
  image?: string;
};

export type ScoreBreakdown = {
  lexical: number;
  facets: number;
  coreCoverage: number;
  semantic?: number;
};

export type ScoringConfigV2 = {
  version: string;
  lexicalWeight: number;
  facetWeight: number;
  coreCoverageWeight: number;
  semanticWeight: number;
  semanticFacetWeight: number;
  semanticCoreCoverageWeight: number;
  semanticLexicalWeight: number;
  strongThreshold: number;
  goodThreshold: number;
  exploratoryThreshold: number;
  unsupportedFocusPenalty: number;
};

export type SemanticCatalogManifest = {
  modelId: 'mixedbread-ai/mxbai-embed-xsmall-v1';
  modelRevision: string;
  dtype: 'q8';
  dimensions: 256;
  weightsBytes: number;
  modelPath: string;
  wasmPath: string;
  vectorsUrl: string;
  /** Embeddings for every catalog project, so selecting one needs no model at all. */
  projectVectorsUrl: string;
  vectorVersion: string;
};

export type MatchIndexV2 = {
  schemaVersion: 2;
  indexVersion: string;
  generatedAt: string;
  source: MatchIndexSource;
  taxonomyVersion: string;
  facets: MatchFacet[];
  projects: ProjectProfileV2[];
  funds: FundProfileV2[];
  relationships: ProjectFundRelationship[];
  scoring: ScoringConfigV2;
  semantic?: SemanticCatalogManifest;
};

export type FundRecommendationV2 = FundRecommendation & {
  breakdown: ScoreBreakdown;
  supportedFocus: boolean;
};

export type MatchResultV2 = {
  sufficient: boolean;
  recommendations: FundRecommendationV2[];
  mode: 'baseline' | 'semantic';
};

export type SemanticScorer = {
  load(onProgress: (progress: number) => void): Promise<void>;
  score(input: ProjectMatchInput, fundIds: string[]): Promise<Map<string, number>>;
  dispose(): void;
};

export type BoostHolder = {
  rank: number;
  name: string;
  image?: string | null;
  points: number;
  share: number;
  cumulative: number;
  admin: boolean;
};

export type BoostBucket = {
  label: string;
  users: number;
  points: number;
};

export type BoostsPage = {
  remaining: number;
  accounts: number;
  holders: number;
  zero: number;
  mean: number;
  median: number;
  admin: number;
  community: number;
  top_points: number;
  top_share: number;
  updated_at: string;
  buckets: BoostBucket[];
  top: BoostHolder[];
  error: boolean;
};
