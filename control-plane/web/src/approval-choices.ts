/**
 * Approval choices this console will render.
 *
 * The `approval.request` event carries whatever Hermes offered, and Hermes
 * offers `always`. Answering that makes Hermes write the matched command
 * category into its permanent `command_allowlist`, silencing every future
 * approval in that category — `recursive delete` included — with nothing in
 * Asterism showing the rule exists or able to remove it.
 *
 * The durable event is left exactly as Hermes sent it: it is the operator's
 * evidence of what was asked. Only the presentation is filtered, so a replayed
 * approval card cannot resurrect a button the API would refuse anyway.
 */
export const UNSUPPORTED_CHOICES = new Set(['always']);

export function supportedChoices(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (choice): choice is string => typeof choice === 'string' && !UNSUPPORTED_CHOICES.has(choice),
  );
}
