import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import dayjs from 'dayjs';
import { ADMIN, ADMIN_TOTP_SECRET, BASE_URL, totp } from './fixtures.ts';

/**
 * Foreign-currency charges, credit card autopay, the FX converter, the watchlist with charts
 * (live Yahoo data — needs network) and the email notification settings. Runs after app.spec.ts
 * on the same throwaway database.
 */
test.describe.configure({ mode: 'serial' });

const SHOTS = resolve(import.meta.dirname, '../test-results/screens');
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const btn = (text: string) => new RegExp(`^${text.split('').join('\\s*')}$`);
const modal = (p: Page) => p.locator('.ant-modal:visible').last();

let context: BrowserContext;
let page: Page;

async function api<T = any>(method: string, path: string, data?: unknown): Promise<T> {
  const r = await page.request.fetch(`/api${path}`, { method, data, headers: { 'x-zui-csrf': '1', origin: BASE_URL } });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return (await r.json()) as T;
}

/** Choose an option in the antd Select labelled `label` inside `root` (a dialog). */
async function pick(root: Locator, label: string, option: string) {
  const input = root.getByLabel(label, { exact: true });
  await input.click();
  if ((await input.getAttribute('readonly')) === null) await input.pressSequentially(option.slice(0, 2));
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: option }).first().click();
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto('/login');
  await page.getByPlaceholder('用户名').fill(ADMIN.username);
  await page.getByPlaceholder('密码').fill(ADMIN.password);
  // A code from the next 30-second step, so it is never a replay of the other spec's login.
  await page.locator('.ant-otp input').first().click();
  await page.keyboard.type(totp(ADMIN_TOTP_SECRET, Date.now() + 30_000));
  await page.getByRole('button', { name: btn('登录') }).click();
  await expect(page.getByRole('heading', { name: `欢迎，${ADMIN.displayName}` })).toBeVisible();
});

test.afterAll(async () => {
  await context.close();
});

test('a USD charge paid from a CNY-only wallet: blank = current rate', async () => {
  const inst = await api('POST', '/institutions', { name: '支付宝', country: 'CN', type: 'ewallet' });
  await api('POST', '/accounts', { institutionId: inst.id, name: '余额', type: 'ewallet', currencies: [{ currency: 'CNY', openingBalance: 100000 }], openingDate: '2026-01-01' });
  await api('PUT', '/fx/CNY', { perUsd: 7.2 });

  await page.goto('/transactions');
  await page.getByRole('button', { name: '记一笔' }).click();
  await pick(modal(page), '账户', '余额 · CNY');
  await modal(page).getByText('外币消费').click();
  await modal(page).getByLabel('消费金额（原币）').fill('20');
  await modal(page).getByLabel('商户 / 对方').fill('ChatGPT');
  await expect(modal(page).getByText('留空则按当前汇率换算，约 ¥144.00')).toBeVisible();
  await shot(page, '30-foreign-charge');
  await modal(page).getByRole('button', { name: btn('保存') }).click();
  const row = page.locator('.ant-table-row').filter({ hasText: 'ChatGPT' });
  await expect(row).toContainText('-¥144.00');
  await expect(row).toContainText('$20.00');
});

test('credit card autopay: bound account repays on the due date', async () => {
  const inst = await api('POST', '/institutions', { name: '招商银行', country: 'CN', type: 'bank' });
  await api('POST', '/accounts', { institutionId: inst.id, name: '一卡通', type: 'checking', currencies: [{ currency: 'CNY', openingBalance: 500000 }], openingDate: '2026-01-01' });
  const credit = await api('POST', '/accounts', { institutionId: inst.id, name: '信用卡', type: 'credit', currencies: [{ currency: 'CNY', openingBalance: 0 }], openingDate: '2026-01-01', creditLimit: 5000000 });
  const card = await api('POST', '/cards', { accountId: credit.id, last4: '6688', funding: 'credit', nickname: '招行 Visa', statementDay: 1, dueDay: 20, theme: 'violet' });

  await page.goto(`/cards?card=${card.id}`);
  await page.getByRole('button', { name: btn('编辑') }).first().click();
  await pick(modal(page), '自动还款', '一卡通 · CNY');
  await expect(modal(page).getByText('全额还款')).toBeVisible();
  await shot(page, '31-card-autopay');
  await modal(page).getByRole('button', { name: btn('确定') }).click();
  await expect(modal(page)).toBeHidden();

  const today = dayjs().format('YYYY-MM-DD');
  await api('POST', '/statements', { cardId: card.id, statementDate: dayjs().subtract(19, 'day').format('YYYY-MM-DD'), dueDate: today, statementAmount: 325000 });
  await page.goto('/statements');
  const row = page.locator('.ant-table-row').filter({ hasText: today });
  await expect(row).toContainText('已还清');
  await expect(row).toContainText('自动还款');
  await expect(page.locator('.stat-tile').filter({ hasText: '招行 Visa' })).toContainText('自动还款：招商银行 · 一卡通');
  await shot(page, '32-statements-autopay');
});

test('FX converter between any two currencies', async () => {
  await page.goto('/fx');
  const result = page.locator('.fx-result');
  await expect(result).toHaveText('¥720.00');
  await page.getByRole('spinbutton', { name: '金额' }).fill('250');
  await expect(result).toHaveText('¥1,800.00');
  await page.getByRole('button', { name: '互换' }).click();
  await expect(result).toHaveText('$34.72');
  await shot(page, '33-fx-converter');
});

test('watchlist with Apple-Stocks-style charts (synced by hand)', async () => {
  await page.goto('/invest?tab=watch');
  const add = page.getByPlaceholder('输入代码，例如 AAPL');
  for (const s of ['MSFT', 'NVDA', 'AAPL']) {
    await add.fill(s);
    await add.press('Enter');
    await expect(page.locator('.watch-row').filter({ hasText: s })).toBeVisible();
  }
  await page.locator('.watch-list-card').getByRole('button', { name: /同\s*步/ }).click();
  await expect(page.locator('.watch-row').filter({ hasText: 'AAPL' }).locator('.change-pill')).not.toHaveText('—', { timeout: 30_000 });
  await expect(page.locator('.watch-row .sparkline path').first()).toBeVisible();

  await page.locator('.watch-row').filter({ hasText: 'AAPL' }).click();
  await page.getByRole('button', { name: '同步图表' }).first().click();
  const chart = page.locator('.price-chart svg');
  await expect(chart).toBeVisible({ timeout: 30_000 });
  await page.locator('.watch-ranges').getByText('1年', { exact: true }).click();
  const box = (await page.locator('.price-chart').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await expect(page.locator('.price-chart .viz-tooltip')).toBeVisible();
  await shot(page, '34-watchlist-chart');

  // Price alert on the symbol shown.
  await page.getByLabel('目标价').fill('1');
  await page.locator('.watch-alerts').getByText('跌到').click();
  await page.locator('.watch-alerts').getByRole('button', { name: /添\s*加/ }).click();
  await expect(page.locator('.watch-alerts')).toContainText('监控中');

  // Range table view for screen readers / exact values.
  await page.getByRole('button', { name: '数据表' }).click();
  await expect(page.locator('.watch-detail .ant-table-row').first()).toBeVisible();
});

test('email notification settings with editable templates', async () => {
  await page.goto('/notify');
  await expect(page.getByText('当前环境不能发送邮件')).toBeVisible();
  await page.getByText('编辑邮件内容').first().click();
  const preview = page.locator('.mail-preview').first();
  await expect(preview).toContainText('支付宝 · 余额');
  await page.locator('.notify-rule').first().getByLabel('标题').fill('余额不足：{{card}} 需要 {{needed}}');
  await expect(preview).toContainText('余额不足：招行 Visa 需要 ¥1,440.00');
  await shot(page, '35-notify');
  await page.getByRole('button', { name: btn('保存') }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await page.reload();
  await page.getByText('编辑邮件内容').first().click();
  await expect(page.locator('.notify-rule').first().getByLabel('标题')).toHaveValue('余额不足：{{card}} 需要 {{needed}}');
});

test('mobile: watchlist detail opens in a sheet', async ({ browser }) => {
  const phone = await browser.newContext({ storageState: await context.storageState(), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await phone.newPage();
  await p.goto('/invest?tab=watch');
  await expect(p.locator('.watch-row').first()).toBeVisible();
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(p, '36-mobile-watchlist');
  await p.locator('.watch-row').filter({ hasText: 'AAPL' }).click();
  await expect(p.locator('.ant-drawer .price-chart svg')).toBeVisible();
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${SHOTS}/37-mobile-chart.png` });
  await p.goto('/fx');
  await shot(p, '38-mobile-fx');
  await phone.close();
});
