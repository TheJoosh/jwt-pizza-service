const app = require('./service.js');
const config = require('./config.js');
const { sendMetricsPeriodically } = require('./metrics.js');

const port = process.argv[2] || 3000;
if (config.metrics.enabled) {
  sendMetricsPeriodically();
}
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
