import 'reflect-metadata';
import { assertConfig, config } from './config.js';

// Check secrets before anything else loads: auth.ts builds Better Auth on import.
assertConfig();

const { NestFactory } = await import('@nestjs/core');
const { AppModule } = await import('./app.module.js');

// Better Auth reads the raw body; the auth module adds parsing back for other routes.
const app = await NestFactory.create(AppModule, { bodyParser: false });
app.enableCors({ origin: config.webOrigins, credentials: true });
app.enableShutdownHooks();
await app.listen(config.port);
