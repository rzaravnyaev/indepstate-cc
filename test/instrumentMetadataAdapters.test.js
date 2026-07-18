const assert = require('assert');
const { CCXTExecutionAdapter } = require('../app/services/brokerage-adapter-ccxt/comps/ccxt');
const { SimulatedAdapter } = require('../app/services/brokerage-adapter-simulated/comps/simulated');

async function run() {
  const ccxtAdapter = Object.create(CCXTExecutionAdapter.prototype);
  ccxtAdapter.provider = 'ccxt-test';
  ccxtAdapter.ensureReady = async () => {};
  ccxtAdapter.mapSymbol = () => 'AAA/USDT:USDT';
  ccxtAdapter._isBinanceUsdmLike = () => false;
  ccxtAdapter._getTickSizeFromMarket = () => 0.01;
  ccxtAdapter.exchange = {
    markets: {
      'AAA/USDT:USDT': {
        precision: { amount: 3 },
        limits: { amount: { min: 0.01, max: 100 }, cost: { min: 5 } },
        contractSize: 10
      }
    },
    market(symbol) { return this.markets[symbol]; }
  };
  const metadata = await ccxtAdapter.getInstrumentMetadata('AAAUSDT.P');
  assert.deepStrictEqual(metadata, {
    tickSize: 0.01,
    quantityStep: 0.001,
    minQty: 0.01,
    maxQty: 100,
    minNotional: 5,
    contractSize: 10,
    sources: {
      tickSize: 'ccxt-market',
      quantityStep: 'ccxt-market',
      minQty: 'ccxt-market',
      maxQty: 'ccxt-market',
      minNotional: 'ccxt-market',
      contractSize: 'ccxt-market'
    }
  });

  const simulated = new SimulatedAdapter({ latencyMs: [0, 0] });
  assert.strictEqual((await simulated.getInstrumentMetadata('AAA')).tickSize, 0.01);

  console.log('instrument metadata adapter tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
