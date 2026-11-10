const { recordRequest } = require('../metrics.js');

function metricsRequestMiddleware(req, res, next) {
  const startedAt = process.hrtime.bigint();
  res.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1000000;
    recordRequest({
      method: req.method,
      path: req.baseUrl + req.path,
      statusCode: res.statusCode,
      durationMs,
      userId: req.user && req.user.id,
    });
  });
  next();
}

module.exports = metricsRequestMiddleware;
