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

function stripSymbol(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const colonIndex = raw.indexOf(':');
  return colonIndex >= 0 ? raw.slice(colonIndex + 1).trim() : raw;
}

function decimalPlaces(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return 0;
  const [mantissa, exponentRaw] = raw.split('e');
  const decimals = mantissa.includes('.') ? mantissa.split('.')[1].length : 0;
  const exponent = Number(exponentRaw || 0);
  return Math.max(0, decimals - exponent);
}

function dist(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return '';
  const places = Math.min(Math.max(decimalPlaces(a), decimalPlaces(b)), 12);
  const factor = 10 ** places;
  return Math.abs(Math.round(left * factor) - Math.round(right * factor)) / factor;
}

function distPts(a, b, payload = {}) {
  const gap = dist(a, b);
  if (gap === '') return '';
  const symbol = stripSymbol(payload?.symbol);
  const pts = points.toPoints(null, symbol, gap, undefined, String(gap));
  return Number.isFinite(pts) ? pts : '';
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

  registerActionFunction('stripSymbol', stripSymbol);
  registerActionFunction('dist', dist);
  registerActionFunction('distPts', distPts);

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
    for (const item of queue) {
      executeAction(item.entry, item.payload);
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
      const value = payload[key];
      return formatActionValue(value);
    });
  }

  function parseFunctionArgs(rawArgs, payload) {
    if (typeof rawArgs !== 'string' || rawArgs.trim() === '') return [];
    return rawArgs.split(',').map((arg) => resolvePlaceholders(arg.trim(), payload));
  }

  function resolveCommand(template, payload, entry) {
    if (typeof template !== 'string') return '';
    const expandedFunctions = template.replace(ACTION_FUNCTION_PATTERN, (match, fnName, rawArgs) => {
      const fn = actionFunctions.get(fnName);
      if (typeof fn !== 'function') {
        if (onError) onError(new Error(`Unknown action function: ${fnName}`), entry, payload);
        return '';
      }
      try {
        return formatActionValue(fn(...parseFunctionArgs(rawArgs, payload), payload, entry));
      } catch (err) {
        if (onError) onError(err, entry, payload);
        return '';
      }
    });
    return resolvePlaceholders(expandedFunctions, payload);
  }

  function executeAction(entry, payload) {
    const template = entry.commandTemplate || entry.command || '';
    const cmd = resolveCommand(template, payload, entry);
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
        for (const entry of list) {
          if (entry.name) {
            const state = namedStates.get(entry.name);
            if (state && state.enabled === false) continue;
          }
          executeAction(entry, payload);
        }
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

module.exports = { createActionsBus, stripSymbol, dist, distPts };
