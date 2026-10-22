import { CONFIG } from './config';
import { getMeta, setMeta } from './db';
import { activate, b64urlDecode, type LicensePayload, verifyToken } from './license';
import type { Plan } from './types';

export async function currentPlan(now = Date.now()): Promise<Plan> {
  const token = await getMeta<string>('licenseToken');
  if (!token) return 'free';
  return (await verifyToken(token, CONFIG.LICENSE_PUBLIC_JWK, now)) ? 'pro' : 'free';
}

const DAY = 86_400_000;
/**
 * Silent token renewal: only when a key was activated before, the token expires within 7 days,
 * and we have not tried in the last 24 h. This is the extension's only other network request
 * (same endpoint as activation). A revoked (refunded) key simply stops renewing.
 */
export async function refreshIfNeeded(now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<'skipped' | 'renewed' | 'failed'> {
  const key = await getMeta<string>('licenseKey');
  const token = await getMeta<string>('licenseToken');
  const device = await getMeta<string>('deviceId');
  if (!key || !device) return 'skipped';
  let exp = 0;
  try { exp = (JSON.parse(new TextDecoder().decode(b64urlDecode((token || '').split('.')[0]))) as LicensePayload).exp; } catch { /* none */ }
  if (exp - now > 7 * DAY) return 'skipped';
  const last = (await getMeta<number>('licenseRefreshAt')) || 0;
  if (now - last < DAY) return 'skipped';
  await setMeta('licenseRefreshAt', now);
  const res = await activate(CONFIG.LICENSE_API, key, device, fetchImpl);
  if (!res.token) return 'failed';
  await setMeta('licenseToken', res.token);
  return 'renewed';
}
