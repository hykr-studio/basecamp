import { reserveRoutes } from '@hykr/contracts';

// /api/calendar is the calendar feature's: no module may serve a route under it.
reserveRoutes('calendar');
