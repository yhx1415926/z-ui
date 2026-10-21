/**
 * Outgoing email. On Cloudflare the Worker's send_email binding delivers it (worker.ts), from an
 * address on your domain to your own verified address — free on every plan. Locally there is
 * no mailer, and the notification rules do nothing.
 */

export interface MailMessage {
  from: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
}

export type Mailer = (m: MailMessage) => Promise<void>;

function base64Utf8(s: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** RFC 2047 encoded word for non-ASCII header text. */
const headerText = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${base64Utf8(s)}?=`);

/** A plain-text RFC 5322 message (UTF-8, base64 body), for the raw EmailMessage API. */
export function buildMime(m: MailMessage, date: Date, id: string): string {
  const domain = m.from.split('@')[1] ?? 'localhost';
  const body = base64Utf8(m.text.replace(/\r?\n/g, '\r\n'))
    .match(/.{1,76}/g)!
    .join('\r\n');
  return [
    `From: ${m.fromName ? `${headerText(m.fromName.replace(/["\\]/g, ''))} ` : ''}<${m.from}>`,
    `To: <${m.to}>`,
    `Subject: ${headerText(m.subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${id}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
    '',
  ].join('\r\n');
}

/** Cloudflare errors carry a code such as E_SENDER_NOT_VERIFIED; keep it in the message. */
export function mailError(e: unknown): string {
  const err = e as { code?: string; message?: string };
  const msg = err?.message ?? String(e);
  return (err?.code && !msg.includes(err.code) ? `${err.code}: ${msg}` : msg).slice(0, 500);
}
