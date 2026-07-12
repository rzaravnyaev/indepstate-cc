const { Command } = require('../commands/base');

function normalizeTicker(ticker) {
  const raw = String(ticker || '').trim();
  if (!raw) return '';
  const dot = raw.indexOf('.');
  if (dot >= 0) {
    return raw.slice(0, dot).toUpperCase() + raw.slice(dot);
  }
  return raw.toUpperCase();
}

function parseNumber(value) {
  const n = Number(String(value ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function buildLevelOrderRow(args, now = Date.now()) {
  const [tickerRaw, levelRaw] = args || [];
  const ticker = normalizeTicker(tickerRaw);
  const level = parseNumber(levelRaw);
  if (!ticker || !Number.isFinite(level) || level <= 0) {
    return { ok: false, error: 'Usage: levelOrder {ticker} {level}' };
  }
  return {
    ok: true,
    row: {
      cardType: 'levelOrder',
      ticker,
      level,
      event: 'levelOrder',
      time: now
    }
  };
}

class LevelOrderCommand extends Command {
  constructor(opts = {}) {
    super(['levelOrder', 'lo']);
    this.onAdd = opts.onAdd;
    this.now = opts.now || Date.now;
  }

  run(args) {
    const built = buildLevelOrderRow(args, this.now());
    if (!built.ok) return built;
    if (typeof this.onAdd === 'function') this.onAdd(built.row);
    return { ok: true };
  }
}

module.exports = {
  LevelOrderCommand,
  buildLevelOrderRow,
  normalizeTicker
};
