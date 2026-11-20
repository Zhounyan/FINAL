import { expect, test, type Page } from '@playwright/test';

// One stateful journey through a freshly deployed system (fresh database):
// setup → catalogue → cashiers → POS sales → invoices → voids → the six reports.
test.describe.configure({ mode: 'serial' });

const ADMIN = { name: 'Bill Admin', email: 'admin@billstore.test', password: 'Mango#Tree7!x' };
const MARIA = { name: 'Maria Santos', username: 'maria', email: 'maria@billstore.test', temp: 'Temp#Maria1', password: 'Maria#Strong2026' };
// a cashier without an e-mail address: signs in with the username only
const PEDRO = { name: 'Pedro Reyes', username: 'pedro', email: 'pedro@cashier.invportiq.invalid', temp: 'Temp#Pedro1', password: 'Pedro#Strong2026' };

let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}\n${(e.stack ?? '').split('\n').slice(0, 6).join('\n')}`));
  // Surface failing API calls in the test output (helps diagnose any failure).
  page.on('response', async (r) => {
    if (r.status() >= 500 || (r.status() >= 400 && r.url().includes('/rest/v1/') && !r.url().includes('rpc/'))) {
      console.log(`[api ${r.status()}] ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    }
  });
});
test.afterAll(async () => {
  await page.close();
});

const GROUPS: Record<string, string> = {
  'Stock-In': 'Stock Management',
  'Stock-Out': 'Stock Management',
  'Stock Movement History': 'Stock Management',
  'Daily Report': 'Stock Management',
  'Weekly Report': 'Stock Management',
  'Monthly Report': 'Stock Management',
  'Daily Sales': 'Sales Reports',
  'Weekly Sales': 'Sales Reports',
  'Monthly Sales': 'Sales Reports',
};

async function nav(label: string) {
  const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
  if (label === 'Backup & Restore') {
    await sidebar.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Open Backup & Restore' }).click();
    return;
  }
  const group = GROUPS[label];
  const link = sidebar.getByRole('link', { name: label, exact: true });
  if (group && !(await link.isVisible())) await sidebar.getByRole('button', { name: group }).click();
  await link.click();
}

async function login(user: string, password: string, p: Page = page) {
  await p.goto('/login');
  await p.getByLabel('Username or email').fill(user);
  await p.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
  await p.getByRole('button', { name: 'Sign in' }).click();
}

async function logout() {
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Logout' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

async function expectToast(text: string | RegExp) {
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: text }).first()).toBeVisible();
}

async function pickProduct(name: RegExp) {
  await page.getByRole('combobox', { name: /^Product/ }).click();
  await page.getByRole('option', { name }).click();
}

async function changeTempPassword(temp: string, password: string) {
  await expect(page).toHaveURL(/\/profile/);
  const form = page.getByTestId('change-password-form');
  await form.getByLabel('Current password').fill(temp);
  await form.getByRole('textbox', { name: 'New password', exact: true }).fill(password);
  await form.getByLabel('Confirm new password').fill(password);
  await form.getByRole('button', { name: 'Change password' }).click();
}

async function docxText(path: string): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const { unzipSync, strFromU8 } = await import('fflate');
  const entries = unzipSync(new Uint8Array(readFileSync(path)));
  return strFromU8(entries['word/document.xml']);
}

test('fresh deployment shows the one-time administrator setup with a live password meter', async () => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Initial administrator setup' })).toBeVisible();

  const pw = page.getByRole('textbox', { name: 'Password', exact: true });
  const label = page.getByTestId('strength-label');
  await pw.fill('a');
  await expect(label).toHaveText('Poor');
  await pw.fill('abcdefgh1');
  await expect(label).toHaveText('Weak');
  await pw.fill('Abcdefgh1');
  await expect(label).toHaveText('Fair');
  await pw.fill('Mango#Tr7');
  await expect(label).toHaveText('Good');
  await pw.fill('Mango#Tree7xz');
  await expect(label).toHaveText('Strong');
  await pw.fill('Mango#Tree7x!Rivr');
  await expect(label).toHaveText('Super Strong');

  // weak password is rejected by validation
  await page.getByLabel('Full name').fill(ADMIN.name);
  await page.getByLabel('Email address').fill(ADMIN.email);
  await pw.fill('weakpass');
  await page.getByLabel('Confirm password').fill('weakpass');
  await page.getByRole('button', { name: 'Create administrator account' }).click();
  await expect(page.getByText(/Password must include/)).toBeVisible();

  await pw.fill(ADMIN.password);
  await page.getByLabel('Confirm password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Create administrator account' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByTestId('sales-overview')).toContainText('₱0.00');
});

test('initial setup cannot be repeated by visiting its URL', async () => {
  await page.goto('/setup');
  await expect(page).not.toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('admin manages categories, suppliers and customers (newest first)', async () => {
  await nav('Categories');
  for (const name of ['Beverages', 'Food Products', 'Snacks']) {
    await page.getByRole('button', { name: 'Add category' }).click();
    await page.getByRole('dialog').getByLabel('Category name').fill(name);
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expectToast('Category added.');
  }
  await expect(page.getByTestId('categories-table').locator('tbody tr').first()).toContainText('Snacks');
  await page.getByRole('button', { name: 'Add category' }).click();
  await page.getByRole('dialog').getByLabel('Category name').fill('beverages');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expectToast(/already exists/);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  await nav('Suppliers');
  await page.getByRole('button', { name: 'Add supplier' }).first().click();
  await page.getByRole('dialog').getByLabel('Company / supplier name').fill('Metro Distributors');
  await page.getByRole('dialog').getByLabel('Contact person').fill('Ana Cruz');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expectToast('Supplier added.');

  await nav('Customers');
  await page.getByRole('button', { name: 'Add customer' }).first().click();
  await page.getByRole('dialog').getByLabel('Full name').fill('Juan Dela Cruz');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expectToast('Customer added.');
});

test('admin adds products with barcode, supplier, image and opening stock; codes are unique', async () => {
  await nav('Products');
  const add = async (p: { name: string; sku: string; barcode?: string; category: string; unit: string; min: string; price: string; cost?: string; opening: string; image?: boolean }) => {
    await page.getByRole('button', { name: 'Add product' }).first().click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Product name').fill(p.name);
    await d.getByLabel('SKU / Product code').fill(p.sku);
    if (p.barcode) await d.getByLabel('Barcode').fill(p.barcode);
    await d.getByLabel('Category').selectOption({ label: p.category });
    await d.getByLabel('Unit').fill(p.unit);
    await d.getByLabel('Minimum stock level').fill(p.min);
    await d.getByLabel('Selling price').fill(p.price);
    if (p.cost) await d.getByLabel('Purchase price').fill(p.cost);
    await d.getByLabel('Supplier').selectOption({ label: 'Metro Distributors' });
    await d.getByRole('spinbutton', { name: 'Opening stock', exact: true }).fill(p.opening);
    if (p.image) {
      await d.getByLabel('Product image').setInputFiles('public/logo-192.png');
      await expect(d.getByRole('img', { name: 'Product' })).toBeVisible();
    }
    await d.getByRole('button', { name: 'Add product' }).click();
    await expect(d).toBeHidden();
    await expectToast(/Product added/);
  };
  await add({ name: 'Cola 1L', sku: 'BEV-001', barcode: '4801234567890', category: 'Beverages', unit: 'bottle', min: '20', price: '55', cost: '40', opening: '300', image: true });
  await add({ name: 'Rice 5kg', sku: 'FOOD-001', category: 'Food Products', unit: 'sack', min: '10', price: '260', opening: '50' });
  await add({ name: 'Candy Pop', sku: 'SNK-001', category: 'Snacks', unit: 'pc', min: '5', price: '1.50', opening: '0' });
  const rows = page.getByTestId('products-table').locator('tbody tr');
  await expect(rows.first()).toContainText('Candy Pop');
  await expect(rows.filter({ hasText: 'Cola 1L' })).toContainText('4801234567890');

  // duplicate SKU and barcode are refused
  await page.getByRole('button', { name: 'Add product' }).first().click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Product name').fill('Copy');
  await d.getByLabel('SKU / Product code').fill('bev-001');
  await d.getByLabel('Category').selectOption({ label: 'Beverages' });
  await d.getByRole('button', { name: 'Add product' }).click();
  await expectToast(/already exists/);
  await d.getByLabel('SKU / Product code').fill('BEV-099');
  await d.getByLabel('Barcode').fill('4801234567890');
  await d.getByRole('button', { name: 'Add product' }).click();
  await expectToast(/barcode .* already exists/);
  await d.getByRole('button', { name: 'Cancel' }).click();
});

test('admin creates two cashier accounts (one without e-mail)', async () => {
  await nav('User Management');
  for (const u of [MARIA, PEDRO]) {
    await page.getByRole('button', { name: 'Add Cashier' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Full name').fill(u.name);
    await d.getByLabel('Username').fill(u.username);
    if (u === MARIA) await d.getByLabel('Email address (optional)').fill(u.email);
    await d.getByLabel('Temporary password').fill(u.temp);
    await d.getByLabel('Confirm password').fill(u.temp);
    await d.getByRole('button', { name: 'Create cashier' }).click();
    await expectToast(/Cashier account created/);
  }
  const table = page.getByTestId('users-table');
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await expect(table.locator('tbody tr').filter({ hasText: PEDRO.name })).toContainText('No e-mail');
  await page.getByLabel('Filter by role').selectOption('cashier');
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await page.getByLabel('Filter by role').selectOption('all');
});

test('stock-in and stock-out change inventory through the ledger, with unique reference numbers', async () => {
  await nav('Stock-In');
  await pickProduct(/Cola 1L/);
  await expect(page.getByLabel('Unit cost')).toHaveValue('40.00'); // filled in from the purchase price
  await page.getByLabel('Quantity received').fill('100');
  await expect(page.getByTestId('stock-in-total-cost')).toContainText('₱4,000.00');
  await expect(page.getByTestId('stock-in-total-cost')).toContainText('100 × ₱40.00');
  await page.getByLabel('Unit cost').fill('42');
  await expect(page.getByTestId('stock-in-total-cost')).toContainText('₱4,200.00');
  await page.getByLabel('Unit cost').fill('40');
  await page.getByLabel('Supplier').selectOption({ label: 'Metro Distributors' });
  await page.getByLabel('Supporting document no.').fill('DR-1001');
  await page.getByLabel('Remarks').fill('Weekly delivery');
  await page.getByRole('button', { name: 'Record Stock-In' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Stock changed from 300 to 400 · Reference IN-\d{6}/ })).toBeVisible();
  await expect(page.getByTestId('movement-history')).toContainText('DR-1001');
  await expect(page.getByRole('status').filter({ hasText: 'Total cost ₱4,000.00 (100 × ₱40.00)' })).toBeVisible();
  await expect(page.getByTestId('movement-history').locator('tbody tr').filter({ hasText: 'DR-1001' })).toContainText('₱4,000.00');

  await nav('Stock-Out');
  await pickProduct(/Rice 5kg/);
  await page.getByLabel('Stock-out reason').selectOption('damaged');
  await page.getByLabel('Quantity released').fill('500');
  await page.getByRole('button', { name: 'Record Stock-Out' }).click();
  await expect(page.getByText('Only 50 sack available')).toBeVisible(); // negative stock prevented
  await page.getByLabel('Quantity released').fill('5');
  await page.getByLabel('Remarks').fill('Torn sacks');
  await page.getByRole('button', { name: 'Record Stock-Out' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Record Stock-Out' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Stock changed from 50 to 45 · Reference OUT-\d{6}/ })).toBeVisible();

  await nav('Inventory');
  await expect(page.getByTestId('inventory-cards')).toContainText('445'); // 400 + 45 + 0
  await expect(page.getByTestId('inventory-table').locator('tbody tr').filter({ hasText: 'Candy Pop' })).toContainText('Out of stock');

  // one central history; a stock-out mistake is reversed (once)
  await nav('Stock Movement History');
  const history = page.getByTestId('movement-history');
  await expect(history).toContainText('Stock-Out: Damaged');
  const damaged = history.locator('tbody tr').filter({ hasText: 'Torn sacks' });
  await expect(damaged).toContainText(/OUT-\d{6}/);
  await damaged.getByRole('button', { name: 'Reverse' }).click();
  await page.getByRole('dialog').getByLabel('Reason for reversal').fill('Sacks were repairable');
  await page.getByRole('dialog').getByRole('button', { name: 'Record reversal' }).click();
  await expectToast(/reversed/);
  await expect(damaged).toContainText('Reversed');
  await expect(damaged.getByRole('button', { name: 'Reverse' })).toHaveCount(0);
  await page.getByLabel('Movement type').selectOption('stock_in');
  await expect(history.locator('tbody tr')).toHaveCount(3); // two opening stocks + DR-1001
  await logout();
});

test('cashier signs in with a username, changes the temporary password and sees only cashier pages', async () => {
  await login(MARIA.username, MARIA.temp);
  await changeTempPassword(MARIA.temp, MARIA.password);
  await expect(page.getByText('Ready to sell?')).toBeVisible();
  const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
  const links = await sidebar.getByRole('link').allInnerTexts();
  expect(links.map((l) => l.trim())).toEqual(['Point of Sale', 'Dashboard', 'Products', 'My Sales & Invoices', 'My Profile']);
  for (const path of ['/inventory', '/stock/in', '/stock/history', '/sales', '/sales-reports/daily', '/stock/reports/daily', '/users', '/activity', '/settings', '/backups', '/suppliers']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Access restricted' }), path).toBeVisible();
  }
  // products are read-only for cashiers (no add / edit / delete, no cost prices)
  await nav('Products');
  await expect(page.getByRole('button', { name: 'Add product' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Delete / })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Cost' })).toHaveCount(0);
});

test('POS: search, barcode scan, cart corrections, cash payment with change and invoice', async () => {
  await nav('Point of Sale');
  const search = page.getByLabel('Search Product');
  const cart = page.getByTestId('cart');
  // partial, case-insensitive name search
  await search.fill('COL');
  await page.getByRole('button', { name: 'Add Cola 1L to cart' }).click();
  // barcode scanner: types the code and presses Enter — same product, quantity goes up
  await search.fill('4801234567890');
  await search.press('Enter');
  await expectToast(/already in the cart — quantity is now 2/);
  await expect(search).toHaveValue('');
  await page.getByRole('button', { name: 'Increase quantity of Cola 1L' }).click();
  await page.getByRole('button', { name: 'Decrease quantity of Cola 1L' }).click();
  await expect(page.getByLabel('Quantity of Cola 1L', { exact: true })).toHaveValue('2');
  // search by SKU, add a wrong item and remove it
  await search.fill('food-001');
  await page.getByRole('button', { name: 'Add Rice 5kg to cart' }).click();
  await search.fill('candy');
  await expect(page.getByRole('button', { name: 'Add Candy Pop to cart' })).toBeDisabled(); // out of stock
  await search.fill('');
  await page.getByRole('button', { name: 'Remove Rice 5kg' }).click();
  await expect(cart.getByTestId('cart-line')).toHaveCount(1);
  await search.fill('rice');
  await page.getByRole('button', { name: 'Add Rice 5kg to cart' }).click();
  await page.getByLabel('Quantity of Rice 5kg', { exact: true }).fill('2');
  // cannot exceed available stock
  await page.getByLabel('Quantity of Cola 1L', { exact: true }).fill('9999');
  await expectToast(/Only 400 bottle of Cola 1L in stock/);
  await expect(page.getByLabel('Quantity of Cola 1L', { exact: true })).toHaveValue('400');
  await page.getByLabel('Quantity of Cola 1L', { exact: true }).fill('2');
  await expect(page.getByTestId('pos-total')).toHaveText('₱630.00');

  // insufficient cash is blocked
  const complete = page.getByRole('button', { name: 'Complete Sale' });
  await expect(complete).toBeDisabled();
  await page.getByLabel('Amount Received').fill('500');
  await expect(page.getByText('Amount received is ₱130.00 short.')).toBeVisible();
  await expect(complete).toBeDisabled();
  await page.getByRole('button', { name: '₱1,000.00' }).click();
  await expect(page.getByTestId('pos-change')).toHaveText('₱370.00');
  await complete.click();
  const done = page.getByRole('dialog', { name: 'Sale completed' });
  await expect(done.getByTestId('sale-change')).toHaveText('₱370.00');
  await expect(done).toContainText(/INV-\d{6} · TXN-\d{8}-\d{5}/);

  // invoice: real data, printable, PDF and editable Word
  await done.getByRole('button', { name: 'View Invoice' }).click();
  const inv = page.getByTestId('invoice-view');
  await expect(inv).toContainText(MARIA.name);
  await expect(inv).toContainText('Cola 1L');
  await expect(page.getByTestId('invoice-totals')).toContainText('₱630.00');
  const invoiceNo = (await page.getByRole('dialog').filter({ has: inv }).getByRole('heading').first().innerText()).replace('Invoice ', '').trim();
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('dialog').filter({ has: inv }).getByRole('button', { name: 'PDF' }).click()]);
  expect(pdf.suggestedFilename()).toBe(`${invoiceNo}.pdf`);
  const { statSync } = await import('node:fs');
  expect(statSync(await pdf.path()).size).toBeGreaterThan(5000);
  const [word] = await Promise.all([page.waitForEvent('download'), page.getByRole('dialog').filter({ has: inv }).getByRole('button', { name: 'Word' }).click()]);
  expect(word.suggestedFilename()).toBe(`${invoiceNo}.docx`);
  const xml = await docxText(await word.path());
  expect(xml).toContain(invoiceNo);
  expect(xml).toContain('Maria Santos');
  expect(xml).toContain('Rice 5kg');
  const invoiceDialog = page.getByRole('dialog').filter({ has: inv });
  await invoiceDialog.getByRole('button', { name: 'Print Invoice' }).click();
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
  await invoiceDialog.getByRole('button', { name: 'Close dialog' }).click();
  await done.getByRole('button', { name: 'New Transaction' }).click();
  await expect(cart).toContainText('The cart is empty');
  await expect(search).toBeFocused();
});

test('POS: non-cash payment, and a double-click never records the sale twice', async () => {
  const search = page.getByLabel('Search Product');
  await search.fill('cola');
  await expect(page.getByRole('button', { name: 'Add Cola 1L to cart' })).toContainText('398 bottle left'); // 400 − 2 sold
  await page.getByRole('button', { name: 'Add Cola 1L to cart' }).click();
  await page.getByRole('button', { name: 'GCash', exact: true }).click();
  await page.getByLabel(/GCash reference no/).fill('GC-123');
  await page.getByLabel('Customer name (optional)').fill('Walk-in Ana');
  await page.getByRole('button', { name: 'Complete Sale' }).dblclick();
  const done = page.getByRole('dialog', { name: 'Sale completed' });
  await expect(done).toContainText('GCash');
  await done.getByRole('button', { name: 'New Transaction' }).click();

  await nav('My Sales & Invoices');
  const rows = page.getByTestId('sales-table').locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('GCash');
  await expect(rows.first()).toContainText('₱55.00');

  await nav('Dashboard');
  await expect(page.getByTestId('my-summary')).toContainText('₱685.00');
  // the old invoice address now opens the merged page
  await page.goto('/my-invoices');
  await expect(page).toHaveURL(/\/my-sales$/);
  await expect(page.getByTestId('sales-table').locator('tbody tr')).toHaveCount(2);
  await logout();
});

test('second cashier (username only) sells and cannot see the other cashier\'s transactions', async () => {
  await login(PEDRO.username, PEDRO.temp);
  await changeTempPassword(PEDRO.temp, PEDRO.password);
  await expect(page.getByText('Ready to sell?')).toBeVisible();
  await nav('Point of Sale');
  await page.getByLabel('Search Product').fill('rice');
  await page.getByRole('button', { name: 'Add Rice 5kg to cart' }).click();
  await page.getByLabel('Amount Received').fill('300');
  await expect(page.getByTestId('pos-change')).toHaveText('₱40.00');
  await page.getByRole('button', { name: 'Complete Sale' }).click();
  await expect(page.getByRole('dialog', { name: 'Sale completed' }).getByTestId('sale-change')).toHaveText('₱40.00');
  await page.getByRole('button', { name: 'New Transaction' }).click();
  await nav('My Sales & Invoices');
  await expect(page.getByTestId('sales-table').locator('tbody tr')).toHaveCount(1);
  await expect(page.getByTestId('sales-table')).not.toContainText('GCash');
  await logout();
});

test('admin sees all transactions, filters by cashier and voids a sale (stock returns, invoice marked VOID)', async () => {
  await login(ADMIN.email, ADMIN.password);
  await nav('Sales Transactions & Invoices');
  const rows = page.getByTestId('sales-table').locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await page.getByLabel('Filter by cashier').selectOption({ label: PEDRO.name });
  await expect(rows).toHaveCount(1);
  await rows.first().getByRole('button', { name: /^View / }).click();
  await page.getByRole('button', { name: 'Void transaction' }).click();
  const voidDialog = page.getByRole('dialog', { name: /^Void TXN-/ });
  await expect(voidDialog.getByRole('button', { name: 'Void transaction' })).toBeDisabled();
  await voidDialog.getByLabel('Reason for voiding').fill('Customer returned the sack');
  await voidDialog.getByRole('button', { name: 'Void transaction' }).click();
  await expectToast(/voided. The items were returned to stock/);
  await expect(rows.first()).toContainText('Voided');
  await rows.first().getByRole('button', { name: /^View / }).click();
  await expect(page.getByTestId('invoice-view')).toContainText('VOID');
  await expect(page.getByTestId('invoice-view')).toContainText('Customer returned the sack');
  await page.getByRole('button', { name: 'Close dialog' }).click();

  await nav('Inventory');
  await expect(page.getByTestId('inventory-table').locator('tbody tr').filter({ hasText: 'Rice 5kg' })).toContainText('48'); // 50 − 2 sold (void returned 1)
  // invoices are exported straight from the merged list (no new sale is created)
  await nav('Sales Transactions & Invoices');
  const first = page.getByTestId('sales-table').locator('tbody tr').first();
  const [doc] = await Promise.all([page.waitForEvent('download'), first.getByRole('button', { name: /^Download Word file of INV-/ }).click()]);
  expect(doc.suggestedFilename()).toMatch(/^INV-\d{6}\.docx$/);
  const [pdfFile] = await Promise.all([page.waitForEvent('download'), first.getByRole('button', { name: /^Download PDF of INV-/ }).click()]);
  expect(pdfFile.suggestedFilename()).toMatch(/^INV-\d{6}\.pdf$/);
  await expect(page.getByTestId('sales-table').locator('tbody tr')).toHaveCount(3);
});

test('sales reports: daily, weekly and monthly from completed sales only, with PDF, Word and print', async () => {
  for (const [label, title] of [
    ['Daily Sales', 'Daily Sales Report'],
    ['Weekly Sales', 'Weekly Sales Report'],
    ['Monthly Sales', 'Monthly Sales Report'],
  ] as const) {
    await nav(label);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    const cards = page.getByTestId('sales-report-cards');
    await expect(cards).toContainText('₱685.00'); // 630 + 55; the voided 260 is not counted
    await expect(cards).toContainText('Voided / refunded');
    await expect(page.getByTestId('sales-summary')).toContainText('Net sales');
    await expect(page.getByTestId('by-cashier')).toContainText(MARIA.name);
    await expect(page.getByTestId('by-cashier')).not.toContainText(PEDRO.name);
    await expect(page.getByTestId('by-payment')).toContainText('GCash');
    await expect(page.getByTestId('best-sellers').locator('tbody tr').first()).toContainText('Cola 1L');
    await expect(page.getByTestId('report-transactions').locator('tbody tr')).toHaveCount(3);
  }
  // exports from the monthly report
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PDF' }).click()]);
  expect(pdf.suggestedFilename()).toMatch(/^Monthly-Sales-Report-\d{4}-\d{2}-01-to-\d{4}-\d{2}-\d{2}\.pdf$/);
  const [word] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Word' }).click()]);
  const xml = await docxText(await word.path());
  for (const text of ['Monthly Sales Report', 'Net sales', '₱685.00', 'Maria Santos', 'Best-selling products', 'VOIDED']) expect(xml, text).toContain(text);
  await page.getByRole('button', { name: 'Print' }).click();
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
});

test('stock management reports: daily, weekly and monthly keep stock-in, stock-out and sales separate', async () => {
  for (const [label, title] of [
    ['Daily Report', 'Daily Stock Management Report'],
    ['Weekly Report', 'Weekly Stock Management Report'],
    ['Monthly Report', 'Monthly Stock Management Report'],
  ] as const) {
    await nav(label);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    const cards = page.getByTestId('stock-report-cards');
    await expect(cards).toContainText('450'); // opening 300 + 50, delivery 100
    await expect(cards).toContainText('3 stock-in transaction(s)');
    await expect(cards).toContainText('1 stock-out transaction(s)');
    await expect(cards.getByText('Sales deductions').locator('..').locator('..')).toContainText('6'); // 2 + 2 + 1 + 1 units
    await expect(page.getByTestId('products-received')).toContainText('Cola 1L');
    await expect(page.getByTestId('products-released')).toContainText('Rice 5kg');
  }
  // product and movement-type filters
  await page.getByLabel('Movement type').selectOption('stock_out');
  await expect(page.getByTestId('movement-history').locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('Movement type').selectOption('');
  await pickProduct(/Cola 1L/);
  await expect(page.getByTestId('movement-history')).not.toContainText('Rice 5kg');
  const [word] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Word' }).click()]);
  const xml = await docxText(await word.path());
  for (const text of ['Monthly Stock Management Report', 'Total Stock-In quantity', 'Stock movement history', 'Product: Cola 1L']) expect(xml, text).toContain(text);
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PDF' }).click()]);
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
});

test('administrator dashboard and activity logs reflect real operations', async () => {
  await nav('Dashboard');
  await expect(page.getByTestId('sales-overview')).toContainText("Today's sales");
  await expect(page.getByTestId('sales-overview')).toContainText('₱685.00');
  await expect(page.getByTestId('inventory-overview')).toContainText('445'); // Cola 397 + Rice 48 + Candy 0
  await expect(page.getByTestId('recent-sales')).toContainText('Voided');
  await expect(page.getByTestId('cashier-activity')).toContainText(MARIA.name);

  await nav('Activity Logs');
  const table = page.getByTestId('activity-table');
  for (const action of ['sale', 'invoice_generated', 'sale_voided', 'stock_in', 'stock_out', 'user_created', 'login']) {
    await page.getByLabel('Filter by action').selectOption(action);
    await expect(table.locator('tbody tr').first(), action).toBeVisible();
  }
  await page.getByLabel('Filter by action').selectOption('');
  await page.getByLabel('Filter by user').selectOption({ label: MARIA.name });
  await expect(table).toContainText('Invoice');
  await expect(table).not.toContainText(PEDRO.name);
});

test('repeated failed sign-ins lock the account temporarily', async () => {
  await logout();
  for (let i = 0; i < 5; i++) {
    await login(PEDRO.username, 'Wrong#Pass1');
    await expect(page.getByRole('alert').filter({ hasText: /Invalid username\/email or password|temporarily locked/ })).toBeVisible();
  }
  await login(PEDRO.username, PEDRO.password); // correct password, but locked
  await expect(page.getByRole('alert').filter({ hasText: /temporarily locked/ })).toBeVisible();
});

test('responsive layout on a phone', async ({ browser }) => {
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await login(ADMIN.email, ADMIN.password, phone);
  await expect(phone.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await phone.getByRole('button', { name: 'Open menu' }).click();
  await phone.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Point of Sale', exact: true }).click();
  await expect(phone.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();
  await phone.getByLabel('Search Product').fill('cola');
  await phone.getByRole('button', { name: 'Add Cola 1L to cart' }).click();
  await expect(phone.getByText(/1 item\(s\) · ₱55.00/)).toBeVisible(); // sticky total bar
  await phone.screenshot({ path: 'test-results/mobile-pos.png', fullPage: false });
  await phone.getByRole('button', { name: 'Remove Cola 1L' }).click();

  expect(await phone.locator('meta[name=viewport]').getAttribute('content')).toContain('user-scalable=no');
  for (const path of ['/', '/pos', '/products', '/categories', '/inventory', '/stock/in', '/stock/out', '/stock/history', '/stock/reports/daily', '/sales', '/sales-reports/daily', '/suppliers', '/customers', '/users', '/activity', '/settings', '/backups', '/profile']) {
    await phone.goto(path);
    await expect(phone.locator('main h1').first(), path).toBeVisible();
    await phone.waitForTimeout(300);
    const problems = await phone.evaluate(() => {
      const w = window.innerWidth;
      const out: string[] = [];
      const scrollsX = (el: Element | null): boolean => {
        for (let p = el?.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === 'auto' || o === 'scroll' || o === 'hidden') return true;
        }
        return false;
      };
      for (const el of document.querySelectorAll('main *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > w + 1 && !scrollsX(el)) out.push(`${el.tagName}.${String((el as HTMLElement).className).slice(0, 60)} right=${Math.round(r.right)}`);
      }
      for (const el of document.querySelectorAll('main input:not([type=checkbox]):not([type=radio]):not([type=file]), main select, main textarea')) {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < 16) out.push(`${el.tagName} font ${fs}px`);
      }
      return out.slice(0, 5);
    });
    expect(problems, path).toEqual([]);
  }
  await phone.close();
});

test('notification bell lists stock alerts and opens Stock-In for the product', async () => {
  await login(ADMIN.email, ADMIN.password);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await nav('Inventory');
  await page.getByRole('button', { name: 'Adjust stock' }).click();
  await pickProduct(/Rice 5kg/);
  await page.getByLabel('New counted quantity').fill('5');
  await page.getByLabel('Adjustment reason').fill('Physical count');
  await page.getByRole('button', { name: 'Record adjustment' }).click();
  await page.getByRole('dialog', { name: 'Record stock adjustment?' }).getByRole('button', { name: 'Record adjustment' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'to 5' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.reload();
  const bell = page.getByRole('button', { name: /^Notifications/ });
  await expect(bell).toHaveAccessibleName(/[1-9]\d* unread/);
  await bell.click();
  const notice = page.getByTestId('notification-list').getByRole('button', { name: /Rice 5kg is running low/ });
  await expect(notice).toContainText('5 sack left');
  await notice.click();
  await expect(page).toHaveURL(/\/stock\/in\?product=\d+/);
  await expect(page.getByRole('combobox', { name: /^Product/ })).toHaveValue(/Rice 5kg/);
});

test('admin deletes a cashier account and can recover it within 7 days', async () => {
  await nav('User Management');
  const row = () => page.getByTestId('users-table').locator('tbody tr').filter({ hasText: PEDRO.name });
  await row().getByRole('button', { name: `Delete ${PEDRO.name}` }).click();
  await expect(page.getByRole('dialog')).toContainText('permanently deleted after 7 days');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete account' }).click();
  await expectToast(/will be permanently deleted in 7 days/);
  await expect(row()).toContainText('Deletion pending');
  await row().getByRole('button', { name: `Recover ${PEDRO.name}` }).click();
  await expectToast(/was recovered/);
  await expect(row()).toContainText('Active');
  // deactivated cashiers keep their history
  await row().getByRole('button', { name: `Deactivate ${PEDRO.name}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deactivate' }).click();
  await expectToast(/deactivated/);
  await nav('Sales Transactions & Invoices');
  await expect(page.getByTestId('sales-table')).toContainText(PEDRO.name);
  await nav('User Management');
  await row().getByRole('button', { name: `Activate ${PEDRO.name}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Activate' }).click();
  await expectToast(/activated/);
});

test('users can upload, change and remove their profile photo', async () => {
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'My Profile' })).toBeVisible();
  const photo = page.getByTestId('profile-photo');
  await page.getByLabel('Choose profile photo').setInputFiles('public/logo-192.png');
  await expectToast('Profile photo updated.');
  // shown on the profile page and in the top bar
  await expect(photo.getByRole('img', { name: `${ADMIN.name}'s photo` })).toBeVisible();
  await expect(page.locator('header').getByRole('img', { name: `${ADMIN.name}'s photo` })).toBeVisible();
  const src = await photo.getByRole('img').getAttribute('src');
  expect(src).toMatch(/^data:image\/jpeg;base64,/);
  expect(src!.length).toBeLessThan(200_000); // resized before upload

  await nav('User Management');
  await expect(page.getByTestId('users-table').getByRole('img', { name: `${ADMIN.name}'s photo` })).toBeVisible();

  await page.goto('/profile');
  await photo.getByRole('button', { name: 'Remove' }).click();
  await expectToast('Profile photo removed.');
  await expect(photo.getByRole('img')).toHaveCount(0);
  await expect(photo.getByRole('button', { name: 'Upload photo' })).toBeVisible();
});

const MOCK = 'http://127.0.0.1:54400';
async function apiToken(request: import('@playwright/test').APIRequestContext, email: string, password: string) {
  const r = await request.post(`${MOCK}/auth/v1/token?grant_type=password`, { data: { email, password }, headers: { apikey: 'e2e-anon-key' } });
  return (await r.json()).access_token as string;
}

test('weekly backup runs from the server scheduler with no browser session, once per week', async ({ request }) => {
  // This is exactly what Supabase Cron sends every hour — no user is signed in.
  const bad = await request.post(`${MOCK}/functions/v1/backup-scheduler`, { headers: { 'x-backup-cron-token': 'not-the-token' }, data: {} });
  expect(bad.status()).toBe(401);
  const { token } = await (await request.get(`${MOCK}/__test/cron-token`)).json();
  const call = () => request.post(`${MOCK}/functions/v1/backup-scheduler`, { headers: { 'x-backup-cron-token': token }, data: { source: 'pg_cron' } }).then((r) => r.json());
  const [a, b] = await Promise.all([call(), call()]); // simultaneous duplicate trigger
  expect([a.status, b.status].sort()).toEqual(['in_progress', 'started']);
  const started = a.status === 'started' ? a : b;
  expect(started.result.status).toBe('success');
  expect((await call()).status).toBe('already_done');
});

test('only an admin can create, download or restore backups', async ({ request }) => {
  const anon = await request.post(`${MOCK}/functions/v1/backup-admin`, { headers: { Authorization: 'Bearer e2e-anon-key' }, data: { action: 'create' } });
  expect(anon.status()).toBe(401);
  for (const [email, password] of [[MARIA.email, MARIA.password], [PEDRO.email, PEDRO.password]]) {
    const t = await apiToken(request, email, password);
    for (const action of ['create', 'download', 'restore', 'delete']) {
      const r = await request.post(`${MOCK}/functions/v1/backup-admin`, { headers: { Authorization: `Bearer ${t}` }, data: { action, id: '00000000-0000-0000-0000-000000000000', confirm: 'RESTORE' } });
      expect(r.status(), `${email} ${action}`).toBe(403);
    }
    const rows = await request.get(`${MOCK}/rest/v1/backup_runs?select=id`, { headers: { Authorization: `Bearer ${t}` } });
    expect(await rows.json(), `${email} cannot list backups`).toEqual([]);
  }
});

test('admin backs up, downloads, verifies, restores and uploads backups', async () => {
  await nav('Backup & Restore');
  await expect(page.getByRole('heading', { name: 'Backup & Restore' })).toBeVisible();
  const history = page.getByTestId('backup-history');
  await expect(history.locator('tbody tr').filter({ hasText: 'Automatic' })).toHaveCount(1); // from the scheduler test

  // Manual backup
  await page.getByRole('button', { name: 'Create backup' }).click();
  await expectToast(/Backup completed: InvportIQ_Full_Backup_/);
  const manual = history.locator('tbody tr').filter({ hasText: 'Manual' }).first();
  await expect(manual).toContainText('Successful');
  await expect(manual).toContainText('12'); // tables

  // Details: checksum and per-table counts
  await manual.getByRole('button', { name: /details/ }).click();
  const details = page.getByRole('dialog');
  await expect(details).toContainText('SHA-256');
  await expect(details).toContainText('stock_movements');
  await details.getByRole('button', { name: 'Close dialog' }).click();

  // Download and verify the archive independently
  const [dl] = await Promise.all([page.waitForEvent('download'), manual.getByRole('button', { name: /^Download / }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^InvportIQ_Full_Backup_\d{4}-\d{2}-\d{2}_\d{4}\.zip$/);
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { unzipSync, zipSync, strFromU8, strToU8 } = await import('fflate');
  const zipBytes = readFileSync(await dl.path());
  const entries = unzipSync(new Uint8Array(zipBytes));
  const meta = JSON.parse(strFromU8(entries['metadata.json']));
  expect(meta.table_count).toBe(12);
  expect(Object.keys(meta.table_counts).sort()).toEqual(['activity_logs', 'auth_lockouts', 'categories', 'customers', 'products', 'profiles', 'sale_items', 'sales', 'setup_state', 'stock_movements', 'suppliers', 'system_settings']);
  for (const [name, info] of Object.entries(meta.files as Record<string, { sha256: string }>)) {
    expect(createHash('sha256').update(entries[name]).digest('hex'), name).toBe(info.sha256);
  }
  expect(strFromU8(entries['auth/users.json'])).not.toMatch(/password|encrypted/i);
  const movementsInBackup = JSON.parse(strFromU8(entries['database/stock_movements.json'])).length;

  // Change data after the backup
  await nav('Categories');
  await page.getByRole('button', { name: 'Add category' }).click();
  await page.getByRole('dialog').getByLabel('Category name').fill('Created After Backup');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expectToast('Category added.');

  // Restore (typed confirmation required)
  await nav('Backup & Restore');
  const row = page.getByTestId('backup-history').locator('tbody tr').filter({ hasText: 'Manual' }).first();
  await row.getByRole('button', { name: /^Restore / }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Restore backup' })).toBeDisabled();
  await dialog.getByLabel(/Type RESTORE/).fill('RESTORE');
  await dialog.getByRole('button', { name: 'Restore backup' }).click();
  const done = page.getByRole('dialog', { name: 'Restore completed' });
  await expect(done).toBeVisible({ timeout: 30_000 });
  await expect(done.getByTestId('restore-checks')).toContainText('Safety backup of the current data created');
  await expect(done.getByTestId('restore-checks')).toContainText('Stock ledger balances for every product');
  await done.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('backup-history').locator('tbody tr').filter({ hasText: 'Pre-restore safety' })).toHaveCount(1);

  // The data is back to the backup: the later category is gone, the ledger is identical
  await nav('Categories');
  await expect(page.getByTestId('categories-table')).toBeVisible();
  await expect(page.getByTestId('categories-table')).not.toContainText('Created After Backup');
  await nav('Backup & Restore');

  // A tampered archive is rejected; the genuine one is accepted
  const tampered = zipSync({ ...entries, 'database/products.json': strToU8('[]') });
  await page.getByLabel('Choose backup file to upload').setInputFiles({ name: 'tampered.zip', mimeType: 'application/zip', buffer: Buffer.from(tampered) });
  await expectToast(/Checksum mismatch/);
  await page.getByLabel('Choose backup file to upload').setInputFiles({ name: 'genuine.zip', mimeType: 'application/zip', buffer: zipBytes });
  await expectToast(/Backup verified and stored/);
  const uploaded = page.getByTestId('backup-history').locator('tbody tr').filter({ hasText: 'Uploaded' });
  await expect(uploaded).toContainText('Successful');
  expect(movementsInBackup).toBeGreaterThan(0);

  // Weekly backup already done this week (by the server scheduler)
  await page.getByRole('button', { name: 'Run weekly backup now' }).click();
  await expectToast(/already completed/);

  // Delete the uploaded copy
  await uploaded.getByRole('button', { name: /^Delete / }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete backup' }).click();
  await expectToast('Backup deleted.');
  await expect(page.getByTestId('backup-history').locator('tbody tr').filter({ hasText: 'Uploaded' })).toHaveCount(0);

  // Schedule settings
  const overview = page.getByTestId('backup-overview');
  await expect(overview).toContainText('Every Sunday at 12:00 AM');
  await page.getByLabel('Automatic backup enabled').uncheck();
  await page.getByRole('button', { name: 'Save schedule' }).click();
  await expectToast('Automatic backup settings saved.');
  await expect(overview).toContainText('Disabled');
  await page.getByLabel('Automatic backup enabled').check();
  await page.getByRole('button', { name: 'Save schedule' }).click();
  await expect(overview).toContainText('Enabled');
});

test('forgot password: emailed link opened in another browser lets the user set a new password', async ({ browser, request }) => {
  await logout();
  await page.goto('/forgot-password');
  await page.getByLabel('Email address').fill(MARIA.email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText(/a password reset link has been sent/)).toBeVisible();

  // The link the email contains. Point it at the home page (as Supabase does when the
  // reset page isn't in its redirect list) to prove the app still opens the reset screen.
  const { link } = await (await request.get(`http://127.0.0.1:54400/__test/recovery-link?email=${MARIA.email}`)).json();
  expect(link).toContain('type=recovery');
  const homeLink = link.replace(/redirect_to=[^&]*/, `redirect_to=${encodeURIComponent('http://127.0.0.1:4180/')}`);

  // Open it in a completely separate browser (e.g. the phone's mail app).
  const phone = await browser.newContext();
  const p = await phone.newPage();
  await p.goto(homeLink);
  await expect(p.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  const NEW_PASSWORD = 'Maria#Reset2026!';
  await p.getByRole('textbox', { name: 'New password', exact: true }).fill(NEW_PASSWORD);
  await p.getByLabel('Confirm new password').fill(NEW_PASSWORD);
  await p.getByRole('button', { name: 'Update password' }).click();
  await expect(p).toHaveURL(/\/login$/);
  await expect(p.locator('[data-sonner-toast]').filter({ hasText: 'Password updated' })).toBeVisible();

  // The new password works; the old one no longer does.
  await p.getByLabel('Username or email').fill(MARIA.username);
  await p.getByRole('textbox', { name: 'Password', exact: true }).fill(MARIA.password);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await expect(p.getByRole('alert').filter({ hasText: /Invalid username\/email or password/ })).toBeVisible();
  await p.getByRole('textbox', { name: 'Password', exact: true }).fill(NEW_PASSWORD);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await expect(p.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();

  // A reset link works only once.
  const again = await (await browser.newContext()).newPage();
  await again.goto(link);
  await expect(again.getByRole('heading', { name: 'Reset link invalid or expired' })).toBeVisible();
  await phone.close();
});
