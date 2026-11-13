// At start (the API, the worker and the CLI alike): the zones Postgres knows, and the
// deployment's zone read the same way by JS and SQL (`checkTimeZones`). docs/decisions/X2.md.
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { CORE_OPTIONS, type CoreOptions } from '../tokens.js';
import { checkTimeZones } from './time-zone.js';

@Injectable()
export class TimeZonesCheck implements OnApplicationBootstrap {
  constructor(@Inject(CORE_OPTIONS) private readonly options: CoreOptions) {}

  async onApplicationBootstrap() {
    await checkTimeZones(this.options.db);
  }
}
