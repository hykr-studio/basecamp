// The app's one outbox, sending through the app's API client: each queued write rebuilt from the
// catalog's spec, with its key, its business and its If-Match (decisions B12).
import { ApiError } from '@hykr/api-client';
import { onlineManager } from '@tanstack/react-query';
import { api } from '../../api';
import { currentBusiness } from '../../framework/business';
import type { PendingWrite } from '../../framework/write-queue';
import { getCatalog } from '../../runtime';
import { createOutbox, type Outbox, type OutboxStore } from './outbox';
import { deviceStore } from './store';

/** A write the app no longer knows how to send (its entity or command is gone): refused. */
const unknown = (what: string) =>
  new ApiError(400, { error: 'unknown_write', reason: `This app no longer has ${what}` });

/** The options every try of an item sends: its key, its business, the version it was based on. */
const optionsOf = (item: PendingWrite) => ({
  key: item.key,
  // The business it was captured in, whichever is chosen now; '' asks for the person's default.
  headers: { 'x-tenant-id': item.tenantId ?? '' },
  ...(item.ifMatch !== undefined ? { ifMatch: item.ifMatch } : {}),
});

export function sendPending(item: PendingWrite) {
  const catalog = getCatalog();
  if (item.op.kind === 'command') {
    const spec = catalog.commandByName(item.op.command);
    if (!spec) throw unknown(`the action "${item.op.command}"`);
    return api.command(spec, item.input as never, optionsOf(item));
  }
  const spec = catalog.entities[item.op.entity];
  if (!spec) throw unknown(`"${item.op.entity}"`);
  const client = api.entity(spec);
  const id = String(item.op.recordId ?? '');
  if (item.op.action === 'create') return client.create(item.input as never, optionsOf(item));
  if (item.op.action === 'update') return client.update(id, item.input as never, optionsOf(item));
  return client.remove(id, optionsOf(item));
}

/** A queued create's record, read back (its id was taken: by an earlier try of its own?). */
async function readBack(item: PendingWrite): Promise<unknown | undefined> {
  if (item.op.kind !== 'entity' || !item.op.recordId) return undefined;
  const spec = getCatalog().entities[item.op.entity];
  if (!spec) return undefined;
  try {
    return await api.entity(spec).get(item.op.recordId);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return undefined;
    throw e;
  }
}

/** The device store, opened when first used. */
const lazyStore: OutboxStore = {
  load: async (userId) => (await deviceStore()).outbox.load(userId),
  put: async (item) => (await deviceStore()).outbox.put(item),
  remove: async (id) => (await deviceStore()).outbox.remove(id),
};

let outbox: Outbox | undefined;

/** The app's outbox, made on first use. */
export function theOutbox(): Outbox {
  outbox ??= createOutbox({
    store: lazyStore,
    send: sendPending,
    read: readBack,
    online: () => onlineManager.isOnline(),
    business: currentBusiness,
  });
  return outbox;
}
