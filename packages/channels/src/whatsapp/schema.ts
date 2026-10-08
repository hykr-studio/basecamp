import { z } from 'zod';

/** Meta's webhook envelope (and whaloc's): only the fields we read; the rest pass through. */
const Message = z.looseObject({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  interactive: z
    .looseObject({
      type: z.string(),
      button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
      list_reply: z
        .object({ id: z.string(), title: z.string(), description: z.string().optional() })
        .optional(),
    })
    .optional(),
  button: z.object({ payload: z.string(), text: z.string().optional() }).optional(),
  audio: z.looseObject({ id: z.string(), mime_type: z.string() }).optional(),
  image: z
    .looseObject({ id: z.string(), mime_type: z.string(), caption: z.string().optional() })
    .optional(),
  document: z
    .looseObject({ id: z.string(), mime_type: z.string(), caption: z.string().optional() })
    .optional(),
  video: z
    .looseObject({ id: z.string(), mime_type: z.string(), caption: z.string().optional() })
    .optional(),
  context: z.looseObject({ id: z.string().optional() }).optional(),
});
export type WaMessage = z.infer<typeof Message>;

const Status = z.looseObject({
  id: z.string(),
  status: z.string(),
  timestamp: z.string(),
  recipient_id: z.string().optional(),
  errors: z.array(z.looseObject({ code: z.number() })).optional(),
});

const Value = z.looseObject({
  metadata: z.looseObject({ phone_number_id: z.string() }).optional(),
  contacts: z
    .array(
      z.looseObject({ wa_id: z.string(), profile: z.looseObject({ name: z.string() }).optional() }),
    )
    .optional(),
  messages: z.array(Message).optional(),
  statuses: z.array(Status).optional(),
});

export const Envelope = z.looseObject({
  object: z.string().optional(),
  entry: z.array(
    z.looseObject({
      changes: z.array(z.looseObject({ field: z.string().optional(), value: Value })),
    }),
  ),
});
