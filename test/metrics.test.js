const os = require('os');

const loadMetrics = (mockMetricsConfig = {}) => {
  jest.resetModules();
  jest.mock('../src/config.js', () => ({
    metrics: {
      endpointUrl: 'https://metrics.test/v1/metrics',
      accountId: 'account',
      apiKey: 'secret',
      source: 'test-service',
      ...mockMetricsConfig,
    },
  }));
  return require('../src/metrics.js');
};

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  delete global.fetch;
});

test('exports request and authentication metrics', async () => {
  const metrics = loadMetrics();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

  metrics.recordRequest({
    method: 'PUT',
    statusCode: 200,
    path: '/api/auth',
    durationMs: 25,
    userId: 7,
  });
  metrics.recordRequest({
    method: 'PUT',
    statusCode: 401,
    path: '/api/auth',
    durationMs: 75,
  });

  await metrics.sendMetrics();

  const [endpoint, options] = fetch.mock.calls[0];
  const payload = JSON.parse(options.body);
  const exportedMetrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;

  expect(endpoint).toBe('https://metrics.test/v1/metrics');
  expect(options.method).toBe('POST');
  expect(options.headers).toEqual({
    Authorization: `Basic ${Buffer.from('account:secret').toString('base64')}`,
    'Content-Type': 'application/json',
  });
  expect(payload.resourceMetrics[0].resource.attributes).toEqual([
    { key: 'service_name', value: { stringValue: 'test-service' } },
  ]);
  expect(exportedMetrics).toEqual(expect.arrayContaining([
    expect.objectContaining({
      name: 'http_requests_total',
      sum: expect.objectContaining({
        dataPoints: [expect.objectContaining({
          attributes: [{ key: 'method', value: { stringValue: 'PUT' } }],
          asDouble: 2,
        })],
      }),
    }),
    expect.objectContaining({
      name: 'authentication_attempts_total',
      sum: expect.objectContaining({
        dataPoints: [expect.objectContaining({
          attributes: [{ key: 'result', value: { stringValue: 'success' } }],
          asDouble: 1,
        })],
      }),
    }),
    expect.objectContaining({
      name: 'authentication_attempts_total',
      sum: expect.objectContaining({
        dataPoints: [expect.objectContaining({
          attributes: [{ key: 'result', value: { stringValue: 'failure' } }],
          asDouble: 1,
        })],
      }),
    }),
  ]));
});

test('exports successful and failed order metrics with histograms', async () => {
  const metrics = loadMetrics();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

  metrics.recordOrder({
    statusCode: 201,
    durationMs: 10,
    itemCount: 2,
    revenueBitcoin: 0.5,
  });
  metrics.recordOrder({
    statusCode: 500,
    durationMs: 6000,
    itemCount: 3,
    revenueBitcoin: 0.75,
  });

  await metrics.sendMetrics();

  const payload = JSON.parse(fetch.mock.calls[0][1].body);
  const exportedMetrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
  const sold = exportedMetrics.find(({ name }) => name === 'pizzas_sold_total');
  const revenue = exportedMetrics.find(({ name }) => name === 'revenue_bitcoin_total');
  const failures = exportedMetrics.find(({ name }) => name === 'pizza_creation_failures_total');
  const latency = exportedMetrics.find(({ name }) => name === 'pizza_creation_duration_ms');

  expect(sold.sum.dataPoints[0].asDouble).toBe(2);
  expect(revenue.sum.dataPoints[0].asDouble).toBe(0.5);
  expect(failures.sum.dataPoints[0].asDouble).toBe(1);
  expect(latency.histogram.dataPoints[0]).toMatchObject({
    count: 2,
    sum: 6010,
    bucketCounts: expect.arrayContaining([1]),
    explicitBounds: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  });
});

test('tracks active users and removes users outside the active window', async () => {
  const metrics = loadMetrics();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  const now = 1_000_000;
  jest.spyOn(Date, 'now').mockReturnValue(now);

  metrics.recordRequest({
    method: 'GET',
    statusCode: 200,
    path: '/api/user/me',
    durationMs: 5,
    userId: 42,
  });
  jest.spyOn(Date, 'now').mockReturnValue(now + 5 * 60 * 1000 + 1);

  await metrics.sendMetrics();

  const payload = JSON.parse(fetch.mock.calls[0][1].body);
  const activeUsers = payload.resourceMetrics[0].scopeMetrics[0].metrics
    .find(({ name }) => name === 'active_users');

  expect(activeUsers.gauge.dataPoints[0].asDouble).toBe(0);
});

test('reports CPU and memory usage', async () => {
  const metrics = loadMetrics();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  jest.spyOn(os, 'cpus').mockReturnValue([
    { times: { user: 10, nice: 0, sys: 10, idle: 80, irq: 0 } },
  ]);
  jest.spyOn(os, 'totalmem').mockReturnValue(100);
  jest.spyOn(os, 'freemem').mockReturnValue(25);

  expect(metrics.getCpuUsagePercentage()).toBe(0);
  expect(metrics.getMemoryUsagePercentage()).toBe(75);

  await metrics.sendMetrics();

  const payload = JSON.parse(fetch.mock.calls[0][1].body);
  const exportedMetrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
  expect(exportedMetrics).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'cpu_usage_percent' }),
    expect.objectContaining({ name: 'memory_usage_percent' }),
  ]));
});

test('calculates CPU usage from consecutive snapshots', () => {
  const metrics = loadMetrics();
  jest.spyOn(os, 'cpus')
    .mockReturnValueOnce([
      { times: { user: 10, nice: 0, sys: 10, idle: 80, irq: 0 } },
    ])
    .mockReturnValueOnce([
      { times: { user: 30, nice: 0, sys: 30, idle: 140, irq: 0 } },
    ]);

  expect(metrics.getCpuUsagePercentage()).toBe(0);
  expect(metrics.getCpuUsagePercentage()).toBe(40);
});

test('rejects incomplete metrics configuration', async () => {
  const metrics = loadMetrics({ apiKey: '' });

  await expect(metrics.sendMetrics()).rejects.toThrow(
    'Grafana metrics configuration is incomplete',
  );
});

test('rejects failed metrics exports', async () => {
  const metrics = loadMetrics();
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });

  await expect(metrics.sendMetrics()).rejects.toThrow(
    'Grafana metrics export failed with HTTP 503',
  );
});

test('sends metrics periodically', async () => {
  jest.useFakeTimers();
  const metrics = loadMetrics();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

  const timer = metrics.sendMetricsPeriodically(1000);
  jest.advanceTimersByTime(1000);
  await Promise.resolve();

  expect(fetch).toHaveBeenCalledTimes(1);
  clearInterval(timer);
});

test('logs periodic export failures', async () => {
  jest.useFakeTimers();
  const metrics = loadMetrics();
  global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable'));
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});

  const timer = metrics.sendMetricsPeriodically(1000);
  jest.advanceTimersByTime(1000);
  await Promise.resolve();
  await Promise.resolve();

  expect(error).toHaveBeenCalledWith(
    'Error sending metrics to Grafana:',
    'network unavailable',
  );
  clearInterval(timer);
});
