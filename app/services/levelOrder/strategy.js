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

function normalizeMinLot(value) {
  const n = finiteNumber(value, 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function roundQtyToStep(value, minLot = 1) {
  const qty = Number(value);
  const step = normalizeMinLot(minLot);
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  const units = Math.floor((qty + step * 1e-9) / step);
  return roundQty(units * step);
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
    minLot: normalizeMinLot(finiteNumber(override?.minLot, finiteNumber(defaults.minLot, 1))),
    stopOffsetPts: finiteNumber(override?.stopOffsetPts, finiteNumber(defaults.stopOffsetPts, null)),
    takeProfitPts: finiteNumber(override?.takeProfitPts, finiteNumber(defaults.takeProfitPts, null))
  };
}

function splitQuantity(totalQty, maxLot, instrumentType, minLot = 1) {
  const total = roundQtyToStep(totalQty, minLot);
  const max = Number(maxLot);
  if (!Number.isFinite(total) || total <= 0) return [];
  if (!Number.isFinite(max) || max <= 0 || max >= total) return [total];

  const cap = roundQtyToStep(max, minLot);
  if (!Number.isFinite(cap) || cap <= 0) return [total];

  const parts = [];
  let remaining = total;
  while (remaining > cap) {
    parts.push(cap);
    remaining = roundQty(remaining - cap);
  }
  if (remaining > 0) parts.push(roundQtyToStep(remaining, minLot));
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
  minLot = 1,
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
  const qtyStep = normalizeMinLot(minLot);
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
    instrumentType,
    quantityStep: qtyStep
  });
  const childQtys = splitQuantity(qty, maxLot, instrumentType, qtyStep);
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
    minLot: qtyStep,
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
  roundQtyToStep,
  calculateLimitBidTradePlan
};
