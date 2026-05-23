import { buildApp } from './app.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main() {
  const app = await buildApp({
    serveStatic: process.env.SERVE_STATIC === '1',
    logger: true,
  });
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`douyin-tool listening on http://${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
