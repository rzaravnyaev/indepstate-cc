const assert = require('assert');
const {
  createOutboundWebhooksService,
  parseWebhookCommandArgs,
  renderTemplate,
  resolveEnvRefs
} = require('../app/services/outboundWebhooks');
const { WebhookCommand } = require('../app/services/outboundWebhooks/command');
const { enrichLifecyclePayload } = require('../app/services/outboundWebhooks/manifest');
const { createCommandService } = require('../app/services/commandLine');

function response(status, body = '') {
  return {
    status,
    async text() {
      return body;
    }
  };
}

async function run() {
  process.env.OUTBOUND_TEST_TOKEN = 'tok-123';
  process.env.OUTBOUND_TEST_SECRET = 'relay-secret';

  assert.deepStrictEqual(renderTemplate({
    text: '{text}',
    missing: '{missing}',
    obj: '{obj}',
    legPair: '{legs[0][0]}/{legs[0][1]}'
  }, {
    text: 'hello',
    obj: { a: 1 },
    legs: [['+1P7290', '-1P7280']]
  }), {
    text: 'hello',
    missing: '',
    obj: '{"a":1}',
    legPair: '+1P7290/-1P7280'
  });

  assert.deepStrictEqual(resolveEnvRefs({
    Authorization: 'Bearer ${ENV:OUTBOUND_TEST_TOKEN}',
    Missing: '${ENV:OUTBOUND_TEST_MISSING}'
  }), {
    value: {
      Authorization: 'Bearer tok-123',
      Missing: ''
    },
    missing: ['OUTBOUND_TEST_MISSING']
  });

  assert.deepStrictEqual(parseWebhookCommandArgs([
    'simple',
    'hello',
    'world',
    'props=event:manual;cardId:c1'
  ]), {
    ok: true,
    target: 'simple',
    payload: {
      event: 'manual',
      cardId: 'c1',
      text: 'hello world'
    }
  });

  assert.deepStrictEqual(parseWebhookCommandArgs([
    'simple',
    'props=text:LCS',
    '7510/7500',
    '-',
    '+1C7500/-1C7510'
  ]), {
    ok: true,
    target: 'simple',
    payload: {
      text: 'LCS 7510/7500 - +1C7500/-1C7510'
    }
  });

  assert.deepStrictEqual(enrichLifecyclePayload('order:placed', {
    order: {
      symbol: 'SPXW',
      qty: 2,
      price: 1.25,
      legs: [
        { option: 'PUT', side: 'buy', strike: 7290, quantity: 1 },
        { option: 'PUT', side: 'sell', strike: 7280, quantity: 1 }
      ],
      meta: { requestId: 'req-1' }
    },
    result: { cid: 'cid-1' }
  }), {
    event: 'order:placed',
    cardId: 'cid-1',
    cid: 'cid-1',
    symbol: 'SPXW',
    legs: [
      { option: 'PUT', side: 'buy', strike: 7290, quantity: 1 },
      { option: 'PUT', side: 'sell', strike: 7280, quantity: 1 }
    ],
    legsText: '+1P7290/-1P7280',
    legsPair: '7290/7280',
    qty: 2,
    price: 1.25,
    order: {
      symbol: 'SPXW',
      qty: 2,
      price: 1.25,
      legs: [
        { option: 'PUT', side: 'buy', strike: 7290, quantity: 1 },
        { option: 'PUT', side: 'sell', strike: 7280, quantity: 1 }
      ],
      meta: { requestId: 'req-1' }
    },
    result: { cid: 'cid-1' }
  });

  const requests = [];
  const sleeps = [];
  const fetch = async (url, opts) => {
    requests.push({ url, opts });
    if (url.includes('/retry') && requests.filter(r => r.url.includes('/retry')).length === 1) {
      return response(500, 'nope');
    }
    return response(200, '{"ok":true}');
  };

  const service = createOutboundWebhooksService({
    enabled: true,
    targets: {
      simple: {
        enabled: true,
        url: 'https://example.test/simple',
        headers: {
          Authorization: 'Bearer ${ENV:OUTBOUND_TEST_TOKEN}'
        },
        body: {
          text: '{text}'
        }
      },
      relay: {
        enabled: true,
        url: 'https://example.test/relay',
        headers: {
          'Content-Type': 'application/json',
          'X-Relay-Secret': '${ENV:OUTBOUND_TEST_SECRET}'
        },
        body: {
          event: '{event}',
          cardId: '{cardId}',
          symbol: '{symbol}',
          legs: '{legs}',
          qty: '{qty}',
          price: '{price}',
          ts: '{ts}'
        },
        dedupeKey: '{event}:{cardId}'
      },
      retry: {
        enabled: true,
        url: 'https://example.test/retry',
        body: 'msg={text}',
        okStatuses: ['200'],
        retry: {
          attempts: 2,
          backoffMs: [5]
        }
      },
      passthrough: {
        enabled: true,
        url: 'https://example.test/passthrough'
      },
      disabled: {
        enabled: false,
        url: 'https://example.test/disabled',
        body: { text: '{text}' }
      },
      missingSecret: {
        enabled: true,
        url: 'https://example.test/missing',
        headers: {
          'X-Secret': '${ENV:OUTBOUND_TEST_MISSING}'
        },
        body: { text: '{text}' }
      }
    },
    groups: {
      all: ['simple', 'relay', 'disabled']
    }
  }, {
    fetch,
    sleep: async ms => sleeps.push(ms),
    now: () => '2026-07-17T00:00:00.000Z',
    logger: { error() {} }
  });

  let res = await service.send('simple', { text: 'hello' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(requests[0].url, 'https://example.test/simple');
  assert.strictEqual(requests[0].opts.headers.Authorization, 'Bearer tok-123');
  assert.strictEqual(requests[0].opts.headers['Content-Type'], 'application/json');
  assert.strictEqual(requests[0].opts.body, '{"text":"hello"}');

  res = await service.send('all', {
    text: 'fanout',
    event: 'order_filled',
    cardId: 'c2',
    symbol: 'SPXW',
    legs: '+1P7290 / -1P7280',
    qty: 1,
    price: 2.85
  });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.results.map(item => item.target), ['simple', 'relay', 'disabled']);
  assert.strictEqual(res.results[2].skipped, true);
  const relayReq = requests.find(r => r.url === 'https://example.test/relay');
  assert.strictEqual(relayReq.opts.headers['X-Relay-Secret'], 'relay-secret');
  assert.strictEqual(JSON.parse(relayReq.opts.body).ts, '2026-07-17T00:00:00.000Z');

  const requestCountBeforeDuplicate = requests.length;
  res = await service.send('relay', {
    event: 'order_filled',
    cardId: 'c2',
    symbol: 'SPXW'
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.results[0].duplicate, true);
  assert.strictEqual(requests.length, requestCountBeforeDuplicate);

  res = await service.send('retry', { text: 'try me' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.results[0].attempts, 2);
  assert.deepStrictEqual(sleeps, [5]);

  res = await service.send('missingSecret', { text: 'x' });
  assert.strictEqual(res.ok, false);
  assert.match(res.results[0].error, /OUTBOUND_TEST_MISSING/);

  res = await service.runAction('send relay props=event:order_submitted;cardId:c3', null, {
    symbol: 'NDX',
    legs: '+1C1'
  });
  assert.strictEqual(res.ok, true);
  const actionReq = requests[requests.length - 1];
  assert.strictEqual(JSON.parse(actionReq.opts.body).event, 'order_submitted');
  assert.strictEqual(JSON.parse(actionReq.opts.body).symbol, 'NDX');

  res = await service.runAction('send passthrough props=event:order_cancelled;cardId:c4', null, {
    symbol: 'SHOULD_NOT_BE_SENT',
    legs: 'SHOULD_NOT_BE_SENT'
  });
  assert.strictEqual(res.ok, true);
  const passthroughReq = requests[requests.length - 1];
  assert.deepStrictEqual(JSON.parse(passthroughReq.opts.body), {
    event: 'order_cancelled',
    cardId: 'c4'
  });

  const cmdService = createCommandService({
    commands: [new WebhookCommand({ sender: service })]
  });
  res = await cmdService.run('wh simple command text props=event:manual');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(JSON.parse(requests[requests.length - 1].opts.body).text, 'command text');

  const traceLines = [];
  const traceService = createOutboundWebhooksService({
    enabled: true,
    trace: { enabled: true, includePayload: true, includeBody: true },
    targets: {
      traced: {
        enabled: true,
        url: 'https://example.test/traced',
        headers: {
          Authorization: 'Bearer ${ENV:OUTBOUND_TEST_TOKEN}',
          'X-Relay-Secret': '${ENV:OUTBOUND_TEST_SECRET}'
        },
        body: { text: '{text}' }
      }
    }
  }, {
    fetch: async () => response(200),
    logger: {
      info(...args) { traceLines.push(args); },
      error() {}
    }
  });
  res = await traceService.send('traced', { text: 'trace me' });
  assert.strictEqual(res.ok, true);
  assert.ok(traceLines.some(args => args[1] === 'send.start'));
  const prepared = traceLines.find(args => args[1] === 'target.prepared');
  assert.ok(prepared);
  assert.strictEqual(prepared[2].headers.Authorization, '[redacted]');
  assert.strictEqual(prepared[2].headers['X-Relay-Secret'], '[redacted]');
  assert.deepStrictEqual(prepared[2].body, { text: 'trace me' });

  let dryFetchCalled = false;
  const dryLines = [];
  const dryService = createOutboundWebhooksService({
    enabled: true,
    trace: { enabled: true },
    targets: {
      dry: {
        enabled: true,
        dryRun: true,
        url: 'https://example.test/dry',
        headers: {
          Authorization: 'Bearer ${ENV:OUTBOUND_TEST_TOKEN}'
        },
        body: { text: '{text}' }
      }
    }
  }, {
    fetch: async () => {
      dryFetchCalled = true;
      return response(200);
    },
    logger: {
      info(...args) { dryLines.push(args); },
      error() {}
    }
  });
  res = await dryService.send('dry', { text: 'do not send' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.results[0].dryRun, true);
  assert.strictEqual(dryFetchCalled, false);
  assert.ok(dryLines.some(args => args[1] === 'target.dry-run'));

  console.log('outboundWebhooks tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
