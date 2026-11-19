import { reserveRoutes } from '@hykr/contracts';

// /api/documents is the documents feature's: no module may serve a route under it.
reserveRoutes('documents');
