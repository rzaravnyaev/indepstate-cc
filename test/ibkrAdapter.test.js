const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const {
  IBKRAdapter,
  validateConfig,
  validateContract,
  safeClone,
} = require('../app/services/brokerage-adapter-ibkr/comps/ibkr');

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.placed = [];
    this.cancels = [];
    this.connected = false;
    this.marketDataTypes = [];
    this.marketDataRequests = [];
    this.cancelledMarketData = [];
    this.contractDetailsRequests = [];
  }
  connect() { this.connected = true; this.emit('connect'); }
  reqManagedAccts() {}
  reqIds() {}
  reqOpenOrders() {}
  reqContractDetails(reqId, contract) { this.contractDetailsRequests.push({ reqId, contract }); }
  reqMarketDataType(type) { this.marketDataTypes.push(type); }
  reqMktData(reqId, contract, genericTickList, snapshot, regulatorySnapshot, options) {
    if (this.failMktData) throw new Error(this.failMktData);
    this.marketDataRequests.push({ reqId, contract, genericTickList, snapshot, regulatorySnapshot, options });
  }
  cancelMktData(reqId) { this.cancelledMarketData.push(reqId); }
  placeOrder(orderId, contract, order) { this.placed.push({ orderId, contract, order }); }
  cancelOrder(orderId) { this.cancels.push(orderId); }
}

function makeAdapter(overrides = {}) {
  const client = new FakeClient();
  const adapter = new IBKRAdapter({
    enabled: true,
    autoConnect: false,
    mode: 'paper',
    host: '127.0.0.1',
    port: 4002,
    clientId: 12,
    accountId: 'DU123',
    defaultTif: 'DAY',
    instruments: {
      AAPL: { conId: 265598, symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD', primaryExchange: 'NASDAQ', tickSize: 0.01 },
    },
    clientFactory: { create: () => client, eventNames: {} },
    ...overrides,
  }, 'ibkr');
  adapter.connect();
  return { adapter, client };
}

function captureConsole(fn) {
  const calls = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => calls.push({ method: 'log', args });
  console.error = (...args) => calls.push({ method: 'error', args });
  try {
    const result = fn();
    return { result, calls };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function emitContractDetails(client, reqId, contract, extra = {}) {
  client.emit('contractDetails', reqId, { contract, ...extra });
  client.emit('contractDetailsEnd', reqId);
}

function ready(adapter, client, nextId = 100) {
  client.emit('managedAccounts', 'DU123');
  client.emit('nextValidId', nextId);
  assert.strictEqual(adapter.isReady(), true);
}

(async () => {
  {
    const valid = validateConfig({ enabled: false, debug: false, host: '127.0.0.1', port: 4002, clientId: 1, mode: 'paper', defaultTif: 'DAY' });
    assert.strictEqual(valid.ok, true);
    const debugValid = validateConfig({ enabled: false, debug: true, host: '127.0.0.1', port: 4002, clientId: 1, mode: 'paper', defaultTif: 'DAY' });
    assert.strictEqual(debugValid.ok, true);
    const invalid = validateConfig({ enabled: 'yes', debug: 'yes', host: '', port: 99999, clientId: -1, mode: 'demo', defaultTif: '' });
    assert.strictEqual(invalid.ok, false);
    assert(invalid.errors.includes('debug must be boolean'));
    assert(invalid.errors.length >= 5);
  }



  {
    const legacyCfg = validateConfig({ enabled: false, host: '127.0.0.1', port: 4002, clientId: 1, mode: 'paper', defaultTif: 'DAY', contractResolution: { defaultSecType: 'STK', defaultExchange: 'SMART', defaultCurrency: 'USD', preferredPrimaryExchanges: ['NASDAQ'] } });
    assert.strictEqual(legacyCfg.ok, false);
    assert(legacyCfg.errors.includes('contractResolution.defaultSecType is no longer supported; use contractResolution.profiles instead'));
    assert(legacyCfg.errors.includes('contractResolution.defaultExchange is no longer supported; use contractResolution.profiles instead'));
    assert(legacyCfg.errors.includes('contractResolution.defaultCurrency is no longer supported; use contractResolution.profiles instead'));
    assert(legacyCfg.errors.includes('contractResolution.preferredPrimaryExchanges is no longer supported; use contractResolution.profiles instead'));

    const invalidDefault = validateConfig({ enabled: false, host: '127.0.0.1', port: 4002, clientId: 1, mode: 'paper', defaultTif: 'DAY', contractResolution: { defaultProfile: 'MISSING' } });
    assert.strictEqual(invalidDefault.ok, false);
    assert(invalidDefault.errors.includes('contractResolution.defaultProfile references unknown profile "MISSING"'));

    const invalidByType = validateConfig({ enabled: false, host: '127.0.0.1', port: 4002, clientId: 1, mode: 'paper', defaultTif: 'DAY', contractResolution: { profileByInstrumentType: { EQ: 'NOPE' } } });
    assert.strictEqual(invalidByType.ok, false);
    assert(invalidByType.errors.includes('contractResolution.profileByInstrumentType is no longer supported; use contractResolution.profiles instead'));

    const invalidBySymbol = validateConfig({ enabled: false, host: '127.0.0.1', port: 4002, clientId: 1, mode: 'paper', defaultTif: 'DAY', contractResolution: { profileBySymbol: { ALNY: 'NOPE' } } });
    assert.strictEqual(invalidBySymbol.ok, false);
    assert(invalidBySymbol.errors.includes('contractResolution.profileBySymbol.ALNY references unknown profile "NOPE"'));

    const invalidForce = validateConfig({ enabled: false, host: '127.0.0.1', port: 4002, clientId: 1, mode: 'paper', defaultTif: 'DAY', contractResolution: { forceProfileForInstrumentTypes: 'CFD' } });
    assert.strictEqual(invalidForce.ok, false);
    assert(invalidForce.errors.includes('contractResolution.forceProfileForInstrumentTypes is no longer supported; use contractResolution.profiles instead'));

    const invalidProfile = validateConfig({ enabled: false, host: '127.0.0.1', port: 4002, clientId: 1, mode: 'paper', defaultTif: 'DAY', contractResolution: { profiles: { BAD: { secType: 'STK', exchange: 'SMART', preferredPrimaryExchanges: { primary: 'NASDAQ' } } }, profileBySymbol: {}, defaultProfile: 'BAD' } });
    assert.strictEqual(invalidProfile.ok, false);
    assert(invalidProfile.errors.includes('contractResolution.profiles.BAD.currency is required'));
    assert(invalidProfile.errors.includes('contractResolution.profiles.BAD.preferredPrimaryExchanges must be an array or comma-separated string'));
  }

  {
    const files = [
      path.join(__dirname, '../app/main.js'),
      path.join(__dirname, '../app/services/pendingOrders/hub.js'),
    ];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      const contextQuoteCalls = lines.filter(line =>
        (line.includes('getQuote?.(') || line.includes('forgetQuote?.(')) && line.includes(', {')
      );
      assert.deepStrictEqual(contextQuoteCalls, [], `${path.basename(file)} must not pass object context to shared quote adapter methods`);
    }
  }

  {
    const adapter = new IBKRAdapter({ enabled: false, autoConnect: false }, 'ibkr');
    const res = await adapter.placeOrder({ symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 });
    assert.strictEqual(res.status, 'disabled');
  }

  {
    const { result, calls } = captureConsole(() => makeAdapter());
    assert.strictEqual(calls.length, 0);
    assert(result.adapter.logs.some(entry => entry.message === 'connecting'));
  }

  {
    const { calls } = captureConsole(() => makeAdapter({ debug: true }));
    assert(calls.some(call => call.args[0] === '[IBKR]'));
  }

  {
    const { adapter } = makeAdapter();
    const missing = await adapter.placeOrder({ symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 });
    assert.strictEqual(missing.status, 'rejected');
    assert.match(missing.reason, /account|nextValidId|not connected|not ready/i);
  }

  {
    assert.strictEqual(validateContract('MSFT', null), 'IBKR contract mapping missing for MSFT');
    assert.match(validateContract('MSFT', { symbol: 'MSFT', secType: 'STK', exchange: 'SMART', currency: 'USD' }), /primaryExchange/);
    assert.strictEqual(validateContract('MSFT', { conId: 123 }), '');
  }



  {
    const { adapter } = makeAdapter();
    const quote = await adapter.getQuote('AAPL');
    assert.strictEqual(quote, null);
    assert(adapter.logs.some(entry => entry.message === 'quote unavailable: adapter not ready'));
  }

  {
    const { adapter, client } = makeAdapter({ instruments: {} });
    ready(adapter, client, 90);
    const promise = adapter.resolveContractForSymbol('INTC');
    assert.strictEqual(client.contractDetailsRequests.length, 1);
    assert.deepStrictEqual(client.contractDetailsRequests[0].contract, { symbol: 'INTC', secType: 'STK', exchange: 'SMART', currency: 'USD' });
    emitContractDetails(client, client.contractDetailsRequests[0].reqId, { conId: 270639, symbol: 'INTC', secType: 'STK', exchange: 'SMART', currency: 'USD', primaryExchange: 'NASDAQ', localSymbol: 'INTC', tradingClass: 'NMS' }, { minTick: 0.01 });
    const contract = await promise;
    assert.strictEqual(contract.conId, 270639);
    assert.strictEqual(contract.symbol, 'INTC');
    assert(adapter.logs.some(entry => entry.message === 'IBKR contract resolved' && entry.symbol === 'INTC'));

    const cached = await adapter.resolveContractForSymbol('INTC');
    assert.strictEqual(cached.conId, 270639);
    assert.strictEqual(client.contractDetailsRequests.length, 1);
  }

  {
    const { adapter, client } = makeAdapter({ instruments: {} });
    ready(adapter, client, 90);
    const promise = adapter.resolveContractForSymbol('ALNY');
    assert.deepStrictEqual(client.contractDetailsRequests[0].contract, { symbol: 'ALNY', secType: 'STK', exchange: 'SMART', currency: 'USD' });
    emitContractDetails(client, client.contractDetailsRequests[0].reqId, { conId: 12345, symbol: 'ALNY', secType: 'STK', exchange: 'SMART', currency: 'USD', primaryExchange: 'NASDAQ' }, { minTick: 0.01 });
    const contract = await promise;
    assert.strictEqual(contract.secType, 'STK');
  }

  {
    const { adapter, client } = makeAdapter({ instruments: {}, contractResolution: { profileBySymbol: { ALNY: 'CFD' } } });
    ready(adapter, client, 90);
    const promise = adapter.resolveContractForSymbol('ALNY');
    assert.deepStrictEqual(client.contractDetailsRequests[0].contract, { symbol: 'ALNY', secType: 'CFD', exchange: 'SMART', currency: 'USD' });
    emitContractDetails(client, client.contractDetailsRequests[0].reqId, { conId: 54321, symbol: 'ALNY', secType: 'CFD', exchange: 'SMART', currency: 'USD' }, { minTick: 0.01 });
    const contract = await promise;
    assert.strictEqual(contract.secType, 'CFD');
  }

  {
    const { adapter, client } = makeAdapter({
      instruments: {
        ALNY: { conId: 999, symbol: 'ALNY', secType: 'CFD', exchange: 'SMART', currency: 'USD', tickSize: 0.01 },
      },
      contractResolution: { profileBySymbol: { ALNY: 'STK' } },
    });
    ready(adapter, client, 90);
    const contract = await adapter.resolveContractForSymbol('ALNY');
    assert.strictEqual(contract.conId, 999);
    assert.strictEqual(contract.secType, 'CFD');
    assert.strictEqual(client.contractDetailsRequests.length, 0);
  }

  {
    const { adapter, client } = makeAdapter({ instruments: {}, contractResolution: { profileBySymbol: { ALNY: 'CFD' } } });
    ready(adapter, client, 90);
    const promise = adapter.resolveContractForSymbol('ALNY');
    assert.deepStrictEqual(client.contractDetailsRequests[0].contract, { symbol: 'ALNY', secType: 'CFD', exchange: 'SMART', currency: 'USD' });
    emitContractDetails(client, client.contractDetailsRequests[0].reqId, { conId: 54321, symbol: 'ALNY', secType: 'CFD', exchange: 'SMART', currency: 'USD' }, { minTick: 0.01 });
    const contract = await promise;
    assert.strictEqual(contract.secType, 'CFD');
  }

  {
    const { adapter, client } = makeAdapter({ instruments: {} });
    ready(adapter, client, 90);

    const stockPromise = adapter.resolveContractForSymbol('ALNY');
    emitContractDetails(client, client.contractDetailsRequests[0].reqId, { conId: 111, symbol: 'ALNY', secType: 'STK', exchange: 'SMART', currency: 'USD', primaryExchange: 'NASDAQ' }, { minTick: 0.01 });
    const stock = await stockPromise;
    assert.strictEqual(stock.conId, 111);

    adapter.cfg.contractResolution.profileBySymbol.ALNY = 'CFD';
    const cfdPromise = adapter.resolveContractForSymbol('ALNY');
    assert.strictEqual(client.contractDetailsRequests.length, 2);
    assert.deepStrictEqual(client.contractDetailsRequests[1].contract, { symbol: 'ALNY', secType: 'CFD', exchange: 'SMART', currency: 'USD' });
    emitContractDetails(client, client.contractDetailsRequests[1].reqId, { conId: 222, symbol: 'ALNY', secType: 'CFD', exchange: 'SMART', currency: 'USD' }, { minTick: 0.01 });
    const cfd = await cfdPromise;
    assert.strictEqual(cfd.conId, 222);

    adapter.cfg.contractResolution.profileBySymbol.ALNY = 'STK';
    const cachedStock = await adapter.resolveContractForSymbol('ALNY');
    assert.strictEqual(cachedStock.conId, 111);
    assert.strictEqual(client.contractDetailsRequests.length, 2);
  }

  {
    const { adapter, client } = makeAdapter({ instruments: {}, contractResolveTimeoutMs: 20 });
    ready(adapter, client, 90);
    const quote = await adapter.getQuote('MSFT');
    assert.strictEqual(quote, null);
    assert(adapter.logs.some(entry => entry.message === 'IBKR contract resolution failed' && /could not resolve contract for MSFT/i.test(entry.reason)));
  }

  {
    const { adapter, client } = makeAdapter({ instruments: {} });
    ready(adapter, client, 90);
    const promise = adapter.resolveContractForSymbol('DUPE');
    const reqId = client.contractDetailsRequests[0].reqId;
    client.emit('contractDetails', reqId, { contract: { conId: 1, symbol: 'DUPE', secType: 'STK', exchange: 'SMART', currency: 'USD', primaryExchange: 'NASDAQ' }, minTick: 0.01 });
    client.emit('contractDetails', reqId, { contract: { conId: 2, symbol: 'DUPE', secType: 'STK', exchange: 'SMART', currency: 'USD', primaryExchange: 'NASDAQ' }, minTick: 0.01 });
    client.emit('contractDetailsEnd', reqId);
    await assert.rejects(promise, /IBKR contract resolution ambiguous for DUPE/);
  }

  {
    const { adapter, client } = makeAdapter({ marketDataType: 3 });
    ready(adapter, client, 91);
    const promise = adapter.getQuote('AAPL');
    await Promise.resolve();
    const promise2 = adapter.getQuote('AAPL');
    await Promise.resolve();
    assert.strictEqual(client.marketDataTypes[0], 3);
    assert.strictEqual(client.marketDataRequests.length, 1);
    assert.strictEqual(client.marketDataRequests[0].contract.conId, 265598);
    assert.strictEqual(client.marketDataRequests[0].snapshot, false);
    client.emit('tickPrice', client.marketDataRequests[0].reqId, 1, 100);
    client.emit('tickPrice', client.marketDataRequests[0].reqId, 2, 101);
    const quote = await promise;
    const quote2 = await promise2;
    assert.strictEqual(quote.price, 100.5);
    assert.strictEqual(quote.bid, 100);
    assert.strictEqual(quote.ask, 101);
    assert.strictEqual(quote2.price, 100.5);
    assert.strictEqual(quote.tickSize, 0.01);
    assert.strictEqual(quote.tickSource, 'ibkr');
    assert.deepStrictEqual(client.cancelledMarketData, []);
  }

  {
    const { adapter, client } = makeAdapter({ instruments: {} });
    ready(adapter, client, 91);
    const promise = adapter.getQuote('INTC');
    await Promise.resolve();
    assert.strictEqual(client.contractDetailsRequests.length, 1);
    emitContractDetails(client, client.contractDetailsRequests[0].reqId, { conId: 270639, symbol: 'INTC', secType: 'STK', exchange: 'SMART', currency: 'USD', primaryExchange: 'NASDAQ', localSymbol: 'INTC', tradingClass: 'NMS' }, { minTick: 0.01 });
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(client.marketDataRequests.length, 1);
    assert.strictEqual(client.marketDataRequests[0].contract.conId, 270639);
    client.emit('tickPrice', client.marketDataRequests[0].reqId, 4, 32.5);
    const quote = await promise;
    assert.strictEqual(quote.price, 32.5);
    assert.strictEqual(quote.tickSize, 0.01);
    assert.deepStrictEqual(client.cancelledMarketData, []);
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 92);
    const promise = adapter.getQuote('AAPL');
    await Promise.resolve();
    client.emit('tickPrice', client.marketDataRequests[0].reqId, 4, 102.25);
    const quote = await promise;
    assert.strictEqual(quote.price, 102.25);
    assert.strictEqual(quote.last, 102.25);
    assert.deepStrictEqual(client.cancelledMarketData, []);

    client.emit('tickPrice', client.marketDataRequests[0].reqId, 1, 102);
    client.emit('tickPrice', client.marketDataRequests[0].reqId, 2, 103);
    const updated = await adapter.getQuote('AAPL');
    assert.strictEqual(client.marketDataRequests.length, 1);
    assert.strictEqual(updated.price, 102.5);
    assert.strictEqual(updated.bid, 102);
    assert.strictEqual(updated.ask, 103);

    await adapter.forgetQuote('aapl');
    assert.deepStrictEqual(client.cancelledMarketData, [client.marketDataRequests[0].reqId]);
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 93);
    const promise = adapter.getQuote('AAPL');
    await Promise.resolve();
    client.emit('tickPrice', client.marketDataRequests[0].reqId, 9, 99.75);
    const quote = await promise;
    assert.strictEqual(quote.price, 99.75);
    assert.strictEqual(quote.close, 99.75);
    assert.deepStrictEqual(client.cancelledMarketData, []);
  }

  {
    const { adapter, client } = makeAdapter({ quoteTimeoutMs: 20 });
    ready(adapter, client, 94);
    const quote = await adapter.getQuote('AAPL');
    assert.strictEqual(quote, null);
    assert.deepStrictEqual(client.cancelledMarketData, []);
    assert(adapter.logs.some(entry => entry.message === 'quote timeout'));

    client.emit('tickPrice', client.marketDataRequests[0].reqId, 4, 102.25);
    const late = await adapter.getQuote('AAPL');
    assert.strictEqual(client.marketDataRequests.length, 1);
    assert.strictEqual(late.price, 102.25);
    await adapter.forgetQuote('AAPL');
    assert.deepStrictEqual(client.cancelledMarketData, [client.marketDataRequests[0].reqId]);
  }

  {
    const { adapter, client } = makeAdapter({
      instruments: {},
      quoteTimeoutMs: 2000,
      contractResolution: { profileBySymbol: { ALNY: 'CFD' } },
    });
    ready(adapter, client, 94);
    const promise = adapter.getQuote('ALNY');
    await Promise.resolve();
    emitContractDetails(client, client.contractDetailsRequests[0].reqId, {
      conId: 54321,
      symbol: 'ALNY',
      secType: 'CFD',
      exchange: 'SMART',
      currency: 'USD',
      localSymbol: 'ALNYn',
      tradingClass: 'ALNY',
    }, { minTick: 0.01 });
    await Promise.resolve();
    await Promise.resolve();
    const reqId = client.marketDataRequests[0].reqId;
    client.emit('rerouteMktDataReq', reqId, 12345, 'NASDAQ');
    assert.strictEqual(client.marketDataRequests.length, 2);
    assert.deepStrictEqual(client.cancelledMarketData, [reqId]);
    assert.strictEqual(client.marketDataRequests[1].reqId, reqId);
    assert.deepStrictEqual(client.marketDataRequests[1].contract, {
      conId: 12345,
      symbol: 'ALNY',
      secType: 'STK',
      exchange: 'NASDAQ',
      currency: 'USD',
      primaryExchange: 'NASDAQ',
    });
    client.emit('tickPrice', reqId, 4, 187.25);
    const quote = await promise;
    assert.strictEqual(quote.price, 187.25);
    assert.strictEqual(quote.last, 187.25);
    assert(adapter.logs.some(entry => entry.message === 'market data reroute requested' && entry.symbol === 'ALNY'));
  }

  {
    const { adapter, client } = makeAdapter({
      instruments: {},
      quoteTimeoutMs: 20,
      contractResolution: { profileBySymbol: { ALNY: 'CFD' } },
    });
    ready(adapter, client, 94);
    const promise = adapter.getQuote('ALNY');
    await Promise.resolve();
    assert.deepStrictEqual(client.contractDetailsRequests[0].contract, { symbol: 'ALNY', secType: 'CFD', exchange: 'SMART', currency: 'USD' });
    emitContractDetails(client, client.contractDetailsRequests[0].reqId, {
      conId: 54321,
      symbol: 'ALNY',
      secType: 'CFD',
      exchange: 'SMART',
      currency: 'USD',
      localSymbol: 'ALNYn',
      tradingClass: 'ALNY',
    }, { minTick: 0.01 });
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(client.marketDataRequests.length, 1);
    const reqId = client.marketDataRequests[0].reqId;
    assert.strictEqual(client.marketDataRequests[0].contract.secType, 'CFD');
    client.emit('marketDataType', reqId, 1);
    client.emit('rerouteMktDataReq', reqId, 12345, 'SMART');
    client.emit('tickReqParams', reqId, 0.01, 'NASDAQ', 3);
    client.emit('tickString', reqId, 45, 'diagnostic');
    client.emit('tickGeneric', reqId, 49, 1.25);
    client.emit('tickOptionComputation', reqId, 13, { canAutoExecute: true }, 0.2, 0.5, 1.5, 0, 0.1, 0.2, -0.03, 102.25);
    const promise2 = adapter.getQuote('ALNY');
    await Promise.resolve();
    assert.strictEqual(client.marketDataRequests.length, 2);
    assert.strictEqual(client.marketDataRequests[1].reqId, reqId);

    const quote = await promise;
    const quote2 = await promise2;
    assert.strictEqual(quote, null);
    assert.strictEqual(quote2, null);
    assert.deepStrictEqual(client.cancelledMarketData, [reqId]);

    const timeoutLogs = adapter.logs.filter(entry => entry.message === 'quote timeout' && entry.symbol === 'ALNY');
    assert.strictEqual(timeoutLogs.length, 2);
    assert(timeoutLogs.every(entry => entry.reqId === reqId));
    assert.deepStrictEqual(timeoutLogs.map(entry => entry.waiterId).sort((a, b) => a - b), [1, 2]);
    const diagnostic = timeoutLogs[0];
    assert.strictEqual(diagnostic.profile, 'CFD');
    assert.strictEqual(diagnostic.secType, 'CFD');
    assert.strictEqual(diagnostic.conId, 54321);
    assert.deepStrictEqual(diagnostic.activeMarketDataContract, {
      conId: 12345,
      symbol: 'ALNY',
      secType: 'STK',
      exchange: 'SMART',
      currency: 'USD',
    });
    assert.strictEqual(diagnostic.requestedMarketDataType, 3);
    assert.strictEqual(diagnostic.observedMarketDataType, 1);
    assert.strictEqual(diagnostic.snapshotQuotes, false);
    assert(diagnostic.elapsedMs >= 0);
    assert.strictEqual(diagnostic.diagnosticCounts.marketDataType, 1);
    assert.strictEqual(diagnostic.diagnosticCounts.rerouteMktDataReq, 1);
    assert.strictEqual(diagnostic.diagnosticCounts.tickReqParams, 1);
    assert.strictEqual(diagnostic.diagnosticCounts.tickString, 1);
    assert.strictEqual(diagnostic.diagnosticCounts.tickGeneric, 1);
    assert.strictEqual(diagnostic.diagnosticCounts.tickOptionComputation, 1);
    assert.deepStrictEqual(diagnostic.diagnosticSamples.rerouteMktDataReq[0], { conId: 12345, exchange: 'SMART' });
    assert.deepStrictEqual(diagnostic.diagnosticSamples.tickReqParams[0], { minTick: 0.01, bboExchange: 'NASDAQ', snapshotPermissions: 3 });
  }

  {
    const { adapter, client } = makeAdapter({ quoteTimeoutMs: 2000 });
    ready(adapter, client, 94);
    const promise = adapter.getQuote('AAPL');
    await Promise.resolve();
    await adapter.forgetQuote('AAPL');
    const quote = await promise;
    assert.strictEqual(quote, null);
    assert.deepStrictEqual(client.cancelledMarketData, [client.marketDataRequests[0].reqId]);
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 95);
    const promise = adapter.getQuote('AAPL');
    await Promise.resolve();
    client.emit('error', new Error('No market data permissions'), 354, client.marketDataRequests[0].reqId);
    const quote = await promise;
    assert.strictEqual(quote, null);
    assert.deepStrictEqual(client.cancelledMarketData, [client.marketDataRequests[0].reqId]);
    assert(adapter.logs.some(entry => entry.message === 'IBKR market data subscription missing or unavailable'));
    const permissionLog = adapter.logs.find(entry => entry.message === 'IBKR market data subscription missing or unavailable');
    assert.strictEqual(permissionLog.errorLabel, 'not-subscribed');
    assert.strictEqual(permissionLog.diagnosticCounts.errors, 1);

    const retry = adapter.getQuote('AAPL');
    await Promise.resolve();
    assert.strictEqual(client.marketDataRequests.length, 2);
    client.emit('tickPrice', client.marketDataRequests[1].reqId, 4, 103.5);
    const retryQuote = await retry;
    assert.strictEqual(retryQuote.price, 103.5);
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 96);
    client.failMktData = 'boom';
    const quote = await adapter.getQuote('AAPL');
    assert.strictEqual(quote, null);
    assert.strictEqual(client.marketDataRequests.length, 0);
    assert.deepStrictEqual(client.cancelledMarketData, [900000000]);
    assert(adapter.logs.some(entry => entry.message === 'reqMktData failed'));
  }

  {
    const { adapter, client } = makeAdapter({ instruments: {} });
    ready(adapter, client, 100);
    const promise = adapter.placeOrder({ symbol: 'INTC', side: 'buy', type: 'market', qty: 3, clientOrderId: 'cid-intc' });
    await Promise.resolve();
    assert.strictEqual(client.contractDetailsRequests.length, 1);
    emitContractDetails(client, client.contractDetailsRequests[0].reqId, { conId: 270639, symbol: 'INTC', secType: 'STK', exchange: 'SMART', currency: 'USD', primaryExchange: 'NASDAQ', localSymbol: 'INTC', tradingClass: 'NMS' });
    await Promise.resolve();
    await Promise.resolve();
    const res = await promise;
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(client.placed[0].contract.conId, 270639);
    assert.strictEqual(client.placed[0].order.totalQuantity, 3);
  }

  {
    const { adapter, client } = makeAdapter({ instruments: {}, contractResolution: { profileBySymbol: { ALNY: 'CFD' } } });
    ready(adapter, client, 100);
    const promise = adapter.placeOrder({ symbol: 'ALNY', instrumentType: 'CFD', side: 'buy', type: 'market', qty: 1, clientOrderId: 'cid-alny-cfd' });
    await Promise.resolve();
    assert.deepStrictEqual(client.contractDetailsRequests[0].contract, { symbol: 'ALNY', secType: 'CFD', exchange: 'SMART', currency: 'USD' });
    emitContractDetails(client, client.contractDetailsRequests[0].reqId, { conId: 54321, symbol: 'ALNY', secType: 'CFD', exchange: 'SMART', currency: 'USD' });
    await Promise.resolve();
    await Promise.resolve();
    const res = await promise;
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(client.placed[0].contract.secType, 'CFD');
    assert.strictEqual(client.placed[0].contract.exchange, 'SMART');
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 100);
    const res = await adapter.placeOrder({ symbol: 'AAPL', side: 'buy', type: 'market', qty: 5, clientOrderId: 'cid-mkt' });
    assert.strictEqual(res.status, 'ok');
    assert.deepStrictEqual(res.raw.orderIds, [100]);
    assert.strictEqual(client.placed.length, 1);
    assert.strictEqual(client.placed[0].order.orderType, 'MKT');
    assert.strictEqual(client.placed[0].order.action, 'BUY');
    assert.strictEqual(client.placed[0].order.totalQuantity, 5);
    assert.strictEqual(client.placed[0].order.transmit, true);
    assert.strictEqual(client.placed[0].order.account, 'DU123');
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 200);
    const res = await adapter.placeOrder({ symbol: 'AAPL', side: 'sell', type: 'limit', qty: 2, price: 191.25, tif: 'GTC', clientOrderId: 'cid-lmt' });
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(client.placed[0].order.orderType, 'LMT');
    assert.strictEqual(client.placed[0].order.action, 'SELL');
    assert.strictEqual(client.placed[0].order.lmtPrice, 191.25);
    assert.strictEqual(client.placed[0].order.tif, 'GTC');
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 300);
    const res = await adapter.placeOrder({ symbol: 'AAPL', side: 'buy', type: 'stop', qty: 1, price: 10 });
    assert.strictEqual(res.status, 'rejected');
    assert.match(res.reason, /Unsupported IBKR order type/);
    assert.strictEqual(client.placed.length, 0);
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 400);
    const res = await adapter.placeOrder({ symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, price: 100, tickSize: 0.01, tp: 250, sl: 100, clientOrderId: 'cid-bracket' });
    assert.strictEqual(res.status, 'ok');
    assert.deepStrictEqual(res.raw.orderIds, [400, 401, 402]);
    assert.strictEqual(client.placed.length, 3);
    assert.strictEqual(client.placed[0].order.transmit, false);
    assert.strictEqual(client.placed[1].order.orderType, 'LMT');
    assert.strictEqual(client.placed[1].order.parentId, 400);
    assert.strictEqual(client.placed[1].order.lmtPrice, 102.5);
    assert.strictEqual(client.placed[1].order.transmit, false);
    assert.strictEqual(client.placed[2].order.orderType, 'STP');
    assert.strictEqual(client.placed[2].order.auxPrice, 99);
    assert.strictEqual(client.placed[2].order.parentId, 400);
    assert.strictEqual(client.placed[2].order.transmit, true);
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 500);
    const res = await adapter.placeOrder({ symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, price: 100, tickSize: 0.01, tp: 250, clientOrderId: 'cid-bad-bracket' });
    assert.strictEqual(res.status, 'rejected');
    assert.match(res.reason, /Both tp and sl/);
    assert.strictEqual(client.placed.length, 0);
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 10);
    client.emit('openOrder', 25, { symbol: 'AAPL' }, {}, { status: 'Submitted' });
    assert.strictEqual(adapter.allocateOrderId(), 26);
  }

  {
    const { adapter, client } = makeAdapter({ cancelConfirmTimeoutMs: 1000 });
    ready(adapter, client, 700);
    const p = adapter.cancelOrder('42');
    assert.deepStrictEqual(client.cancels, [42]);
    client.emit('orderStatus', 42, 'Cancelled', 0, 1);
    const res = await p;
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(res.providerOrderId, '42');
  }

  {
    const { adapter, client } = makeAdapter();
    ready(adapter, client, 800);
    let rejected;
    adapter.on('order:rejected', evt => { rejected = evt; });
    const res = await adapter.placeOrder({ symbol: 'AAPL', side: 'buy', type: 'market', qty: 1, clientOrderId: 'cid-error' });
    assert.strictEqual(res.status, 'ok');
    client.emit('error', new Error('Order rejected by IB'), 201, 800);
    assert(rejected);
    assert.match(rejected.reason, /IBKR API error/);
  }

  {
    const sanitized = safeClone({ token: 'abc', nested: { apiKey: 'secret', value: 1 }, password: 'pw' });
    assert.strictEqual(sanitized.token, '[redacted]');
    assert.strictEqual(sanitized.nested.apiKey, '[redacted]');
    assert.strictEqual(sanitized.password, '[redacted]');
    assert.strictEqual(sanitized.nested.value, 1);
  }

  console.log('ibkrAdapter tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
