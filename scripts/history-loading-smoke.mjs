// Run against the Vite dev server. Install Playwright or set PLAYWRIGHT_MODULE.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
const base = process.env.TEST_URL || 'http://127.0.0.1:1210';
const makeMessages = (count, prefix = 'History') => Array.from({ length: count }, (_, i) => ({
    id: i + 1, timestamp: 1791940000, type: 'text', content: `${prefix} message ${i + 1}`,
}));
const messages = makeMessages(1000);
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let requests = [];
let releaseOlder;
let olderGate = new Promise(resolve => { releaseOlder = resolve; });
let failOlder = false;
let ignoreCursor = false;
let wire;
await page.route('**/server?*', route => route.fulfill({ json: { auth: false, roomProtected: false } }));
await page.route('**/rooms*', route => route.fulfill({ json: [] }));
await page.route('**/content?*', async route => {
    const params = new URL(route.request().url()).searchParams;
    const room = params.get('room');
    const before = Number(params.get('before')) || Infinity;
    const limit = Number(params.get('limit'));
    const dataset = room === 'other' ? makeMessages(3, 'Other room') : messages;
    const result = dataset.filter(item => ignoreCursor || item.id < before).slice(-limit);
    requests.push({ room, before, limit });
    if (before !== Infinity) await olderGate;
    if (failOlder && before !== Infinity) return route.fulfill({ status: 503, json: {} });
    await route.fulfill({ json: { messages: result } });
});
await page.routeWebSocket('**/push*', socket => {
    wire = socket;
    setTimeout(() => socket.send(JSON.stringify({ event: 'config', data: {
        version: 'test', server: { history: 1000 }, text: { limit: 4096 }, file: { limit: 104857600 },
    } })), 20);
});
await page.addInitScript(() => {
    window.scrollCalls = [];
    const original = window.scrollTo.bind(window);
    window.scrollTo = (...args) => { window.scrollCalls.push(args[0]); return original(...args); };
});
const connectStores = () => page.evaluate(async () => {
    window.appStore = (await import('/src/store/app.js')).useAppStore();
    window.wsStore = (await import('/src/store/websocket.js')).useWebSocketStore();
});
const send = (event, data) => wire.send(JSON.stringify({ event, data }));
const countCards = () => page.locator('.timeline-panel__item').count();
const first = page.locator('.timeline-panel__item').first();
try {
    await page.goto(base);
    await first.waitFor();
    await connectStores();
    assert.equal(await countCards(), 10);
    assert.match(await first.innerText(), /History message 1000/);
    assert.equal(requests[0].limit, 10);
    assert.equal(await page.evaluate(() => scrollY), 0);
    // The first page is usable while the old-page request is deliberately blocked.
    assert.equal(await page.evaluate(() => wsStore.historyLoading), true);
    await page.waitForTimeout(150);
    assert.equal(requests[1].before, 991);
    assert.equal(requests[1].limit, 50);
    assert.equal(await countCards(), 10);
    console.log('PASS: newest 10 render first, independently of older history');

    // These IDs are in the blocked HTTP snapshot; live changes must win.
    send('revoke', { id: 990 });
    send('update', { id: 989, content: 'Live edit wins' });
    send('receive', { id: 1001, timestamp: 1791940000, type: 'text', content: 'Newest live' });
    await page.waitForFunction(() => appStore.received[0]?.id === 1001);
    releaseOlder();
    await page.waitForFunction(() => !wsStore.historyLoading);
    assert.equal(await page.evaluate(() => appStore.received.length), 1000);
    assert.equal(await page.evaluate(() => appStore.received.some(item => item.id === 990)), false);
    assert.equal(await page.evaluate(() => appStore.received.find(item => item.id === 989)?.content), 'Live edit wins');
    assert.equal(await page.evaluate(() => new Set(appStore.received.map(item => item.id)).size), 1000);
    assert.equal(await countCards(), 20);
    assert.match(await first.innerText(), /Newest live/);
    assert.equal(await page.evaluate(() => scrollY), 0);
    assert.equal(await page.evaluate(() => scrollCalls.some(call => call.behavior === 'smooth')), false);
    console.log('PASS: all 1000 history items loaded; only 20 cards mounted; live edits/deletions preserved');

    await page.evaluate(() => { appStore.setSearchQuery('History message 1'); });
    await page.waitForFunction(() => appStore.visibleReceived.some(item => item.id === 1));
    // Exact text matches are not required by the app search; narrow to a unique oldest item.
    await page.evaluate(() => { appStore.received.find(item => item.id === 1).content = 'Unique oldest result'; appStore.setSearchQuery('Unique oldest result'); });
    await page.waitForFunction(() => document.querySelectorAll('.timeline-panel__item').length === 1);
    assert.match(await first.innerText(), /Unique oldest result/);
    await page.evaluate(() => appStore.setSearchQuery(''));
    await page.waitForFunction(() => document.querySelectorAll('.timeline-panel__item').length === 20);
    await page.locator('.timeline-panel__item').last().scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelectorAll('.timeline-panel__item').length > 20);
    await page.evaluate(() => { window.scrollCalls = []; });
    send('receive', { id: 1002, timestamp: 1791940001, type: 'text', content: 'Another live' });
    await page.waitForFunction(() => appStore.received[0]?.id === 1002);
    assert.equal(await page.evaluate(() => scrollCalls.length), 0);
    console.log('PASS: search includes oldest messages; scrolling reveals older cards without jumping to top');

    // Switch rooms while a page is pending, then reload the cached original room.
    olderGate = new Promise(resolve => { releaseOlder = resolve; });
    requests = [];
    await page.evaluate(() => { void wsStore.loadHistoryFromHttp(); });
    await page.waitForTimeout(250);
    assert.ok(requests.some(request => request.before < Infinity));
    await page.evaluate(() => wsStore.switchRoom('other'));
    await page.waitForFunction(() => !wsStore.historyLoading && appStore.received.length === 3);
    releaseOlder();
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => appStore.received.length), 3);
    assert.match(await first.innerText(), /Other room message 3/);
    assert.equal(await page.evaluate(() => scrollY), 0);
    await page.evaluate(() => wsStore.switchRoom(''));
    await page.waitForFunction(() => !wsStore.historyLoading && appStore.received.length === 1000);
    console.log('PASS: cancelling old requests isolates rooms and refreshes cached-room history');

    failOlder = true;
    await page.evaluate(() => { appStore.received = []; void wsStore.loadHistoryFromHttp(); });
    await page.waitForFunction(() => wsStore.historyError);
    assert.equal(await page.evaluate(() => appStore.received.length), 10);
    assert.match(await first.innerText(), /History message 1000/);
    failOlder = false;
    await page.evaluate(() => { void wsStore.loadHistoryFromHttp(); });
    await page.waitForFunction(() => !wsStore.historyLoading && !wsStore.historyError);
    assert.equal(await page.evaluate(() => appStore.received.length), 1000);
    console.log('PASS: background failures retain recent messages; retry completes history');

    ignoreCursor = true;
    requests = [];
    await page.evaluate(() => { appStore.received = []; void wsStore.loadHistoryFromHttp(); });
    await page.waitForFunction(() => !wsStore.historyLoading);
    assert.ok(requests.length <= 3, 'Server ignoring cursor must not cause an endless loop');
    ignoreCursor = false;
    await page.reload();
    await first.waitFor();
    await connectStores();
    assert.match(await first.innerText(), /History message 1000/);
    assert.equal(await page.evaluate(() => scrollY), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: legacy cursor handling terminates; refresh shows newest without browser errors');
} finally {
    await browser.close();
}
