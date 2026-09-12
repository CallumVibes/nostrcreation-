import { browser } from '$app/environment';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { BunkerSigner, parseBunkerInput, createNostrConnectURI } from 'nostr-tools/nip46';
import { pool } from './nostr.js';
import { NOSTRCONNECT_RELAYS, APP_NAME } from './kinds.js';
import { isNativeAndroid, signerInstalled, requestPublicKey, signEventNative } from './nip55.js';

/**
 * Three ways in, no fourth.
 *
 *   nip55   — Android intents to a local signer app. Best experience by far,
 *             and only available inside the Capacitor build.
 *   bunker  — NIP-46 remote signing, over relays. How Amber works on the web.
 *   nip07   — a browser extension. Desktop only in practice.
 *
 * There is deliberately no field to paste an nsec into.
 *
 * On the NIP-55 path, once the user ticks "remember my choice" in Amber, our
 * Kotlin plugin signs through the content provider with no UI at all. That is
 * the entire argument for shipping an APK rather than a PWA.
 */

const STORE = 'hub:auth';

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/.{1,2}/g) ?? [], (b) => parseInt(b, 16));

function randomSecret() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return toHex(b);
}

class Signer {
  pubkey = $state(null);
  method = $state(null); // 'nip55' | 'bunker' | 'nip07'
  connecting = $state(false);
  error = $state(null);

  /** True when a NIP-55 signer app is installed and we're in the APK. */
  nativeAvailable = $state(false);

  /** The nostrconnect:// URI to render as a QR / deep link, while pairing. */
  pairingUri = $state(null);
  /** Some bunkers (nsec.app) ask you to approve in a web page. Amber does not. */
  authUrl = $state(null);

  #bunker = null;
  #clientSecret = null;
  #signerPackage = null;

  constructor() {
    if (browser) {
      this.#restore();
      signerInstalled().then((yes) => (this.nativeAvailable = yes));
    }
  }

  get connected() {
    return !!this.pubkey;
  }

  get hasExtension() {
    return browser && typeof window.nostr !== 'undefined';
  }

  // -- persistence -------------------------------------------------------

  #load() {
    try {
      return JSON.parse(localStorage.getItem(STORE) ?? 'null');
    } catch {
      return null;
    }
  }

  #save(data) {
    localStorage.setItem(STORE, JSON.stringify(data));
  }

  /**
   * Rehydrate on boot. For bunker sessions this rebuilds the signer from the
   * stored pointer without a fresh pairing — nostr-tools only needs connect()
   * on the first handshake.
   */
  async #restore() {
    const saved = this.#load();
    if (!saved?.pubkey) return;

    if (saved.method === 'nip55') {
      // Nothing to reconnect — the signer is a local app. Per the spec we
      // must not call get_public_key again while the user stays logged in.
      this.pubkey = saved.pubkey;
      this.method = 'nip55';
      this.#signerPackage = saved.signerPackage ?? null;
      return;
    }

    if (saved.method === 'nip07') {
      this.pubkey = saved.pubkey;
      this.method = 'nip07';
      return;
    }

    if (saved.method === 'bunker' && saved.clientSecret && saved.pointer) {
      try {
        this.#clientSecret = fromHex(saved.clientSecret);
        this.#bunker = BunkerSigner.fromBunker(this.#clientSecret, saved.pointer, {
          pool,
          onauth: (url) => (this.authUrl = url)
        });
        this.pubkey = saved.pubkey;
        this.method = 'bunker';
      } catch {
        this.disconnect();
      }
    }
  }

  // -- native signer app (NIP-55) ----------------------------------------

  /**
   * One tap: Amber opens, the user picks an account and approves, we're back.
   * No relays, no QR, no pairing timeout.
   */
  async connectNative() {
    this.error = null;
    if (!isNativeAndroid()) {
      this.error = 'Native signing is only available in the Android app.';
      return;
    }
    this.connecting = true;
    try {
      const { pubkey, package: pkg } = await requestPublicKey();
      this.pubkey = pubkey;
      this.method = 'nip55';
      this.#signerPackage = pkg ?? null;
      this.#save({ method: 'nip55', pubkey, signerPackage: pkg ?? null });
    } catch (e) {
      this.error =
        e?.code === 'REJECTED'
          ? 'You declined the request in the signer.'
          : e?.code === 'NO_SIGNER'
            ? 'No signer app found. Install Amber, then try again.'
            : `Sign-in failed: ${e?.message ?? 'unknown error'}.`;
    } finally {
      this.connecting = false;
    }
  }

  // -- extension ---------------------------------------------------------

  async connectExtension() {
    this.error = null;
    if (!this.hasExtension) {
      this.error =
        'No extension found. Install Alby or nos2x, or use Amber instead if you are on Android.';
      return;
    }
    this.connecting = true;
    try {
      const pk = await window.nostr.getPublicKey();
      this.pubkey = pk;
      this.method = 'nip07';
      this.#save({ method: 'nip07', pubkey: pk });
    } catch {
      this.error = 'The extension refused the request. Approve it and try again.';
    } finally {
      this.connecting = false;
    }
  }

  // -- bunker / Amber ----------------------------------------------------

  /**
   * Client-initiated pairing. We mint a nostrconnect:// URI, show it, and wait
   * for Amber to reach us on the listed relays.
   *
   * On Android the same URI works as a deep link, so the user taps rather than
   * scans. On desktop they scan it with Amber's QR reader.
   */
  async startPairing() {
    this.error = null;
    this.connecting = true;
    this.#clientSecret = generateSecretKey();

    const secret = randomSecret();
    const uri = createNostrConnectURI({
      clientPubkey: getPublicKey(this.#clientSecret),
      relays: NOSTRCONNECT_RELAYS,
      secret,
      name: APP_NAME
    });
    this.pairingUri = uri;

    try {
      // Resolves once the bunker echoes our secret back. Amber will not
      // respond while it is backgrounded, so give this a generous window and
      // tell the user to keep the app open.
      const bunker = await BunkerSigner.fromURI(this.#clientSecret, uri, {
        pool,
        onauth: (url) => (this.authUrl = url)
      });
      await this.#adopt(bunker);
    } catch (e) {
      this.error = `Pairing didn't complete: ${e?.message ?? 'no response from the signer'}. Make sure Amber is open in the foreground, then try again.`;
    } finally {
      this.connecting = false;
      this.pairingUri = null;
    }
  }

  cancelPairing() {
    this.pairingUri = null;
    this.connecting = false;
  }

  /**
   * Bunker-initiated pairing. Amber can mint a bunker:// URI under its
   * connected-apps screen; paste it here. Also covers nsec.app, Keychat and
   * anything else that speaks NIP-46.
   */
  async connectBunkerUri(input) {
    this.error = null;
    this.connecting = true;
    try {
      const pointer = await parseBunkerInput(input.trim());
      if (!pointer) throw new Error('that is not a bunker:// URI');

      this.#clientSecret = generateSecretKey();
      const bunker = BunkerSigner.fromBunker(this.#clientSecret, pointer, {
        pool,
        onauth: (url) => (this.authUrl = url)
      });
      await bunker.connect();
      await this.#adopt(bunker, pointer);
    } catch (e) {
      this.error = `Couldn't connect: ${e?.message ?? 'unknown error'}.`;
    } finally {
      this.connecting = false;
    }
  }

  async #adopt(bunker, pointer) {
    this.#bunker = bunker;
    this.pubkey = await bunker.getPublicKey();
    this.method = 'bunker';
    this.authUrl = null;
    this.#save({
      method: 'bunker',
      pubkey: this.pubkey,
      clientSecret: toHex(this.#clientSecret),
      // bunker.bp is the negotiated pointer — relays and remote pubkey.
      pointer: pointer ?? bunker.bp
    });
  }

  // -- signing -----------------------------------------------------------

  /** Single path for every event this app publishes. */
  async signEvent(unsigned) {
    if (this.method === 'nip55') {
      // Returns the complete signed event: the signer computes id and sig.
      return signEventNative(unsigned, this.pubkey, this.#signerPackage);
    }
    if (this.method === 'nip07') {
      if (!this.hasExtension) throw new Error('The signing extension is no longer available.');
      return window.nostr.signEvent(unsigned);
    }
    if (this.method === 'bunker') {
      if (!this.#bunker) throw new Error('The remote signer is not connected.');
      // Amber prompts on-device for every request unless permissions were
      // granted at pairing time. Expect a wait here.
      return this.#bunker.signEvent(unsigned);
    }
    throw new Error('Not signed in.');
  }

  disconnect() {
    try {
      this.#bunker?.close();
    } catch {
      /* already gone */
    }
    this.#bunker = null;
    this.#clientSecret = null;
    this.#signerPackage = null;
    this.pubkey = null;
    this.method = null;
    this.authUrl = null;
    this.pairingUri = null;
    if (browser) localStorage.removeItem(STORE);
  }
}

export const signer = new Signer();
