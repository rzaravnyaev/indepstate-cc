const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('jsdom not installed, skipping levelOrderRenderer test');
  process.exit(0);
}
const Module = require('module');

async function run() {
  const handlers = {};
  const calls = [];
  const ipcRenderer = {
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: async (ch, payload) => {
      calls.push({ ch, payload });
      if (ch === 'orders:list') return [];
      if (ch === 'settings:get') return {};
      if (ch === 'settings:list') return [];
      if (ch === 'settings:set') return true;
      if (ch === 'actions-bus:list') return [];
      if (ch === 'actions-bus:set-enabled') return [];
      if (ch === 'instrument:get') return { bid: 101, ask: 102, price: 101.5, tickSize: 0.5 };
      if (ch === 'level-order:place') return {
        status: 'ok',
        provider: 'simulated',
        providerOrderId: 'level:test',
        raw: {
          plan: { childQtys: [1, 2] },
          results: [
            { requestId: `${payload.requestId}_1`, qty: 1, result: { status: 'ok', providerOrderId: 'pending:cid-1' } },
            { requestId: `${payload.requestId}_2`, qty: 2, result: { status: 'ok', providerOrderId: 'pending:cid-2' } }
          ]
        }
      };
      return {};
    }
  };

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') {
      return { ipcRenderer };
    }
    return originalLoad(request, parent, isMain);
  };

  const dom = new JSDOM(`<!DOCTYPE html><div id="wrap"><div id="grid"></div></div><input id="filter"><input id="cmdline"><button id="settings-btn"></button><div id="settings-panel"><div id="settings-sections"></div><div id="settings-fields"></div><button id="settings-close"></button></div>`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.CSS = dom.window.CSS;
  global.navigator = { userAgent: 'node.js' };

  const renderer = require('../app/renderer.js');
  const t = renderer.__testing;
  t.setLevelOrderConfig({
    defaults: { riskUsd: 50, maxLot: 3, stopOffsetPts: 4, takeProfitPts: 12 },
    symbols: []
  });

  const row = { cardType: 'levelOrder', ticker: 'TST', event: 'levelOrder', time: 0, level: 100, provider: 'simulated', instrumentType: 'EQ' };
  handlers['orders:new'](null, row);
  const key = t.rowKey(row);
  let card = t.cardByKey(key);
  let buttons = Array.from(card.querySelectorAll('button.btn'));
  assert.deepStrictEqual(buttons.map(b => b.dataset.kind), ['LB', 'LS']);
  assert.strictEqual(buttons[0].disabled, true);
  assert.strictEqual(card.querySelector('.card__note').textContent, 'Bid quote required');

  t.instrumentInfo.set('TST', { bid: 101, ask: 102, price: 101.5, tickSize: 0.5 });
  t.render();
  card = t.cardByKey(key);
  buttons = Array.from(card.querySelectorAll('button.btn'));
  assert.strictEqual(buttons[0].disabled, false);
  const pointSizeInput = card.querySelector('input.point-size');
  assert(pointSizeInput);
  assert.strictEqual(pointSizeInput.value, '');
  const inputs = Array.from(card.querySelectorAll('.level-order-line input.num'));
  assert.deepStrictEqual(inputs.map(i => i.value), ['100', '50', '4', '3', '12']);
  pointSizeInput.value = '0.001';
  pointSizeInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  buttons[0].click();
  await new Promise(resolve => setTimeout(resolve, 20));
  const call = calls.find(c => c.ch === 'level-order:place');
  assert(call);
  assert.strictEqual(call.payload.action, 'LB');
  assert.strictEqual(call.payload.level, 100);
  assert.strictEqual(call.payload.riskUsd, 50);
  assert.strictEqual(call.payload.stopOffsetPts, 4);
  assert.strictEqual(call.payload.maxLot, 3);
  assert.strictEqual(call.payload.takeProfitPts, 12);
  assert.strictEqual(call.payload.pointSize, 0.001);
  assert.strictEqual(call.payload.tickSize, 0.001);
  const parentRequestId = call.payload.requestId;
  assert.strictEqual(t.cardStates.get(key), 'pending-exec');
  assert(t.levelOrderGroups.has(parentRequestId));
  assert.strictEqual(t.levelOrderGroups.get(parentRequestId).placedReqIds.size, 0);

  handlers['execution:pending'](null, {
    reqId: `${parentRequestId}_1`,
    pendingId: 'cid-1',
    order: {
      symbol: 'TST',
      side: 'buy',
      qty: 1,
      meta: { requestId: `${parentRequestId}_1`, parentRequestId, childCount: 2 }
    }
  });
  handlers['execution:pending'](null, {
    reqId: `${parentRequestId}_2`,
    pendingId: 'cid-2',
    order: {
      symbol: 'TST',
      side: 'buy',
      qty: 2,
      meta: { requestId: `${parentRequestId}_2`, parentRequestId, childCount: 2 }
    }
  });
  assert.strictEqual(t.levelOrderPendingToGroup.get('cid-1'), parentRequestId);

  handlers['execution:result'](null, {
    reqId: `${parentRequestId}_1`,
    provider: 'simulated',
    status: 'ok',
    providerOrderId: 'ticket-1',
    order: {
      symbol: 'TST',
      side: 'buy',
      qty: 1,
      meta: { requestId: `${parentRequestId}_1`, parentRequestId, childCount: 2 }
    }
  });
  assert.strictEqual(t.cardStates.get(key), 'pending-exec');
  assert.strictEqual(card.querySelector('input.qty').value, '3');
  assert.strictEqual(t.levelOrderGroups.get(parentRequestId).placedReqIds.size, 1);

  handlers['execution:result'](null, {
    reqId: `${parentRequestId}_2`,
    pendingId: 'cid-2',
    provider: 'simulated',
    status: 'ok',
    providerOrderId: 'ticket-2',
    parentRequestId,
    childCount: 2,
    order: {
      symbol: 'TST',
      side: 'buy',
      qty: 2
    }
  });
  assert.strictEqual(t.levelOrderGroups.get(parentRequestId).placedReqIds.size, 2);
  assert.strictEqual(t.levelOrderGroups.get(parentRequestId).total, 2);
  assert.strictEqual(t.cardStates.get(key), 'pending-exec');

  handlers['position:opened'](null, {
    ticket: 'position-1',
    origOrder: { meta: { requestId: `${parentRequestId}_1`, parentRequestId, childCount: 2 } }
  });
  assert.strictEqual(t.cardStates.get(key), 'pending-exec');
  handlers['position:opened'](null, {
    ticket: 'position-2',
    origOrder: { meta: { requestId: `${parentRequestId}_2`, parentRequestId, childCount: 2 } }
  });
  assert.strictEqual(t.cardStates.get(key), 'executing');

  t.cardStates.set(key, 'pending-exec');
  handlers['level-order:positions-ready'](null, {
    requestId: parentRequestId,
    expectedQty: 3,
    foundQty: 3,
    foundCids: ['cid-1', 'cid-2']
  });
  assert.strictEqual(t.cardStates.get(key), 'executing');

  Module._load = originalLoad;
  console.log('levelOrderRenderer tests passed');
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
