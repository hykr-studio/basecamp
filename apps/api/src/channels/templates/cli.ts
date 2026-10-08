// pnpm templates:sync   create missing templates at the provider, record their status
// pnpm templates:check  fail unless every template a notification uses is approved
// The provider is whatever WA_GRAPH_URL points at: whaloc locally and in CI, Meta in deploys.
import { createWhatsAppAdapter } from '@app/channels';
import { config } from '../../config.js';
import { sharedDb } from '../../infra/db.js';
import { TemplateSync } from './template-sync.js';

const command = process.argv[2] ?? 'sync';
const sync = new TemplateSync(
  sharedDb.db,
  createWhatsAppAdapter({
    graphUrl: config.whatsapp.graphUrl,
    apiVersion: config.whatsapp.apiVersion,
    accessToken: config.whatsapp.accessToken,
    appSecret: config.whatsapp.appSecret,
    wabaId: config.whatsapp.wabaId,
  }),
  config.appUrl,
);

let failed = false;
if (command === 'sync') {
  const report = await sync.run({ create: true });
  for (const t of report.created) console.log(`created   ${t} (pending review)`);
  for (const s of report.statuses)
    console.log(
      `${s.status.toLowerCase().padEnd(9)} ${s.template}${s.reason ? `: ${s.reason}` : ''}`,
    );
  for (const e of report.errors) console.error(`error     ${e}`);
  failed = report.errors.length > 0;
} else if (command === 'check') {
  await sync.run({ create: false });
  const problems = await sync.check();
  for (const p of problems) console.error(`not ready ${p}`);
  if (!problems.length) console.log('every template a notification uses is approved');
  failed = problems.length > 0;
} else {
  console.error(`unknown command ${command}: sync or check`);
  failed = true;
}
await sharedDb.pool.end();
process.exit(failed ? 1 : 0);
