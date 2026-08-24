import type { ProjectProfile } from '../artizen/types';
import { findExactProject, searchProjects } from './project-search';

/** Where in the interaction the picker is being asked to decide. */
export type PickerPhase = 'typing' | 'commit';

export type PickerState = {
  options: ProjectProfile[];
  /** Index into options, or -1 when there is nothing to highlight. */
  activeIndex: number;
  /**
   * The project the picker is willing to select, and only ever during 'commit'.
   * Typing must never select on the user's behalf: the live catalog contains
   * projects whose name or slug is a single character, so an exact match part
   * way through a word would silently rewrite the field.
   */
  committed?: ProjectProfile;
};

export function pickerState(projects: ProjectProfile[], query: string, phase: PickerPhase): PickerState {
  if (phase === 'commit') {
    return { options: [], activeIndex: -1, committed: findExactProject(projects, query) };
  }
  const options = searchProjects(projects, query);
  return { options, activeIndex: options.length ? 0 : -1 };
}

/** Wrapping arrow-key movement over the visible options. */
export function moveActive(activeIndex: number, count: number, step: number): number {
  if (count <= 0) return -1;
  if (activeIndex < 0) return step > 0 ? 0 : count - 1;
  return (activeIndex + step + count) % count;
}
