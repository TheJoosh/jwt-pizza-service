const os = require('os');
const config = require('./config.js');

const activeUserWindowMs = 5 * 60 * 1000;
const histogramBuckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

const state = {
  requests: new Map(),
  auth: new Map(),
  activeUsers: new Map(),
  pizzasSold: 0,
  pizzaCreationFailures: 0,
  revenueBitcoin: 0,
  requestLatency: [],
  pizzaLatency: [],
  lastCpuSnapshot: null,
};

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function recordRequest({ method, statusCode, path, durationMs, userId }) {
  increment(state.requests, 'total');
  increment(state.requests, method);

  if (userId !== undefined && userId !== null) {
    state.activeUsers.set(String(userId), Date.now());
  }

  if (method === 'PUT' && path === '/api/auth') {
    increment(state.auth, statusCode >= 200 && statusCode < 300 ? 'success' : 'failure');
  }

  state.requestLatency.push(durationMs);
}

function recordOrder({ statusCode, durationMs, itemCount, revenueBitcoin }) {
  state.pizzaLatency.push(durationMs);
  if (statusCode >= 200 && statusCode < 300) {
    state.pizzasSold += itemCount;
    state.revenueBitcoin += revenueBitcoin;
  } else {
    state.pizzaCreationFailures += 1;
  }
}

function getCpuUsagePercentage() {
  const cpus = os.cpus();
  const current = cpus.reduce(
    (total, cpu) => ({
      idle: total.idle + cpu.times.idle,
      total: total.total + Object.values(cpu.times).reduce((sum, value) => sum + value, 0),
    }),
    { idle: 0, total: 0 },
  );
  const previous = state.lastCpuSnapshot;
  state.lastCpuSnapshot = current;

  if (!previous) {
    return 0;
  }

  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  return totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0;
}

function getMemoryUsagePercentage() {
  return ((os.totalmem() - os.freemem()) / os.totalmem()) * 100;
}

function pruneActiveUsers() {
  const cutoff = Date.now() - activeUserWindowMs;
  for (const [userId, lastSeen] of state.activeUsers) {
    if (lastSeen < cutoff) {
      state.activeUsers.delete(userId);
    }
  }
}

function attributes(values) {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value: { stringValue: String(value) },
  }));
}

function numberDataPoint(value, labels = {}) {
  return {
    attributes: attributes(labels),
    timeUnixNano: String(Date.now() * 1000000),
    asDouble: value,
  };
}

function histogramDataPoint(values) {
  const bucketCounts = histogramBuckets.map(() => 0);
  let greaterThanLastBucket = 0;
  for (const value of values) {
    const bucket = histogramBuckets.findIndex((limit) => value <= limit);
    if (bucket === -1) {
      greaterThanLastBucket += 1;
    } else {
      bucketCounts[bucket] += 1;
    }
  }
  return {
    timeUnixNano: String(Date.now() * 1000000),
    count: values.length,
    sum: values.reduce((total, value) => total + value, 0),
    bucketCounts: [...bucketCounts, greaterThanLastBucket],
    explicitBounds: histogramBuckets,
  };
}

function buildMetrics() {
  pruneActiveUsers();
  const metrics = [];
  for (const [method, count] of state.requests) {
    metrics.push({
      name: 'http_requests_total',
      description: 'Total HTTP requests, grouped by method and status class.',
      unit: 'requests',
      sum: {
        dataPoints: [numberDataPoint(count, { method })],
        aggregationTemporality: 2,
        isMonotonic: true,
      },
    });
  }
  if (state.auth.size > 0) {
    metrics.push({
      name: 'authentication_attempts_total',
      unit: 'attempts',
      sum: {
        dataPoints: [...state.auth].map(([result, count]) => numberDataPoint(count, { result })),
        aggregationTemporality: 2,
        isMonotonic: true,
      },
    });
  }

  const counters = [
    ['pizzas_sold_total', state.pizzasSold, 'pizzas'],
    ['pizza_creation_failures_total', state.pizzaCreationFailures, 'failures'],
    ['revenue_bitcoin_total', state.revenueBitcoin, 'BTC'],
  ];
  for (const [name, value, unit] of counters) {
    metrics.push({
      name,
      unit,
      sum: {
        dataPoints: [numberDataPoint(value)],
        aggregationTemporality: 2,
        isMonotonic: true,
      },
    });
  }

  const gauges = [
    ['active_users', state.activeUsers.size, 'users'],
    ['cpu_usage_percent', getCpuUsagePercentage(), '%'],
    ['memory_usage_percent', getMemoryUsagePercentage(), '%'],
  ];
  for (const [name, value, unit] of gauges) {
    metrics.push({ name, unit, gauge: { dataPoints: [numberDataPoint(value)] } });
  }

  for (const [name, values] of [
    ['server_request_duration_ms', state.requestLatency],
    ['pizza_creation_duration_ms', state.pizzaLatency],
  ]) {
    if (values.length > 0) {
      metrics.push({ name, unit: 'ms', histogram: { dataPoints: [histogramDataPoint(values)], aggregationTemporality: 2 } });
    }
  }
  return metrics;
}

async function sendMetrics() {
  const { endpointUrl, accountId, apiKey, source } = config.metrics;
  if (!endpointUrl || !accountId || !apiKey) {
    throw new Error('Grafana metrics configuration is incomplete');
  }

  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountId}:${apiKey}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      resourceMetrics: [{
        resource: { attributes: attributes({ service_name: source }) },
        scopeMetrics: [{ scope: { name: 'jwt-pizza-service' }, metrics: buildMetrics() }],
      }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Grafana metrics export failed with HTTP ${response.status}`);
  }
}

function sendMetricsPeriodically(period = 15000) {
  const timer = setInterval(() => {
    sendMetrics().catch((error) => console.error('Error sending metrics to Grafana:', error.message));
  }, period);
  timer.unref();
  return timer;
}

module.exports = {
  recordRequest,
  recordOrder,
  sendMetrics,
  sendMetricsPeriodically,
  getCpuUsagePercentage,
  getMemoryUsagePercentage,
};
