const { EventEmitter } = require('events');
const points = require('../points');

const DEFAULT_RUNNER_KEY = '__default__';
const ACTION_FUNCTION_PATTERN = /\b([A-Za-z_][A-Za-z0-9_]*)\(([^()]*)\)/g;

function formatActionValue(value) {
  if (value == null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function parsePath(path) {
  const raw = String(path || '').trim();
  if (!raw) return [];
  const parts = [];
  raw.replace(/([^.[\]]+)|\[(\d+)\]/g, (_match, prop, index) => {
    parts.push(index != null ? Number(index) : prop);
    return '';
  });
  return parts;
}

function getPathValue(obj, path) {
  const parts = parsePath(path);
  if (!parts.length) return undefined;
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function stripSymbol(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const colonIndex = raw.indexOf(':');
  return colonIndex >= 0 ? raw.slice(colonIndex + 1).trim() : raw;
}

// Keep dist() stable for decimal prices: Math.abs(1.5 - 1.35) would otherwise
// produce 0.1499999999999999, which breaks command templates and point conversion.
function decimalPlaces(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return 0;
  const [mantissa, exponentRaw] = raw.split('e');
  const decimals = mantissa.includes('.') ? mantissa.split('.')[1].length : 0;
  const exponent = Number(exponentRaw || 0);
  return Math.max(0, decimals - exponent);
}

function decimalFactor(values) {
  const places = Math.min(Math.max(...values.map(decimalPlaces)), 12);
  return 10 ** places;
}

function isBlankActionArg(value) {
  return typeof value === 'string' && value.trim() === '';
}

function hasInvalidNumericArg(values) {
  return values.some((value) => isBlankActionArg(value));
}

function add(...values) {
  while (values.length && typeof values[values.length - 1] === 'object') values.pop();
  if (!values.length || hasInvalidNumericArg(values)) return '';
  const nums = values.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return '';
  const factor = decimalFactor(values);
  return nums.reduce((sum, n) => sum + Math.round(n * factor), 0) / factor;
}

function dist(a, b) {
  if (hasInvalidNumericArg([a, b])) return '';
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return '';
  const factor = decimalFactor([a, b]);
  return Math.abs(Math.round(left * factor) - Math.round(right * factor)) / factor;
}

function distPts(a, b, payload = {}) {
  const gap = dist(a, b);
  if (gap === '') return '';
  const symbol = stripSymbol(payload?.symbol);
  const pts = points.toPoints(null, symbol, gap, undefined, String(gap));
  return Number.isFinite(pts) ? pts : '';
}

function distPtsPlus(a, b, extra, payload = {}) {
  if (hasInvalidNumericArg([extra])) return '';
  const rawPts = distPts(a, b, payload);
  if (rawPts === '') return '';
  const pts = Number(rawPts);
  const extraPts = Number(extra);
  if (!Number.isFinite(pts) || !Number.isFinite(extraPts)) return '';
  return add(pts, extraPts);
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function signedOptionLegQty(leg) {
  const qty = Math.abs(Number(leg?.quantity ?? leg?.qty ?? 0));
  const side = String(leg?.side || '').toLowerCase();
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  return side === 'sell' || side === 'short' ? -qty : qty;
}

function optionLegToken(leg) {
  if (!leg || typeof leg !== 'object') return '';
  const qty = signedOptionLegQty(leg);
  if (!qty) return '';
  const optionCode = String(leg.option || '').toUpperCase().startsWith('P') ? 'P' : 'C';
  const strike = leg.strike ?? leg.price ?? '';
  return `${qty > 0 ? '+' : '-'}${Math.abs(qty)}${optionCode}${strike}`;
}

function optionLegs(legs) {
  const list = parseMaybeJson(legs);
  if (!Array.isArray(list)) return '';
  return list.map(optionLegToken).filter(Boolean).join('/');
}

function optionLegPair(legs) {
  const list = parseMaybeJson(legs);
  if (!Array.isArray(list)) return '';
  return list.map(leg => leg && typeof leg === 'object' ? leg.strike ?? leg.price ?? '' : '').filter(v => v !== '').join('/');
}

function createActionsBus(opts = {}) {
  const emitter = new EventEmitter();
  const namedStates = new Map(); // name -> { enabled, label }
  const nameOrder = []; // preserve config order
  const configHandlers = new Map(); // event -> handler
  const pending = new Map(); // runnerKey -> [ { entry, payload } ]
  const commandRunners = new Map(); // runnerKey -> fn
  const actionFunctions = new Map();

  if (typeof opts.commandRunner === 'function') {
    commandRunners.set(DEFAULT_RUNNER_KEY, opts.commandRunner);
  }
  const onError = typeof opts.onError === 'function' ? opts.onError : null;
  const instrumentInfo = opts.instrumentInfo;

  function actionDistPts(a, b, payload = {}) {
    const gap = dist(a, b);
    if (gap === '') return '';
    const symbol = stripSymbol(payload?.symbol);
    const context = {
      provider: payload?.provider || payload?.meta?.provider,
      symbol,
      instrumentType: payload?.instrumentType,
      payload
    };
    const calculate = () => {
      if (instrumentInfo && typeof instrumentInfo.toPoints === 'function') {
        return instrumentInfo.toPoints(context, gap, {
          explicitTickSize: payload?.tickSize,
          deltaTokenForFallback: String(gap)
        });
      }
      return points.toPoints(payload?.tickSize, symbol, gap, undefined, String(gap));
    };
    if (!instrumentInfo || typeof instrumentInfo.get !== 'function' || instrumentInfo.peek?.(context)) {
      const value = calculate();
      return Number.isFinite(value) ? value : '';
    }
    return instrumentInfo.get(context, { quote: false, timeoutMs: 5000 })
      .then(() => {
        const value = calculate();
        return Number.isFinite(value) ? value : '';
      })
      .catch(() => {
        const value = calculate();
        return Number.isFinite(value) ? value : '';
      });
  }

  function actionDistPtsPlus(a, b, extra, payload = {}) {
    if (hasInvalidNumericArg([extra])) return '';
    const finish = (rawPts) => {
      if (rawPts === '') return '';
      const pts = Number(rawPts);
      const extraPts = Number(extra);
      if (!Number.isFinite(pts) || !Number.isFinite(extraPts)) return '';
      return add(pts, extraPts);
    };
    const rawPts = actionDistPts(a, b, payload);
    return rawPts && typeof rawPts.then === 'function' ? rawPts.then(finish) : finish(rawPts);
  }

  registerActionFunction('stripSymbol', stripSymbol);
  registerActionFunction('add', add);
  registerActionFunction('dist', dist);
  registerActionFunction('distPts', actionDistPts);
  registerActionFunction('distPtsPlus', actionDistPtsPlus);
  registerActionFunction('optionLegs', optionLegs);
  registerActionFunction('optionLegPair', optionLegPair);

  function getRunnerKey(name) {
    return typeof name === 'string' && name.trim()
      ? name.trim()
      : DEFAULT_RUNNER_KEY;
  }

  function parseActionSpec(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      const prefixRaw = trimmed.slice(0, colonIndex);
      const prefix = prefixRaw.trim();
      const rest = trimmed.slice(colonIndex + 1);
      const restTrimmed = rest.trimStart();
      const nextChar = restTrimmed.charAt(0);
      if (
        prefix &&
        restTrimmed &&
        !/\s/.test(prefix) &&
        nextChar !== '/' &&
        nextChar !== '\\'
      ) {
        return {
          runnerName: prefix,
          runnerKey: getRunnerKey(prefix),
          commandTemplate: restTrimmed,
          raw: trimmed
        };
      }
    }

    return {
      runnerName: null,
      runnerKey: DEFAULT_RUNNER_KEY,
      commandTemplate: trimmed,
      raw: trimmed
    };
  }

  function normalizeName(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  function normalizeLabel(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  function queuePending(runnerKey, entry, payload) {
    const key = runnerKey || DEFAULT_RUNNER_KEY;
    if (!pending.has(key)) pending.set(key, []);
    pending.get(key).push({ entry, payload });
  }

  function flushPending(runnerKey) {
    const key = runnerKey || DEFAULT_RUNNER_KEY;
    const queue = pending.get(key);
    if (!queue || queue.length === 0) return;
    pending.delete(key);
    let chain = null;
    for (const item of queue) {
      if (chain) chain = chain.then(() => executeAction(item.entry, item.payload));
      else {
        const result = executeAction(item.entry, item.payload);
        if (result && typeof result.then === 'function') chain = result;
      }
    }
  }

  function setRunner(key, fn) {
    const runnerKey = key || DEFAULT_RUNNER_KEY;
    if (typeof fn === 'function') {
      commandRunners.set(runnerKey, fn);
      flushPending(runnerKey);
      if (runnerKey !== DEFAULT_RUNNER_KEY && pending.has(DEFAULT_RUNNER_KEY)) {
        flushPending(DEFAULT_RUNNER_KEY);
      }
    } else if (commandRunners.has(runnerKey)) {
      commandRunners.delete(runnerKey);
    }
  }

  function setCommandRunner(fn) {
    setRunner(DEFAULT_RUNNER_KEY, fn);
  }

  function registerCommandRunner(name, fn) {
    const runnerKey = getRunnerKey(name);
    setRunner(runnerKey, fn);
    return () => {
      if (commandRunners.get(runnerKey) === fn) {
        commandRunners.delete(runnerKey);
      }
    };
  }

  function normalizeActionFunctionName(name) {
    if (typeof name !== 'string') return null;
    const trimmed = name.trim();
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? trimmed : null;
  }

  function registerActionFunction(name, fn) {
    const key = normalizeActionFunctionName(name);
    if (!key || typeof fn !== 'function') return null;
    actionFunctions.set(key, fn);
    return () => {
      if (actionFunctions.get(key) === fn) {
        actionFunctions.delete(key);
      }
    };
  }

  function unregisterActionFunction(name) {
    const key = normalizeActionFunctionName(name);
    if (!key) return false;
    return actionFunctions.delete(key);
  }

  function listActionFunctions() {
    return Array.from(actionFunctions.keys()).sort();
  }

  function resolvePlaceholders(template, payload) {
    if (typeof template !== 'string') return '';
    if (!payload || typeof payload !== 'object') return template;
    return template.replace(/\{([^{}\s]+)\}/g, (match, key) => {
      const value = getPathValue(payload, key);
      return formatActionValue(value);
    });
  }

  function parseFunctionArgs(rawArgs, payload) {
    if (typeof rawArgs !== 'string' || rawArgs.trim() === '') return [];
    return rawArgs.split(',').map((arg) => resolvePlaceholders(arg.trim(), payload));
  }

  function resolveCommand(template, payload, entry) {
    if (typeof template !== 'string') return '';
    const matches = Array.from(template.matchAll(new RegExp(ACTION_FUNCTION_PATTERN.source, 'g')));
    if (!matches.length) return resolvePlaceholders(template, payload);
    const values = matches.map((match) => {
      const [, fnName, rawArgs] = match;
      const fn = actionFunctions.get(fnName);
      if (typeof fn !== 'function') {
        if (onError) onError(new Error(`Unknown action function: ${fnName}`), entry, payload);
        return '';
      }
      try {
        return fn(...parseFunctionArgs(rawArgs, payload), payload, entry);
      } catch (err) {
        if (onError) onError(err, entry, payload);
        return '';
      }
    });
    const build = (resolvedValues) => {
      let expanded = '';
      let offset = 0;
      matches.forEach((match, index) => {
        expanded += template.slice(offset, match.index) + formatActionValue(resolvedValues[index]);
        offset = match.index + match[0].length;
      });
      expanded += template.slice(offset);
      return resolvePlaceholders(expanded, payload);
    };
    if (values.some(value => value && typeof value.then === 'function')) {
      return Promise.all(values.map(value => Promise.resolve(value).catch(err => {
        if (onError) onError(err, entry, payload);
        return '';
      }))).then(build);
    }
    return build(values);
  }

  function executeAction(entry, payload) {
    const template = entry.commandTemplate || entry.command || '';
    const resolved = resolveCommand(template, payload, entry);
    if (resolved && typeof resolved.then === 'function') {
      return resolved.then(cmd => executeResolvedAction(cmd, entry, payload));
    }
    return executeResolvedAction(resolved, entry, payload);
  }

  function executeResolvedAction(cmd, entry, payload) {
    if (!cmd) return;
    const runnerKey = entry.runnerKey || DEFAULT_RUNNER_KEY;
    let runner = commandRunners.get(runnerKey);
    if (!runner && runnerKey === DEFAULT_RUNNER_KEY && commandRunners.size === 1) {
      runner = commandRunners.values().next().value;
    }
    if (typeof runner !== 'function') {
      queuePending(runnerKey, entry, payload);
      return;
    }
    try {
      const res = runner(cmd, entry, payload);
      if (res && typeof res.then === 'function') {
        res.catch((err) => {
          if (onError) onError(err, entry, payload);
        });
      } else if (res && res.ok === false && onError) {
        onError(new Error(res.error || 'Action failed'), entry, payload);
      }
    } catch (err) {
      if (onError) onError(err, entry, payload);
    }
  }

  function clearConfigHandlers() {
    for (const [eventName, handler] of configHandlers.entries()) {
      emitter.off(eventName, handler);
    }
    configHandlers.clear();
  }

  function configure(actions = []) {
    clearConfigHandlers();
    const grouped = new Map();
    const seenNames = new Set();
    const nameLabels = new Map();
    nameOrder.length = 0;
    pending.clear();

    function registerEntry(actionItem, nameOverride, labelOverride) {
      if (!actionItem || typeof actionItem !== 'object') return;
      const eventName = typeof actionItem.event === 'string' ? actionItem.event.trim() : '';
      const command = typeof actionItem.action === 'string' ? actionItem.action.trim() : '';
      if (!eventName || !command) return;
      const spec = parseActionSpec(command);
      if (!spec || !spec.commandTemplate) return;
      const name = nameOverride != null ? nameOverride : normalizeName(actionItem.name);
      const label = labelOverride != null ? labelOverride : normalizeLabel(actionItem.label);
      const entry = {
        event: eventName,
        command: spec.raw,
        commandTemplate: spec.commandTemplate,
        runnerName: spec.runnerName,
        runnerKey: spec.runnerKey,
        name
      };
      if (!grouped.has(eventName)) grouped.set(eventName, []);
      grouped.get(eventName).push(entry);
      if (name && !seenNames.has(name)) {
        seenNames.add(name);
        nameOrder.push(name);
      }
      if (name && label) {
        nameLabels.set(name, label);
      }
    }

    if (Array.isArray(actions)) {
      actions.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const groupName = normalizeName(item.name);
        const groupLabel = normalizeLabel(item.label);
        if (Array.isArray(item.bindings)) {
          item.bindings.forEach((binding) => {
            registerEntry(binding, groupName, groupLabel);
          });
        }
        registerEntry(item);
      });
    }

    // cleanup removed named actions
    for (const key of Array.from(namedStates.keys())) {
      if (!seenNames.has(key)) namedStates.delete(key);
    }
    // ensure records for current names
    for (const name of nameOrder) {
      const cur = namedStates.get(name) || {};
      namedStates.set(name, {
        enabled: cur.enabled !== false,
        label: (nameLabels.has(name) ? nameLabels.get(name) : cur.label) || name
      });
    }

    for (const [eventName, list] of grouped.entries()) {
      const handler = (payload) => {
        let chain = null;
        for (const entry of list) {
          if (entry.name) {
            const state = namedStates.get(entry.name);
            if (state && state.enabled === false) continue;
          }
          if (chain) chain = chain.then(() => executeAction(entry, payload));
          else {
            const result = executeAction(entry, payload);
            if (result && typeof result.then === 'function') chain = result;
          }
        }
        return chain;
      };
      configHandlers.set(eventName, handler);
      emitter.on(eventName, handler);
    }
  }

  function emit(eventName, payload) {
    emitter.emit(eventName, payload);
  }

  function on(eventName, handler) {
    emitter.on(eventName, handler);
    return () => emitter.off(eventName, handler);
  }

  function off(eventName, handler) {
    emitter.off(eventName, handler);
  }

  function once(eventName, handler) {
    emitter.once(eventName, handler);
  }

  function listNamedActions() {
    return nameOrder.map((name) => {
      const info = namedStates.get(name) || {};
      return {
        name,
        label: info.label || name,
        enabled: info.enabled !== false
      };
    });
  }

  function setActionEnabled(name, enabled) {
    if (!namedStates.has(name)) return false;
    const info = namedStates.get(name);
    info.enabled = !!enabled;
    return true;
  }

  function getActionState(name) {
    const info = namedStates.get(name);
    if (!info) return undefined;
    return info.enabled !== false;
  }

  return {
    emit,
    on,
    off,
    once,
    configure,
    listNamedActions,
    setActionEnabled,
    getActionState,
    setCommandRunner,
    registerCommandRunner,
    registerActionFunction,
    unregisterActionFunction,
    listActionFunctions
  };
}

module.exports = { createActionsBus, stripSymbol, add, dist, distPts, distPtsPlus, getPathValue, optionLegs, optionLegPair };
