import { pausedSentenceKey, UsageRefusalRule } from '@hykr/contracts';

/**
 * Why a reply failed, in words: the model provider's message (it arrives as the serialised
 * error, stack and all), never its stack trace; the thread's trace link keeps the detail. A
 * turn the business's credits refused reads the app's own sentence for its rule, in its language
 * (`say`, the app's `t`; the operator's pause has its own, `pausedSentenceKey`): the API words
 * its reason in the turn's language, which the app does not send.
 */
export function replyError(
  error: unknown,
  say: (key: ReturnType<typeof pausedSentenceKey>) => string,
): string {
  let detail: { message?: unknown; statusCode?: unknown } = {};
  if (typeof error === 'string') {
    try {
      detail = JSON.parse(error);
    } catch {
      detail = { message: error };
    }
  } else if (error instanceof Error) detail = { message: error.message };
  else if (error && typeof error === 'object') detail = error;
  const message = typeof detail.message === 'string' ? detail.message.split('\n')[0] : '';
  // A turn the server refused before the model ran (a model the business does not allow): the
  // API's own reason; the business's credits used up, a limit reached or the operator's pause:
  // the app's words for that rule.
  const refused = (() => {
    try {
      const body = JSON.parse(message) as { error?: unknown; rule?: unknown; reason?: unknown };
      if (body.error !== 'turn_refused') return '';
      const rule = UsageRefusalRule.safeParse(body.rule);
      if (rule.success) return say(pausedSentenceKey(rule.data));
      return typeof body.reason === 'string' ? body.reason : '';
    } catch {
      return '';
    }
  })();
  if (refused) return refused;
  if (detail.statusCode === 429 || /rate.?limit/i.test(message))
    return 'The model is busy right now (rate-limited). Wait a moment, then send it again.';
  return message
    ? `The assistant couldn't answer: ${message.slice(0, 200)}`
    : "The assistant couldn't answer. Send it again.";
}
