/** WhatsApp could not deliver a message and won't be able to (not on WhatsApp, blocked, …). */
export class DeliveryFailed {
  constructor(
    readonly messageId: string,
    readonly contactId: string,
    readonly errorCode: number | undefined,
    /** The notification it carried, if any: it moves to the next channel. */
    readonly notification: string | null,
  ) {}
}
