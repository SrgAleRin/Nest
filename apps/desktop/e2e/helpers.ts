import { expect, type Page } from '@playwright/test';

/** Opens the new-tab picker anchored to the plus button. */
export async function openNewTabPicker(page: Page): Promise<void> {
  await page.locator('.terminal-new-caret').click();
}

/** Opens the picker and starts one harness by its profile id. */
export async function startHarness(page: Page, harnessId: string): Promise<void> {
  await openNewTabPicker(page);
  const item = page.locator(`[data-harness-id="${harnessId}"]`);
  await expect(item).toBeVisible();
  await item.click();
}
