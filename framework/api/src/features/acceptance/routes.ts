import { reserveRoutes } from '@hykr/contracts';

// /api/acceptances is the acceptance feature's: no module may serve a route under it.
reserveRoutes('acceptances');
