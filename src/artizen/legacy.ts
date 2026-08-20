import type { Bubble } from './bubble';
import type { Constraint, ProjectFundingSeason, ProjectRow, Row, Season } from './types';
import { LEAD_CREATOR, byId, hidden, localProjectPath, mapSome, num, sortByDesc, text } from './util';

function legacySeasonFunding(project: Row, number: number): Omit<ProjectFundingSeason, 'number' | 'title'> | undefined {
  switch (number) {
    case 4: {
      const raised = num(project['season 4 total raised ']);
      const match = num(project['season 4 match funding']);
      const sales = Math.max(raised - match, 0.0);
      return { sales, venus: 0.0, match, prize: 0.0, raised };
    }
    case 5: {
      const sales = num(project['season 5 total sales']);
      const prize = num(project['season 5 leaderboard prize (usd)']);
      return { sales, venus: 0.0, match: 0.0, prize, raised: sales + prize };
    }
    default:
      return undefined;
  }
}

// S4/S5 predate projectseason; Artizen stores them on the project record.
// A later projectseason stub may exist with sales but no prize/match — merge, don't skip.
export function appendLegacyProjectSeasons(
  seasons: ProjectFundingSeason[],
  project: Row,
  seasonsMeta: Record<string, Season>,
): void {
  const byNumber: Record<number, Season> = Object.fromEntries(
    Object.values(seasonsMeta).map((meta) => [meta.number, meta]),
  );
  const existing: Record<string, ProjectFundingSeason> = Object.fromEntries(
    seasons.map((season) => [String(season.number), season]),
  );
  for (const number of [4, 5]) {
    const funding = legacySeasonFunding(project, number);
    if (!(funding && num(funding.raised) > 0)) continue;

    const row = existing[String(number)];
    if (row) {
      row.sales = Math.max(num(row.sales), num(funding.sales));
      row.match = Math.max(num(row.match), num(funding.match));
      row.prize = Math.max(num(row.prize), num(funding.prize));
      row.raised = row.sales + num(row.venus) + row.match + row.prize;
    } else {
      const meta = byNumber[number];
      seasons.push({
        ...funding,
        number,
        title: meta?.title ?? `Season ${number}`,
      });
    }
  }
}

// S4/S5 fund awards live on curated submissions, not projectseason match/prize.
export function applyLegacySubmissionAwards(
  seasons: ProjectFundingSeason[],
  submissionRows: Row[],
  seasonsMeta: Record<string, Season>,
): void {
  const awards: Record<number, { match: number; prize: number }> = {};
  for (const row of submissionRows) {
    if (row['Status'] !== 'Curated') continue;

    const n = row['season number'];
    const number = (n != null && n !== false ? n : byId(seasonsMeta, row['season'])?.number) as number | undefined;
    if (![4, 5].some((season) => season == number)) continue;

    const bucket = (awards[number as number] ||= { match: 0.0, prize: 0.0 });
    bucket.match += num(row['$ amount raised']);
    bucket.prize += num(row['prize unlocked usd']);
  }
  const existing: Record<string, ProjectFundingSeason> = Object.fromEntries(
    seasons.map((season) => [String(season.number), season]),
  );
  for (const [numberStr, extra] of Object.entries(awards)) {
    const number = Number(numberStr);
    const added = extra.match + extra.prize;
    if (!(added > 0)) continue;

    const row = existing[String(number)];
    if (row) {
      row.match += extra.match;
      row.prize += extra.prize;
      row.raised = num(row.sales) + num(row.venus) + row.match + row.prize;
    } else {
      const meta = Object.values(seasonsMeta).find((season) => season.number === number);
      seasons.push({
        number,
        title: meta?.title ?? `Season ${number}`,
        sales: 0.0,
        venus: 0.0,
        match: extra.match,
        prize: extra.prize,
        raised: added,
      });
    }
  }
}

async function curatedAwardsByProject(
  client: Bubble,
  seasonId: string,
): Promise<Record<string, { match: number; prize: number }>> {
  const awards: Record<string, { match: number; prize: number }> = {};
  const rows = await client.list('projectsubmission', {
    constraints: [
      { key: 'season', constraint_type: 'equals', value: seasonId },
      { key: 'Status', constraint_type: 'equals', value: 'Curated' },
    ],
  });
  for (const row of rows) {
    const projectId = row['Project'];
    if (!projectId) continue;

    const key = String(projectId);
    const bucket = (awards[key] ||= { match: 0.0, prize: 0.0 });
    bucket.match += num(row['$ amount raised']);
    bucket.prize += num(row['prize unlocked usd']);
  }
  return awards;
}

export async function legacySeasonProjectRows(client: Bubble, season: Season): Promise<ProjectRow[]> {
  const number = season.number;
  let constraints: Constraint[];
  switch (number) {
    case 4:
      constraints = [{ key: 'season 4 total raised ', constraint_type: 'greater than', value: 0 }];
      break;
    case 5:
      constraints = [{ key: 'season 5 total sales', constraint_type: 'greater than', value: 0 }];
      break;
    default:
      return [];
  }
  const awards = await curatedAwardsByProject(client, season.id);
  return sortByDesc(
    mapSome(await client.list('project', { constraints }), (project) => {
      if (hidden(project)) return undefined;

      const name = text(project['Name']);
      if (!name) return undefined;

      const funding = legacySeasonFunding(project, number);
      if (!funding) return undefined;

      const extra = byId(awards, project['_id']);
      if (extra) {
        funding.match += extra.match;
        funding.prize += extra.prize;
        funding.raised = funding.sales + funding.venus + funding.match + funding.prize;
      }
      if (!(num(funding.raised) > 0)) return undefined;

      const slug = text(project['Slug']) ?? project['_id'];
      return {
        ...funding,
        name,
        url: localProjectPath(slug),
        creator: text(project[LEAD_CREATOR]),
        logline: text(project['Logline']),
      };
    }),
    (project) => project.raised,
  );
}
