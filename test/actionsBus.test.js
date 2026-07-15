const assert = require('assert');
const { createActionsBus } = require('../app/services/actions-bus');

function run() {
  const executed = [];
  const errors = [];
  const bus = createActionsBus({
    onError(err) {
      errors.push(err.message);
    }
  });
  bus.registerActionFunction('joinSymbolLevel', (symbol, price) => `${symbol}@${price}`);

  bus.configure([
    {
      name: 'Foo action',
      label: 'Foo toggle',
      bindings: [
        { event: 'foo', action: 'commandLine:test {symbol}' },
        { event: 'bar', action: 'commandLine:bar {symbol}' },
        { event: 'tv', action: 'commandLine:lo stripSymbol({symbol}) {price} props=producingLineId:{lineId}' },
        { event: 'plain', action: 'commandLine:plain stripSymbol({symbol})' },
        { event: 'custom', action: 'commandLine:custom joinSymbolLevel({symbol}, {price})' },
        { event: 'ray', action: 'commandLine:lo stripSymbol({symbol}) {price} props=stopOffsetPts:dist({price},{rayPrice});stopOffsetTicks:distPts({price},{rayPrice});producingLineId:{lineId}' },
        { event: 'add-helper', action: 'commandLine:add-helper add({price},{offset}, {extra})' },
        { event: 'unknown-fn', action: 'commandLine:unknown missingFn({symbol}) keep-going' }
      ]
    },
    { event: 'foo', action: 'other:always-run' },
    { event: 'foo', action: 'no-prefix-run' }
  ]);

  let named = bus.listNamedActions();
  assert.deepStrictEqual(named, [{ name: 'Foo action', label: 'Foo toggle', enabled: true }]);

  bus.emit('foo', { symbol: 'AAA' });
  bus.emit('bar', { symbol: 'AAA' });
  bus.emit('tv', { symbol: 'NYSE:AAA', price: 1.23, lineId: 'foo' });
  bus.emit('plain', { symbol: 'ES.cfd' });
  bus.emit('custom', { symbol: 'AAA', price: 1.23 });
  bus.emit('ray', { symbol: 'NYSE:AAA', price: 1.5, rayPrice: 1.35, lineId: 'foo' });
  bus.emit('add-helper', { price: 1.5, offset: 0.15, extra: 0.2 });
  bus.emit('unknown-fn', { symbol: 'AAA' });
  assert.deepStrictEqual(executed, []);
  assert.deepStrictEqual(errors, ['Unknown action function: missingFn']);
  errors.length = 0;

  const commandLineRunner = (cmd) => {
    executed.push(`cli:${cmd}`);
    return { ok: true };
  };

  bus.registerCommandRunner('commandLine', commandLineRunner);
  bus.setCommandRunner(commandLineRunner);

  bus.registerCommandRunner('other', (cmd) => {
    executed.push(`other:${cmd}`);
    return { ok: true };
  });

  assert.deepStrictEqual(executed, [
    'cli:test AAA',
    'cli:bar AAA',
    'cli:lo AAA 1.23 props=producingLineId:foo',
    'cli:plain ES.cfd',
    'cli:custom AAA@1.23',
    'cli:lo AAA 1.5 props=stopOffsetPts:0.15;stopOffsetTicks:15;producingLineId:foo',
    'cli:add-helper 1.85',
    'cli:unknown  keep-going',
    'cli:no-prefix-run',
    'other:always-run'
  ]);
  assert.deepStrictEqual(errors, ['Unknown action function: missingFn']);
  errors.length = 0;

  bus.emit('foo', { symbol: 'AAA' });
  bus.emit('bar', { symbol: 'AAA' });
  assert.deepStrictEqual(executed, [
    'cli:test AAA',
    'cli:bar AAA',
    'cli:lo AAA 1.23 props=producingLineId:foo',
    'cli:plain ES.cfd',
    'cli:custom AAA@1.23',
    'cli:lo AAA 1.5 props=stopOffsetPts:0.15;stopOffsetTicks:15;producingLineId:foo',
    'cli:add-helper 1.85',
    'cli:unknown  keep-going',
    'cli:no-prefix-run',
    'other:always-run',
    'cli:test AAA',
    'other:always-run',
    'cli:no-prefix-run',
    'cli:bar AAA'
  ]);

  bus.setActionEnabled('Foo action', false);
  assert.strictEqual(bus.getActionState('Foo action'), false);
  bus.emit('foo', { symbol: 'BBB' });
  bus.emit('bar', { symbol: 'BBB' });
  assert.deepStrictEqual(executed, [
    'cli:test AAA',
    'cli:bar AAA',
    'cli:lo AAA 1.23 props=producingLineId:foo',
    'cli:plain ES.cfd',
    'cli:custom AAA@1.23',
    'cli:lo AAA 1.5 props=stopOffsetPts:0.15;stopOffsetTicks:15;producingLineId:foo',
    'cli:add-helper 1.85',
    'cli:unknown  keep-going',
    'cli:no-prefix-run',
    'other:always-run',
    'cli:test AAA',
    'other:always-run',
    'cli:no-prefix-run',
    'cli:bar AAA',
    'other:always-run',
    'cli:no-prefix-run'
  ]);

  bus.configure([
    { event: 'bar', action: 'commandLine:second {price}', name: 'Second' }
  ]);

  executed.length = 0;
  bus.emit('bar', { price: 1.23 });
  assert.deepStrictEqual(executed, ['cli:second 1.23']);

  named = bus.listNamedActions();
  assert.deepStrictEqual(named, [{ name: 'Second', label: 'Second', enabled: true }]);
  assert.strictEqual(bus.getActionState('Foo action'), undefined);
  assert.ok(bus.listActionFunctions().includes('stripSymbol'));
  assert.ok(bus.listActionFunctions().includes('add'));
  assert.ok(bus.listActionFunctions().includes('joinSymbolLevel'));
  assert.strictEqual(bus.unregisterActionFunction('joinSymbolLevel'), true);
  assert.ok(!bus.listActionFunctions().includes('joinSymbolLevel'));

  console.log('actionsBus tests passed');
}

try {
  run();
} catch (err) {
  console.error(err);
  process.exit(1);
}
