const assert = require('assert');
const { LevelOrderCommand, buildLevelOrderRow } = require('../app/services/levelOrder/command');
const {
  resolveLevelOrderDefaults,
  splitQuantity,
  calculateLimitBidTradePlan
} = require('../app/services/levelOrder/strategy');

const orderCalculator = {
  qty({ riskUsd, stopPts, tickSize, instrumentType }) {
    const raw = riskUsd / (stopPts * tickSize);
    return instrumentType === 'EQ' ? Math.floor(raw) : Number(raw.toFixed(3));
  }
};

(function testCommand() {
  let row;
  const cmd = new LevelOrderCommand({ now: () => 123, onAdd: r => { row = r; } });
  const res = cmd.run(['spx.cfd', '7500']);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(row, {
    cardType: 'levelOrder',
    ticker: 'SPX.cfd',
    level: 7500,
    event: 'levelOrder',
    time: 123
  });
  assert.strictEqual(buildLevelOrderRow(['SPX']).ok, false);
})();

(function testCommandProps() {
  let row;
  const cmd = new LevelOrderCommand({ now: () => 123, onAdd: r => { row = r; } });
  let res = cmd.run(['spx.cfd', '7500', 'props=producingLineId:foo']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.producingLineId, 'foo');

  res = cmd.run(['spx.cfd', '7500', 'props=producingLineId:foo;source:tv;note:line']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(row.producingLineId, 'foo');
  assert.strictEqual(row.source, 'tv');
  assert.strictEqual(row.note, 'line');

  res = cmd.run(['spx.cfd', '7500', 'props=ticker:BAD;level:1;event:bad;time:999;cardType:bad;producingLineId:foo']);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(row, {
    cardType: 'levelOrder',
    ticker: 'SPX.cfd',
    level: 7500,
    event: 'levelOrder',
    time: 123,
    producingLineId: 'foo'
  });

  assert.strictEqual(buildLevelOrderRow(['SPX', '7500', 'props=bad']).ok, false);
  assert.strictEqual(buildLevelOrderRow(['SPX', '7500', 'props=bad:']).ok, false);
  assert.strictEqual(buildLevelOrderRow(['SPX', '7500', 'props=bad-key:value']).ok, false);
  assert.strictEqual(buildLevelOrderRow(['SPX', '7500', 'extra']).ok, false);
})();

(function testDefaults() {
  const cfg = {
    defaults: { riskUsd: 50, maxLot: 0, stopOffsetPts: 10, takeProfitPts: null },
    symbols: [{ ticker: 'SPX.cfd', riskUsd: 100, maxLot: 3, stopOffsetPts: 5, takeProfitPts: 30 }]
  };
  assert.deepStrictEqual(resolveLevelOrderDefaults(cfg, 'SPX.cfd'), {
    riskUsd: 100,
    maxLot: 3,
    stopOffsetPts: 5,
    takeProfitPts: 30
  });
  assert.deepStrictEqual(resolveLevelOrderDefaults(cfg, 'AAPL'), {
    riskUsd: 50,
    maxLot: 0,
    stopOffsetPts: 10,
    takeProfitPts: null
  });
})();

(function testSideValidationAndMath() {
  const buy = calculateLimitBidTradePlan({
    action: 'LB',
    ticker: 'TST',
    instrumentType: 'EQ',
    level: 100,
    riskUsd: 110,
    stopOffsetPts: 2,
    maxLot: 5,
    takeProfitPts: 9,
    bid: 101,
    tickSize: 0.5,
    orderCalculator
  });
  assert.strictEqual(buy.ok, true);
  assert.strictEqual(buy.orderKind, 'BL');
  assert.strictEqual(buy.levelDistancePts, 2);
  assert.strictEqual(buy.stopPts, 4);
  assert.strictEqual(buy.stopPrice, 99);
  assert.strictEqual(buy.totalQty, 55);
  assert.deepStrictEqual(buy.childQtys, [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
  assert.strictEqual(buy.takeProfitPts, 9);

  const sell = calculateLimitBidTradePlan({
    action: 'LS',
    ticker: 'TST',
    instrumentType: 'EQ',
    level: 100,
    riskUsd: 110,
    stopOffsetPts: 2,
    maxLot: 0,
    bid: 99,
    tickSize: 0.5,
    orderCalculator
  });
  assert.strictEqual(sell.ok, true);
  assert.strictEqual(sell.orderKind, 'SL');
  assert.strictEqual(sell.stopPrice, 101);
  assert.deepStrictEqual(sell.childQtys, [55]);

  assert.strictEqual(calculateLimitBidTradePlan({
    action: 'LB', level: 100, riskUsd: 1, stopOffsetPts: 1, bid: 99, tickSize: 1, orderCalculator
  }).ok, false);
  assert.strictEqual(calculateLimitBidTradePlan({
    action: 'LS', level: 100, riskUsd: 1, stopOffsetPts: 1, bid: 101, tickSize: 1, orderCalculator
  }).ok, false);
})();

(function testSplitRemainder() {
  assert.deepStrictEqual(splitQuantity(12.3, 5, 'CX'), [5, 5, 2.3]);
  assert.deepStrictEqual(splitQuantity(12.3, 0, 'CX'), [12.3]);
  assert.deepStrictEqual(splitQuantity(12.3, 5, 'EQ'), [5, 5, 2]);
})();

console.log('levelOrder tests passed');
