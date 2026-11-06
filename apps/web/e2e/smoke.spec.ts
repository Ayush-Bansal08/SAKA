import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startMockApi, type MockApi } from './mock-api';

const SHOTS = fileURLToPath(new URL('../../../docs/ui-revamp/screenshots/after/', import.meta.url));
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

test('home answers the main question, with real numbers and a way into every view', async ({
  page,
}) => {
  await open(page);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
  await expect(page.getByText('Portfolio value')).toBeVisible();
  await expect(page.getByText('All-time P&L')).toBeVisible();
  await expect(page.getByText('Agent spend today')).toBeVisible();
  await expect(page.getByText('waiting for you').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}home.png` });
  await page.getByRole('link', { name: 'Ask SAKA' }).click();
  await expect(page).toHaveURL(/\/ask$/);
});

test('"swap $5" → preview with countdown → receipt in place with 0G proof', async ({ page }) => {
  await open(page, '/ask');
  await expect(page.getByRole('heading', { name: /I'm your agent/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}ask-empty.png` });
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
  await open(page, '/ask');
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
  await open(page, '/ask');
  await ask(page, 'Swap $500 ETH to USDC');
  const card = page.getByLabel('Refused').last();
  await expect(card.getByText('7.2 / max 5')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}refusal.png` });
  await card.getByRole('button', { name: 'Try instead: Swap $250 ETH to USDC' }).click();
  await expect(page.getByLabel('Message your agent').locator('textarea')).toHaveValue(
    'Swap $250 ETH to USDC',
  );
});

test('activity, autopilot, tablet and 375px mobile layouts', async ({ page }) => {
  await open(page, '/ask');
  await ask(page, 'Is USDC safe?');
  await expect(page.getByText('Looks safe', { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}ask-desktop.png` });
  await page.goto('/activity');
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: 'When it said no' }).click();
  await expect(page.getByRole('table').getByText('Refused').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}activity.png` });
  await page.goto('/inbox');
  await expect(page).toHaveURL(/\/autopilot$/);
  await expect(page.getByText('Needs your approval')).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open live activity' }).click();
  await expect(
    page.getByRole('dialog').getByRole('toolbar', { name: 'Filter activity' }),
  ).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Live activity')).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}home-tablet.png` });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  const tabs = page.getByRole('navigation', { name: 'Main' });
  await expect(tabs.getByRole('link', { name: 'Ask' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({ path: `${SHOTS}home-mobile.png` });
  await tabs.getByRole('link', { name: 'Activity' }).click();
  await expect(page).toHaveURL(/\/activity$/);
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
  await expect(page).toHaveURL(/\/ask$/);
  await expect(page.getByLabel('Message your agent').locator('textarea')).toHaveValue(
    'Exit 100% of position pos1',
  );

  await page.goto('/settings');
  await expect(page.getByRole('button', { name: 'Connect Telegram' })).toBeVisible();
  await expect(page.getByLabel('Your time zone')).toHaveValue('Asia/Kolkata');
  await page.screenshot({ path: `${SHOTS}settings.png`, fullPage: true });
  await page.goto('/autopilot/mandate');
  await expect(page.getByRole('switch', { name: 'Auto-act: Dip buys' })).toBeChecked();
  await page.screenshot({ path: `${SHOTS}autopilot-mandate.png`, fullPage: true });
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

test('old links keep their query string and the plan drawer still opens', async ({ page }) => {
  await open(page, '/inbox?plan=missing-plan');
  await expect(page).toHaveURL(/\/autopilot\?plan=missing-plan$/);
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('LP actions and New rule reach the chat from their new views', async ({ page }) => {
  await open(page, '/portfolio');
  await expect(page.getByText('In range')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}portfolio.png`, fullPage: true });
  await page.getByRole('button', { name: 'Rebalance' }).click();
  await expect(page).toHaveURL(/\/ask$/);
  await expect(page.getByLabel('Message your agent').locator('textarea')).toHaveValue(
    'Rebalance my ETH/USDC position lp_1 around the current price',
  );
  await page.goto('/autopilot/mandate');
  await page.getByRole('button', { name: 'New rule' }).click();
  await expect(page).toHaveURL(/\/ask$/);
  await expect(page.getByLabel('Message your agent').locator('textarea')).toHaveValue(
    'Sell half if ETH goes up 2%',
  );
});

test('simulator: old path redirects, scenarios run, no action reads as deliberate', async ({
  page,
}) => {
  await open(page, '/inbox/simulator');
  await expect(page).toHaveURL(/\/autopilot\/simulator$/);
  await expect(page.getByRole('heading', { name: 'Market Event Simulator' })).toBeVisible();
  await expect(page.getByText('SIMULATED').first()).toBeVisible();
  await page.getByRole('button', { name: 'Paper' }).click();
  await expect(page.getByText(/nothing is broadcast/)).toBeVisible();
  await page.getByRole('button', { name: 'Trigger A better LP pool?' }).click();
  await expect(page.getByText('No action', { exact: true })).toBeVisible();
  await expect(page.getByText(/chose not to act/)).toBeVisible();
  await expect(page.getByText('Supports waiting')).toBeVisible();
  await expect(page.getByText('Move now')).toHaveCount(0);
  await page.getByRole('button', { name: 'Alternatives considered' }).click();
  await expect(page.getByText('Move now')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}autopilot-simulator.png`, fullPage: true });
});

test('show agent internals opens the trace beside the chat and is remembered', async ({ page }) => {
  await open(page, '/ask');
  const internals = page.getByRole('switch', { name: 'Show agent internals' });
  await expect(page.getByRole('complementary', { name: 'Agent trace' })).toHaveCount(0);
  await internals.click();
  await expect(page.getByRole('complementary', { name: 'Agent trace' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('complementary', { name: 'Agent trace' })).toBeVisible();
  await page.getByRole('switch', { name: 'Show agent internals' }).click();
});

test('sidebar collapses to a rail and remembers it', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
});

for (const width of [360, 768, 1024, 1440]) {
  test(`no sideways scroll on any view at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page);
    for (const path of [
      '/',
      '/ask',
      '/autopilot',
      '/autopilot/mandate',
      '/autopilot/simulator',
      '/portfolio',
      '/activity',
      '/hooks',
      '/settings',
    ]) {
      await page.goto(path);
      await expect(page.locator('#main')).toBeVisible();
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${path} at ${width}px`).toBeLessThanOrEqual(0);
      if (width === 360)
        await page.screenshot({
          path: `${SHOTS}mobile${path === '/' ? '-home' : path.replace(/\//g, '-')}.png`,
        });
    }
  });
}

test('hooks stays reachable from the account menu on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page);
  await page.getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('menuitem', { name: 'Hooks' }).click();
  await expect(page).toHaveURL(/\/hooks$/);
});

test('signed out: the connect screen, not a broken dashboard', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}sign-in.png` });
});

test('on a phone the plan drawer is a bottom sheet that closes with Escape', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page, '/activity?plan=missing-plan');
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  const box = await sheet.boundingBox();
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(800);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
});

test('reduced motion stops the breathing glow', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '/ask');
  const name = await page.evaluate(() => {
    const el = document.createElement('span');
    el.className = 'agent-breathe';
    document.body.append(el);
    return getComputedStyle(el).animationName;
  });
  expect(name).toBe('none');
});

test('the keyboard reaches the tabs and shows a focus ring', async ({ page }) => {
  await open(page, '/autopilot');
  const tab = page.getByRole('navigation', { name: 'Autopilot' }).getByRole('link', {
    name: 'Mandate',
  });
  await tab.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  expect(await tab.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/autopilot\/mandate$/);
});

test('the approval link the API sends still works, and Reject trades nothing', async ({ page }) => {
  await open(page, '/ask');
  await ask(page, 'Swap $60 ETH to USDC');
  await expect(
    page
      .getByLabel('Approval needed')
      .last()
      .getByRole('button', { name: /Approve \(dev\)/ }),
  ).toBeVisible({ timeout: 15_000 });
  await page.goto('/autopilot');
  await expect(page.getByRole('button', { name: /Approve \(dev\)/ }).first()).toBeVisible();
  const pending = await page.evaluate(async () => {
    const token = JSON.parse(localStorage.getItem('warden.session') ?? '{}').token;
    const res = await fetch('http://127.0.0.1:3901/approvals/pending', {
      headers: { authorization: `Bearer ${token}` },
    });
    return (await res.json()) as { approvals: { id: string }[] };
  });
  await page.goto(`/approvals/${pending.approvals[0]!.id}`);
  await expect(page.getByRole('heading', { name: 'This needs you' })).toBeVisible();
  await expect(page.getByText('Expires in')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}approval-page.png` });
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText(/Nothing was traded/)).toBeVisible({ timeout: 10_000 });
});
