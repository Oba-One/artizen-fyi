import type { ProjectPage, ProjectSibling, ProjectSiblingFund, ProjectSubmission } from '../artizen';
import { moneyCells, moneyColumns, moneyHeaders, truncate, usd } from '../format';
import { artizenLinks, driveBadges, escapeHtml, heroSplit, layout, namedLink, panel, sumField, treeRow } from './layout';

export function renderProject(project: ProjectPage): string {
  const tags = (project.tags || []).map((tag) => `<span class="badge text-bg-secondary me-1 mb-1">${escapeHtml(tag)}</span>`).join('');
  const fundingTable = project.seasons.length ? projectFundingTable(project) : '';
  const submissions = project.submissions?.length ? projectSubmissions(project.submissions) : '';
  const siblings = project.siblings?.length ? projectSiblings(project.siblings) : '';
  const siblingFunds = project.sibling_funds?.length ? projectSiblingFunds(project.sibling_funds) : '';
  return layout({
    title: project.name,
    description: project.logline || `Artizen project: ${project.name}`,
    image: project.image,
    tree: true,
    body: `
      ${heroSplit(
        project.image,
        project.name,
        `<h1>${escapeHtml(project.name)}</h1>
          ${project.logline ? `<p class="lead">${escapeHtml(project.logline)}</p>` : ''}
          ${tags ? `<div class="mb-2">${tags}</div>` : ''}
          ${artizenLinks(project.artizen_url)}`,
      )}
      ${fundingTable}
      ${submissions}
      ${siblings}
      ${siblingFunds}
    `,
  });
}

function projectFundingTable(project: ProjectPage): string {
  const includeBonus =
    project.seasons.some((season) => Number(season.bonus) > 0) ||
    project.seasons.some((season) => (season.drives || []).some((drive) => Number(drive.bonus) > 0));
  const cols = moneyColumns(includeBonus);
  const seasons = project.seasons
    .map((season, si) => {
      const seasonId = `s${si}`;
      const seasonOpen = si === 0;
      const drives = season.drives || [];
      const seasonRow = treeRow({
        className: 'artizen-tree-season',
        id: seasonId,
        open: seasonOpen,
        hasKids: drives.length > 0,
        label: escapeHtml(season.title),
        cells: `${moneyCells(season, 'td', cols)}<td class="text-end">${usd(season.available)}</td>`,
      });
      const driveRows = drives
        .map((drive, di) => {
          const driveId = `${seasonId}d${di}`;
          const driveOpen = seasonOpen && di === 0;
          const funds = drive.funds || [];
          const driveRow = treeRow({
            className: 'artizen-tree-drive',
            id: driveId,
            parent: seasonId,
            hidden: !seasonOpen,
            open: driveOpen,
            hasKids: funds.length > 0,
            label: `${escapeHtml(drive.name)}${driveBadges(drive)}`,
            cells: `${moneyCells(drive, 'td', cols)}<td class="text-end">${drive.active ? usd(drive.available) : ''}</td>`,
          });
          const fundRows = funds
            .map((fund) =>
              treeRow({
                className: 'artizen-tree-fund',
                parent: driveId,
                hidden: !driveOpen,
                label: namedLink(fund.url, fund.name),
                // Unlocked sits in Match; other money columns stay empty so Available lines up.
                cells:
                  cols.map((col) => `<td class="text-end">${col.field === 'match' ? usd(fund.unlocked) : ''}</td>`).join('') +
                  `<td class="text-end">${drive.active ? usd(fund.available) : ''}</td>`,
              }),
            )
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
    bonus: sumField(project.seasons, 'bonus'),
    sprint: sumField(project.seasons, 'sprint'),
    raised: sumField(project.seasons, 'raised'),
  };
  return panel(`
    <h2 class="artizen-panel-title">Funding</h2>
    <div class="table-responsive">
      <table class="table table-sm artizen-funding-tree">
        <thead><tr>
          <th></th>${moneyHeaders('text-end', cols)}
          <th class="text-end">Available</th>
        </tr></thead>
        <tbody>${seasons}</tbody>
        <tfoot><tr>
          <th>Total</th>
          ${moneyCells(totals, 'th', cols)}
          <th class="text-end">${usd(sumField(project.seasons, 'available'))}</th>
        </tr></tfoot>
      </table>
    </div>`);
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
      const head = treeRow({
        className: 'artizen-tree-season',
        id: seasonId,
        open,
        hasKids: true,
        label: escapeHtml(group.title),
        cells: '<td></td>',
      });
      const kids = group.items
        .map((submission) => {
          const status = String(submission.status);
          const cls =
            status === 'Curated' || status === 'Approved'
              ? 'text-bg-primary'
              : status === 'Removed'
                ? 'text-bg-danger'
                : 'text-bg-secondary';
          return treeRow({
            className: 'artizen-tree-submission',
            parent: seasonId,
            hidden: !open,
            label: namedLink(submission.url, submission.name),
            cells: `<td class="text-end"><span class="badge ${cls}">${escapeHtml(status)}</span></td>`,
          });
        })
        .join('');
      return head + kids;
    })
    .join('');
  return panel(`
    <h2 class="artizen-panel-title">Submissions</h2>
    <div class="table-responsive">
      <table class="table table-sm artizen-funding-tree">
        <thead><tr><th></th><th class="text-end">Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`);
}

function projectSiblings(siblings: ProjectSibling[]): string {
  const rows = siblings
    .map((sibling, i) => {
      const logline = sibling.logline
        ? `<br><small class="text-muted">${escapeHtml(truncate(sibling.logline, 90))}</small>`
        : '';
      const funds = sibling.funds
        .map((fund) => `<li>${namedLink(fund.url, fund.name)}</li>`)
        .join('');
      return `<tr>
        <td><span class="text-muted">${i + 1}.</span> ${namedLink(sibling.url, sibling.name)}${logline}</td>
        <td class="text-center">${sibling.funds.length}</td>
        <td><ul class="artizen-sibling-funds">${funds}</ul></td>
      </tr>`;
    })
    .join('');
  return panel(`
    <h2 class="artizen-panel-title">Top siblings</h2>
    <div class="table-responsive">
      <table class="table table-sm artizen-siblings">
        <thead><tr><th>Project</th><th class="text-center">Funds</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`);
}

function projectSiblingFunds(funds: ProjectSiblingFund[]): string {
  const rows = funds
    .map((fund, i) => {
      const siblings = fund.siblings
        .map((sibling) => `<li>${namedLink(sibling.url, sibling.name)}</li>`)
        .join('');
      return `<tr>
        <td><span class="text-muted">${i + 1}.</span> ${namedLink(fund.url, fund.name)}${fundAvailable(fund.available)}</td>
        <td class="text-center">${fund.siblings.length}</td>
        <td><ul class="artizen-sibling-funds">${siblings}</ul></td>
      </tr>`;
    })
    .join('');
  return panel(`
    <h2 class="artizen-panel-title">Other funds of top siblings</h2>
    <div class="table-responsive">
      <table class="table table-sm artizen-siblings">
        <thead><tr><th>Fund</th><th class="text-center">Siblings</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`);
}

function fundAvailable(available?: number): string {
  const amount = usd(available);
  return amount ? `<br><small class="text-muted">${amount}</small>` : '';
}
