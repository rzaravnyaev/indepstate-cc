# Instrument information service

`servicesApi.instrumentInfo` is the shared provider-aware source for live quotes and stable symbol
rules. Cache identity is the resolved lowercase provider plus the normalized uppercase symbol, so the
same ticker can safely use different brokers.

## Snapshot

`get(context, options)` returns:

```js
{
  provider: 'ccxt-binance-futures',
  symbol: 'BTCUSDT.P',
  instrumentType: 'CX',
  quote: { bid: 64000, ask: 64001, price: 64000.5, timestamp: 1780000000000 },
  metadata: {
    tickSize: 0.1,
    quantityStep: 0.001,
    minQty: 0.001,
    maxQty: 1000,
    minNotional: 5,
    contractSize: 1
  },
  sources: { tickSize: 'adapter:ccxt-binance-futures:binance-exchangeInfo' },
  quoteUpdatedAt: 1780000000000,
  metadataUpdatedAt: 1780000000000
}
```

Metadata fields other than the effective `tickSize` are optional. Raw provider responses are not part
of the public snapshot. Quotes are fresh for one second by default; metadata is fresh for five minutes.
Concurrent requests for one provider/symbol are coalesced.

At main-process startup, Binance USD-M providers selected by the CX execution route are created in
the background and their public futures `exchangeInfo` batch is preloaded. Startup does not wait for
the request. Live quotes are never preloaded.

## API

- `get(context, options)` fetches stale sections. Options include `forceQuote`, `forceMetadata`,
  `quote: false`, `metadata: false`, custom maximum ages, and `timeoutMs`.
- `peek(context)` returns the current cached snapshot without I/O.
- `forget(context)` clears the cached quote and forwards `forgetQuote(symbol)` to the adapter while
  retaining stable metadata.
- `resolveTickSize(context, { explicitTickSize })` applies the common precedence policy.
- `getTickSizeResolution(...)` also returns the selected source.
- `toPoints(context, deltaPrice, options)` converts through that resolved tick size.
- `on('updated', handler)` subscribes to changed snapshots.

Tick-size precedence is: explicit request value, provider metadata, symbol/pattern configuration,
then the configured global default. Explicit values are never stored in the shared cache.

## Adapter support

Adapters may implement `getInstrumentMetadata(symbol)` independently of `getQuote(symbol)`. The
service also extracts stable fields returned alongside legacy quotes. CCXT supplies exchange market
and filter rules, IBKR supplies contract details, and simulated/OptionStrat provide static rules. DWX
and J2T use tick-size configuration fallback because their integrations do not expose symbol specs.

For Binance futures, startup preload, quote symbol validation, and metadata lookup share one in-flight
exchange-info promise. The resulting all-symbol metadata map is cached for five minutes. Binance
metadata does not require CCXT `loadMarkets()`; non-Binance CCXT adapters retain their normal market
loading behavior.

Every changed snapshot is emitted on the actions bus as `instrument-info:updated`. Point helpers use
a warm snapshot synchronously; on a cold cache they wait up to five seconds for metadata and then
continue with configured fallback.
