// A time sent in a query string (`before=`, `since=`): JavaScript reads more than Postgres stores
// (docs/decisions/V1.md). The check is `@hykr/contracts`' now, so the list grammar and the SLA
// cursor share it (V10); this path stays for the routes that import it.
export { storableInstant } from '@hykr/contracts';
