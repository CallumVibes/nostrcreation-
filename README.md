# Hubcast

A Nostr page for people who broadcast somewhere else. Links, live status and a
zap button, published as signed events rather than held on a platform.

Steps 1 and 2 of the build plan: a read-only creator page from an npub, and a
signed editor for the link block.

## Running it

```bash
npm install
npm run dev
```

Opens on <http://localhost:5173>.

### Testing on your phone

This is the part that trips people up. Several browser APIs the app depends on
— `crypto.subtle`, `navigator.clipboard`, service worker registration, and the
home-screen install prompt — only work in a **secure context**. `localhost`
counts. A LAN address like `http://192.168.1.40:5173` does not, so half the app
silently misbehaves if you test that way.

Two options:

**Tunnel (easiest, works with Amber on a different device):**

```bash
npm run dev
npx cloudflared tunnel --url http://localhost:5173
```

Open the printed `https://…trycloudflare.com` URL on your phone.

**Local HTTPS:**

```bash
npm i -D @vitejs/plugin-basic-ssl
```

Add it to `vite.config.js` plugins and run `npm run dev -- --host`. You'll have
to accept the self-signed certificate warning on the phone.

### Building

```bash
npm run build     # static site in build/
npm run preview
```

The output is plain static files. Any host works — Vercel, Netlify, Cloudflare
Pages, nginx. The only server requirement is an SPA fallback rewriting unknown
paths to `index.html`, since `/p/npub1…` is client-routed.

## Installing it as an app

`static/manifest.webmanifest` and `static/sw.js` make it installable. Over
HTTPS, Android Chrome offers "Add to Home screen" and it launches standalone
without browser chrome. iOS needs Share → Add to Home Screen, done manually.

The service worker caches the app shell only. Relay data is never cached — a
stale "on air" lamp is worse than no lamp — and websockets bypass service
workers entirely, so relays are unaffected.

### The iOS caveat

Amber is Android-only, so on iPhone your signing options are a `bunker://` URI
from nsec.app or similar. Worth knowing before you promise iOS users anything.

## Android app (NIP-55, the good path)

This is worth doing for one reason: inside a native shell you can talk to Amber
over **NIP-55** instead of NIP-46. No QR, no pairing relays, no
keep-Amber-in-the-foreground problem. Better still, once the user ticks
"remember my choice" in Amber, signing goes through Amber's **content
provider** and completes in the background with no UI at all.

### Option A: let CI build it

If you don't want Android Studio on your machine, push to GitHub and use the
included workflow. Actions tab → **Android APK** → Run workflow. It produces a
sideloadable debug APK as a build artifact in about five minutes.

`.github/workflows/android.yml` generates the `android/` directory from
scratch on every run, which is why that directory is gitignored — it's build
output, not source. The source of truth is `native/android/` plus
`scripts/wire-native.mjs`.

### Option B: build locally

Needs Android Studio (or the command-line SDK tools) and **JDK 17** —
Capacitor 6's template targets Java 17, and JDK 21 trips the Kotlin/AGP
compatibility check.

```bash
npm install
npm run build
npm run android:init     # cap add android + wire the native layer
npm run android:sync     # rebuild + re-apply; safe to re-run any time
```

Then either open it:

```bash
npm run android:open
```

or go straight to a connected device:

```bash
cd android && ./gradlew installDebug
```

Re-run `npm run android:sync` after every web change.

### What wire-native.mjs does

`cap add android` scaffolds a Java-only project and overwrites `MainActivity`,
so the native layer has to be re-applied afterwards. The script:

1. copies the Kotlin sources in, rewriting `package` to match `appId`
2. deletes the generated `MainActivity.java` (two `MainActivity` classes in one
   package is a compile error)
3. injects the `<queries>` block into `AndroidManifest.xml` as a sibling of
   `<application>`
4. adds `kotlin-gradle-plugin` to the root `build.gradle` and applies
   `kotlin-android` in the app one — without this Gradle silently ignores every
   `.kt` file

All four steps are idempotent, which is what makes the CI build possible.

### How the native signing path works

`native/android/NostrSignerPlugin.kt` implements two transports and tries them
in order:

1. **Content resolver** — `content://com.greenart7c3.nostrsigner.SIGN_EVENT`.
   Silent, instant, no app switch. Only answers for permissions the user chose
   to remember.
2. **Intent** — opens Amber for manual approval. Used for login, and whenever
   the provider declines.

The distinction that matters, and the one most integrations get wrong: a
**null cursor** means "not remembered, go ask the user", while a **`rejected`
column** means "the user said never". Only the first may fall back to an
intent. Falling back on an explicit rejection nags the user with a popup they
already refused.

At login we request `sign_event` permission for exactly the four kinds this
app publishes — 30890, 30311, 30315, 9041 — so the background path is
available immediately without asking for anything we don't use.

### Things that will go wrong

**"No signer installed" when Amber is clearly installed.** The `<queries>`
block is missing or in the wrong place. Android 11+ hides packages from you
unless you declare what you're looking for, and it must be a sibling of
`<application>`, not a child. `wire-native.mjs` handles this; check its output
if discovery fails.

**Gradle can't find `NostrSignerPlugin`.** The Kotlin plugin isn't applied, so
`.kt` files were ignored. Re-run `npm run android:sync` and check it reports
the Gradle patches.

**Kotlin/AGP version error.** You're on JDK 21. Use JDK 17.

**The plugin resolves but every call hangs.** `registerPlugin` must be called
*before* `super.onCreate` in `MainActivity`.

**Duplicate class MainActivity.** A generated `MainActivity.java` survived
alongside our `.kt`. Re-run `npm run android:sync`.

### What's still NIP-46

The web build is unchanged and still uses NIP-46 for Amber, so the same
codebase serves desktop browsers and iOS. `signer.svelte.js` picks
automatically: `nativeAvailable` is true only inside the APK with a signer
installed.

## How it works

There is no backend. The browser opens websockets to a handful of relays,
reads events, and publishes signed ones back. `npm run build` emits a static
SPA you can drop on any host.

| Route | Does |
| --- | --- |
| `/` | Decode an npub / nprofile / hex key and jump to that page |
| `/p/[npub]` | Public page: profile, live tally, channels, zap |
| `/edit` | Sign in and publish your link block |

### Events read

- **kind 0** — name, picture, about, `nip05`, and `lud16` for the zap button
- **kind 10002** (NIP-65) — the creator's own write relays, merged into the query set
- **kind 30311** (NIP-53) — live events. A `status` tag of `live` lights the tally lamp; the `streaming` tag is where the viewer actually goes, usually Twitch
- **kind 30315** (NIP-38) — a general status line, respecting `expiration`

### Events written

- **kind 30890** — the link block. See below.

## The kind 30890 problem

There is no standard event kind for a creator link block. NIP-39 external
identities are the closest thing, but the `i` tag has no Twitch, YouTube or
Kick provider, no ordering, and no display notes.

So this app defines a provisional addressable kind:

```json
{
  "kind": 30890,
  "content": "",
  "tags": [
    ["d", "creator-hub"],
    ["title", "Callum"],
    ["category", "gaming"],
    ["link", "twitch", "https://twitch.tv/x", "Live Mon/Thu"],
    ["link", "youtube", "https://youtube.com/@x"]
  ]
}
```

Being addressable, republishing with the same `d` tag replaces the previous
version — no deletion dance.

**Before shipping**, check 30890 against
<https://github.com/nostr-protocol/registry-of-kinds>. If it's taken, move.
If it isn't, write it up and open a NIP PR; a link block is generic enough
that other clients would use it, and a shared kind is worth more than a
private one.

## Signing in

Three backends behind one `signEvent()`, in `src/lib/signer.svelte.js`. There
is no field to paste an nsec into, and there never will be.

| Backend | Where | Notes |
| --- | --- | --- |
| `nip55` | Android APK | Local intents to Amber. Best UX; can sign in the background |
| `bunker` | Any browser | NIP-46 over relays. How Amber works on the web |
| `nip07` | Desktop browser | Alby, nos2x |

The app picks automatically — `nip55` when available, otherwise the web paths.

### Amber over NIP-46 (web build)

Amber's NIP-55 intents are for native apps only; a web page can't use them
reliably, since the round-trip depends on clipboard hand-off and breaks across
browsers. So the web build uses NIP-46, which Amber also speaks.

Both pairing directions work:

- **Client-initiated.** We mint a `nostrconnect://` URI via `createNostrConnectURI`
  and wait on `BunkerSigner.fromURI`. On desktop it renders as a QR for Amber to
  scan. On Android the same URI is a deep link, so it's a tap.
- **Bunker-initiated.** Paste a `bunker://` URI from Amber's connected-apps
  screen. Parsed with `parseBunkerInput`, connected with `BunkerSigner.fromBunker`.

The same code path covers nsec.app, Keychat and anything else speaking NIP-46.
`onauth` is wired up for signers that need a browser approval step — nsec.app
does this, Amber doesn't.

Pairing relays are separate from content relays and live in `NOSTRCONNECT_RELAYS`.
Keep that list short: both halves of the handshake must be on the same relay at
the same moment, so more relays makes pairing less reliable, not more.

**Amber gotcha:** over NIP-46 it can't answer while backgrounded. If pairing or
signing hangs, that's almost always why. This problem disappears entirely in
the APK.

### What's stored

Only in localStorage, only on the user's device:

- the public key, so a reload doesn't force a re-pair
- for `nip55`, the signer's package name, so later requests skip the app chooser
- for `bunker`, the **client** secret key and the negotiated bunker pointer

That client key is not the user's identity key — it's this app's key for
talking to the signer. If it leaks, the attacker can send signing requests to
the bunker until the user revokes the app in Amber. Worth a warning on shared
machines.

## Not done yet

- **Go-live panel** — publishing 30311 and 30315 rather than only reading them. This is the feature that makes the app worth opening weekly
- **Zap goals** — kind 9041, with progress tallied from kind 9735 receipts filtered by `#e`
- **NIP-47 wallet connect** so creators see zaps arrive in-app
- **Permission scoping at pair time** — right now Amber prompts on every single signing request because we don't request `perms` in the connect URI. Fine for a page you edit occasionally, painful once the go-live panel exists
- **Blossom uploads** for kind 20 and 22 posts
- **The directory** — needs a real indexer subscribing across relays into Postgres. Can't be done client-side at usable speed
