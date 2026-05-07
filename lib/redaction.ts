import { createHash } from 'node:crypto';

const MASK = '•••';

export function shortUsageHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function buildStablePublicId(value: string, length = 6): string {
  return shortUsageHash(value).slice(0, length).toUpperCase();
}

function maskSegment(value: string, keepStart: number, keepEnd: number): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= keepStart + keepEnd) {
    return `${trimmed.slice(0, 1)}${MASK}`;
  }

  const start = trimmed.slice(0, keepStart);
  const end = keepEnd > 0 ? trimmed.slice(-keepEnd) : '';
  return `${start}${MASK}${end}`;
}

export function redactEmail(email: string | null | undefined): string {
  const trimmed = email?.trim() || '';
  if (!trimmed) return '';

  const [localPart, domainPart] = trimmed.split('@');
  if (!localPart || !domainPart) {
    return maskSegment(trimmed, 2, 1);
  }

  const domainSegments = domainPart.split('.');
  const topLevelDomain = domainSegments.pop() || '';
  const baseDomain = domainSegments.join('.');
  const maskedDomain = baseDomain ? maskSegment(baseDomain, 2, 1) : MASK;

  return `${maskSegment(localPart, 2, 1)}@${maskedDomain}${topLevelDomain ? `.${topLevelDomain}` : ''}`;
}

export function redactToken(token: string | null | undefined): string {
  const trimmed = token?.trim() || '';
  if (!trimmed) return '';
  if (trimmed.length <= 8) return MASK;
  return `${trimmed.slice(0, 4)}${MASK}${trimmed.slice(-4)}`;
}

export function redactEmailsInText(value: string | null | undefined): string {
  const text = value?.trim() || '';
  if (!text) return '';

  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (match) => redactEmail(match));
}

export function redactTokensInText(value: string | null | undefined): string {
  const text = value?.trim() || '';
  if (!text) return '';

  return text.replace(/\b(?:sk|rk|pk|proj|sess)-[A-Za-z0-9._-]{8,}\b/gi, () => MASK);
}

export function redactSensitiveText(value: string | null | undefined): string {
  return redactTokensInText(redactEmailsInText(value));
}
