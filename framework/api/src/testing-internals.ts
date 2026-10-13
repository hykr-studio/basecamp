// The parts of a running app a test drives directly: template sync, the notification
// schedule, the WhatsApp adapter and the database. Import it after boot(): loading it reads
// the server's configuration from the environment.
export { NotifyService, scheduledJobId } from './channels/notify/notify.service.js';
export { TemplateSync } from './channels/templates/template-sync.js';
export { WHATSAPP } from './channels/whatsapp/adapter.provider.js';
export { DB } from './infra/db.module.js';
