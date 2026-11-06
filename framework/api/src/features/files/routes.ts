import { reserveRoutes } from '@hykr/contracts';

// /api/files is the framework's: no module's plural or command path may take it. Loaded with
// @hykr/api's entry (index.ts), before any application is defined.
reserveRoutes('files');
