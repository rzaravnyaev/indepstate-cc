# Execution Adapters

The adapter registry builds and caches execution connectors based on entries in `app/services/brokerage/config/execution.json`.
Copy this file to the `config` directory under the application's user data path to override the bundled defaults.

Each provider entry selects an adapter implementation and its settings.
Use `getAdapter(name)` to obtain a ready-to-use instance and `getProviderConfig(name)` to read raw configuration.

Provider routing is resolved centrally in priority order: explicit `provider`, `bySymbol`, `byInstrumentType`, then `default`.
Use `bySymbol` for exact symbol-to-provider overrides, for example `"bySymbol": { "AAPL": "j2t" }`.

## Optional data methods

Adapters may expose read-only data methods in addition to execution methods. MCP data tools call these through the adapter layer instead of reaching into provider-specific clients directly.

- `getInstrumentMetadata(symbol)` returns any available stable `tickSize`, `quantityStep`, `minQty`, `maxQty`, `minNotional`, and `contractSize` rules. The shared instrument-information service caches these optional fields and records their provenance.
- `getHistoricBars({ symbol, timeframe, from, to, limit, timeoutMs })` returns normalized OHLCV bars sorted oldest to newest. `from` and `to` are JavaScript `Date` values or compatible inputs at the adapter boundary; public MCP input uses ISO strings. DWX implements this through `GET_HISTORIC_DATA`.
