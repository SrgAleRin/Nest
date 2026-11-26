import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmAction } from './ConfirmAction';
import type { ConfirmRequest } from '../confirm';

const discard: ConfirmRequest = {
  title: 'Discard src/login.ts',
  body: [
    'Restores the path from HEAD (git restore --source=HEAD --staged --worktree), so it drops the staged and the unstaged changes of this path, not only the unstaged side.',
    'This cannot be undone.',
  ],
  acceptLabel: 'Discard changes',
  destructive: true,
};

function render(request: ConfirmRequest = discard): string {
  return renderToStaticMarkup(
    <ConfirmAction request={request} onAccept={() => undefined} onCancel={() => undefined} />,
  );
}

/**
 * The contract the e2e specs match: one alertdialog root, an accept and a
 * cancel testid, and text that names the exact target.
 */
describe('confirm action markup', () => {
  it('is an alertdialog labelled and described by its own text', () => {
    const html = render();
    expect(html).toMatch(
      /data-testid="confirm-action"[^>]*role="alertdialog"|role="alertdialog"[^>]*data-testid="confirm-action"/,
    );
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    // Both aria ids point at real elements of the dialog.
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(labelledBy && html.includes(`id="${labelledBy}"`)).toBe(true);
    expect(describedBy && html.includes(`id="${describedBy}"`)).toBe(true);
  });

  it('has both controls with their stable testids and the action label', () => {
    const html = render();
    expect(html).toContain('data-testid="confirm-cancel"');
    expect(html).toContain('data-testid="confirm-accept"');
    expect(html).toContain('>Cancel<');
    expect(html).toContain('>Discard changes<');
    // A destructive accept reads as the danger button of the design system.
    expect(html).toMatch(
      /data-testid="confirm-accept"[^>]*btn-danger|btn-danger[^>]*data-testid="confirm-accept"/,
    );
  });

  it('states the scope instead of asking whether the user is sure', () => {
    const html = render();
    expect(html).toContain('Discard src/login.ts');
    expect(html).toContain('git restore --source=HEAD --staged --worktree');
    expect(html).toContain('cannot be undone');
    expect(html.toLowerCase()).not.toContain('are you sure');
  });

  it('renders a non-destructive accept as the primary button', () => {
    const html = render({
      title: 'Publish feature/login as origin/feature/login',
      body: ['origin/main is not touched.'],
      acceptLabel: 'Publish branch',
      destructive: false,
    });
    expect(html).toMatch(
      /data-testid="confirm-accept"[^>]*btn-primary|btn-primary[^>]*data-testid="confirm-accept"/,
    );
    expect(html).not.toContain('btn-danger');
  });
});
