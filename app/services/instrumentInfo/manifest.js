const { createInstrumentInfoService } = require('.');
const { detectInstrumentType } = require('../instruments');

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function isBinanceCcxtProvider(config) {
  const adapter = String(config?.adapter || '').trim().toLowerCase();
  const exchangeId = String(config?.exchangeId || '').trim().toLowerCase();
  return (adapter === 'ccxt' || adapter.startsWith('ccxt-'))
    && ['binance', 'binanceusdm', 'binance-futures', 'binancefutures'].includes(exchangeId);
}

function findConfiguredMetadataPreloadProviders(brokerage) {
  const cfg = brokerage?.getExecutionConfig?.() || {};
  const providers = cfg.providers || {};
  const candidates = new Set();
  const cxProvider = normalizeProvider(cfg.byInstrumentType?.CX);
  if (cxProvider) candidates.add(cxProvider);
  else {
    const defaultProvider = normalizeProvider(cfg.default);
    if (defaultProvider) candidates.add(defaultProvider);
  }
  for (const [symbol, provider] of Object.entries(cfg.bySymbol || {})) {
    if (detectInstrumentType(String(symbol || '')) === 'CX') {
      const normalized = normalizeProvider(provider);
      if (normalized) candidates.add(normalized);
    }
  }
  return Array.from(candidates).filter(provider => isBinanceCcxtProvider(providers[provider]));
}

function prewarmConfiguredInstrumentMetadata(brokerage, {
  schedule = typeof setImmediate === 'function' ? setImmediate : (fn => setTimeout(fn, 0)),
  onError = (err, provider) => console.error('[instrumentInfo] metadata prewarm failed', provider, err?.message || err)
} = {}) {
  const providers = findConfiguredMetadataPreloadProviders(brokerage);
  if (!providers.length) return providers;
  schedule(() => {
    for (const provider of providers) {
      try {
        brokerage.getAdapter(provider);
      } catch (err) {
        onError(err, provider);
      }
    }
  });
  return providers;
}

function initService(servicesApi = {}) {
  if (!servicesApi.instrumentInfo) {
    servicesApi.instrumentInfo = createInstrumentInfoService({
      brokerage: servicesApi.brokerage,
      onError(err, context) {
        console.error('[instrumentInfo]', err?.message || err, context);
      }
    });
  }
  if (!servicesApi.__instrumentMetadataPrewarmScheduled) {
    servicesApi.__instrumentMetadataPrewarmScheduled = true;
    prewarmConfiguredInstrumentMetadata(servicesApi.brokerage);
  }
}

module.exports = {
  initService,
  isBinanceCcxtProvider,
  findConfiguredMetadataPreloadProviders,
  prewarmConfiguredInstrumentMetadata
};
