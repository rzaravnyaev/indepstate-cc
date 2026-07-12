function finiteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundQty(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(10));
}

function resolveLevelOrderDefaults(config = {}, ticker) {
  const defaults = config.defaults || {};
  const normalizedTicker = String(ticker || '').trim().toUpperCase();
  const override = Array.isArray(config.symbols)
    ? config.symbols.find(item => String(item?.ticker || '').trim().toUpperCase() === normalizedTicker)
    : null;
  return {
    riskUsd: finiteNumber(override?.riskUsd, finiteNumber(defaults.riskUsd, null)),
    maxLot: finiteNumber(override?.maxLot, finiteNumber(defaults.maxLot, 0)),
    stopOffsetPts: finiteNumber(override?.stopOffsetPts, finiteNumber(defaults.stopOffsetPts, null)),
    takeProfitPts: finiteNumber(override?.takeProfitPts, finiteNumber(defaults.takeProfitPts, null))
  };
}

function splitQuantity(totalQty, maxLot, instrumentType) {
  const total = instrumentType === 'EQ'
    ? Math.floor(Number(totalQty))
    : roundQty(totalQty);
  const max = Number(maxLot);
  if (!Number.isFinite(total) || total <= 0) return [];
  if (!Number.isFinite(max) || max <= 0 || max >= total) return [total];

  const cap = instrumentType === 'EQ' ? Math.floor(max) : roundQty(max);
  if (!Number.isFinite(cap) || cap <= 0) return [total];

  const parts = [];
  let remaining = total;
  while (remaining > cap) {
    parts.push(cap);
    remaining = roundQty(remaining - cap);
  }
  if (remaining > 0) parts.push(instrumentType === 'EQ' ? Math.floor(remaining) : roundQty(remaining));
  return parts.filter(q => Number.isFinite(q) && q > 0);
}

function calculateLimitBidTradePlan({
  action,
  ticker,
  instrumentType,
  level,
  riskUsd,
  stopOffsetPts,
  maxLot,
  takeProfitPts,
  bid,
  tickSize,
  lot = 1,
  orderCalculator
} = {}) {
  const sideAction = String(action || '').toUpperCase();
  if (sideAction !== 'LB' && sideAction !== 'LS') {
    return { ok: false, reason: 'Unsupported level order action' };
  }

  const lvl = finiteNumber(level);
  const bidPrice = finiteNumber(bid);
  const tick = finiteNumber(tickSize);
  const risk = finiteNumber(riskUsd);
  const offset = finiteNumber(stopOffsetPts);
  if (!Number.isFinite(lvl) || lvl <= 0) return { ok: false, reason: 'Level > 0 required' };
  if (!Number.isFinite(bidPrice) || bidPrice <= 0) return { ok: false, reason: 'Bid quote required' };
  if (!Number.isFinite(tick) || tick <= 0) return { ok: false, reason: 'Tick size required' };
  if (!Number.isFinite(risk) || risk <= 0) return { ok: false, reason: 'Risk $ > 0 required' };
  if (!Number.isFinite(offset) || offset <= 0) return { ok: false, reason: 'Stop offset pts > 0 required' };

  const isBuy = sideAction === 'LB';
  if (isBuy && bidPrice < lvl) return { ok: false, reason: 'Cannot buy when bid is below level' };
  if (!isBuy && bidPrice > lvl) return { ok: false, reason: 'Cannot sell when bid is above level' };

  const levelDistancePts = Math.abs(bidPrice - lvl) / tick;
  const stopPts = levelDistancePts + offset;
  const stopPrice = isBuy ? lvl - offset * tick : lvl + offset * tick;
  const qty = orderCalculator.qty({
    riskUsd: risk,
    stopPts,
    tickSize: tick,
    lot,
    instrumentType
  });
  const childQtys = splitQuantity(qty, maxLot, instrumentType);
  if (!childQtys.length) return { ok: false, reason: 'Calculated quantity is 0' };

  const tp = finiteNumber(takeProfitPts);
  return {
    ok: true,
    ticker,
    action: sideAction,
    orderKind: isBuy ? 'BL' : 'SL',
    orderSide: isBuy ? 'buy' : 'sell',
    level: lvl,
    bid: bidPrice,
    tickSize: tick,
    riskUsd: risk,
    stopOffsetPts: offset,
    levelDistancePts,
    stopPts,
    stopPrice,
    takeProfitPts: Number.isFinite(tp) && tp > 0 ? tp : null,
    totalQty: qty,
    childQtys
  };
}

module.exports = {
  resolveLevelOrderDefaults,
  splitQuantity,
  calculateLimitBidTradePlan
};
