import type { Leaderboard } from '../artizen';
import { funding, usd, type Funded } from '../format';
import { escapeHtml, layout, namedLink, panel } from './layout';

type ArchetypeId = 'sparkler' | 'multiplier' | 'closer';

type Archetype = {
  id: ArchetypeId;
  name: string;
  formula: string;
  goal: string;
  lead: string;
  body: string[];
  moves: string[];
};

const ARCHETYPES: Archetype[] = [
  {
    id: 'sparkler',
    name: 'The Best Friend',
    formula: 'V/S',
    goal: 'Maximise contributions from Venus',
    lead: 'Get Venus to buy your Artifacts. You do not need a huge fanbase — you need to be in the game with her.',
    body: [
      'On this board, Sales is community Artifact buys only; Venus’s own purchases are peeled off. So V/S asks how much the house put in, per fan dollar.',
      'Venus, Artizen’s AI cofounder, buys Artifacts when you play quests in the grow app. Fund a Friend mirrors your buys on other creators, dollar for dollar, up to $10,000. Match Quests such as Sunday Funday add extra Venus buys on fresh collector sales — those land in V, not in the Match column. Sprints and raffles pay the podium as Artifact purchases; some of those show up as Venus extras, which still sit in V.',
    ],
    moves: [
      'Play Fund a Friend, Back the Backers, and First Believer while they are live. Generosity comes back as Venus sales.',
      'Race Sprints and sit raffles. Podium prizes land as real buys on your project.',
      'Your own buys on your own project do not trigger Match Quests. Back other people.',
    ],
  },
  {
    id: 'multiplier',
    name: 'The Multiplier',
    formula: 'M/S',
    goal: 'Maximise match funding',
    lead: 'Stack Funds, then sell just enough to unlock the match. Extra sales past the cap are just sales.',
    body: [
      'Every Fund that curates you adds available match. The Endowment gives every approved project a baseline pool, so you are never at zero. Each $1 of sales — and each $1 of Venus — unlocks match at that week’s Match Multiple, until the cap runs dry.',
      'A 3× week turns $1 into $4 raised from one pool. Two Funds and the Endowment stack. High M/S is the project that got widely curated and unlocked its pools without needing a giant sales book. Best Friend play feeds this: Venus buys unlock match too.',
    ],
    moves: [
      'Submit to every Fund you qualify for. One curation is enough to start; more curations deepen the pool.',
      'Treat available match as the week’s goal. Sell until it unlocks, then save the next wave of fans for a fresh drive.',
      'Play high-multiple weeks harder. A 3× Thursday is worth more than a 1× Thursday on the same sales.',
    ],
  },
  {
    id: 'closer',
    name: 'The Closer',
    formula: 'P/S',
    goal: 'Maximise prize money',
    lead: 'Rank is sales plus match. Prizes follow rank. Boosts take a share of a separate bonus pot.',
    body: [
      'P/S is prize per fan dollar — not Venus, not match. A modest seller who podiums can beat a whale who finishes 40th.',
      'Since Harvest, the project board ranks on money raised (sales + match), not boost score. #1 takes the biggest prize, #2 half of that, #3 half of #2, then it flattens so everyone ranked still gets something. Boosts no longer set rank; they win you a share of the bonus pot, on a gentle curve that spreads wide. That bonus is its own column, B/S, when a drive has a pot. Season totals roll into a finale prize.',
    ],
    moves: [
      'Climb sales + match. Unlock match first — it counts twice, once as dollars and once as rank.',
      'Rally Boosts for the bonus pot. The WIN tile on a Fund Drive card prices the cheapest mix of boosts and money to take #1.',
      'Be there for the Fair Finish. Drives close Thursday 11:00 AM PT; a 5-minute timer starts for whoever is #1, and restarts only if the lead flips.',
    ],
  },
];

function scoreOf(row: Funded, id: ArchetypeId): number {
  const sales = row.sales || 0;
  if (sales <= 0) return 0;
  if (id === 'sparkler') return row.multiple_v || 0;
  if (id === 'multiplier') return row.multiple_m || 0;
  return row.multiple_p || 0;
}

function featured(rows: Funded[]): Record<ArchetypeId, Funded[]> {
  const top = [...rows].sort((a, b) => (b.raised || 0) - (a.raised || 0)).slice(0, 100);
  const pick = (id: ArchetypeId) =>
    top
      .filter((item) => (item.sales || 0) > 0)
      .sort((a, b) => scoreOf(b, id) - scoreOf(a, id))
      .slice(0, 3);
  return {
    sparkler: pick('sparkler'),
    multiplier: pick('multiplier'),
    closer: pick('closer'),
  };
}

function exampleLine(row: Funded, id: ArchetypeId): string {
  const multiple =
    id === 'sparkler' ? row.multiple_v : id === 'multiplier' ? row.multiple_m : row.multiple_p;
  const extra =
    id === 'sparkler'
      ? `${usd(row.v2)} Venus`
      : id === 'multiplier'
        ? `${usd(row.match)} match`
        : `${usd(row.prize)} prize`;
  const x = multiple != null && multiple > 0 ? `<strong>${multiple.toFixed(1)}×</strong>` : '';
  return `<li>
    <span class="artizen-archetype-example-row">${namedLink(row.url, row.name)}${x}</span>
    <span class="text-muted">${usd(row.sales)} sales · ${extra}</span>
  </li>`;
}

function exampleBlock(rows: Funded[], id: ArchetypeId): string {
  if (rows.length === 0) return '';
  return `<div class="artizen-archetype-example">
    <p>Notable examples</p>
    <ol>${rows.map((row) => exampleLine(row, id)).join('')}</ol>
  </div>`;
}

export function renderPlay(data: Leaderboard, seasonParam: string | null): string {
  const rows = data.projects.map(funding);
  const examples = featured(rows);
  const cards = ARCHETYPES.map((arch) => {
    const formula = arch.formula;
    const moves = arch.moves.map((move) => `<li>${move}</li>`).join('');
    const paras = arch.body.map((p) => `<p>${p}</p>`).join('');
    return `<article class="artizen-archetype artizen-archetype-${arch.id}">
      <p class="artizen-archetype-kicker"><span>${escapeHtml(formula)}</span> ${escapeHtml(arch.goal)}</p>
      <h2>${escapeHtml(arch.name)}</h2>
      <p class="lead">${escapeHtml(arch.lead)}</p>
      ${paras}
      <h3>How to play</h3>
      <ul>${moves}</ul>
      ${exampleBlock(examples[arch.id], arch.id)}
    </article>`;
  }).join('');

  return layout({
    title: 'Strategies · artizen.fyi',
    description: 'Three Artizen strategies, read from the V/S, M/S, and P/S columns.',
    strategies: true,
    season: seasonParam,
    body: `
      ${panel(`
        <h1>Strategies</h1>
        <p class="lead">Artizen is a weekly funding game. The <a href="https://play.artizen.fund/" target="_blank" rel="noopener">official Playbook</a> is the rulebook. This page is how to read the three multiples on the <a href="/projects${seasonParam ? `?season=${encodeURIComponent(seasonParam)}` : ''}">projects board</a> (V/S, M/S and P/S) as three different ways to win.</p>
        <p class="mb-0">The objective is consistent across all three: maximise the return on each dollar of sales.</p>
      `)}
      <div class="artizen-archetypes">${cards}</div>
    `,
  });
}
