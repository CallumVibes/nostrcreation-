import { registerPlugin, Capacitor } from '@capacitor/core';

/**
 * Bridge to the Kotlin plugin in native/android/NostrSignerPlugin.kt.
 * Resolves to a stub in a plain browser, so guard every call with
 * isNativeAndroid() first.
 */
const NostrSigner = registerPlugin('NostrSigner');

export const isNativeAndroid = () =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

/**
 * Pre-authorised at login so the content provider can answer in the
 * background afterwards. Only the kinds this app actually publishes: asking
 * for broad permissions on a signer screen is how you lose a user's trust in
 * the first thirty seconds.
 */
export const REQUESTED_PERMISSIONS = [
  { type: 'sign_event', kind: 30890 }, // link block
  { type: 'sign_event', kind: 30311 }, // live event
  { type: 'sign_event', kind: 30315 }, // status
  { type: 'sign_event', kind: 9041 } // zap goal
];

export async function signerInstalled() {
  if (!isNativeAndroid()) return false;
  try {
    const { installed } = await NostrSigner.isInstalled();
    return !!installed;
  } catch {
    return false;
  }
}

/** Opens the signer for account selection. Returns { pubkey, package }. */
export function requestPublicKey() {
  return NostrSigner.getPublicKey({
    permissions: JSON.stringify(REQUESTED_PERMISSIONS)
  });
}

/**
 * Returns the fully signed event. The signer computes id and sig, so we parse
 * what comes back rather than merging a signature into our draft.
 */
export async function signEventNative(unsigned, currentUser, signerPackage) {
  const res = await NostrSigner.signEvent({
    event: JSON.stringify({ ...unsigned, pubkey: currentUser }),
    currentUser,
    package: signerPackage ?? undefined
  });
  if (!res?.event) throw new Error('The signer returned no event.');
  return JSON.parse(res.event);
}
