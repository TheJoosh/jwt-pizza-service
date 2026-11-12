const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config.js');

const requestContext = new AsyncLocalStorage();
const sensitiveKey = /(authorization|cookie|password|secret|token|jwt|api[-_]?key|credential|private[-_]?key)/i;
const sensitiveText = /(bearer\s+[a-z0-9._-]+|basic\s+[a-z0-9+/=]+|(?:password|secret|token|jwt|api[-_]?key|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+))/ig;

function sanitizeString(value) {
  return value.replace(sensitiveText, '[REDACTED]');
}

function sanitize(value, key = '') {
  if (key !== 'hasAuthorizationHeader' && sensitiveKey.test(key)) {
    return '[REDACTED]';
  }
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitize(childValue, childKey),
    ]));
  }
  return value;
}

function writeLog(entry) {
  const sanitizedEntry = sanitize({
    timestamp: new Date().toISOString(),
    ...entry,
  });
  const line = JSON.stringify(sanitizedEntry);
  console.log(line);
  return sendLog(sanitizedEntry);
}

async function sendLog(entry) {
  const { endpointUrl, accountId, apiKey, source } = config.logging || {};
  if (!endpointUrl || !accountId || !apiKey) {
    return;
  }

  try {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountId}:${apiKey}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        streams: [{
          stream: {
            service_name: source || 'jwt-pizza-service',
            log_type: entry.type || 'application',
          },
          values: [[
            String(Date.now() * 1000000),
            JSON.stringify(entry),
          ]],
        }],
      }),
    });
    if (!response.ok) {
      throw new Error(`Log export failed with HTTP ${response.status}`);
    }
  } catch (error) {
    console.error('Error sending logs:', error.message);
  }
}

function currentUser() {
  const user = requestContext.getStore()?.req.user;
  return user ? { id: user.id, name: user.name } : null;
}

function requestLogger(req, res, next) {
  let responseBody;
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = (body) => {
    responseBody = body;
    return originalJson(body);
  };
  res.send = (body) => {
    if (responseBody === undefined) {
      responseBody = body;
    }
    return originalSend(body);
  };

  res.once('finish', () => {
    writeLog({
      type: 'http',
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      hasAuthorizationHeader: Boolean(req.headers.authorization),
      user: currentUser(),
      requestBody: req.body,
      responseBody,
    });
  });

  requestContext.run({ req }, next);
}

function sanitizeSql(sql) {
  return String(sql).replace(/'(?:''|[^'])*'/g, "'[REDACTED]'");
}

function instrumentDatabaseConnection(connection) {
  for (const method of ['query', 'execute']) {
    const original = connection[method].bind(connection);
    connection[method] = async (...args) => {
      const sql = args[0];
      try {
        const result = await original(...args);
        writeLog({
          type: 'database',
          query: sanitizeSql(sql),
          user: currentUser(),
        });
        return result;
      } catch (error) {
        logException(error, { type: 'database', query: sanitizeSql(sql), user: currentUser() });
        throw error;
      }
    };
  }
  return connection;
}

async function fetchFactory(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
    let responseBody;
    if (typeof response.clone === 'function') {
      responseBody = await response.clone().text();
    }
    writeLog({
      type: 'factory',
      user: currentUser(),
      requestBody: options.body,
      responseBody,
      statusCode: response.status,
    });
    return response;
  } catch (error) {
    logException(error, { type: 'factory', user: currentUser(), requestBody: options.body });
    throw error;
  }
}

function logException(error, context = {}) {
  writeLog({
    ...context,
    type: context.type || 'exception',
    exception: {
      name: error.name,
      message: error.message,
    },
  });
}

function registerProcessExceptionHandlers() {
  if (registerProcessExceptionHandlers.registered) {
    return;
  }
  registerProcessExceptionHandlers.registered = true;
  process.on('uncaughtException', (error) => {
    logException(error);
  });
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logException(error);
  });
}

module.exports = {
  fetchFactory,
  instrumentDatabaseConnection,
  logException,
  requestLogger,
  registerProcessExceptionHandlers,
  sanitize,
  sendLog,
};
