import type { Bubble } from './bubble';
import type { Drive, FundDriveNest, FundFundingSeason, FundMatchedProject, FundPage, Row, Season } from './types';
import {
  LEAD_CREATOR,
  byId,
  driveContext,
  fundUrl,
  groupBy,
  hidden,
  ids,
  leftoverMatch,
  localProjectPath,
  mapSome,
  maybeNum,
  mediaUrl,
  num,
  sortByDesc,
  sum,
  text,
} from './util';

export async function buildFund(client: Bubble, slug: string): Promise<FundPage | null> {
  const row = await client.findOne('fund', slug);
  if (!row) return null;

  const id = String(row['_id'] ?? '');
  const slugValue = text(row['Slug']) ?? id;
  const ext =
    row['Extended info'] != null && row['Extended info'] !== false
      ? (await client.findBy('fundextendedinfo', '_id', row['Extended info']))[0]
      : undefined;

  const slices = await client.list('projectfundboostslice', {
    constraints: [
      { key: 'fund', constraint_type: 'equals', value: id },
      { key: 'match cap $', constraint_type: 'greater than', value: 0 },
    ],
  });
  const awardRows = await client.listFundAwards([id]);
  const projectIds = ids([...slices.map((s) => s['project']), ...awardRows.map((s) => s['Project'])]);
  const projects = await client.indexed('project', projectIds);
  const boostIds = ids(slices.map((s) => s['boost']));
  const seasonsMeta = await client.seasonsById();
  const driveList = await client.fetchNormalizedDrives(boostIds, seasonsMeta);
  const drives: Record<string, Drive> = Object.fromEntries(driveList.map((d) => [d.id, d]));

  const matchedProjects: FundMatchedProject[] = mapSome(
    groupBy(slices, (s) => [s['project'], s['boost']]),
    ([pair, grouped]) => {
      const [projectId, boostId] = pair as [unknown, unknown];
      const project = byId(projects, projectId);
      if (!project) return undefined;

      const drive = byId(drives, boostId);
      const projectSlug = text(project['Slug']) ?? projectId;
      return {
        name: text(project['Name']) ?? '',
        url: localProjectPath(projectSlug),
        creator: text(project[LEAD_CREATOR]),
        hidden: hidden(project),
        ...driveContext(drive),
        drive_url: drive && drive.url,
        available: leftoverMatch(grouped),
        unlocked: sum(grouped, (r) => num(r['match unlocked'])),
      } satisfies FundMatchedProject;
    },
  );
  matchedProjects.push(...fundAwardProjects(awardRows, projects, seasonsMeta));

  const contribs = await client.list('fundcontribution', {
    constraints: [
      { key: 'Fund', constraint_type: 'equals', value: id },
      { key: 'confirmed', constraint_type: 'equals', value: true },
    ],
  });
  const contribSeasons = mapSome(groupBy(contribs, (c) => c['Season']), ([seasonId, grouped]) => {
    const meta = byId(seasonsMeta, seasonId);
    return {
      number: meta?.number,
      title: meta?.title ?? 'Season',
      total: sum(grouped, (r) => num(r['amount $USD'])),
      count: grouped.length,
    } satisfies FundFundingSeason;
  });

  const contribTotal = sum(contribs, (c) => num(c['amount $USD']));
  const slicedAvailable = sum(
    matchedProjects.filter((project) => project.drive_active),
    (project) => num(project.available),
  );
  const unallocated = num(row['Funding - current']) - slicedAvailable;
  const seasons = nestFundFunding(contribSeasons, matchedProjects, unallocated);

  return {
    name: text(ext?.['full title']) || (text(row['name']) ?? ''),
    artizen_url: fundUrl(slugValue),
    image: mediaUrl(row['cover image']),
    subtitle: text(ext?.['subtitle']),
    for_title: text(ext?.['for title']),
    sponsor: text(ext?.['lead sponsor (text)']),
    available: sum(seasons, (season) => num(season.available)),
    unlocked: sum(seasons, (season) => num(season.unlocked)),
    prize_art: maybeNum(row['Prize ART']),
    prize_usd: maybeNum(row['Prize USD']),
    active: row['active'],
    contrib_total: contribTotal,
    seasons,
  };
}

function fundAwardProjects(
  awardRows: Row[],
  projects: Record<string, Row>,
  seasonsMeta: Record<string, Season>,
): FundMatchedProject[] {
  return mapSome(
    groupBy(awardRows, (row) => {
      const n = row['season number'];
      const number = n != null && n !== false ? n : byId(seasonsMeta, row['season'])?.number;
      return [row['Project'], number];
    }),
    ([pair, grouped]) => {
      const [projectId, number] = pair as [unknown, unknown];
      const raised = sum(grouped, (r) => num(r['$ amount raised']));
      if (!(raised > 0 && number != null && number !== false)) return undefined;

      const project = byId(projects, projectId);
      const meta = byId(seasonsMeta, grouped[0]['season']);
      const projectSlug = text(project?.['Slug']) || projectId;
      return {
        name: text(project?.['Name']) || 'Project',
        url: localProjectPath(projectSlug),
        creator: text(project?.[LEAD_CREATOR]),
        hidden: hidden(project),
        drive: 'Awards',
        drive_url: null,
        drive_active: false,
        drive_number: null,
        drive_multiple: null,
        season: meta?.title ?? `Season ${number}`,
        season_number: number as number,
        available: 0.0,
        unlocked: raised,
      } satisfies FundMatchedProject;
    },
  );
}

function nestFundFunding(
  contribSeasons: FundFundingSeason[],
  matchedProjects: FundMatchedProject[],
  unallocated = 0,
): FundFundingSeason[] {
  const seasons = contribSeasons.map((season) => ({ ...season }));
  const known = seasons.map((season) => season.number);
  for (const project of matchedProjects) {
    if (known.some((n) => n == project.season_number)) continue;

    seasons.push({
      number: project.season_number,
      title: project.season ?? `Season ${project.season_number}`,
      total: 0.0,
      count: 0,
    });
    known.push(project.season_number);
  }
  sortByDesc(seasons, (season) => season.number || 0);

  const nested = seasons.map((season) => {
    const seasonProjects = matchedProjects.filter((project) => project.season_number == season.number);
    const drives: FundDriveNest[] = sortByDesc(
      groupBy(seasonProjects, (project) => project.drive ?? 'Drive').map(([name, projects]) => {
        const sample = projects[0];
        const active = sample && sample.drive_active;
        const leftover = sum(projects, (p) => num(p.available));
        return {
          name: String(name ?? 'Drive'),
          url: sample && sample.drive_url,
          active,
          number: sample && sample.drive_number,
          multiple: sample && sample.drive_multiple,
          unlocked: sum(projects, (p) => num(p.unlocked)),
          available: active ? leftover : 0.0,
          projects: [...projects].sort((a, b) => {
            const av = num(b.available) - num(a.available);
            if (av) return av;
            return num(b.unlocked) - num(a.unlocked);
          }),
        } satisfies FundDriveNest;
      }),
      (drive) => drive.number || 0,
    );
    return {
      ...season,
      unlocked: sum(drives, (drive) => drive.unlocked),
      available: sum(drives, (drive) => drive.available),
      drives,
    };
  });

  if (num(unallocated) >= 0.5 && nested.length > 0) {
    const latest = nested[0];
    const row: FundDriveNest = {
      name: 'Unallocated',
      url: null,
      active: false,
      adjustment: true,
      number: null,
      multiple: null,
      unlocked: 0.0,
      available: num(unallocated),
      projects: [],
    };
    const activeIdx = latest.drives!.findIndex((drive) => drive.active);
    if (activeIdx >= 0) latest.drives!.splice(activeIdx + 1, 0, row);
    else latest.drives!.push(row);
    latest.available = num(latest.available) + num(unallocated);
  }

  return nested;
}
