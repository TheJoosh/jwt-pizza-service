const { recordOrder } = require('../metrics.js');

function metricsOrderMiddleware(req, res, next) {
  if (req.method !== 'POST' || req.baseUrl + req.path !== '/api/order') {
    return next();
  }

  const startedAt = process.hrtime.bigint();
  res.once('finish', () => {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    const revenueBitcoin = items.reduce((total, item) => total + Number(item.price || 0), 0);
    recordOrder({
      statusCode: res.statusCode,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1000000,
      itemCount: items.length,
      revenueBitcoin,
    });
  });
  next();
}

module.exports = metricsOrderMiddleware;
