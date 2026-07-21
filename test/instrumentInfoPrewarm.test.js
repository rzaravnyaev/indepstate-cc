const assert = require('assert');
const {
  findConfiguredMetadataPreloadProviders,
  prewarmConfiguredInstrumentMetadata
} = require('../app/services/instrumentInfo/manifest');

function brokerageFor(config, calls = []) {
  return {
    getExecutionConfig() { return config; },
    getAdapter(provider) { calls.push(provider); return { provider }; }
  };
}

function run() {
  const config = {
    default: 'simulated',
    byInstrumentType: { CX: 'binance-main', EQ: 'dwx' },
    bySymbol: {
      'ETHUSDT.P': 'BINANCE-MAIN',
      'MOVRUSDT.P': 'binance-alt',
      AAPL: 'unused-ccxt'
    },
    providers: {
      'binance-main': { adapter: 'ccxt', exchangeId: 'binance' },
      'binance-alt': { adapter: 'ccxt', exchangeId: 'binanceusdm' },
      'unused-ccxt': { adapter: 'ccxt', exchangeId: 'binance' },
      dwx: { adapter: 'dwx' },
      simulated: { adapter: 'simulated' }
    }
  };
  const calls = [];
  const brokerage = brokerageFor(config, calls);
  assert.deepStrictEqual(findConfiguredMetadataPreloadProviders(brokerage), ['binance-main', 'binance-alt']);

  let scheduled;
  const selected = prewarmConfiguredInstrumentMetadata(brokerage, { schedule(fn) { scheduled = fn; } });
  assert.deepStrictEqual(selected, ['binance-main', 'binance-alt']);
  assert.deepStrictEqual(calls, []);
  scheduled();
  assert.deepStrictEqual(calls, ['binance-main', 'binance-alt']);

  const fallback = brokerageFor({
    default: 'binance-default',
    byInstrumentType: { EQ: 'dwx' },
    providers: { 'binance-default': { adapter: 'ccxt', exchangeId: 'binance-futures' }, dwx: { adapter: 'dwx' } }
  });
  assert.deepStrictEqual(findConfiguredMetadataPreloadProviders(fallback), ['binance-default']);

  const nonBinance = brokerageFor({
    default: 'simulated',
    byInstrumentType: { CX: 'generic-ccxt' },
    providers: { 'generic-ccxt': { adapter: 'ccxt', exchangeId: 'okx' }, simulated: { adapter: 'simulated' } }
  });
  assert.deepStrictEqual(findConfiguredMetadataPreloadProviders(nonBinance), []);

  console.log('instrument info prewarm tests passed');
}

run();
