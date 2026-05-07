import { createHash } from 'node:crypto';

const REDACTED_EMAIL = '[redacted email]';
const REDACTED_TOKEN = '[redacted token]';

export function shortUsageHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function buildStablePublicId(value: string, length = 6): string {
  return shortUsageHash(value).slice(0, length).toUpperCase();
}

export function redactEmail(email: string | null | undefined): string {
  return email?.trim() ? REDACTED_EMAIL : '';
}

export function redactToken(token: string | null | undefined): string {
  return token?.trim() ? REDACTED_TOKEN : '';
}

export function redactEmailsInText(value: string | null | undefined): string {
  const text = value?.trim() || '';
  if (!text) return '';

  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED_EMAIL);
}

export function redactTokensInText(value: string | null | undefined): string {
  const text = value?.trim() || '';
  if (!text) return '';

  return text.replace(/\b(?:sk|rk|pk|proj|sess)-[A-Za-z0-9._-]{8,}\b/gi, REDACTED_TOKEN);
}

export function redactSensitiveText(value: string | null | undefined): string {
  return redactTokensInText(redactEmailsInText(value));
}
