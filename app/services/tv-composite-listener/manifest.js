function normalizeSymbol(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneActivity(value) {
  return value && typeof value === 'object' ? { ...value } : null;
}

function decimalPlaces(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return 0;
  const [mantissa, exponentRaw] = raw.split('e');
  const decimals = mantissa.includes('.') ? mantissa.split('.')[1].length : 0;
  const exponent = Number(exponentRaw || 0);
  return Math.max(0, decimals - exponent);
}

function distance(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  const places = Math.min(Math.max(decimalPlaces(a), decimalPlaces(b)), 12);
  const factor = 10 ** places;
  return Math.abs(Math.round(left * factor) - Math.round(right * factor)) / factor;
}

function initService(servicesApi = {}) {
  const api = servicesApi.tvCompositeListener = servicesApi.tvCompositeListener || {};
  const actionBus = servicesApi.actionBus;
  const stateBySymbol = new Map();

  function getSymbolState(symbol) {
    const key = normalizeSymbol(symbol);
    if (!key) return null;
    if (!stateBySymbol.has(key)) stateBySymbol.set(key, {});
    return stateBySymbol.get(key);
  }

  function getState(symbol) {
    const normalized = normalizeSymbol(symbol);
    if (normalized) {
      const state = stateBySymbol.get(normalized) || {};
      return { line: cloneActivity(state.line), ray: cloneActivity(state.ray) };
    }
    const out = {};
    for (const [key, state] of stateBySymbol.entries()) {
      out[key] = { line: cloneActivity(state.line), ray: cloneActivity(state.ray) };
    }
    return out;
  }

  function emitComposite(symbol) {
    const normalized = normalizeSymbol(symbol);
    const state = normalized ? stateBySymbol.get(normalized) : null;
    if (!state?.line || !state?.ray || !actionBus || typeof actionBus.emit !== 'function') return;
    const { line, ray } = state;
    const gap = distance(line.price, ray.rayPrice);
    actionBus.emit('tv-tool-horzline-ray', {
      symbol: line.symbol,
      price: line.price,
      linePrice: line.price,
      lineId: line.lineId,
      rayPrice: ray.rayPrice,
      rayId: ray.rayId,
      distance: gap,
      lineServerUpdateTime: line.serverUpdateTime,
      rayServerUpdateTime: ray.serverUpdateTime
    });
  }

  function onLine(payload = {}) {
    const symbol = normalizeSymbol(payload.symbol);
    const price = Number(payload.price);
    if (!symbol || !Number.isFinite(price)) return;
    const state = getSymbolState(symbol);
    state.line = { ...payload, symbol, price };
    emitComposite(symbol);
  }

  function onRay(payload = {}) {
    const symbol = normalizeSymbol(payload.symbol);
    const rayPrice = Number(payload.rayPrice ?? payload.price);
    if (!symbol || !Number.isFinite(rayPrice)) return;
    const state = getSymbolState(symbol);
    state.ray = { ...payload, symbol, rayPrice };
    emitComposite(symbol);
  }

  function removeLine(payload = {}) {
    const lineId = payload.lineId;
    for (const state of stateBySymbol.values()) {
      if (!lineId || state.line?.lineId === lineId) delete state.line;
    }
  }

  function removeRay(payload = {}) {
    const rayId = payload.rayId;
    for (const state of stateBySymbol.values()) {
      if (!rayId || state.ray?.rayId === rayId) delete state.ray;
    }
  }

  api.getState = getState;

  if (actionBus && typeof actionBus.on === 'function') {
    actionBus.on('tv-tool-horzline', onLine);
    actionBus.on('tv-tool-horzray', onRay);
    actionBus.on('tv-tool-horzline-remove', removeLine);
    actionBus.on('tv-tool-horzray-remove', removeRay);
  }
}

module.exports = { initService, distance };
