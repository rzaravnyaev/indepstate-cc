const path = require('path');
const settings = require('../settings');
const points = require('./index');

settings.register(
  'tick-sizes',
  path.join(__dirname, 'config', 'tick-sizes.json'),
  path.join(__dirname, 'config', 'tick-sizes-settings-descriptor.json')
);

function initService(servicesApi = {}) {
  settings.onApply('tick-sizes', () => {
    servicesApi.instrumentInfo?.invalidateConfigTickSizes?.();
  });
}

settings.onApply('tick-sizes', ({ config }) => {
  points.configure(config);
});

module.exports = { initService };
