import { createServer } from './server.js';

const port = parseInt(process.env.PORT || '3000', 10);
const host = process.env.HOST || '0.0.0.0';

const app = createServer();
app
  .listen({ port, host })
  .then((address) => {
    app.log.info({ address }, 'API server started');
  })
  .catch((err) => {
    app.log.error({ err }, 'Failed to start API server');
    process.exit(1);
  });
