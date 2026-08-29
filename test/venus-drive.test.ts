import { describe, expect, it } from 'vitest';
import type { Drive } from '../src/artizen/types';
import { assignVenusDrive } from '../src/artizen/util';

function drive(partial: Pick<Drive, 'id' | 'name' | 'start' | 'end'> & Partial<Drive>): Drive {
  return {
    url: `/${partial.id}`,
    season_id: 's7',
    status: partial.active ? 'Active' : 'Ended',
    active: false,
    ...partial,
  };
}

const season = 's7';
const flywheel = drive({
  id: 'flywheel',
  name: 'Flywheel Fund Drive',
  start: '2026-08-13T18:00:00.000Z',
  end: '2026-08-20T18:00:00.000Z',
});
const harvest = drive({
  id: 'harvest',
  name: 'Harvest Fund Drive',
  start: '2026-08-23T23:39:28.701Z',
  end: '2026-08-27T18:00:00.000Z',
});
const eclipse = drive({
  id: 'eclipse',
  name: 'Eclipse Fund Drive',
  start: '2026-08-27T18:00:00.000Z',
  end: '2026-09-03T18:00:00.000Z',
  active: true,
});
const drives = [eclipse, harvest, flywheel];

describe('assignVenusDrive', () => {
  it('keeps an in-window buy on that drive', () => {
    expect(assignVenusDrive({ 'Created Date': '2026-08-14T18:16:49.094Z', Season: season }, drives)?.id).toBe(
      'flywheel',
    );
    expect(assignVenusDrive({ 'Created Date': '2026-08-29T12:08:52.274Z', Season: season }, drives)?.id).toBe(
      'eclipse',
    );
  });

  it('puts a leftover between drives on the next neighbour, not today\'s active drive', () => {
    expect(assignVenusDrive({ 'Created Date': '2026-08-22T11:46:29.828Z', Season: season }, drives)?.id).toBe(
      'harvest',
    );
  });

  it('does not peel a leftover off a frozen last drive', () => {
    const ended = drives.map((row) => ({ ...row, active: false, status: 'Ended' }));
    expect(assignVenusDrive({ 'Created Date': '2026-09-04T12:00:00.000Z', Season: season }, ended)).toBeUndefined();
  });
});
