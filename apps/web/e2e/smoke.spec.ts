import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startMockApi, type MockApi } from './mock-api';

const SHOTS = fileURLToPath(new URL('../../../docs/screenshots/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });
let api: MockApi;

test.beforeAll(async () => {
  api = await startMockApi(3901);
});
test.afterAll(async () => api.close());

async function open(page: Page, path = '/') {
  await page.addInitScript(() =>
    localStorage.setItem(
      'warden.session',
      JSON.stringify({ token: 'mock', expiresAt: new Date(Date.now() + 864e5).toISOString() }),
    ),
  );
  await page.goto(path);
}

async function ask(page: Page, text: string) {
  const box = page.getByLabel('Message your agent').locator('textarea');
  await expect(box).toBeEnabled({ timeout: 20_000 });
  await box.fill(text);
  await box.press('Enter');
}

test('"swap $5" → preview with countdown → receipt in place with 0G proof', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('heading', { name: /I'm your agent/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}cockpit-empty.png` });
  await ask(page, 'Swap $5 ETH to USDC');
  const preview = page.getByLabel('Action preview');
  await expect(preview.getByText(/Agent will do this in/)).toBeVisible();
  await expect(preview.getByText('0G guard approved · p=0.96')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}preview-countdown.png` });
  const receipt = page.getByLabel('Receipt');
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel('Action preview')).toHaveCount(0); // transitioned in place
  await expect(receipt.getByText('0G Storage')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: `${SHOTS}receipt.png` });
  await receipt.getByRole('button', { name: /Details/ }).click();
  await expect(page.getByRole('dialog').getByText('Timeline')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('0x3593564c')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}plan-drawer.png` });
});

test('"swap $60" → approval → Reject → denied, nothing traded', async ({ page }) => {
  await open(page);
  await ask(page, 'Swap $60 ETH to USDC');
  const card = page.getByLabel('Approval needed').last();
  await expect(card.getByText('60 / max 25')).toBeVisible({ timeout: 15_000 });
  await expect(card.getByRole('button', { name: /Approve \(dev\)/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}approval.png` });
  await card.getByRole('button', { name: 'Reject' }).click();
  await expect(card.getByText('You rejected it. Nothing was traded.')).toBeVisible({
    timeout: 10_000,
  });
});

test('refusal card renders the suggestion chip and it pre-fills the composer', async ({ page }) => {
  await open(page);
  await ask(page, 'Swap $500 ETH to USDC');
  const card = page.getByLabel('Refused').last();
  await expect(card.getByText('7.2 / max 5')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}refusal.png` });
  await card.getByRole('button', { name: 'Try instead: Swap $250 ETH to USDC' }).click();
  await expect(page.getByLabel('Message your agent').locator('textarea')).toHaveValue(
    'Swap $250 ETH to USDC',
  );
});

test('activity, inbox, tablet and 375px mobile layouts', async ({ page }) => {
  await open(page);
  await ask(page, 'Is USDC safe?');
  await expect(page.getByText('Looks safe', { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}cockpit-desktop.png` });
  await page.goto('/activity');
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: 'When it said no' }).click();
  await expect(page.getByRole('table').getByText('Refused').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}activity.png` });
  await page.goto('/inbox');
  await expect(page.getByText('Needs your approval')).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open live activity' }).click();
  await expect(
    page.getByRole('dialog').getByRole('toolbar', { name: 'Filter activity' }),
  ).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Live activity')).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}cockpit-tablet.png` });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Agent' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({ path: `${SHOTS}cockpit-mobile.png` });
  await page.getByRole('tab', { name: 'Activity' }).click();
  await page.screenshot({ path: `${SHOTS}activity-mobile.png` });
});

test('hooks explorer: cards with scores and plain words, detail page with breakdown', async ({
  page,
}) => {
  await open(page, '/hooks');
  await expect(page.getByLabel('Safety score 25 of 100, Danger')).toBeVisible();
  await expect(page.getByText('Can change your swap amount').first()).toBeVisible();
  await page.getByRole('button', { name: 'Safe', exact: true }).click();
  await page.screenshot({ path: `${SHOTS}hooks.png` });
  await page.getByRole('link', { name: 'DynamicFeeHook' }).click();
  await expect(page.getByText('return delta permissions')).toBeVisible();
  await expect(page.getByText('-25')).toBeVisible();
  await expect(page.getByText('Owner changed to 0x1111…1111')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}hook-detail.png`, fullPage: true });
});

test('inbox: pinned brief, red alert, Yes / Change / No, nav badge; settings controls', async ({
  page,
}) => {
  await open(page, '/inbox');
  await expect(page.getByText('Portfolio: $2,600.00 (+1.2% in 24 h).')).toBeVisible();
  const red = page.getByRole('listitem', { name: /Hook 0xa0c0/ });
  await expect(red.getByText('Red alert')).toBeVisible();
  await expect(red.getByText('Simulated (demo)')).toBeVisible();
  await expect(red.getByText('Fresh human check')).toBeVisible();
  await expect(page.getByLabel('2 waiting for you').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}inbox.png`, fullPage: true });

  const dip = page.getByRole('listitem', { name: /ETH dipped/ });
  await dip.getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByText('Your agent is doing it now.')).toBeVisible();
  await expect(dip.getByRole('button', { name: 'Yes' })).toHaveCount(0);
  await expect(page.getByLabel('1 waiting for you').first()).toBeVisible();

  await red.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel('Message your agent').locator('textarea')).toHaveValue(
    'Exit 100% of position pos1',
  );

  await page.goto('/settings');
  await expect(page.getByRole('button', { name: 'Connect Telegram' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Auto-act: Dip buys' })).toBeChecked();
  await expect(page.getByLabel('Your time zone')).toHaveValue('Asia/Kolkata');
  await page.screenshot({ path: `${SHOTS}settings-alerts.png`, fullPage: true });
});

test('a Telegram "Change" link opens the chat pre-filled and cleans the address', async ({
  page,
}) => {
  await open(page, '/?prefill=Buy%20%2420%20of%20ETH&suggestion=abc');
  await expect(page.getByLabel('Message your agent').locator('textarea')).toHaveValue(
    'Buy $20 of ETH',
  );
  await expect(page).not.toHaveURL(/prefill/);
});

test('the inbox fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, '/inbox');
  await expect(page.getByText('Morning brief').first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({ path: `${SHOTS}inbox-mobile.png`, fullPage: true });
});
