import { describe, it, expect } from 'vitest';
import { pushIntent, pushSummary } from '../src/ui/Push';

describe('pushIntent', () => {
  it('catches short push requests', () => {
    for (const t of ['push it', 'push', 'git push', 'push to github', 'please push my changes to GitHub!', 'commit and push to github',
      'push the branch', 'publish to github', 'push cyberpunk-version']) {
      expect(pushIntent(t, ['cyberpunk-version']), t).toBe(true);
    }
  });
  it('leaves real work for the team', () => {
    for (const t of ['push notifications for new orders', 'push the button lower', 'sync it', 'upload a photo form',
      'add a push button to the header', 'make the footer push down']) {
      expect(pushIntent(t), t).toBe(false);
    }
  });
});

describe('pushSummary', () => {
  it('says what happened per repo', () => {
    expect(pushSummary([{ repo: 'a', ok: true, branch: 'main', remote: 'origin', upToDate: false }], false)).toBe('pushed main to origin/main');
    expect(pushSummary([
      { repo: 'api', ok: true, branch: 'dev', remote: 'origin', upToDate: true },
      { repo: 'web', ok: false, error: 'Authentication failed' },
    ], true)).toBe('api: already up to date on origin/dev\nweb: push failed — Authentication failed');
  });
});
