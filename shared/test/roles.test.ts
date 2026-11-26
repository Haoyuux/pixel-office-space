import { describe, it, expect } from 'vitest';
import { ROLES, DEFAULT_TEAM } from '../src/roles';

describe('role catalogue', () => {
  it('has the default team', () => {
    expect(DEFAULT_TEAM).toEqual(['pm', 'techlead', 'frontend', 'backend', 'qa']);
  });
  it('only PM is required', () => {
    expect(ROLES.filter(r => r.required).map(r => r.id)).toEqual(['pm']);
  });
  it('every role has its own desk', () => {
    expect(new Set(ROLES.map(r => `${r.deskRow}:${r.deskCol}`)).size).toBe(9);
    expect(ROLES.find(r => r.id === 'frontend')).toMatchObject({ deskRow: 0, deskCol: 1 });
  });
});
