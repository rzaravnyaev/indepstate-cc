const { createInstrumentInfoService } = require('.');

function initService(servicesApi = {}) {
  if (servicesApi.instrumentInfo) return;
  servicesApi.instrumentInfo = createInstrumentInfoService({
    brokerage: servicesApi.brokerage,
    onError(err, context) {
      console.error('[instrumentInfo]', err?.message || err, context);
    }
  });
}

module.exports = { initService };
