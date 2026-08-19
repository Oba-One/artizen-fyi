import type { ProjectPage, ProjectSubmission } from '../artizen';
import { moneyCells, usd } from '../format';
import { chevron, driveBadges, escapeHtml, layout, simpleFormat, sumField, treeHidden, videoIframe } from './layout';

export function renderProject(project: ProjectPage): string {
  const tags = (project.tags || []).map((tag) => `<span class="badge text-bg-secondary me-1 mb-1">${escapeHtml(tag)}</span>`).join('');
  const imgCol = project.image
    ? `<div class="col-lg-4 mb-3"><img class="artizen-hero" src="${escapeHtml(project.image)}" alt="${escapeHtml(project.name)}"></div><div class="col-lg-8">`
    : '<div class="col-lg-12">';
  const fundingTable = project.seasons.length ? projectFundingTable(project) : '';
  const submissions = project.submissions?.length ? projectSubmissions(project.submissions) : '';
  const video = videoIframe(project.video) || '';
  const sections = (
    [
      ['About', project.description],
      ['Impact', project.impact],
      ['Progress', project.progress],
      ['Team', project.team],
    ] as const
  )
    .map(([heading, body]) => (body ? `<h2 class="mt-4">${heading}</h2>${simpleFormat(body)}` : ''))
    .join('');
  return layout({
    title: project.name,
    description: project.logline || `Artizen project: ${project.name}`,
    image: project.image,
    tree: true,
    body: `
      <p class="mb-3"><a href="/projects">&larr; Artizen leaderboards</a></p>
      <div class="row mb-4">
        ${imgCol}
          <h1 class="mb-2">${escapeHtml(project.name)}</h1>
          ${project.logline ? `<p class="lead">${escapeHtml(project.logline)}</p>` : ''}
          ${project.creator ? `<p class="mb-2">${escapeHtml(project.creator)}</p>` : ''}
          ${tags}
          <p class="mt-2 mb-0"><a href="${escapeHtml(project.artizen_url)}" target="_blank" rel="noopener">View on Artizen</a></p>
        </div>
      </div>
      ${fundingTable}
      ${submissions}
      ${video}
      ${sections}
    `,
  });
}

function projectFundingTable(project: ProjectPage): string {
  const seasons = project.seasons
    .map((season, si) => {
      const seasonId = `s${si}`;
      const seasonOpen = si === 0;
      const drives = season.drives || [];
      const seasonRow = `<tr class="artizen-tree-season" data-id="${seasonId}">
        <td>${chevron(seasonOpen, drives.length > 0)} ${escapeHtml(season.title)}</td>
        ${moneyCells(season)}
        <td class="text-end">${Number(season.available) > 0 ? usd(season.available) : ''}</td>
      </tr>`;
      const driveRows = drives
        .map((drive, di) => {
          const driveId = `${seasonId}d${di}`;
          const driveOpen = seasonOpen && di === 0;
          const funds = drive.funds || [];
          const hidden = treeHidden(seasonOpen);
          const driveRow = `<tr class="artizen-tree-drive${hidden}" data-id="${driveId}" data-parent="${seasonId}">
            <td>${chevron(driveOpen, funds.length > 0)} ${escapeHtml(drive.name)}${driveBadges(drive)}</td>
            ${moneyCells(drive)}
            <td class="text-end">${drive.active ? usd(drive.available) : ''}</td>
          </tr>`;
          const fundRows = funds
            .map((fund) => {
              const fundHidden = treeHidden(driveOpen);
              return `<tr class="artizen-tree-fund${fundHidden}" data-parent="${driveId}">
                <td><span class="artizen-tree-toggle"></span> <a href="${escapeHtml(fund.url)}" class="text-dark">${escapeHtml(fund.name)}</a></td>
                <td class="text-end"></td><td class="text-end"></td>
                <td class="text-end">${usd(fund.unlocked)}</td>
                <td class="text-end"></td><td class="text-end"></td><td class="text-end"></td><td class="text-end"></td><td class="text-end"></td><td class="text-end"></td>
                <td class="text-end">${drive.active ? usd(fund.available) : ''}</td>
              </tr>`;
            })
            .join('');
          return driveRow + fundRows;
        })
        .join('');
      return seasonRow + driveRows;
    })
    .join('');
  const totals = {
    sales: sumField(project.seasons, 'sales'),
    venus: sumField(project.seasons, 'venus'),
    match: sumField(project.seasons, 'match'),
    prize: sumField(project.seasons, 'prize'),
    raised: sumField(project.seasons, 'raised'),
  };
  return `
    <h2 class="mt-4">Funding</h2>
    <div class="table-responsive mb-4">
      <table class="table table-sm artizen-funding-tree">
        <thead><tr>
          <th></th><th class="text-end">Sales</th><th class="text-end">Venus</th><th class="text-end">Match</th>
          <th class="text-end">Prize</th><th class="text-end">V+M+P</th><th class="text-end">V/S</th>
          <th class="text-end">(V+M)/S</th><th class="text-end">(V+M+P)/S</th><th class="text-end">Raised</th>
          <th class="text-end">Available</th>
        </tr></thead>
        <tbody>${seasons}</tbody>
        <tfoot><tr>
          <th>Total</th>
          ${moneyCells(totals, 'th')}
          <th class="text-end">${usd(sumField(project.seasons, 'available'))}</th>
        </tr></tfoot>
      </table>
    </div>`;
}

function projectSubmissions(submissions: ProjectSubmission[]): string {
  const groups: { title: string; items: ProjectSubmission[] }[] = [];
  const index = new Map<string, number>();
  for (const s of submissions) {
    const key = `${s.season_number}\0${s.season}`;
    let i = index.get(key);
    if (i == null) {
      i = groups.length;
      index.set(key, i);
      groups.push({ title: s.season || 'Season', items: [] });
    }
    groups[i].items.push(s);
  }
  const rows = groups
    .map((group, si) => {
      const seasonId = `sub${si}`;
      const open = si === 0;
      const head = `<tr class="artizen-tree-season" data-id="${seasonId}">
        <td>${chevron(open, true)} ${escapeHtml(group.title)}</td><td></td>
      </tr>`;
      const kids = group.items
        .map((submission) => {
          const accepted = submission.status === 'Curated' || submission.status === 'Approved';
          const hidden = treeHidden(open);
          return `<tr class="artizen-tree-submission${hidden}" data-parent="${seasonId}">
            <td><span class="artizen-tree-toggle"></span> <a href="${escapeHtml(submission.url)}" class="text-dark">${escapeHtml(submission.name)}</a></td>
            <td class="text-end"><span class="badge ${accepted ? 'text-bg-primary' : 'text-bg-secondary'}">${escapeHtml(submission.status)}</span></td>
          </tr>`;
        })
        .join('');
      return head + kids;
    })
    .join('');
  return `
    <h2 class="mt-4">Submissions</h2>
    <div class="table-responsive mb-4">
      <table class="table table-sm artizen-funding-tree">
        <thead><tr><th></th><th class="text-end">Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}
