import type { ChannelAdapter } from '@hykr/channels';
import { CORE_OPTIONS, type CoreOptions, TenantConfigService } from '@hykr/core';
import { type Database, messages } from '@hykr/db';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { WHATSAPP } from '../../channels/whatsapp/adapter.provider.js';
import { type InboundHook, type InboundInfo, inboundHooks } from '../../hooks.js';
import { FilesService } from './files.service.js';
import { fileLine } from './lines.js';

const log = new Logger('FilesInbound');

/** The common extension of a type, for a file sent without a name. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
};

/**
 * A photo, document or video someone sends on WhatsApp is stored as a file of theirs (and their
 * account's, when the number is linked), and named to the assistant's turn by its id, so the
 * assistant can put it on a record with a write. The message row becomes `media`, with the file
 * id. A business turns this off with `files.keepInboundMedia`. A file too large, or one that
 * cannot be downloaded, is not kept; the caption still reaches the turn.
 */
@Injectable()
export class FilesInboundHook implements InboundHook, OnModuleInit {
  readonly name = 'files';

  private readonly db: Database;

  constructor(
    @Inject(CORE_OPTIONS) core: CoreOptions,
    @Inject(WHATSAPP) private readonly wa: ChannelAdapter,
    private readonly tenants: TenantConfigService,
    private readonly files: FilesService,
  ) {
    this.db = core.db;
  }

  onModuleInit() {
    if (!inboundHooks.has(this.name)) inboundHooks.register(this);
  }

  async onMessage(info: InboundInfo) {
    const { message } = info;
    if (message.body.kind !== 'media') return null;
    const { settings } = await this.tenants.get(info.tenantId);
    if (!settings.files.keepInboundMedia) return null;
    let media: { bytes: Buffer; mime: string };
    try {
      media = await this.wa.downloadMedia(message.body.mediaId, message.to);
    } catch (e) {
      log.warn(`media not downloaded: ${e instanceof Error ? e.message : e}`);
      return null;
    }
    const mime = message.body.mime || media.mime;
    if (media.bytes.length > this.files.config.maxBytes) return null;
    const name =
      message.body.filename ||
      `whatsapp-${message.at.toISOString().slice(0, 10)}.${EXTENSIONS[mime.split(';')[0]] ?? 'bin'}`;
    let row: Awaited<ReturnType<FilesService['storeBytes']>>;
    try {
      row = await this.files.storeBytes({
        tenantId: info.tenantId,
        uploader: { kind: 'contact', contactId: info.contactId },
        ...(info.userId ? { ownerId: info.userId } : {}),
        source: 'whatsapp',
        name,
        mime,
        bytes: media.bytes,
        audit: { actorKind: 'contact', actorId: info.contactId, channel: 'whatsapp' },
      });
    } catch (e) {
      log.warn(`media not kept: ${e instanceof Error ? e.message : e}`);
      return null;
    }
    await this.db
      .update(messages)
      .set({ kind: 'media', body: { fileId: row.id } })
      .where(
        and(
          eq(messages.tenantId, info.tenantId),
          eq(messages.providerMessageId, message.providerMessageId),
        ),
      );
    return { context: [fileLine(row)] };
  }
}
