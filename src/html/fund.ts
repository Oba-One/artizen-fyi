import type { FundPage } from '../artizen';
import { delimited, usd } from '../format';
import { chevron, driveBadges, escapeHtml, layout, richText, sumField, treeHidden, videoIframe } from './layout';

export function renderFund(fund: FundPage): string {
  const prize = fund.prize_usd
    ? `<span class="badge text-bg-primary">Prize ${usd(fund.prize_usd)}</span>`
    : fund.prize_art
      ? `<span class="badge text-bg-primary">Prize ${delimited(fund.prize_art)} ART</span>`
      : '';
  const fundingTable = fund.seasons.length ? fundFundingTable(fund) : '';
  const video = videoIframe(fund.video) || '';
  const about = fund.description ? `<h2 class="mt-4">About</h2>${richText(fund.description)}` : '';
  const eligibility = fund.eligibility ? `<h2 class="mt-4">Eligibility</h2>${richText(fund.eligibility)}` : '';
  return layout({
    title: fund.name,
    description: fund.subtitle || fund.for_title || `Artizen fund: ${fund.name}`,
    image: fund.image,
    tree: true,
    body: `
      <p class="mb-3"><a href="/funds">&larr; Artizen leaderboards</a></p>
      <div class="row mb-4">
        <div class="col-lg-4 mb-3">${fund.image ? `<img class="artizen-hero" src="${escapeHtml(fund.image)}" alt="${escapeHtml(fund.name)}">` : ''}</div>
        <div class="col-lg-8">
          <h1 class="mb-2">${escapeHtml(fund.name)}</h1>
          ${fund.subtitle ? `<p class="lead">${escapeHtml(fund.subtitle)}</p>` : ''}
          ${fund.for_title ? `<p class="text-muted">For ${escapeHtml(fund.for_title)}</p>` : ''}
          ${fund.sponsor ? `<p>Lead sponsor: ${escapeHtml(fund.sponsor)}</p>` : ''}
          ${fund.active === false ? '<span class="badge text-bg-secondary me-1">Inactive</span>' : ''}
          ${prize}
          <p class="mt-2 mb-0"><a href="${escapeHtml(fund.artizen_url)}" target="_blank" rel="noopener">View on Artizen</a></p>
        </div>
      </div>
      ${fundingTable}
      ${video}
      ${about}
      ${eligibility}
    `,
  });
}

function fundFundingTable(fund: FundPage): string {
  const seasons = fund.seasons
    .map((season, si) => {
      const seasonId = `s${si}`;
      const seasonOpen = si === 0;
      const drives = season.drives || [];
      const count =
        Number(season.count) > 0
          ? `<small class="text-muted">${season.count} ${season.count === 1 ? 'contribution' : 'contributions'}</small>`
          : '';
      const seasonRow = `<tr class="artizen-tree-season" data-id="${seasonId}">
        <td>${chevron(seasonOpen, drives.length > 0)} ${escapeHtml(season.title)} ${count}</td>
        <td class="text-end">${usd(season.total)}</td>
        <td class="text-end">${usd(season.unlocked)}</td>
        <td class="text-end">${Number(season.available) > 0 ? usd(season.available) : ''}</td>
        <td class="text-end">${usd((season.unlocked || 0) + (season.available || 0))}</td>
      </tr>`;
      const driveRows = drives
        .map((drive, di) => {
          const driveId = `${seasonId}d${di}`;
          const driveOpen = seasonOpen && di === 0;
          const live = drive.active || drive.adjustment;
          const hidden = treeHidden(seasonOpen);
          const adjust = drive.adjustment ? ' artizen-tree-adjust' : '';
          const projects = drive.projects || [];
          const driveRow = `<tr class="artizen-tree-drive${adjust}${hidden}" data-id="${driveId}" data-parent="${seasonId}">
            <td>${chevron(driveOpen, projects.length > 0)} ${escapeHtml(drive.name)}${driveBadges(drive)}</td>
            <td class="text-end"></td>
            <td class="text-end">${drive.adjustment ? '' : usd(drive.unlocked)}</td>
            <td class="text-end">${live ? usd(drive.available) : ''}</td>
            <td class="text-end">${live || Number(drive.unlocked) > 0 ? usd((drive.unlocked || 0) + (drive.available || 0)) : ''}</td>
          </tr>`;
          const projectRows = projects
            .map((project) => {
              const projectHidden = treeHidden(driveOpen);
              return `<tr class="artizen-tree-project${projectHidden}" data-parent="${driveId}">
                <td><span class="artizen-tree-toggle"></span>
                  <span class="artizen-tree-label">
                    <a href="${escapeHtml(project.url)}" class="text-dark">${escapeHtml(project.name)}</a>
                    ${project.hidden ? ' <span class="badge text-bg-secondary">hidden</span>' : ''}
                    ${project.creator ? `<br><small class="text-muted">${escapeHtml(project.creator)}</small>` : ''}
                  </span>
                </td>
                <td class="text-end"></td>
                <td class="text-end">${usd(project.unlocked)}</td>
                <td class="text-end">${live ? usd(project.available) : ''}</td>
                <td class="text-end">${live || Number(project.unlocked) > 0 ? usd((project.unlocked || 0) + (project.available || 0)) : ''}</td>
              </tr>`;
            })
            .join('');
          return driveRow + projectRows;
        })
        .join('');
      return seasonRow + driveRows;
    })
    .join('');
  return `
    <h2 class="mt-4">Funding</h2>
    <p class="text-muted mb-2">Unlocked = match paid to projects plus awards on curated submissions (Artizen’s distributed). Raised = unlocked + available.</p>
    <div class="table-responsive mb-4">
      <table class="table table-sm artizen-funding-tree">
        <thead><tr>
          <th></th><th class="text-end">Contributions</th><th class="text-end">Unlocked</th>
          <th class="text-end">Available</th><th class="text-end">Raised</th>
        </tr></thead>
        <tbody>${seasons}</tbody>
        <tfoot><tr>
          <th>Total</th>
          <th class="text-end">${usd(sumField(fund.seasons, 'total'))}</th>
          <th class="text-end">${usd(sumField(fund.seasons, 'unlocked'))}</th>
          <th class="text-end">${usd(sumField(fund.seasons, 'available'))}</th>
          <th class="text-end">${usd(sumField(fund.seasons, 'unlocked') + sumField(fund.seasons, 'available'))}</th>
        </tr></tfoot>
      </table>
    </div>`;
}
