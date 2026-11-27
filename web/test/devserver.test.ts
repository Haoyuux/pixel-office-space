import { describe, it, expect, beforeEach } from 'vitest';
import { runIntent } from '../src/ui/DevServer';
import { useOffice, resetOffice } from '../src/state/store';

describe('runIntent', () => {
  it.each([
    'run my portfolio', 'can you run my porfolio', 'Run it', 'run', 'start the dev server', 'please start the app locally',
    'npm run dev', 'launch the site', 'serve it', 'run bpm-portfolio', 'open it in the browser', 'spin up the dev server',
  ])('"%s" runs it', t => expect(runIntent(t, 'bpm-portfolio')).toBe('run'));

  it.each(['stop the server', 'kill the dev server', 'shut down the app', 'stop my portfolio'])('"%s" stops it', t =>
    expect(runIntent(t, 'bpm-portfolio')).toBe('stop'));

  it.each([
    'run the tests', 'start a login page', 'run npm audit and fix issues', 'stop', 'open the project',
    'how do I run my portfolio?', 'build the site', 'start working on the contact form', 'run the migration on the server',
  ])('"%s" stays a request for the team', t => expect(runIntent(t, 'bpm-portfolio')).toBeNull());
});

describe('dev server events in the store', () => {
  beforeEach(() => resetOffice());
  it('state from updates and the snapshot; log appends, reset clears, removal forgets', () => {
    const s = useOffice.getState();
    s.apply({ type: 'devserver.updated', projectId: 'p', ts: '', state: { projectId: 'p', status: 'running', url: 'http://localhost:3000/' } });
    s.apply({ type: 'devserver.log', projectId: 'p', ts: '', lines: ['a'] });
    s.apply({ type: 'devserver.log', projectId: 'p', ts: '', lines: ['b'] });
    expect(useOffice.getState().devLogs.p).toEqual(['a', 'b']);
    s.apply({ type: 'devserver.log', projectId: 'p', ts: '', lines: [], reset: true });
    expect(useOffice.getState().devLogs.p).toEqual([]);
    expect(useOffice.getState().devServers.p.url).toBe('http://localhost:3000/');
    s.apply({ type: 'snapshot', ts: '', snapshot: { projects: [], tickets: [], devServers: [{ projectId: 'q', status: 'starting' }] } });
    expect(Object.keys(useOffice.getState().devServers)).toEqual(['q']);
    s.apply({ type: 'project.removed', projectId: 'q', ts: '' });
    expect(useOffice.getState().devServers).toEqual({});
  });
});
