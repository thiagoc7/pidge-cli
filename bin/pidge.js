#!/usr/bin/env node
'use strict';
//
// pidge — CLI so an agent (a running Claude Code, or any agent with a shell) can send a rich
// iPhone notification AND block until the human answers (polling — the primary
// read path for terminal/CLI use, where there's no webhook to receive a reply).
//
//   export PIDGE_URL=https://api.pidge.sh          # default http://localhost:3000
//   export PIDGE_TOKEN=hld_xxx                     # the channel's bearer key
//   (HERALD_URL / HERALD_TOKEN are legacy env names, still honored as a
//    fallback; with no env vars set, ~/.config/pidge/env — KEY=VALUE — is read
//    instead, so the key can live OUTSIDE the agent's chat/context entirely)
//
//   TWO AXES: (1) the TYPE — one married list of 5 the
//   human configured how to receive: message · important · urgent · event · live;
//   (2) the RESPONSE — buttons (--actions/--custom-action) + send-and-go vs wait
//   (--wait blocks until the human answers). Response composes onto ANY type.
//
//   # just inform — fire-and-forget (prints the raw 201)
//   pidge message --title "Build green" --body "2m12s"
//
//   # a pendency the human should resolve (the DEFAULT type) + block on the answer
//   pidge important --title "Approve deploy?" --actions yes,no --wait
//
//   # a go/no-go decision with Face ID — the approval RECIPE (= important + wait + gate)
//   pidge approval --title "Deploy to production?"
//
//   # urgent: breaks through silent/Focus, escalates to an AlarmKit alarm
//   pidge urgent --title "Balance dropped below $5k" --escalate
//
//   # a thing with a known time: push at T−lead + a lock-screen countdown
//   pidge event --title "Team meeting" --event-at "2026-06-10T15:00:00"
//
//   # block on an already-sent notification (by correlation_id)
//   pidge wait order-7 --timeout 300
//
//   # cancel a still-scheduled notification before it fires
//   pidge cancel med-ozempic-qui
//
// stdout is ALWAYS machine-readable: `notify` prints the raw 201 JSON; `ask`/`wait`
// print the chosen_action JSON. Everything human (warnings, the correlation_id,
// snooze notices) goes to stderr. Exit codes: 0 = responded, 3 = timed out (= "no
// answer yet", NOT a failure — back off and retry later), 2 = error, 1 = usage.
//
// DESIGN: this CLI is a thin pipe — the SERVER's manifest (GET /api/v1/manifest)
// is the contract, and validation lives server-side (422s are self-describing).
// New /notify fields work without a CLI release via --param key=value.

const { parseArgs } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
// The one question about Terminals this CLI is allowed to ask when deciding
// what to SAY: does this computer have the feature installed?
const { announceTerminals } = require('../src/terminals-installed');

// `pidge --version` / `-v` — handled BEFORE parseArgs (which would otherwise
// throw "Unknown option" on the undeclared flag). Prints the version, exit 0.
// Gated on require.main so an in-process require of this file (wire.js pulls
// the pure e2e helpers this way) is side-effect-free — a requirer whose own
// argv carried -v must never trigger this process.exit(0) at import time.
if (require.main === module && (process.argv.includes('--version') || process.argv.includes('-v'))) {
  try { console.log(require(path.join(__dirname, '..', 'package.json')).version); }
  catch { console.log('unknown'); }
  process.exit(0);
}

// Identity isolation (a real incident: a shared config file made one agent's
// setup hijack another's cron): ~/.config/pidge/env is one slot per
// machine-user, so N agents sharing a HOME share an identity. Two isolation
// mechanisms, project-first since 0.28:
//   1. PROJECT scope (the default) — an agent lives in a project directory
//      (each git worktree is one), so `setup` run inside a git project stores
//      the key at ~/.config/pidge/projects/<hash-of-toplevel>/env and every
//      later command run anywhere inside that project finds it by walking up
//      to the same toplevel. Two projects can NEVER collide, and the identity
//      has a durable home a future session rediscovers with zero ceremony.
//   2. PIDGE_AGENT=<id> — a NON-secret namespacing var the human sets at the
//      agent's launch → ~/.config/pidge/agents/<id>/env. Wins over project
//      scope (explicit beats inferred); the answer for two agents sharing ONE
//      directory, or an agent with no project at all.
// The CLI still WRITES the key in every scope (the agent never sees it — token
// hygiene intact). No PIDGE_AGENT + no project env ⇒ the legacy shared file
// (single-agent machines and daemons; `setup --global` targets it on purpose).
// (An explicit PIDGE_TOKEN env var still wins over any file — the purest
// per-agent path.)
const AGENT_ID = (process.env.PIDGE_AGENT || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
function pidgeBaseDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pidge');
}
function pidgeConfigDir() {
  return AGENT_ID ? path.join(pidgeBaseDir(), 'agents', AGENT_ID) : pidgeBaseDir();
}
// The project toplevel: walk up from cwd to the first `.git` entry (a DIR in a
// normal checkout, a FILE in a linked worktree — both count, so every worktree
// is its own project). null outside any git project — identity then falls back
// to the shared file, which keeps a cron in $HOME exactly as it always was.
// $HOME itself is never a project: a dotfiles-in-git home would otherwise turn
// EVERY directory under it into one project and make "outside any project"
// unreachable for those users. Fully guarded: a deleted cwd (process.cwd()
// throws ENOENT) must degrade to "no project", never kill `--help` at load.
function findProjectRoot() {
  try {
    let dir = process.cwd();
    for (;;) {
      try {
        fs.statSync(path.join(dir, '.git'));
        return dir === os.homedir() ? null : dir;
      } catch { /* keep walking */ }
      const up = path.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  } catch { return null; }
}
const PROJECT_ROOT = findProjectRoot();
// Keyed by a hash of the toplevel PATH (not a file inside the repo): the key
// can never be committed, the repo stays untouched, and a deleted worktree
// leaves only a prunable orphan dir here.
const PROJECT_CONFIG_DIR = PROJECT_ROOT
  ? path.join(pidgeBaseDir(), 'projects',
      crypto.createHash('sha256').update(PROJECT_ROOT).digest('hex').slice(0, 16))
  : null;

// token hygiene: when the env vars are unset, fall back to the config file
// (KEY=VALUE the CLI writes during setup, or the HUMAN writes once) so the raw
// hld_… key never rides the agent's chat/context. Explicit env vars always win;
// `export ` prefixes, quotes and #comments are tolerated.
function readEnvFile(file) {
  try {
    const out = {};
    for (let line of fs.readFileSync(file, 'utf8').split('\n')) {
      line = line.trim().replace(/^export\s+/, '');
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 1) continue;
      const value = line.slice(i + 1).replace(/^["']|["']$/g, '');
      if (value) out[line.slice(0, i)] = value;
    }
    return out;
  } catch { return {}; }
}

// Config paths are computed EARLY (multi-runtime v2): the per-request
// agent fingerprint hashes CONFIG_FILE, and the shared `headers` const stamps
// that fingerprint on every call — so both must exist before line-863's headers.
// READ resolution: PIDGE_AGENT (explicit) → the project's env WHEN IT EXISTS →
// the legacy shared file. An existing shared-file install inside a git repo
// keeps resolving the shared file (no project env yet), so nothing moves under
// a working setup — the project scope takes over only once `setup` writes it.
// An install whose TOKEN comes from the ENVIRONMENT is fully specified already:
// it must NEVER adopt a project env it doesn't own (state.json pins, PIDGE_URL,
// the fingerprint all belong to the env-var identity — resolving a foreign
// project file here would let a mere `cd` bleed another channel's config into
// it, including silently bypassing the E2E anti-downgrade pin).
// `let` (not const): runSetup retargets these to the file it is about to WRITE
// (which may not exist yet), so the fingerprint that binds the claim is the
// identity the install will actually live at.
const ENV_TOKEN_SET = !!(process.env.PIDGE_TOKEN || process.env.HERALD_TOKEN);
let CONFIG_DIR = AGENT_ID ? pidgeConfigDir()
  : (!ENV_TOKEN_SET && PROJECT_CONFIG_DIR && fs.existsSync(path.join(PROJECT_CONFIG_DIR, 'env'))) ? PROJECT_CONFIG_DIR
  : pidgeConfigDir();
let CONFIG_FILE = path.join(CONFIG_DIR, 'env');
// Declared here (not next to fingerprintSalt below) because `identityHeaders()`
// runs at module load — and a `let` in the TDZ would throw
// "Cannot access 'FP_SALT_CACHE' before initialization". Keyed on CONFIG_DIR so a
// runSetup retarget (which reassigns CONFIG_DIR) re-derives the salt.
let FP_SALT_CACHE = null; // { dir, salt }
const FILE_ENV = readEnvFile(CONFIG_FILE);

const BASE = process.env.PIDGE_URL || process.env.HERALD_URL || FILE_ENV.PIDGE_URL || 'http://localhost:3000';
const TOKEN = process.env.PIDGE_TOKEN || process.env.HERALD_TOKEN || FILE_ENV.PIDGE_TOKEN;
// Execution attribution: the per-run bearer SIGNS every agent-track call
// (header `x-pidge-run`) so the human sees WHICH execution spoke. It is ENV-ONLY
// on purpose — a run is a disposable, per-execution signature, NEVER a stored
// credential (it must never land in the config file the way TOKEN does; a stale
// run token in FILE_ENV would mis-sign a later, unrelated session). Advisory
// everywhere: an expired/invalid token degrades to unsigned, never a 401.
const RUN_TOKEN = process.env.PIDGE_RUN_TOKEN || null;

function die(msg, code = 1) { console.error(msg); process.exit(code); }
// stdout on a PIPE is ASYNC (to a file or a TTY it is not): `console.log(body)`
// only QUEUES the bytes, and a `process.exit()` on the next tick kills the drain
// wherever the pipe buffer ended. Measured: a 486 KB body printed then exited
// reached a slow reader as 64 KB — or as NOTHING — while the SAME command
// redirected to a file was whole. That is exactly how `pidge inbox --limit 200`
// read through a subprocess arrived cut at ~64 KB ("Unterminated string" in the
// agent that parsed it), and a pipe IS the canonical way an agent reads this
// CLI. So every exit that FOLLOWS a printed body goes through here instead: the
// zero-length write's callback fires only after the bytes already queued reached
// the OS. stderr drains too — the narration is the provenance of that body.
//   ALWAYS `await exitFlushed(code)` (or `return exitFlushed(code)`): the
// promise never resolves, so nothing after the call runs — the same "this line
// ends the process" reading `process.exit()` had. Dropping the await would let
// the next statements execute in the tick before the exit lands.
function exitFlushed(code = 0) {
  return new Promise(() => {
    let pending = 2;
    const bye = () => { if (--pending === 0) process.exit(code); };
    try { process.stdout.write('', bye); } catch { bye(); }
    try { process.stderr.write('', bye); } catch { bye(); }
  });
}
// NB: the TOKEN requirement is enforced AFTER help/usage handling (below) — a
// first-time `npx pidge-cli --help` must work without any setup.

// ---------------------------------------------------------------------------
// E2E crypto — wire format v1 (shared with the server and the iOS app; test
// vectors in test/e2e_vectors.json).
// AES-256-GCM · 32-byte per-channel key · ONE independent envelope per field:
//   field envelope  "v1:" + base64url( nonce(12) || ciphertext || tag(16) )
//   blob framing    [0x01][nonce 12B][ciphertext][tag 16B]  (binary, no base64)
//   AAD             "ch<channel_id>:<correlation_id>:<field_name>"    (ASCII)
//   kf              base64url(SHA-256(key)[0..3])    (4-byte key fingerprint)
// This section is the PURE functions + the shared fixture (test/e2e_vectors.json)
// ONLY — the send/receive integration lives further down in the wire layer.
// The nonce parameter exists ONLY for the deterministic
// fixture; production callers omit it (crypto.randomBytes(12) per envelope).
// ---------------------------------------------------------------------------
const E2E_FIELD_PREFIX = 'v1:';
const E2E_BLOB_VERSION = 0x01;
const E2E_NONCE_BYTES = 12;
const E2E_TAG_BYTES = 16;

function e2eKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('e2e key must be a 32-byte Buffer');
  return key;
}
function e2eNonce(nonce) {
  if (nonce === undefined) return crypto.randomBytes(E2E_NONCE_BYTES);
  if (!Buffer.isBuffer(nonce) || nonce.length !== E2E_NONCE_BYTES) {
    throw new Error('e2e nonce must be a 12-byte Buffer (deterministic tests only — omit it in production)');
  }
  return nonce;
}

// The AAD binds a ciphertext to ITS channel + notification + field (anti-swap/
// anti-replay: a ciphertext moved to any other slot fails the tag). channel_id
// is the PUBLIC id (whoami/manifest) — never the secret.
function e2eAad(channelId, correlationId, fieldName) {
  if (channelId === undefined || channelId === null || channelId === '') throw new Error('e2e AAD needs a channel_id');
  if (!correlationId) throw new Error('e2e AAD needs a correlation_id');
  if (!fieldName) throw new Error('e2e AAD needs a field_name');
  return `ch${channelId}:${correlationId}:${fieldName}`;
}

function e2eSeal(key, aad, plaintext, nonce) {
  const iv = e2eNonce(nonce);
  const cipher = crypto.createCipheriv('aes-256-gcm', e2eKey(key), iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ct, tag: cipher.getAuthTag() };
}
function e2eOpen(key, aad, raw, what) {
  const iv = raw.subarray(0, E2E_NONCE_BYTES);
  const ct = raw.subarray(E2E_NONCE_BYTES, raw.length - E2E_TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', e2eKey(key), iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(raw.length - E2E_TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // GCM gives ONE failure signal for all of these — don't guess further.
    throw new Error(`e2e ${what} failed to authenticate: wrong key, wrong AAD, or corrupted data`);
  }
}

function e2eEncryptField(key, aad, plaintext, nonce) {
  const { iv, ct, tag } = e2eSeal(key, aad, Buffer.from(String(plaintext), 'utf8'), nonce);
  return E2E_FIELD_PREFIX + Buffer.concat([iv, ct, tag]).toString('base64url');
}

function e2eDecryptField(key, aad, envelope) {
  if (typeof envelope !== 'string') throw new Error('e2e envelope must be a string');
  if (!envelope.startsWith(E2E_FIELD_PREFIX)) {
    const ver = /^(v\d+):/.exec(envelope);
    throw new Error(ver ? `unknown e2e envelope version "${ver[1]}" — this CLI speaks v1`
      : 'not an e2e field envelope (missing "v1:" prefix)');
  }
  const b64 = envelope.slice(E2E_FIELD_PREFIX.length);
  // Buffer.from(_, 'base64url') silently SKIPS invalid chars — a mangled
  // envelope must fail loud here, not decode to garbage that then fails the
  // tag with a misleading "wrong key" story. Trailing '=' padding tolerated.
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(b64)) throw new Error('invalid base64url in e2e envelope');
  const raw = Buffer.from(b64, 'base64url');
  if (raw.length < E2E_NONCE_BYTES + E2E_TAG_BYTES) throw new Error('e2e envelope too short');
  return e2eOpen(key, aad, raw, 'field').toString('utf8');
}

function e2eEncryptBlob(key, aad, buffer, nonce) {
  if (!Buffer.isBuffer(buffer)) throw new Error('e2e blob plaintext must be a Buffer');
  const { iv, ct, tag } = e2eSeal(key, aad, buffer, nonce);
  return Buffer.concat([Buffer.from([E2E_BLOB_VERSION]), iv, ct, tag]);
}

function e2eDecryptBlob(key, aad, buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('e2e blob must be a Buffer');
  if (buffer.length < 1 + E2E_NONCE_BYTES + E2E_TAG_BYTES) throw new Error('e2e blob too short');
  if (buffer[0] !== E2E_BLOB_VERSION) {
    throw new Error(`unknown e2e blob version 0x${buffer[0].toString(16).padStart(2, '0')} — this CLI speaks 0x01`);
  }
  return e2eOpen(key, aad, buffer.subarray(1), 'blob');
}

// kf — 4 bytes of SHA-256(key), base64url. Rides CLEAR next to `enc:"v1"` so
// the device can say "sent with another key" PRECISELY instead of showing
// garbage (kills the token-of-one-channel + secret-of-another pitfall).
function e2eKeyFingerprint(key) {
  return crypto.createHash('sha256').update(e2eKey(key)).digest().subarray(0, 4).toString('base64url');
}

// Per-channel key DERIVATION from a paired computer's key (setup
// --from-computer; vectors: the fixture's `derivation` suite). Full pin:
// HKDF-SHA256 (RFC 5869) extract-then-expand · salt EMPTY · IKM = the 32 RAW
// key bytes (e2eKey refuses anything else — the classic mistake is feeding
// the 43-char base64url STRING) · info "pidge-derive:v1:ch<public id>" ASCII ·
// L = 32. One-way: no derived key reveals the computer key; each channel's
// info makes its key distinct. Both sides derive (the app from the tunnel key
// it holds) — NO secret travels for a derived channel.
function e2eDeriveChannelKey(computerKey, channelId) {
  const id = Number(channelId);
  if (!Number.isInteger(id) || id < 0) throw new Error('e2e derivation needs the channel\'s public integer id');
  return Buffer.from(crypto.hkdfSync('sha256', e2eKey(computerKey), Buffer.alloc(0), `pidge-derive:v1:ch${id}`, 32));
}

// PIDGE_SECRET reads from the SAME slot/precedence as PIDGE_TOKEN: env var wins
// over the config file (scope-aware via PIDGE_AGENT/project/XDG_CONFIG_HOME) —
// the {TOKEN, SECRET} pair always travels together from one source. Fresh read
// of the RESOLVED file (not the load-time FILE_ENV): setup retargets the scope
// mid-process and its post-setup doctor must read the file it just wrote.
function e2eLoadSecret() {
  return process.env.PIDGE_SECRET || readEnvFile(CONFIG_FILE).PIDGE_SECRET || null;
}

// PIDGE_SECRET is the channel's 32-byte key, base64url. Returns the key Buffer,
// null when absent, and THROWS a named error on a malformed value — the caller
// decides warn-and-send-clear (send path) vs BROKEN (doctor on an E2E channel).
function e2eParseSecret(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s)) throw new Error('PIDGE_SECRET is not base64url');
  const key = Buffer.from(s, 'base64url');
  if (key.length !== 32) throw new Error(`PIDGE_SECRET decodes to ${key.length} bytes — the channel key is exactly 32`);
  return key;
}

// Action ids whose LABELS must NEVER be sealed: the server's 12
// built-ins + the system ids "dismiss"/"acknowledge"/"seen" ("seen"
// is the app's opened-signal: the server intercepts it, so a custom
// "seen" button never reaches the agent; newer servers 422 it).
// Mirrors the server's reserved action-id list and the iOS app's builtin set,
// both of which SKIP label decrypt for these ids — a sealed label on one would
// render raw "v1:…" on the button. Built-in ids ride CLEAR everywhere (the
// action contract runs on ids); only CUSTOM labels are sealed. Newer servers
// 422 a custom action with one of these ids anyway — this is the
// fail-safe for older servers.
const E2E_NEVER_SEAL_LABEL_IDS = new Set([
  'snooze', 'done', 'reschedule', 'mute', 'reply',
  'yes', 'no', 'approve', 'reject', 'accept', 'decline', 'later',
  'dismiss', 'acknowledge', 'seen',
]);

// ── bridge outage triage (pure helpers — exported for tests) ────────────────
// The bridge's "channel looks broken" desktop alert used to fire on ANY 5
// consecutive poll failures — which on a laptop means EVERY sleep/wake cycle
// (a dark-wake polls with a dead network, fails 5 times, alerts, recovers,
// re-arms; one night = 30 alerts, all of them the Mac napping). These helpers
// make the alert sleep-aware: classify each failure as LOCAL (this machine /
// its network) vs SERVER-shaped, detect system sleep from wall-clock gaps
// (the OS freezes timers while asleep), and only wake the human for a
// server-shaped streak that persisted through real awake time — with a
// cool-down so one bad night is one alert, not thirty.

// Errno classes that mean THIS machine (or its LAN) lost the network: DNS
// dead/unreachable, interface down, no route to anywhere. They back off like
// any failure but must never pop the desktop alert. ECONNREFUSED is
// deliberately NOT here: refused on a working network means the SERVER's port
// is closed (alertable); refused with no route is caught by !hasNetwork.
const BRIDGE_LOCAL_ERRNOS = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'EHOSTDOWN', 'ENONET',
]);

// One poll failure → 'local' | 'server'.
//   status     — HTTP status when a response arrived (an answer PROVES the path works)
//   code       — errno off the network error (undici rides it on e.cause.code)
//   hasNetwork — cheap corroboration: does the machine have any non-internal interface?
//   justWoke   — a system sleep was detected moments ago (stale-socket aborts on wake)
function classifyBridgeFailure({ status = null, code = null, hasNetwork = true, justWoke = false } = {}) {
  if (status !== null && status !== undefined) return 'server'; // an HTTP answer reached us
  if (code && BRIDGE_LOCAL_ERRNOS.has(code)) return 'local';
  if (justWoke) return 'local';    // abort/timeout right after a detected sleep = wake turbulence
  if (!hasNetwork) return 'local'; // no interface has an address — offline, not the server
  return 'server';                 // the network looks fine and the server didn't answer
}

// Did the machine SLEEP through this wait? The OS suspends timers during
// system sleep, so an await that returns wildly past its deadline measured the
// lid closing, not slowness. Threshold: 2× the expected wait plus 30 s of
// slack — generous enough that a busy event loop never false-positives.
function sleptThrough(expectedMs, actualMs) {
  return actualMs > expectedMs * 2 + 30000;
}

// The alert-policy ledger for the "channel looks broken" DESKTOP alert. The
// stderr log narrates every failure regardless — this gates only the popup:
//   · only SERVER-shaped failures count (local/offline never alert);
//   · the streak must persist ≥ minStreakMs of AWAKE wall-clock;
//   · at most one alert per outage, and one per cooldownMs across outages;
//   · a detected sleep resets the streak (sleptReset) but never the cool-down.
function createBridgeAlertPolicy({ brokenAfter = 5, minStreakMs = 600000, cooldownMs = 14400000 } = {}) {
  let serverFails = 0;        // consecutive server-shaped failures this outage
  let streakStartedAt = null; // when the current server-shaped streak began (awake clock)
  let lastAlertAt = null;     // cool-down anchor — survives outages AND sleeps
  let alerted = false;        // the alert fired for THIS outage
  return {
    // Record one failure; returns { awakeMs } when the desktop alert should fire.
    fail(shape, now) {
      if (shape !== 'server') return null;
      serverFails++;
      if (streakStartedAt === null) streakStartedAt = now;
      const awakeMs = now - streakStartedAt;
      if (serverFails < brokenAfter || alerted || awakeMs < minStreakMs) return null;
      if (lastAlertAt !== null && now - lastAlertAt < cooldownMs) return null;
      alerted = true; lastAlertAt = now;
      return { awakeMs };
    },
    // The machine slept: whatever streak was building is stale evidence.
    sleptReset() { serverFails = 0; streakStartedAt = null; },
    // Healthy round-trip: close the outage. True ⇒ the alert HAD fired (the
    // caller emits the quiet "recovered" notice so the human isn't left hanging).
    recovered() {
      const had = alerted;
      serverFails = 0; streakStartedAt = null; alerted = false;
      return had;
    },
    get alerted() { return alerted; },
  };
}

// --- voice notes: name them honestly, transcribe NOTHING ---------------------
// The human's composer can record audio. That arrives as an ordinary
// attachment, and an agent that only sees `filename` + a byte count has no way
// to know it is holding speech — so it either ignores it or, worse, invents
// what the human "said". Both are failures we can prevent with metadata: the
// render stamps `kind:"voice"`, carries the sender-declared `duration_seconds`
// through, and states ONCE that Pidge does not transcribe.
//
// Detection is deliberately at RENDER time, not on the wire: a sealed
// attachment says `application/octet-stream` and its real name is an envelope
// only the client can open — the `.m4a` is legible exactly one step after
// e2eProcessAttachment decrypts `message_filename`.
const VOICE_AUDIO_EXTENSIONS = new Set(['.m4a', '.mp3', '.wav', '.ogg', '.opus']);

// ONE line, on purpose: it enters an agent's context every render that carries
// a voice note, so it says the whole truth and stops. Nothing in this CLI
// transcribes, bundles a model, or calls an STT API — pretending otherwise (or
// staying silent and letting the agent guess) is the dishonesty this kills.
const VOICE_HINT = 'Pidge does not transcribe voice notes. Transcribe locally if you need text (e.g. whisper.cpp, `whisper`, or your own STT API).';

// A voice note is `audio/*` OR an audio extension on the (already opened)
// filename. Both halves are needed: a clear send carries a real content type,
// while a sealed one is generic bytes whose name only exists after decryption.
// Exported for tests.
function isVoiceAttachment(att) {
  if (!att || typeof att !== 'object') return false;
  const ct = typeof att.content_type === 'string' ? att.content_type.trim().toLowerCase() : '';
  if (ct.startsWith('audio/')) return true;
  const name = typeof att.filename === 'string' ? att.filename : '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false; // no extension, or a dot-leading name with none
  return VOICE_AUDIO_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

// duration_seconds is OPTIONAL and server-declared — an integer when the sender
// measured it, absent otherwise. Anything that isn't a finite non-negative
// number is treated as absent: a voice note with no length still renders fine,
// and we never print a duration we can't stand behind. Exported for tests.
function voiceDurationSeconds(att) {
  const raw = att && att.duration_seconds;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

// m:ss (h:mm:ss past the hour) — how a human reads a recording's length.
// Exported for tests.
function formatVoiceDuration(total) {
  const s = Math.max(0, Math.round(Number(total) || 0));
  const secs = String(s % 60).padStart(2, '0');
  const mins = Math.floor(s / 60);
  if (mins < 60) return `${mins}:${secs}`;
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}:${secs}`;
}

// The render step, run ONCE per printed batch over the FINISHED, ordered rows —
// never inside the per-row async open, where whichever download resolved first
// would decide who carries the hint. Voice rows gain `kind`/`duration_seconds`
// and one 🎤 line each; the hint rides the FIRST voice attachment of the batch
// and prints once. A non-audio attachment is not touched at all. Mutates the
// (already-copied) attachment objects and returns the rows. Exported for tests.
function annotateVoiceAttachments(rows, log = console.error) {
  if (!Array.isArray(rows)) return rows;
  let hinted = false;
  for (const row of rows) {
    const att = row && typeof row === 'object' ? row.attachment : null;
    if (!isVoiceAttachment(att)) continue;
    att.kind = 'voice';
    const secs = voiceDurationSeconds(att);
    if (secs === null) delete att.duration_seconds; // never echo a garbage length back
    else att.duration_seconds = secs;
    const when = secs === null ? '' : `, ${formatVoiceDuration(secs)}`;
    // WHERE the bytes are, in the same words the JSON uses. A clear attachment
    // keeps its opt-in posture — this line reports it, it does not change it.
    let where;
    if (att.path) where = `saved to ${att.path}`;
    else if (att.sealed) where = 'sealed, bytes NOT downloaded (--no-download / --digest)';
    else if (att.url) where = 'not saved — it is a clear attachment; --download writes it to disk';
    else where = 'no local copy';
    log(`pidge: 🎤 voice note${when} — ${where}`);
    if (!hinted) {
      hinted = true;
      att.hint = VOICE_HINT;
      log(`pidge: ${VOICE_HINT}`);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Test seam: require()ing this file exposes the pure e2e helpers and stops
// HERE — none of the CLI machinery below (parseArgs, the TOKEN check, command
// dispatch) runs under a require. The exports are assigned UNCONDITIONALLY,
// then the early `return` skips the CLI body when not the main module.
// Executed as a binary, only the return is skipped, so the CLI still runs
// unchanged.
// ---------------------------------------------------------------------------
module.exports = {
  e2eAad, e2eKeyFingerprint, e2eLoadSecret, e2eParseSecret, e2eDeriveChannelKey,
  e2eEncryptField, e2eDecryptField, e2eEncryptBlob, e2eDecryptBlob,
  E2E_NEVER_SEAL_LABEL_IDS, e2ePinKeyFor,
  // sealed media — the pure halves (gate decision + filename hygiene).
  e2eMediaSealDecision, sanitizeAttachmentName,
  // voice notes — detection + the render annotation (pure; no transcription).
  isVoiceAttachment, voiceDurationSeconds, formatVoiceDuration, annotateVoiceAttachments,
  VOICE_HINT, VOICE_AUDIO_EXTENSIONS,
  // bridge outage triage — the pure halves of the sleep-aware alert policy.
  classifyBridgeFailure, sleptThrough, createBridgeAlertPolicy, BRIDGE_LOCAL_ERRNOS,
};
if (require.main !== module) return;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  title: { type: 'string' },
  body: { type: 'string' },
  'body-markdown': { type: 'string', short: 'm' },
  'body-markdown-file': { type: 'string' },   // a path, or "-" to read stdin
  subtitle: { type: 'string' },
  template: { type: 'string' },                // content/action pattern (manifest `templates`)
  profile: { type: 'string' },                 // delivery profile id (manifest `profiles`)
  'event-at': { type: 'string' },              // WHEN the thing happens (profile event)
  'lead-minutes': { type: 'string' },          // notify/countdown lead before event_at
  urgency: { type: 'string' },                 // normal | persistent | alarm (low-level — prefer --profile)
  escalate: { type: 'boolean' },               // alert type — force an AlarmKit alarm (escalate:true)
  gated: { type: 'boolean' },                  // one Face-ID confirm action (replaces content_template:sensitive)
  image: { type: 'string' },                   // banner+feed image: local path → uploaded; URL → as-is
  file: { type: 'string' },                    // real artifact (xlsx/pdf/csv…): local path → uploaded
  url: { type: 'string' },                     // deep link the app opens on tap
  copy: { type: 'string' },                    // tap-to-copy value on the detail
  actions: { type: 'string' },                 // comma list from the catalog
  'custom-action': { type: 'string', multiple: true }, // id:label[:destructive][:confirm][:biometric][:terminal]
  'deliver-at': { type: 'string' },
  'reply-to': { type: 'string' },
  'correlation-id': { type: 'string' },
  thread: { type: 'string' },                  // conversation handle — same id ⇒ one strand on the phone
  after: { type: 'string' },                   // decision queue: held until this cid resolves
  'collapse-key': { type: 'string' },
  param: { type: 'string', multiple: true },   // key=value escape hatch → raw /notify field
  download: { type: 'boolean' },               // save CLEAR inbound attachments too (sealed ones always save)
  'no-download': { type: 'boolean' },          // catchup: don't fetch/unseal attachments (digest implies it)
  'download-dir': { type: 'string' },          // where attachments land (default <config dir>/downloads)
  note: { type: 'string' },                    // /notify sent_note — WHY this runtime sent it (clear metadata, no secrets)
  timeout: { type: 'string' },
  interval: { type: 'string' },
  // The response axis: --wait blocks until the human answers (composes on
  // ANY type — send-and-go vs wait). ask/approval imply it.
  wait: { type: 'boolean' },
  // inbox flags
  pending: { type: 'boolean' },
  // inbox uses `--summary` as a valueless BOOLEAN (counts+latency). The
  // `ack` command needs `--summary "<what you did>"` as a STRING. One global
  // OPTIONS map can't be both, so this stays boolean (for inbox) and the `ack`
  // case RE-PARSES its own argv with `summary` typed as a string — otherwise the
  // global parse would swallow the value as a stray positional (a silent no-op on
  // an attribution field, the worst failure mode).
  summary: { type: 'boolean' },
  all: { type: 'boolean' },
  limit: { type: 'string' },
  before: { type: 'string' },                  // catchup: page older than this message id
  since: { type: 'string' },                   // catchup: incremental cursor — only ids > this
  digest: { type: 'boolean' },                 // catchup: one condensed line per message
  // realtime: WS by default when the runtime has a WebSocket (Node ≥22)
  realtime: { type: 'boolean' },               // force WS (warn+fallback if unavailable)
  'no-realtime': { type: 'boolean' },          // polling only
  'quiet-nag': { type: 'boolean' },            // silence the manifest-version nag for this run
  // onboarding v2
  claim: { type: 'string' },                   // setup --claim <single-use code>
  'from-computer': { type: 'boolean' },        // setup: DERIVE PIDGE_SECRET from this machine's paired-computer key
  // Agent Sessions (`pidge terminal …`) — see src/terminal/
  code: { type: 'string' },                    // terminal connect: the Connect-a-computer claim code
  qr: { type: 'boolean' },                     // terminal connect: computer-first pairing — mint K here, print a QR, type back the app's code
  secret: { type: 'string' },                  // terminal connect: PIDGE_SECRET fallback (env var preferred)
  session: { type: 'string' },                 // terminal disable: explicit session id (else ancestor-walk)
  approvals: { type: 'string' },               // terminal enable: comma tool list for the approval gate (off by default)
  manager: { type: 'string' },                 // update: force npm | pnpm | yarn | bun (default: inferred)
  yes: { type: 'boolean' },                    // terminal connect: skip the consent prompt (scripted installs)
  'no-daemon': { type: 'boolean' },            // terminal connect: skip the service install (any platform)
  replace: { type: 'boolean' },                // terminal connect: consent to overwrite THIS computer's tunnel identity
  // listen keeps going after a batch (supervisor loop, one process)
  follow: { type: 'boolean' },
  force: { type: 'boolean' },                  // setup: overwrite a config owned by ANOTHER channel
  print: { type: 'boolean' },                  // setup: print export lines instead of writing a file (per-agent, human runs it)
  global: { type: 'boolean' },                 // setup: target the shared machine file instead of the project scope
  'listen-mode': { type: 'string' },           // setup: declare operating_contract listen mode (turn_based|always_on; default turn_based)
  target: { type: 'string' },                  // skill install: claude (default) | agents | gemini — same content, different destination file
  // Read-receipt split — `ack` after the work; listen no longer consumes on read.
  'up-to': { type: 'string' },                 // ack: process messages up to this id
  ids: { type: 'string' },                     // ack: process this comma-list of ids
  renew: { type: 'boolean' },                  // ack: heartbeat the visibility-timeout lease (state=delivered)
  'ack-on-read': { type: 'boolean' },          // listen: restore the pre-0.9 immediate-consume
  window: { type: 'string' },                  // selftest: reachability window in seconds (default 30)
  exec: { type: 'string' },                    // bridge/listen: the handler command (ONE invocation per batch)
  handler: { type: 'string' },                 // bridge install: generate the handler for claude | codex | gemini
  enable: { type: 'boolean' },                 // bridge install: start the service now and PROVE it with a selftest
  'no-hook': { type: 'boolean' },              // setup: do not install the Claude Code SessionStart hook (`pidge presence`)
  'handler-timeout': { type: 'string' },       // bridge/listen --exec: max seconds ONE handler run may take (default 1800)
  ndjson: { type: 'boolean' },                 // listen/online: one compact JSON object per line (uniform `type`)
  // approve: the two gated-action labels (default Allow / Deny)
  'allow-label': { type: 'string' },
  'deny-label': { type: 'string' },
  // Collapse `setup` onboarding to a single status line (the full
  // doctor stays the default; --quiet is opt-in, never the default).
  quiet: { type: 'boolean' },
  // The `pidge live` verb drives the REAL Live
  // Activity endpoints (status center) — no more silent degrade to /notify.
  status: { type: 'string' },                  // live: short status line on the card
  symbol: { type: 'string' },                  // live: SF Symbol name
  detail: { type: 'string' },                  // live: small trailing value
  progress: { type: 'string' },                // live: 0..1 → progress bar
  step: { type: 'string' },                    // live: "3/5" sugar → progress + fraction label
  'ends-at': { type: 'string' },               // live: ISO8601 → native countdown (server concludes at zero)
  'starts-at': { type: 'string' },             // live: ISO8601 → elapsed count-up
  paused: { type: 'boolean' },                 // live: is_running=false (pause the timer)
  resume: { type: 'boolean' },                 // live: is_running=true (resume the timer)
  dedicated: { type: 'boolean' },              // live: own device card (budget 2 — over budget degrades loudly)
  end: { type: 'boolean' },                    // live: end the entry (shows done + outcome, lingers, leaves)
  outcome: { type: 'string' },                 // live --end: the line shown next to the ✓
  linger: { type: 'string' },                  // live --end: seconds the final snapshot stays (default 30)
  // execution attribution — `pidge run start` knobs (+ `--json` raw body).
  mode: { type: 'string' },                    // run start: interactive | poll | bridge | custom (default custom)
  role: { type: 'string' },                    // run start: main | worker | subagent (display-only)
  label: { type: 'string' },                   // run start: the friendly execution label (default agentLabel())
  'parent-seal': { type: 'string' },           // run start: a subagent points its parent run's seal
  ephemeral: { type: 'boolean' },              // run start: a disposable, per-message execution
  ttl: { type: 'string' },                     // run start: sliding TTL in seconds → ttl_seconds
  json: { type: 'boolean' },                   // run start: print the raw server body instead of the export lines
  'no-defer': { type: 'boolean' },             // bridge: turn OFF the polite poller (never defer to an interactive run)
};

// The overview is assembled, not one literal, because ONE block of it is
// conditional: a computer with no Terminals daemon never hears about Terminals
// (see src/terminals-installed). With the feature installed — or with its
// override env set — the three pieces join back into the exact text this help
// has always printed.
const USAGE_HEAD = `pidge — send an iPhone notification to a human and block until they answer.

USAGE
  pidge setup --claim CODE [--url BASE]   one-shot onboarding: exchange the single-use
                                          code for the channel key, store it, run doctor.
                                          Run it INSIDE your project (git): the key is scoped
                                          to that project — N agents in N projects never collide.
                                          Same directory, 2+ agents? PIDGE_AGENT=<id> at each
                                          launch → ~/.config/pidge/agents/<id>/env.
                                          --global store in the shared machine file instead
                                                   (a daemon/cron outside any project)
                                          --print  emit 'export PIDGE_TOKEN=…' instead of a file
                                                   (you run it in YOUR terminal; paste into the
                                                   agent's launcher — never run --print as an agent)
                                          --force  overwrite a file owned by another channel
                                          --listen-mode turn_based|persistent|external_daemon
                                                   declare how you operate (default turn_based)
  pidge doctor                            validate the setup WITHOUT exposing secrets:
                                          env source, server, key, "canal X · N devices"
  pidge whoami                            which channel does this key speak for (JSON)
  pidge hello  [options]                  FIRST-CONTACT WOW: your channel's debut handshake,
                                          narrated LIVE on the lock screen by a 3-stage Live Activity
                                          (Conectando → toque para confirmar → Concluído ✓). send + wait
                                          in one — run it as your FIRST contact on a fresh channel.
  AXIS 1 — TYPE (the married list of 5; the human configured how each arrives):
  pidge message   [options]               just inform, no action — clears when the human OPENS it
  pidge important [options]  ⭐DEFAULT     a pendency the human should resolve ("waiting-for-you" card)
  pidge urgent    [options]               breaks through silent/Focus; --escalate forces an AlarmKit alarm
  pidge event     [options]               a scheduled thing — needs --event-at (countdown Live Activity)
  pidge live [CID] [options]              a REAL lock-screen card (Live Activity): entry of the
                                          user's consolidated status center. --title starts/upserts;
                                          CID without --title updates; --end concludes (✓ + outcome)
  AXIS 2 — RESPONSE (composes on ANY type above): --actions/--custom-action add
  buttons; text reply is ALWAYS available; --wait blocks until the human answers
  (send-and-go vs --wait). Two shortcuts bundle both axes:
  pidge ask      [options]                = important + --wait; needs --actions (prints chosen_action JSON)
  pidge approval [options]                = important + Approve/Reject + Face ID + --wait (a go/no-go)
  pidge approve "<question>" [options]    exit-code gate for hooks: Face-ID allow/deny, DENY-DEFAULT —
                                          exit 0 ONLY on explicit allow (deny/timeout/error → non-zero)
  COMPAT aliases (old names still work → mapped to the new type):
  pidge fyi→message · report→important · alert→urgent  (event/live unchanged)
  pidge notify [options]                  DEPRECATED — send without a type; prefer a TYPE above
  pidge wait   <correlation_id> [options] block on an already-sent notification
  pidge cancel <correlation_id>           cancel a still-scheduled notification
  pidge inbox  [--pending|--summary|--all|--limit N]   what you sent: list, pending slice, or counts+latency
  pidge catchup [--limit N] [--before ID]  READ-ONLY peek at the whole conversation (GET ?history=true):
                                          the thread newest-first, answers included — NEVER consumes,
                                          NEVER acks, NEVER opens a lease. Run it to SITUATE yourself at
                                          the start of an interactive session on a channel whose messages
                                          another runtime (a bridge/daemon) is the real consumer of — so
                                          you learn what's already handled WITHOUT stealing a message.
                                          Exit 0 (printed, even if empty) · 2 error. NEVER run \`listen\`
                                          on a channel another runtime consumes (double-consume).`;

// Printed only on a computer that installed Terminals.
const USAGE_TERMINAL = `  pidge terminal <sub>                    TERMINALS: share a tmux PANE with the human's phone —
                                          a Claude session as its structured transcript (E2E-sealed,
                                          typed replies land in its input box) or a plain terminal.
                                          connect --code C   once per computer (paste the app's one-liner)
                                          connect --qr       computer-first pairing: prints a QR the app
                                                             scans, you type back the code it shows
                                                             (no one-liner, no secret in any clipboard)
                                          (claude sharing)   the ONLY door is the PreToolUse HOOK: paste
                                                             "Run exactly this one bash command and nothing
                                                             else: \`pidge terminal enable\`" INTO the session
                                                             you want mirrored. The hook fires before the
                                                             command runs, shares that session id and denies
                                                             the tool — no PATH, no picker, no sid.
                                          share              share THIS pane (run it inside the pane)
                                          config K on|off    what the phone may do to this computer:
                                                             remote_spawn (OFF) · remote_capture (OFF) · inventory (ON)
                                          enable             a CONFIRMATION of the above (never the door)
                                          doctor             does this computer read a LIVE agent AS an
                                                             agent? run it on the machine, with claude up
                                          disable · status · disconnect`;

// The update line names its Terminals caller only where that caller exists.
const usageUpdate = (withTerminals) => `  pidge update                            update this CLI to the latest published pidge-cli
                                          (npm/pnpm/yarn/bun auto-detected${withTerminals ? '; \`terminal connect\` nudges you here' : ''})`;

const USAGE_TAIL = `  pidge bridge --exec '<handler>'         24/7 SUPERVISOR: loop listen --all → your handler runs
                                          ONCE per batch (batch JSON on stdin) → exit 0 ⇒ ack of the
                                          batch's EXACT ids · non-zero ⇒ NOT acked (the server lease
                                          re-serves). ONE instance per channel (pid-checked lockfile by
                                          hash(token)); --handler-timeout caps one run (default 30 min);
                                          model-agnostic: --exec 'claude -p …' | 'codex exec …' | any script
  pidge bridge install [--enable]         OPT-IN — a STAND-IN (another agent) answering while nobody is
      [--handler claude|codex|gemini]     there; only when your human asked for one. Writes the launchd
      [--exec '<handler>']                (macOS) / systemd (Linux) user service running the bridge from
                                          THIS project with a GENERATED handler for the model CLI on PATH
                                          (+ an editable prompt) or your own --exec; --enable starts it
                                          and PROVES it with a selftest (exit 0 = measured). Yields the
                                          channel to a live listen. Never embeds the key.
  pidge bridge status | uninstall         measured ONLINE/OFFLINE (service · lock · server) | stop + remove
  pidge presence                          ONE line: is anyone listening? (built for a SessionStart hook)
  pidge hook install | uninstall          the Claude Code SessionStart hook that runs pidge presence
  pidge listen [--timeout N] [--all] [--exec '<handler>'] [--ndjson] [--follow]
                                          block until the human MESSAGES you from the app, print, exit
                                          a read message is DELIVERED (gray ✓✓), NOT done — ACK it
                                          AFTER the work: pidge ack --up-to <id> (a ~10-min lease re-serves
                                          un-acked messages, so a crash never loses one)
                                          --exec  = ONE round, run by YOUR handler (batch JSON on stdin,
                                                    ONE invocation): exit 0 ⇒ ack of the batch's EXACT ids
                                                    (+ the handler's \`pidge-summary:\` line, if any) ·
                                                    non-zero ⇒ a handler_failed JSON line on STDOUT, NO ack,
                                                    exit 2. The handler's exit code decides the ack; an ack
                                                    that FAILS after a 0 is an ack_failed line + exit 2.
                                          --ndjson      = one compact JSON object per line, every line
                                                          stamped \`type\` (default = a pretty array)
                                          --ack-on-read = the old immediate-consume (ack on print)
                                          --follow      = KEEP listening until --timeout (supervisor-only)
                                          --all  = the SINGLE EAR: also hear notification ANSWERS
                                          listen HOLDS this channel's consumer lock while it runs — a
                                          second listen/bridge is REFUSED (exit 2). Read with \`pidge catchup\`.
  pidge online [listen flags]             = pidge listen --all, one word — so a pasted prompt can
                                          just say "stay online: pidge online". Run it as a background
                                          task your harness TRACKS; when it exits: handle → ack → RELAUNCH.
  pidge ack --up-to <id> | --ids a,b [--renew]
                                          mark messages PROCESSED (green ✓✓) after you handled them;
                                          --renew heartbeats the lease on a long task (state=delivered)
  pidge typing [SECONDS|off]              show the human the three dots while you work on a reply.
                                          Run it when their message just landed and you'll be busy
                                          more than ~15s before answering (\`pidge typing 120\` when
                                          it'll be long). It SELF-EXPIRES (default 60s, server clamp
                                          3–300), ANY real send of yours clears it, and running it
                                          again extends it. Display-only — nothing waits on it.
                                          Automatic under bridge / listen --exec (PIDGE_NO_AUTO_TYPING=1 opts out).
  pidge contract set <key>=<value> | contract show
                                          DECLARE how you operate: keep_connection_alive,
                                          mirror_in_origin_session,
                                          listen_mode=turn_based|persistent|external_daemon,
                                          quiet_when_idle. ADVISORY, never policy (the human SEES if you honor it).
  pidge selftest [--window N]             prove your listener works by ROUND-TRIP: fire a nonce and
                                          watch (READ-ONLY) for YOUR listener to pick it up + ack it.
                                          PASS exit 0 / FAIL exit 2 (with the likely cause) — with
                                          nothing listening it FAILS: it never acks its own nonce.
                                          Run it with your listener UP, whenever sends seem unheard.
  pidge skill install [--target T]        write the generated Pidge skill from the live manifest
                                          (persistent knowledge for an AI agent). --target claude
                                          (default) → .claude/skills/pidge/SKILL.md · agents → AGENTS.md ·
                                          gemini → GEMINI.md (same content, different destination)
  pidge --version                         print the CLI version
  pidge --help

REALTIME
  listen/ask/wait hold a WebSocket to the server (ActionCable at /cable) when the
  runtime has one (Node ≥22): answers/messages land in <1 s, an idle hours-long
  listen survives server deploys by RECONNECTING, and while you listen the human
  sees "ouvindo agora" in the app. Everything durable still goes over HTTP
  (backlog GET + ack), so a dropped socket costs latency, never data.
  --realtime      force WS (warns + falls back to polling if unavailable)
  --no-realtime   polling only (the ?wait= long-poll, capped 25 s server-side)
  Degrade ladder, narrated on stderr: WS → ?wait= long-poll → plain GETs every
  ~45 s after 3 consecutive failures on held polls. Degrade is STICKY for
  the session (we can't probe held-poll health without re-paying the failure) —
  re-invoke the command to retry the fast path.

OPTIONS (notify / ask)
  --title TEXT             (required) the headline
  --body TEXT              message shown on the banner
  --body-markdown MD       rich body for the tap-through detail screen
  --subtitle TEXT
  --gated                  add a Face-ID confirm on the consequential action (money/deletion)
  --body-markdown-file F   read the markdown body from a file (or "-" for stdin)
  --profile ID             low-level alias of the TYPE axis (the HUMAN owns what it
                           does): message · important · urgent · event · live ·
                           the user's custom profiles. Prefer the typed subcommands
                           above; an explicit --profile still wins. See the manifest.
  --event-at ISO8601       WHEN the thing happens (a FACT; required by profile event)
  --lead-minutes N         notify/start countdown N min before event_at (5–240)
  --urgency LEVEL          normal | persistent | alarm (low-level — prefer --profile)
  --image PATH_OR_URL      image on the banner + feed: a local path is uploaded for
                           you (your machine has no public URL); an https URL is sent as-is
                           (E2E channel + open media gate ⇒ a local path is SEALED first)
  --file PATH              a real artifact (xlsx, pdf, csv…) the human previews,
                           shares and saves on the phone; uploaded automatically (≤25 MB;
                           sealed bytes + filename when the media gate is open)
  --url URL                deep link the app opens when the user taps (PR, dashboard, log)
  --copy TEXT              value offered as tap-to-copy on the detail (code, token)
  --actions LIST           RESPONSE axis — comma list: yes,no,approve,reject,accept,
                           decline,later,done,snooze,reschedule,reply,mute (or a JSON
                           array of custom {id,label} objects). Composes on ANY type.
  --custom-action SPEC     "id:label[:destructive][:confirm][:biometric][:terminal]" (repeatable)
  --wait                   RESPONSE axis — block until the human answers (any type),
                           then print chosen_action JSON. 0.32+: if the human TYPES in
                           the channel composer meanwhile, the wait returns that instead
                           (kind:"human_message" — handle, \`pidge ack\`, re-wait).
                           Without it: fire-and-forget (the answer arrives later in
                           \`pidge listen --all\`). ask/approval imply it.
  --deliver-at ISO8601     schedule for later
  --reply-to URL           also POST the answer to your webhook (HMAC-signed)
  --correlation-id ID      idempotency + routing key (auto-generated if omitted)
  --thread ID              conversation handle: sends sharing it group as ONE
                           strand on the phone — use it for follow-ups
  --after CID              decision queue: HELD until that notification is
                           answered — chain N decisions so the human sees one at a
                           time ("Decisão 2/3" --after <cid-da-1>); snooze doesn't advance
  --collapse-key KEY       replace/update a prior notification
  --param KEY=VALUE        pass ANY raw /notify field (repeatable) — future server
                           fields work without a CLI update; the manifest is the contract
  --timeout SECONDS        how long --wait blocks (ask/approval: template's suggestion,
                           ~3600 for a decision · wait: 300) — explicit always wins
  --interval SECONDS       FALLBACK poll cadence (default 30) — normally unused: WS or
                           the server-held long-poll (?wait=25) make answers ~instant

ENV
  PIDGE_URL     your Pidge server (default http://localhost:3000; HERALD_URL honored)
  PIDGE_TOKEN   your channel's bearer key (required; HERALD_TOKEN honored). Setting
                this per agent at launch is the cleanest multi-agent isolation —
                env var always wins over any file.
  PIDGE_AGENT   <id> namespacing the config file to ~/.config/pidge/agents/<id>/env —
                for 2+ agents sharing ONE directory (the CLI still writes the
                key — no secret in the agent's chat). STICKY: set at setup, every
                later pidge command needs the same var. Unset ⇒ project scope when
                setup ran inside a git project (~/.config/pidge/projects/<hash>/env,
                resolved by walking up to the toplevel), else the legacy shared
                ~/.config/pidge/env (single-agent machines and daemons).
  PIDGE_SECRET  the channel's E2E key (base64url, 32 bytes). When the human turns
                on end-to-end encryption, the app's Connect screen shows a separate
                TERMINAL step that writes it next to the token — into THIS
                install's config file (pidge doctor prints the path; export it in
                the shell before setup and setup persists it in the right scope).
                The secret never travels in the chat prompt (never paste it in
                chat). Same slot and precedence as PIDGE_TOKEN (the pair travels
                together).
                With it set and the channel E2E, sends are sealed and sealed
                answers/messages decrypt automatically; without it, sends go clear
                and the app marks them "⚠️ sem criptografia". Validate with
                \`pidge doctor\`.
  PIDGE_NO_AUTO_TYPING=1
                turn OFF the automatic typing indicator that \`bridge\`/\`listen --exec\`
                raise when they hand a batch to your handler (\`pidge typing\` by hand
                still works). Display-only either way — nothing downstream reads it.

OUTPUT
  stdout is machine-readable (a fire-and-forget send→the raw 201 JSON; a --wait
  send / ask / approval / wait→chosen_action JSON); human notices go to stderr.
  listen/online print ZERO OR MORE compact continuity_context lines and THEN one
  pretty-printed JSON ARRAY of messages — never parse that stdout line by line.
  --ndjson gives one compact object per line instead, each stamped \`type\`
  ("message" | "notification_reply" | "continuity_context" | "batch_end").
  The rule either way: ACKABLE ⇔ the object has an \`id\`; switch on \`type\`.
  Exit: 0 answered · 3 timed out (no answer yet, not a failure) · 4 timed out
  WITHOUT ONE healthy round-trip all session (the CHANNEL looks broken —
  server/network — not the human ignoring you: surface it instead of retrying
  blindly) · 2 error · 1 usage.

Responses are one-and-done EXCEPT snooze/reschedule (they re-fire); a --wait send
keeps polling through a snooze and prints snooze_until. Follow-up = a NEW
notification. An over-ceiling type is delivered DEGRADED, never rejected — read
the 201's degraded/degrade_reason (narrated on stderr). \`live\` is status-only:
it never produces an answer, so --wait/ask refuse it.

Full spec (the contract — always current): GET $PIDGE_URL/api/v1/manifest`;

function usageText() {
  const withTerminals = announceTerminals();
  const parts = [USAGE_HEAD];
  if (withTerminals) parts.push(USAGE_TERMINAL);
  parts.push(usageUpdate(withTerminals), USAGE_TAIL);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// per-subcommand help. `pidge <cmd> --help` (and `pidge help <cmd>`) must
// show the focused help for THAT command — its synopsis, what it does, and only
// the flags that apply — instead of dumping the global USAGE (the bug an agent
// hit: `pidge ask --help` listed the global flags, burying ask's own
// --actions/--timeout). The global USAGE stays the no-command / `pidge --help`
// view. One option dictionary feeds both so the text can't drift.
// ---------------------------------------------------------------------------
const OPTION_DOCS = {
  title: '--title TEXT             (required) the headline',
  body: '--body TEXT              the message shown on the banner',
  'body-markdown': '--body-markdown MD       rich body for the tap-through detail screen',
  'body-markdown-file': '--body-markdown-file F   read the markdown body from a file (or "-" for stdin) — avoids shell-quoting long markdown',
  subtitle: '--subtitle TEXT          a secondary line under the title',
  gated: '--gated                  add a Face-ID confirm on the consequential action (money/deletion). Pair with a louder profile if it must also be loud.',
  profile: '--profile ID             low-level alias of the TYPE (the human owns it): message · important · urgent · event · live · custom',
  'event-at': '--event-at ISO8601       WHEN the thing happens (required by event)',
  'lead-minutes': '--lead-minutes N         notify/countdown N min before event_at (5–240)',
  urgency: '--urgency LEVEL          normal | persistent | alarm (low-level — prefer the typed subcommand)',
  escalate: '--escalate               urgent: force an AlarmKit alarm that breaks through silent/Focus',
  image: '--image PATH_OR_URL      banner+feed image: a local path is uploaded; an https URL is sent as-is',
  file: '--file PATH              a real artifact (xlsx/pdf/csv…) uploaded for the human (≤25 MB)',
  url: '--url URL                deep link the app opens on tap (PR, dashboard, log)',
  copy: '--copy TEXT              tap-to-copy value on the detail screen',
  actions: '--actions LIST|JSON      RESPONSE axis: comma list from the catalog (e.g. yes,no · or reply ALONE — never mix a decision with reply) OR a JSON array of {"id","label"} custom actions — composes on ANY type',
  'custom-action': '--custom-action SPEC     "id:label[:destructive][:confirm][:biometric][:terminal]" (repeatable)',
  wait: '--wait                  RESPONSE axis: block until the human answers (any type), then print chosen_action JSON (ask/approval imply it). 0.32+: a composer message typed meanwhile returns as kind:"human_message"',
  'deliver-at': '--deliver-at ISO8601     schedule the send for later',
  'reply-to': '--reply-to URL           also POST the answer to your webhook (HMAC-signed)',
  'correlation-id': '--correlation-id ID      idempotency + routing key (auto-generated if omitted)',
  thread: '--thread ID              conversation handle: same id ⇒ one strand on the phone',
  after: '--after CID              decision queue: held until that notification is answered',
  'collapse-key': '--collapse-key KEY       replace/update a prior notification',
  param: '--param KEY=VALUE        pass ANY raw /notify field (repeatable) — the manifest is the contract',
  timeout: '--timeout SECONDS        how long --wait blocks (ask/approval: template suggestion ~3600 · wait: 300 · listen: 600)',
  interval: '--interval SECONDS       FALLBACK poll cadence (default 30) — normally unused (WS/long-poll)',
  realtime: '--realtime               force the realtime WebSocket (warn + fall back to polling if unavailable)',
  'no-realtime': '--no-realtime            polling only (skip the WebSocket)',
  pending: '--pending                only delivered + still-unanswered notifications',
  summary: '--summary                counts + answer latency (one call)',
  'all-inbox': '--all                    whole-account scope (not just this channel)',
  'all-listen': '--all                    single ear: also hear notification ANSWERS, not just messages',
  download: '--download               also save CLEAR inbound attachments to disk (sealed ones always save)',
  'no-download': '--no-download            catchup: skip fetching/unsealing attachments (--digest implies it)',
  'download-dir': '--download-dir DIR       where inbound attachments land (default ~/.config/pidge/downloads)',
  note: '--note TEXT              send: WHY this runtime sent it (sent_note — clear metadata, no secrets)',
  limit: '--limit N                cap the number of rows',
  before: '--before ID              catchup: page the thread OLDER than this message id (walk back through history)',
  since: '--since ID               catchup: incremental cursor — only messages NEWER than this id (O(new), not O(thread))',
  digest: '--digest                 catchup: one condensed line per message (id · kind · 60 chars · handled by X: <note> / ✓ acked (no note) / ✓ acked (mute — no note, nothing sent after) / PENDING)',
  target: '--target T               skill install: claude (default) → .claude/skills/pidge/SKILL.md · agents → AGENTS.md · gemini → GEMINI.md',
  claim: '--claim CODE             the single-use setup code (the human copies it from the Pidge app)',
  'from-computer': '--from-computer          setup: derive PIDGE_SECRET from this machine\'s paired-computer key (both sides derive — no secret travels; needs `pidge terminal connect` done here)',
  code: '--code CODE              terminal connect: the Connect-a-computer claim code (from the app\'s one-liner)',
  qr: '--qr                     terminal connect: computer-first pairing — mints the key HERE, prints a QR for the app to scan, then asks for the code the app shows (never combined with --code/PIDGE_SECRET)',
  secret: '--secret S               terminal connect: PIDGE_SECRET fallback (prefer the env var — keeps it out of argv)',
  session: '--session SID            terminal disable: a session id from `pidge terminal status` (optional when exactly one session is shared). `enable` takes no sid — the hook that catches the pasted command knows it.',
  approvals: '--approvals T1,T2        gate these tools behind an Approve/Deny push (off by default). It rides the PASTED command (`pidge terminal enable --approvals Bash,Write`) — the hook reads it there.',
  manager: '--manager NAME           update: force the package manager (npm | pnpm | yarn | bun; default: inferred from where this copy lives)',
  yes: '--yes                    terminal connect: skip the consent prompt (scripted installs)',
  'no-daemon': '--no-daemon              terminal connect: skip the service install on any platform (run `pidge terminal daemon` yourself)',
  replace: '--replace                terminal connect: overwrite this computer\'s EXISTING tunnel identity (without it, a second connect refuses loudly; the old channel stays on the server — remove it in the app)',
  global: '--global                 store in the shared machine file (~/.config/pidge/env) instead of the project scope — for a daemon/cron that runs outside any project',
  'url-base': '--url BASE               the Pidge server base URL (default https://api.pidge.sh)',
  print: '--print                  emit `export …` lines instead of writing a file (per-agent; you run it)',
  force: '--force                  overwrite a shared config owned by another channel',
  'listen-mode': '--listen-mode MODE       declare how you operate: turn_based | persistent | external_daemon',
  follow: '--follow                 KEEP listening until --timeout (supervisor-only; traps a turn-based agent)',
  'ack-on-read': '--ack-on-read            consume messages on read (pre-0.9 immediate-consume)',
  'up-to': '--up-to ID               process every message up to this id',
  ids: '--ids a,b                process this comma-list of ids',
  renew: '--renew                  heartbeat the visibility-timeout lease instead of processing',
  'ack-summary': '--summary "TEXT"         ack: attribution — WHAT you did (a successor session sees it via `pidge catchup`; capped ~1000 chars)',
  window: '--window N               reachability window in seconds (default 30)',
  handler: '--handler NAME           bridge install: GENERATE the handler + its prompt for claude | codex | gemini (default: the first of those on PATH). Editable files in the pidge config dir.',
  'no-hook': '--no-hook                setup: skip the Claude Code SessionStart hook that prints the channel\'s presence (`pidge presence`) at every session start, resume, /clear and /compact',
  enable: '--enable                 bridge install: enable + start the service now, wait for it, then PROVE the round-trip with a selftest — exit 0 only on PASS',
  exec: "--exec CMD               the handler: run ONCE per batch with the batch JSON on stdin; exit 0 = batch acked (its EXACT ids), non-zero = NOT acked (the server lease re-serves — make it idempotent)",
  'exec-listen': "--exec CMD               ONE round handled by YOUR command: the batch JSON ({messages,continuity?}) on its stdin, ONE invocation; exit 0 ⇒ ack of the EXACT ids (+ its `pidge-summary:` line) · non-zero/timeout ⇒ a {\"type\":\"handler_failed\"} line on stdout, NO ack, exit 2 · a failed ACK after a 0 ⇒ {\"type\":\"ack_failed\"} on stdout, exit 2. Refuses with --follow / --ndjson / --ack-on-read",
  'handler-timeout': '--handler-timeout N      max seconds ONE handler run may take (default 1800 = 30 min) — over it: SIGTERM (SIGKILL 5s later), treated as a FAILED batch (not acked)',
  ndjson: '--ndjson                 one compact JSON object per line instead of the pretty array — every line stamped `type` (message | notification_reply | continuity_context | batch_end); ackable ⇔ it has an `id`',
  'quiet-nag': '--quiet-nag              silence the "server has new capabilities" nag for this run',
  'allow-label': '--allow-label TEXT       approve: label on the Face-ID allow button (default "Allow")',
  'deny-label': '--deny-label TEXT        approve: label on the deny button (default "Deny")',
  quiet: '--quiet                  setup: collapse onboarding to one status line (the full doctor stays the default)',
  status: '--status TEXT            short status line on the card ("copiando índices")',
  symbol: '--symbol NAME            SF Symbol (hammer.fill, arrow.down.circle)',
  detail: '--detail TEXT            small trailing value on the card',
  progress: '--progress N             0..1 → progress bar (or use --step)',
  step: '--step N/M               steps sugar: "3/5" → progress 0.6 + the fraction label (no steps field on the wire)',
  'ends-at': '--ends-at ISO8601        countdown — the SERVER concludes the entry when it hits zero',
  'starts-at': '--starts-at ISO8601      elapsed count-up from this instant',
  paused: '--paused                 pause the timer (is_running:false); omit-to-preserve — updates never reset it',
  resume: '--resume                 resume a paused timer (is_running:true)',
  dedicated: '--dedicated              own device card instead of a status-center entry (budget 2 — the 3rd degrades loudly)',
  end: '--end                    end the entry: done ✓ + outcome, lingers --linger seconds, then leaves the card',
  outcome: '--outcome TEXT           end: the line shown next to the ✓ (falls back to the final --status)',
  linger: '--linger N               end: seconds the final snapshot stays visible (default 30)',
  mode: '--mode M                 run start: interactive | poll | bridge | custom (default custom)',
  role: '--role R                 run start: main | worker | subagent (display-only)',
  label: '--label L                run start: the friendly execution label (default your PIDGE_LABEL/agent id)',
  'parent-seal': '--parent-seal S          run start: a subagent points at its parent run\'s seal ($PIDGE_RUN_SEAL)',
  ephemeral: '--ephemeral              run start: mark a disposable, per-message execution',
  ttl: '--ttl N                  run start: sliding TTL in seconds (server clamps; default 24h)',
  json: '--json                   run start: print the raw server body instead of the two export lines',
  'no-defer': '--no-defer               bridge: never hold back for a live interactive run (turn OFF the polite poller)',
};
// Content flags shared by every send.
// `template` is intentionally OFF the menu (content_template is
// undocumented back-compat). It stays a parseable OPTION but is NOT listed here,
// so `pidge <type> --help` no longer prints a bare, description-less `template` line.
const CONTENT_OPTS = ['title', 'body', 'body-markdown', 'body-markdown-file', 'subtitle', 'profile',
  'event-at', 'lead-minutes', 'urgency', 'image', 'file', 'url', 'copy', 'actions',
  'custom-action', 'deliver-at', 'reply-to', 'correlation-id', 'thread', 'after',
  'collapse-key', 'note', 'param'];
// Typed sends also carry the RESPONSE axis: --wait (block on the answer) + the
// blocking knobs. (`live` is status-only — it never answers, so it skips these.)
const SEND_OPTS = [...CONTENT_OPTS, 'gated', 'wait', 'timeout', 'interval', 'realtime', 'no-realtime'];

// `usage`, `body` and `opts` may be a FUNCTION of "does this computer have
// Terminals installed?" — the few entries whose text names the feature print it
// only where the feature lives (the flags themselves never change: --from-computer
// still works when typed, it just stops advertising a pairing this machine
// cannot have done).
const HELP = {
  setup: {
    summary: 'one-shot onboarding: exchange a single-use claim code for the channel key, store it, run doctor.',
    usage: (t) => `pidge setup --claim CODE [--url BASE] [--global] [--print] [--force]${t ? ' [--from-computer]' : ''} [--listen-mode MODE]`,
    body: 'The CLI writes the key itself (chmod 600) — it never appears on screen or in the agent\'s chat. Run it INSIDE your project (git): the key is scoped to that project, so N agents in N projects never collide (--global targets the shared machine file instead — for daemons/cron). Two agents in the SAME directory: set PIDGE_AGENT=<id> at each agent\'s launch. A fumbled setup is safe to re-run: within the code\'s 15-min TTL the same install gets its key again (server v84+). --quiet collapses the onboarding to one status line.',
    opts: (t) => ['claim', 'url-base', 'global', 'print', 'force', ...(t ? ['from-computer'] : []), 'listen-mode', 'quiet'],
  },
  doctor: {
    summary: 'validate the setup WITHOUT exposing secrets (env source, server, key, device reach, realtime probe).',
    usage: 'pidge doctor',
    opts: [],
  },
  presence: {
    summary: 'ONE line for a session-start hook: is anyone listening on this channel right now?',
    usage: 'pidge presence',
    body: '"OFFLINE — nobody is listening; start the watch: Monitor(…)" or "listening — <label> [kind] holds the queue; read with catchup, never start a second listener". Exit 0 always (a hook must never break a session). The server\'s measured presence decides; a lingering consumer row never contradicts it.',
    opts: [],
  },
  hook: {
    summary: 'install/remove the Claude Code SessionStart hook that runs `pidge presence` at every session start, resume, /clear and /compact.',
    usage: 'pidge hook install  ·  pidge hook uninstall',
    body: 'Writes ONE tagged entry into the PROJECT\'s .claude/settings.json (other hooks untouched; idempotent; uninstall removes only ours). The command carries your identity (PIDGE_AGENT / XDG_CONFIG_HOME when set) and follows @latest from the npx cache, or a `pidge` on PATH. `pidge setup` installs it for you under Claude Code (--no-hook skips).',
    opts: [],
  },
  whoami: {
    summary: 'which channel does this key speak for (prints the identity JSON).',
    usage: 'pidge whoami',
    opts: [],
  },
  update: {
    summary: 'update this CLI to the latest published pidge-cli (npm/pnpm/yarn/bun, auto-detected).',
    usage: 'pidge update [--manager npm|pnpm|yarn|bun]',
    body: (t) => `The installed base is the failure mode: \`npx pidge-cli\` prefers a copy your machine ALREADY has, so an old install keeps running (0.28.0 was measured on a real Mac while 0.40.0 was published) and every newer subcommand reads as "unknown option". This installs \`pidge-cli@latest\` globally with the manager that owns this copy. Already current ⇒ it says so and exits 0; an unreachable registry ⇒ it warns and installs anyway; a failed install ⇒ exit 2 with the manual line.${t ? ' `pidge terminal connect` runs the same check and points here.' : ''}`,
    opts: ['manager'],
  },
  hello: {
    summary: 'first-contact WOW: your channel\'s debut handshake, narrated live by a 3-stage Live Activity. send + wait in one.',
    usage: 'pidge hello [options]',
    body: 'First contact on a fresh channel: send the debut handshake and block until your human confirms. The server narrates a 3-stage Live Activity. --timeout defaults to 120s; a timeout exits 3 (no confirmation yet — it stays in your queue, `pidge listen --all` collects it), never hanging the session. It runs the same health verdict as `wait`/`listen`: a debut on a channel that never completed ONE healthy round-trip exits 4 (the channel, not your human) instead of blaming the silence on them.',
    opts: [...CONTENT_OPTS, 'timeout', 'interval', 'realtime', 'no-realtime'],
  },
  // AXIS 1 — the married catalog of 5. The TYPE you pick IS how the
  // human configured it to arrive. RESPONSE (--actions/--wait) composes on any of them.
  message: {
    summary: 'just inform — passive info the human reads when they want; no action (clears when they OPEN it).',
    usage: 'pidge message --title TEXT [--body TEXT | --body-markdown MD] [--image PATH] [--url URL]',
    body: 'Fire-and-forget by default (stdout is the raw 201). Use it for logs, registros and neutral summaries. Need a decision? add --actions + --wait, or use `pidge important`/`pidge approval`. (Replaces the old `fyi`.)',
    opts: [...SEND_OPTS],
  },
  important: {
    summary: '⭐ the DEFAULT — a pendency the human should resolve ("waiting-for-you" card; clears on Done).',
    usage: 'pidge important --title TEXT [--actions yes,no] [--wait] [--body-markdown MD]',
    body: 'Fire-and-forget by default; add --actions/--custom-action for quick-tap buttons and --wait to block until the human answers (prints chosen_action JSON). The most-used type — on the fence between informing and asking, pick this. (Replaces the old `report`.)',
    opts: [...SEND_OPTS],
  },
  urgent: {
    summary: 'breaks through silent/Focus; --escalate forces an AlarmKit alarm. Use for the real and inadiável (<1/day).',
    usage: 'pidge urgent --title TEXT [--escalate] [--actions yes,no] [--wait]',
    body: 'A contract of trust: reserve it for what truly can\'t wait. --escalate asks for an AlarmKit alarm that rings through silent + Focus (the human\'s settings still decide). Once DELIVERED an urgent only stops when answered — you can\'t abort it. (Replaces the old `alert`.)',
    opts: [...SEND_OPTS, 'escalate'],
  },
  event: {
    summary: 'a scheduled thing with a known time — countdown Live Activity (needs --event-at).',
    usage: 'pidge event --title TEXT --event-at ISO8601 [--lead-minutes N] [--body-markdown MD]',
    body: 'REQUIRES --event-at (ISO8601, e.g. 2026-06-26T14:00-03:00 — no offset ⇒ the user\'s timezone). --lead-minutes (5–240) starts the countdown N min before.',
    opts: [...SEND_OPTS],
  },
  live: {
    summary: 'track an in-flight task (deploy/build/trip) on a REAL lock-screen Live Activity. Status-only — never answers.',
    usage: 'pidge live [CID] --title TEXT [--status "…"] [--step 3/5 | --progress 0.6 | --ends-at ISO] · pidge live CID --end [--outcome "…"] [--linger N]',
    body: 'Drives the /live_activities endpoints — by default an ENTRY of the user\'s ONE consolidated status-center card (cards never stack; --dedicated opts into an own card, budget 2). FIELDS DRIVE THE RENDER: --step/--progress → bar + fraction · --ends-at → native countdown (the server concludes it at zero) · --end → ✓ + --outcome, lingers --linger seconds, then leaves. The handle is the CID (positional or --correlation-id; auto-generated on first POST — reuse it to update/end). Updates are cheap: identical re-writes echo operation:"noop"; a stale entry is retired by the server. ALWAYS --end what you started anyway — outcome beats timeout.',
    opts: ['title', 'status', 'step', 'progress', 'ends-at', 'starts-at', 'paused', 'resume', 'detail', 'symbol', 'dedicated', 'end', 'outcome', 'linger', 'correlation-id'],
  },
  // AXIS 2 — the two response shortcuts (bundle a type + buttons + --wait).
  ask: {
    summary: 'a DECISION — = important + --wait; needs --actions. Blocks until the human answers (prints chosen_action JSON).',
    usage: 'pidge ask --title TEXT --actions yes,no [--reply-to URL] [options]',
    body: 'Shorthand for important --wait that REQUIRES a way to answer — --actions (catalog or JSON) or --custom-action. For a typed answer use --actions reply ALONE (never a decision + reply together). Holds a WebSocket (or polls) until a TERMINAL answer; a snooze/reschedule re-fires.',
    opts: [...CONTENT_OPTS, 'timeout', 'interval', 'realtime', 'no-realtime'],
  },
  approval: {
    summary: 'a go/no-go RECIPE — = important + Approve/Reject + Face ID on Approve + --wait.',
    usage: 'pidge approval --title TEXT [--body-markdown MD] [options]',
    body: 'The easy shortcut for an explicit approval: injects an Approve (Face-ID gated) / Reject pair and blocks on the answer. Pass your own --actions/--custom-action to override the default pair. A gated action is detail-screen only (the banner shows no quick buttons by design).',
    opts: [...CONTENT_OPTS, 'timeout', 'interval', 'realtime', 'no-realtime'],
  },
  // — the HOOK-shaped gate. DENY-DEFAULT: exit 0 ONLY on an explicit allow;
  // deny, timeout, a dead channel or any ambiguity is non-zero, so a permission
  // hook fails CLOSED. Built for PreToolUse (see the runnable example below).
  approve: {
    summary: 'ask the human to authorize a risky action (Face ID) and BLOCK — deny-default: exit 0 ONLY on explicit allow.',
    usage: 'pidge approve "<question>" [--body TEXT] [--timeout N] [--allow-label L] [--deny-label L]',
    body: [
      'Sends an important/sensitive notification with two gated custom actions — allow (Face-ID confirm) and deny — then blocks on the answer (the same long-poll as `pidge ask`).',
      'DENY-DEFAULT (the security rule): only an explicit allow is exit 0. deny → exit 1; timeout / no answer / a broken channel / an HTTP failure on the send → exit 1. ONLY a raw network error (the send never reached the server at all) → exit 2. NON-ZERO ALWAYS MEANS "not approved" — treat it as a deny.',
      'TRUST CAVEAT: the gate is only as trustworthy as this process\'s env — whatever can rewrite PIDGE_URL/PIDGE_TOKEN can redirect the approval (and your bearer token) to its own server and answer "allow". Run permission hooks in an environment you trust.',
      'chosen_action JSON is printed to stdout; human notices go to stderr.',
      '',
      'PreToolUse hook (Claude Code) — gate a risky tool behind a human Face-ID tap, fail-closed:',
      '  #!/usr/bin/env bash',
      '  input=$(cat)                                   # the hook JSON on stdin',
      '  tool=$(printf %s "$input" | jq -r .tool_name)',
      '  cmd=$(printf %s "$input" | jq -r ".tool_input.command // (.tool_input|tostring)")',
      '  if pidge approve "Allow $tool?" --body "$cmd" --timeout 300 >/dev/null 2>&1; then',
      '    exit 0            # human approved (Face ID) → let the tool run',
      '  else',
      '    echo "Blocked: no human approval for $tool" >&2',
      '    exit 2            # exit 2 = PreToolUse BLOCK; fail-closed on deny/timeout/error',
      '  fi',
    ].join('\n'),
    opts: [...CONTENT_OPTS, 'allow-label', 'deny-label', 'timeout', 'interval', 'realtime', 'no-realtime'],
  },
  // COMPAT aliases — old names map to the new type (kept so scripts don't break).
  fyi: {
    summary: 'COMPAT alias of `pidge message` (renamed in 0.14 — the married catalog). Still works; prefer `message`.',
    usage: 'pidge fyi … (→ pidge message …)',
    opts: [...SEND_OPTS],
  },
  report: {
    summary: 'COMPAT alias of `pidge important` (renamed in 0.14). Still works; prefer `important`.',
    usage: 'pidge report … (→ pidge important …)',
    opts: [...SEND_OPTS],
  },
  alert: {
    summary: 'COMPAT alias of `pidge urgent` (renamed in 0.14). Still works; prefer `urgent`.',
    usage: 'pidge alert … (→ pidge urgent …)',
    opts: [...SEND_OPTS, 'escalate'],
  },
  notify: {
    summary: 'DEPRECATED — send WITHOUT a type; the server falls back to its default. Use a typed send instead.',
    usage: 'pidge notify [options]',
    body: 'Kept for compat — it warns and still sends (no template_kind; the server picks the channel default). Prefer `pidge message/important/urgent/event/live` (or the `ask`/`approval` shortcuts).',
    opts: [...SEND_OPTS],
  },
  wait: {
    summary: 'block on an already-sent notification until it is answered (prints chosen_action JSON).',
    usage: 'pidge wait <correlation_id> [options]',
    opts: ['timeout', 'interval', 'realtime', 'no-realtime'],
  },
  cancel: {
    summary: 'cancel a still-scheduled notification before it fires (idempotent; 409 once it reached the phone).',
    usage: 'pidge cancel <correlation_id>',
    opts: [],
  },
  inbox: {
    summary: 'what you sent: the list (default), the pending slice, or counts + answer latency.',
    usage: 'pidge inbox [--pending | --summary] [--all] [--limit N]',
    opts: ['pending', 'summary', 'all-inbox', 'limit'],
  },
  listen: {
    summary: 'block until the human MESSAGES you from the app, print, ACK after the work, exit.',
    usage: "pidge listen [--timeout N] [--all] [--exec '<handler>'] [--ndjson] [--ack-on-read] [--follow] [--download] [--download-dir DIR]",
    body: [
      'One-shot by design (loop it, don\'t daemonize). a read message is DELIVERED (gray ✓✓), NOT done — ack it AFTER the work with `pidge ack --up-to <id>` (a ~10-min lease re-serves un-acked messages, so a crash never loses one). a message may carry an `attachment` (a photo/file from the app\'s composer) — a SEALED one is auto-downloaded + decrypted to a local file (`attachment.path` in the JSON); a clear one keeps its fetchable `url` (--download saves it too). An audio attachment (a VOICE NOTE the human recorded) is marked `kind:"voice"` with `duration_seconds` when they measured it — you get the FILE, never a transcript: Pidge does not transcribe, so transcribe locally (whisper.cpp, `whisper`, your own STT) and never guess what they said.',
      '',
      'STDOUT (the contract, so a parser can\'t drift): zero or more compact `{"type":"continuity_context",…}` lines — read-only provenance, nothing there is ackable — and THEN ONE pretty-printed JSON ARRAY of messages. It is heterogeneous and multi-line: never parse it line by line. `--ndjson` prints one compact object per line instead, each stamped `type` ("message" | "notification_reply" mirroring `kind`, plus the continuity lines and a final `{"type":"batch_end","count":N,"max_ackable_id":M}`). Either way: ACKABLE ⇔ the object has an `id`; switch on `type`, never on position.',
      '',
      'ONE CONSUMER PER CHANNEL, mechanized: listen HOLDS this channel\'s lockfile (keyed by hash(token), pid-checked) for its whole run and releases it on the way out. A second `listen` — or a `bridge` — on the same channel is REFUSED (exit 2) and told what to do: read with `pidge catchup` (read-only), or stop the other process. A `--wait`/ask/approval of YOUR OWN while a listener holds the lock is fine and stays a notification-only wait: composer messages belong to the listener, and the CLI says so on stderr.',
      '',
      '`--exec \'<handler>\'` makes ONE round autonomous: instead of printing the batch for you to read, the CLI hands it to your command on stdin — `{"messages":[…],"continuity":[…]}`, ONE invocation — and THE HANDLER\'S EXIT CODE DECIDES THE ACK. Exit 0 ⇒ ack of the batch\'s EXACT ids, carrying the handler\'s last `pidge-summary: <one sentence>` stdout line as the note (no marker ⇒ acked without one, never invented). Non-zero, a spawn error or --handler-timeout ⇒ NOTHING is acked (the lease re-serves), a compact `{"type":"handler_failed","exit":N,"ids":[…]}` line lands on STDOUT — where you wake up — and listen exits 2. Exit 0 with an ACK that then FAILS is its own case, equally loud: `{"type":"ack_failed","ids":[…]}` on stdout and exit 2 — the work happened, the server doesn\'t know it, and the batch comes back. The handler\'s stdout is teed through (a handler that ends mid-line gets a newline before either machine line, so both always parse alone); the lease is renewed every 60 s while it runs. An empty round spawns nothing and exits 3, as always.',
      '',
      'Exits: 0 delivered (or handled + acked under --exec) · 3 nothing arrived this round · 4 nothing arrived AND not one healthy round-trip (the channel looks broken) · 2 error, refused, or a failed handler · 1 usage.',
    ].join('\n'),
    opts: ['timeout', 'all-listen', 'exec-listen', 'handler-timeout', 'ndjson', 'ack-on-read', 'follow', 'interval', 'realtime', 'no-realtime', 'download', 'download-dir'],
  },
  online: {
    summary: 'sugar for `pidge listen --all` — the stay-online loop, one word.',
    usage: "pidge online [--timeout N] [--exec '<handler>'] [--ndjson] [--ack-on-read] [--follow] [--download] [--download-dir DIR]",
    body: 'THE STAY-ONLINE COMMAND, as YOU: \`pidge online --follow --ndjson --timeout 0\` under a session-length watch your harness OWNS (Claude Code: Monitor, persistent:true) streams every message to the session your human is talking to — one message per stdout line, no deadline; handle it, reply through \`pidge message\`, \`pidge ack --up-to <id>\`. A bridge holding the channel yields to it and takes over again when it ends. Without such a watch (Codex, Gemini CLI, a plain shell), run \`pidge online\` in the FOREGROUND of your turn — one round, it blocks until a message — and never in a background terminal that does not wake you: measured on Codex, that is a DEAF consumer (green for the server, silent for the human); \`--follow --timeout 0\` refuses outside Claude Code for that reason (PIDGE_EVENT_STREAM=1 overrides for a harness that really streams). Between turns you are offline. When your session ends your human sees you OFFLINE — correct. A bridge (\`pidge bridge install\`) is ANOTHER agent answering in your place — only if your human asked for a stand-in. It exists so a pasted prompt can just say "stay online: pidge online". Every listen flag forwards; --all is forced (the single ear: composer messages + notification answers). The LOOP is the contract: run it as a background task your harness TRACKS (never a loose shell &); it blocks until something lands — handle it, `pidge ack`, then RELAUNCH it. That loop is what "online" means. Same stdout contract and same consumer lock as `pidge listen` (see `pidge listen --help`); `--exec \'<handler>\'` runs the round for you and lets the handler\'s exit code decide the ack.',
    opts: ['timeout', 'exec-listen', 'handler-timeout', 'ndjson', 'ack-on-read', 'follow', 'interval', 'realtime', 'no-realtime', 'download', 'download-dir'],
  },
  terminal: {
    summary: 'Terminals: share a tmux pane with the phone — a Claude session as structured, E2E-sealed conversation data (typed replies come back into it), or a plain terminal pane.',
    usage: 'pidge terminal connect --code CODE [--url BASE] [--yes] [--no-daemon] [--replace]  ·  pidge terminal connect --qr (computer-first: scan from the app, type back the code)  ·  pidge terminal share (inside a pane)  ·  pidge terminal config [remote_spawn|remote_capture|inventory] [on|off]  ·  pidge terminal enable (confirm)  ·  pidge terminal disable [--session SID|--all] | status | doctor | disconnect',
    body: [
      'The user runs claude inside tmux — that is their ENTIRE responsibility. `connect` (once per computer) pairs with the phone: the app\'s Settings → Computers → Connect a computer mints a tunnel channel + E2E key and shows a one-liner carrying the claim code + PIDGE_SECRET; paste it in a terminal. It asks consent, installs Claude Code hooks (tagged `# pidge-hook`, cleanly removable), refreshes the Pidge skill, copies this CLI to ~/.config/pidge/terminal/cli (so the service never points into a prunable npx cache) and installs a background daemon (launchd on macOS, `systemd --user` on Linux/WSL; a WSL without systemd gets a detached daemon + the line that makes it durable).',
      '',
      'SHARING IS PER SESSION and opt-in, through exactly ONE door — the PreToolUse HOOK. To share a session, PASTE into it: "Run exactly this one bash command and nothing else: `pidge terminal enable` — it signals a local Pidge daemon to mirror THIS Claude session to my phone." Claude runs it, the hook fires BEFORE the command does, carrying the authoritative session_id, and the daemon shares THAT session and DENIES the tool (so the command never actually runs — `pidge` need not be on any PATH; its denial reason is the ✓). No process-tree walk, no picker, no --session. A session whose tty is not a uniquely-identifiable tmux pane is refused loudly, never guessed. A NEW claude in the same pane is NOT auto-enabled (consent is per session id). `pidge terminal enable` typed in a bare terminal is only a CONFIRMATION — it reports what is being mirrored and prints the prompt to paste.',
      '',
      'Everything shared is fully interactive: the phone renders the transcript natively (tool cards, diffs) and typed replies land in the session\'s real input box via tmux send-keys. Sessions outside tmux are not shareable in v1. When claude stops and waits, the human gets a REAL notification. The approval gate (off by default) rides the PASTED command — `pidge terminal enable --approvals Bash,Write` — and gates those tools behind an Approve/Deny push; a timeout falls open to the local prompt.',
      '',
      'THE UNIT IS A PANE, not a session. `pidge terminal share`, typed INSIDE any tmux pane, shares that pane with the phone (it matches its own tty against `#{pane_tty}` — no guessing); if claude is running there it shares as an agent view, otherwise as a terminal. When claude starts in (or exits from) a shared pane the share STAYS — same row, same history, the view just switches. The daemon holds ONE always-on socket while this computer is connected, so the phone sees it online with zero shared panes.',
      '',
      'WHAT THE PHONE MAY DO TO THIS COMPUTER IS GRANTED HERE, and printed in plain words by `connect` and `status`: `pidge terminal config remote_spawn on|off` (default OFF — spawn a new pane, optionally running claude, from the phone), `pidge terminal config remote_capture on|off` (default OFF — let the phone share a pane nobody here shared, which makes it a live input surface) and `pidge terminal config inventory on|off` (default ON — answer the phone\'s on-demand pane list, sealed and never stored). Bare `pidge terminal config` prints all three. Typing into a pane you already shared needs no grant: the share IS the consent. Spawn, capture and inventory create new surface with no act on this machine, so the grant lives where the risk lives.',
      '',
      'E2E is mandatory (the transcript contains everything); the server relays sealed blobs it can never read. `disable` stops one share; `disconnect` = disable --all + uninstall hooks + daemon.',
    ].join('\n'),
    opts: ['code', 'qr', 'secret', 'session', 'approvals', 'yes', 'no-daemon', 'replace', 'url'],
  },
  bridge: {
    summary: '24/7 supervisor: long-poll the channel, run YOUR handler once per batch, ack only on exit 0. Model-agnostic.',
    usage: "pidge bridge install [--handler claude|codex|gemini | --exec '<handler>'] [--enable]  ·  pidge bridge status  ·  pidge bridge uninstall  ·  pidge bridge --exec '<handler>' (run the loop in THIS process)",
    body: [
      'The productized "paste a prompt and the agent stays online". The bridge is deliberately DUMB — no local queue, no own retry ledger: durability is the SERVER\'s ack/lease.',
      '',
      'LOOP: long-poll GET /messages?all=true (the robust floor; a realtime socket, when available, adds presence — "ouvindo agora" — and early wake-ups, never the data path) → your --exec command runs ONCE per batch with the batch JSON on stdin ({"messages":[…]} + "history_hint":true on the first batch since boot — the handler may want `pidge catchup` to situate) → handler exit 0 ⇒ ack of the batch\'s EXACT ids (never a --up-to watermark: that would stamp rows under lease from an EARLIER batch the handler FAILED on) · non-zero ⇒ NOT acked: the ~10-min server lease re-serves the batch. At-least-once is the contract — make the handler IDEMPOTENT. One run is capped by --handler-timeout (default 30 min): over it the handler is SIGTERMed (SIGKILL 5s later) and the batch counts as FAILED; while it runs, a heartbeat line lands on stderr every 5 min AND the batch\'s lease is RENEWED every 60 s (POST /ack {ids, state:"delivered"}) — so a long run neither lapses the ~10-min lease mid-work nor reads as offline (servers with manifest ≥ v79 refresh "listening now" presence on the renew; a failed batch still lapses back: the renew stops the moment the handler exits).',
      'SUMMARY: the handler tells the NEXT session WHAT it did by printing a marker line to stdout — `pidge-summary: <one sentence>`. The bridge tees the handler\'s stdout to its own log AND scans it (streamed, never buffered) for the LAST such line; found ⇒ the ack carries that summary (capped ~1000 chars) so `pidge catchup` shows "handled by X: <summary>"; not found ⇒ acked without one (never invented). An LLM handler is instructable in its own prompt: end with `echo "pidge-summary: <what you did>"` (or have the model print it). Only a line that STARTS with the marker counts — incidental output never becomes attribution.',
      'Model-agnostic by construction: --exec \'claude -p "…"\' | \'codex exec "…"\' | \'gemini "…"\' | any script. This is the multi-LLM answer: no dependence on a harness that wakes on background-task exit.',
      'ONE INSTANCE PER CHANNEL: a lockfile keyed by hash(token) (~/.config/pidge/bridge-<hash>.lock, PID-checked so a crashed bridge never wedges the channel) — a second bridge, or a `listen`, on the same channel is REFUSED (exit 2). `listen` now takes the SAME lock while it runs, so the refusal is symmetric in both directions. Read with `pidge catchup` instead.',
      'ONE ROUND, NO DAEMON: `pidge listen --all --exec \'<handler>\'` is the same handler contract (batch on stdin, exit code decides the ack, `pidge-summary:` is the note) for a single round in a turn-based agent — the bridge is that loop made permanent. Start there when you have a harness that can relaunch you.',
      'FAILURES: 401 → narrated + LOCAL alert + LONG jittered backoff (a rotated key only a human can fix — the bridge never dies silent, never re-loops blind); a channel with no healthy round-trip (the exit-4 class) → same alert + long backoff; every retry sleep is jittered. SIGTERM/SIGINT → clean shutdown: the in-flight batch is NOT acked (the lease re-serves it), the lock is released, exit 0.',
      'INSTALL — OPT-IN, a STAND-IN: a bridge is ANOTHER agent answering in your place while nobody is there — install it only when your human explicitly asked for one (staying online as YOURSELF is `pidge online --follow --ndjson --timeout 0` under a session-length watch; see `pidge online --help`). `pidge bridge install --enable` (from your project folder) writes a launchd (macOS) / systemd user (Linux) service that runs this bridge with WorkingDirectory = this project (so a project-scoped key resolves) and the PATH you have now, GENERATES the handler for the model CLI it finds on PATH (`--handler claude|codex|gemini` to choose; `--exec \'<cmd>\'` for your own) plus an editable prompt file (both in the pidge config dir, .bak on rewrite), declares listen_mode=external_daemon (advisory), and with --enable: starts the service, waits for it to be live, then runs a selftest — exit 0 ONLY on PASS, so "online" is measured, never claimed. The generated handler answers a system-only batch (a selftest nonce, a contract change) without calling the model, after checking the model CLI resolves under the daemon — the PATH failure that kills daemons is caught by the selftest, not by your human. Never embeds the key (it stays in the config file; a key that lives only in your shell env is warned about). `pidge bridge status` prints the measured verdict (service · local lock · server consumers); `pidge bridge uninstall` stops and removes the service and re-declares turn_based.',
    ].join('\n'),
    opts: ['exec', 'handler', 'enable', 'handler-timeout', 'interval', 'realtime', 'no-realtime'],
  },
  run: {
    summary: 'execution attribution: mint a per-run SIGNATURE so the human sees WHICH execution spoke (attribution, not a credential).',
    usage: 'pidge run start [--mode M] [--role R] [--label L] [--parent-seal S] [--ephemeral] [--ttl N] [--json]  ·  pidge run end  ·  pidge run status',
    body: [
      'A run is a short, server-issued seal for ONE execution. Every agent-track call then rides `x-pidge-run: $PIDGE_RUN_TOKEN`, so each message you send is stamped with the exact run — the human can tell three cold sessions apart from one continuous mind. It is ATTRIBUTION, never a channel credential: `Authorization: Bearer hld_…` still authenticates; the run token only signs. An expired/invalid run degrades to unsigned (never a 401), and a server that predates runs (/runs 404) turns the feature off for this process — you keep sending unsigned exactly as before.',
      '',
      '`pidge run start` prints two shell-eval lines on stdout — `export PIDGE_RUN_TOKEN=…` and `export PIDGE_RUN_SEAL=…` — so `eval "$(pidge run start --mode interactive --role main)"` arms the whole session; a friendly narration goes to stderr. `--json` prints the raw server body instead. The token is NEVER written to a config file (env-only, disposable). `pidge run end` reads $PIDGE_RUN_TOKEN and ends that run (best-effort, idempotent; no token ⇒ a no-op). `pidge run status` lists the channel\'s live runs (your own marked `*`).',
      '',
      'A subagent/worker inherits attribution by passing `--role subagent --parent-seal $PIDGE_RUN_SEAL`. `pidge bridge` mints its OWN bridge run per handler automatically — you do not run these there.',
    ].join('\n'),
    opts: ['mode', 'role', 'label', 'parent-seal', 'ephemeral', 'ttl', 'json'],
  },
  ack: {
    summary: 'mark messages PROCESSED (green ✓✓) after you handled them, or --renew the lease on a long task.',
    usage: 'pidge ack --up-to <id> | --ids a,b [--renew] [--summary "<what you did>"]',
    body: [
      '--summary attaches a one-line note (WHAT you did) to the acked messages — a successor session sees it as "handled by X: <summary>" in `pidge catchup`. A bare --summary with no value is a usage error, never a silent no-op.',
      '',
      'AN ACK IS A CLAIM THAT THE WORK IS DONE. Ack AFTER the work, never on read, and never as loop plumbing: a message drained by a loop that did nothing (and answered nothing) is a MUTE ack — the server files it as drained, `pidge catchup` can\'t say what happened, and the human is left with a green check that means nothing. In an automated loop the note belongs to the handler that did the work (`pidge listen --exec` / `pidge bridge` take it from the handler\'s `pidge-summary:` line and never invent one) — so if you have nothing to say, you probably have nothing to ack yet.',
    ].join('\n'),
    opts: ['up-to', 'ids', 'renew', 'ack-summary'],
  },
  typing: {
    summary: 'show the human the three dots while you work on a reply — ephemeral, display-only, self-expiring.',
    usage: 'pidge typing [SECONDS|off]',
    body: [
      'Turns ON the "…" indicator in the human\'s Pidge conversation, exactly like the three dots in a chat app. Bare = 60 s; a number sets the window (the server clamps it to 3–300 s and this command tells you when it will); `pidge typing off` (or `0`) clears it now.',
      '',
      'Use it when you have just received a message from your human and you will be working for more than ~15 seconds before you answer — the gap between their message and your reply is where a human decides you are broken. `pidge typing 120` when you know it will be a long one.',
      '',
      'Three properties make it safe to fire and forget: it SELF-EXPIRES (a crashed agent never leaves them staring at dots), ANY real send of yours clears it at the source (they see your words, not the dots), and to EXTEND it you simply run it again. It is advisory and display-only — no push, no history, nothing downstream reads it, and nothing is ever waiting on it.',
      '',
      'Automatic under `pidge bridge` / `pidge listen --exec`: handing a batch to your handler turns the dots on for you (opt out with PIDGE_NO_AUTO_TYPING=1). Exit 0 · 2 error (a server that predates the indicator answers 404 and says so).',
    ].join('\n'),
    opts: [],
  },
  contract: {
    summary: 'DECLARE how you operate — ADVISORY, never policy (the human SEES if you honor it).',
    usage: 'pidge contract set <key>=<value> | pidge contract show',
    body: 'Keys: keep_connection_alive, mirror_in_origin_session, listen_mode=turn_based|persistent|external_daemon, quiet_when_idle. An unknown key / bad value is rejected locally (exit 1).',
    opts: [],
  },
  selftest: {
    summary: 'prove your listener works by ROUND-TRIP: fire a nonce and watch, read-only, for YOUR listener to ack it.',
    usage: 'pidge selftest [--window N]',
    body: 'It fires a nonce onto your own queue and then only WATCHES (GET /selftest/<id>) — it never reads the queue and never acks the nonce itself. PASS (exit 0) therefore means a REAL consumer handled it; with nothing listening it FAILS (exit 2) and says so, instead of grading its own homework. So: start your listener FIRST, then run this. FAIL names the likely cause (nothing listening · live-but-deaf consumer · slower than --window); an unreadable verdict is reported as INCONCLUSIVE, never as a dead listener.',
    opts: ['window'],
  },
  skill: {
    summary: 'write the generated Pidge skill from the live manifest (persistent Pidge knowledge for an AI agent).',
    usage: 'pidge skill install [--target claude|agents|gemini]',
    body: 'Content is the same for every target — only the destination changes: --target claude (default) → .claude/skills/pidge/SKILL.md (a Claude Code skill) · --target agents → AGENTS.md · --target gemini → GEMINI.md (both at the repo root). An existing file whose content differs is backed up first: a file that is NOT a generated pidge skill is irreplaceable, so it goes to <dest>.bak and is never overwritten (<dest>.bak.<timestamp> if that name is taken); a previous GENERATED skill rolls through a single <dest>.bak.prev, so a manifest bump can never litter your repo. NOTE: only the claude target SELF-HEALS — any pidge command silently refreshes a stale .claude skill, but AGENTS.md/GEMINI.md do NOT auto-update; re-run `pidge skill install --target agents|gemini` yourself to refresh them.',
    opts: ['target'],
  },
  catchup: {
    summary: 'READ-ONLY peek at the whole conversation (GET ?history=true) — the thread newest-first, answers included. NEVER consumes.',
    usage: 'pidge catchup [--since ID] [--digest] [--limit N] [--before ID] [--no-download]',
    body: [
      'Prints the channel\'s conversation as JSON (newest first) over GET /messages?history=true&all=true — the WHOLE thread, notification answers included. It NEVER consumes: no ack, no delivered stamp, no visibility lease. Safe to run any number of times.',
      '',
      'Run it to SITUATE yourself at the start of an interactive session on a channel whose messages another runtime (a 24/7 bridge/daemon) is the real consumer of: you learn what has already been said and handled WITHOUT stealing a message out of that consumer\'s queue. The rule is one consumer per channel — if another runtime consumes this channel, use `catchup` to read and NEVER run `listen` (that would double-consume).',
      '',
      '`--since <id>` is an incremental cursor — only messages with an id GREATER than <id> (situate in O(new), not O(whole thread)). It is enforced client-side too, so it holds regardless of server support. catchup remembers the highest id it printed and, on EVERY no-`--since` run, prints the cursor on stderr (stdout stays clean). `--digest` collapses each message to ONE line — `id · kind · <60 chars> · <state>`, where <state> is `handled by X: <summary>` (acked WITH a note), `✓ acked (no note)` (processed, no note — NOT pending), or `PENDING` (genuinely un-processed). The three states matter: a processed-but-noteless row is NOT work to redo. The two flags compose: `pidge catchup --digest --since <last>`.',
      '',
      'Exit 0 = printed (even the empty `{"messages":[]}`) · 2 = error. There is no wait, so no exit 3/4.',
    ].join('\n'),
    opts: ['since', 'digest', 'limit', 'before', 'download', 'no-download', 'download-dir'],
  },
};

// Render the focused help for one command, or the global USAGE when the topic is
// unknown / absent (so `pidge --help` and `pidge help` keep the full overview).
function helpFor(topic) {
  const h = HELP[topic];
  if (!h) return usageText();
  // one question, asked once per render (see src/terminals-installed)
  const t = announceTerminals();
  const pick = (field) => (typeof field === 'function' ? field(t) : field);
  const body = pick(h.body);
  const opts = pick(h.opts);
  const lines = [`pidge ${topic} — ${h.summary}`, '', 'USAGE', `  ${pick(h.usage)}`];
  if (body) { lines.push('', body); }
  if (opts && opts.length) {
    lines.push('', 'OPTIONS');
    for (const key of opts) lines.push(`  ${OPTION_DOCS[key] || key}`);
  }
  lines.push('', 'Run `pidge --help` for all commands; GET $PIDGE_URL/api/v1/manifest is the full contract (Bearer auth).');
  return lines.join('\n');
}

// A machine-minted claim code may legitimately START with '-' (urlsafe base64
// alphabet — ~1 in 64 codes): parseArgs would read it as an unknown OPTION and
// die with a cryptic "ambiguous" error exactly at onboarding. Pull the value
// out by hand when it looks like a code (long base64url token), leaving real
// flags (short, known names) to the normal parser — belt-and-braces for codes
// minted by servers that predate the no-leading-dash mint rule.
const RAW_ARGV = process.argv.slice(2);
let rescuedClaim = null;
{
  const ci = RAW_ARGV.indexOf('--claim');
  const next = ci >= 0 ? RAW_ARGV[ci + 1] : undefined;
  if (next && /^-[A-Za-z0-9_-]{10,}$/.test(next)) {
    rescuedClaim = next;
    RAW_ARGV.splice(ci, 2); // remove the pair; re-added onto v.claim below
  }
}
let parsed;
try {
  parsed = parseArgs({ args: RAW_ARGV, options: OPTIONS, allowPositionals: true });
} catch (e) {
  die(`pidge: ${e.message}\n\n${usageText()}`, 1);
}
const v = parsed.values;
if (rescuedClaim && v.claim === undefined) v.claim = rescuedClaim;
const command = parsed.positionals[0];
// silence the manifest-version nag entirely (per run via --quiet-nag, or
// per environment via PIDGE_QUIET_NAG=1) — for scripts and CI where the nudge is noise.
const QUIET_NAG = !!v['quiet-nag'] || process.env.PIDGE_QUIET_NAG === '1';
// `--quiet` collapses setup/doctor NARRATION to a single status line.
// `note()` prints an informational line only when NOT quiet; WARNINGS and ERRORS
// keep using console.error directly, so --quiet never hides a broken setup.
const QUIET = !!v.quiet;
const note = (msg) => { if (!QUIET) console.error(msg); };

// Help on stdout, exit 0. `pidge <cmd> --help` / `pidge help <cmd>` show the
// FOCUSED help for that command (its synopsis + own flags); `pidge --help` / `help`
// with no command show the global USAGE. No command at all → USAGE on stderr, exit 1.
if (v.help || command === 'help') {
  const topic = command === 'help' ? parsed.positionals[1] : command;
  console.log(helpFor(topic));
  process.exit(0);
}
if (!command) { console.error(usageText()); process.exit(1); }
// `setup` is the command that CREATES the token config — it must run without one.
// `terminal` (Agent Sessions) has its OWN machine-scoped identity slot at
// ~/.config/pidge/terminal/env — never the per-project token resolution.
//
// The no-token message names EXISTING identities BEFORE suggesting re-onboarding.
// Observed live (2026-08-29, a fresh agent's first day): the identity sat on
// disk under agents/<id>/env, the only missing piece was PIDGE_AGENT=<id> in
// the environment — and this exit pointed at `setup --claim <code>`, a
// single-use code the agent had already burned. The real fix costs one env
// var; say so first, and keep re-onboarding as the LAST resort.
function knownAgentEnvIds() {
  const agentsDir = path.join(pidgeBaseDir(), 'agents');
  try {
    return fs.readdirSync(agentsDir)
      .filter((id) => { try { return fs.existsSync(path.join(agentsDir, id, 'env')); } catch { return false; } })
      .sort();
  } catch { return []; }
}
function projectEnvCount() {
  const projectsDir = path.join(pidgeBaseDir(), 'projects');
  try {
    return fs.readdirSync(projectsDir)
      .filter((h) => { try { return fs.existsSync(path.join(projectsDir, h, 'env')); } catch { return false; } })
      .length;
  } catch { return 0; }
}
function noTokenMessage(prefix) {
  const ids = knownAgentEnvIds();
  const projects = projectEnvCount();
  const hints = [];
  if (ids.length)
    hints.push(`this machine HAS per-agent Pidge config(s) — if one is yours, set the env var (EVERY pidge command needs it): ${ids.map((id) => `PIDGE_AGENT=${id}`).join(' · ')}`);
  if (projects && !PROJECT_ROOT)
    hints.push(`${projects} project-scoped config(s) exist — if you onboarded inside a project folder, run pidge from inside it`);
  const recover = hints.length ? `${hints.join('; ')}. Otherwise: ` : '';
  return `${prefix} ${recover}set PIDGE_TOKEN (env var, or PIDGE_TOKEN=… in ~/.config/pidge/env), or onboard with: pidge setup --claim <code> (ask your human for the code: Pidge app → Canais → o canal → copiar prompt de setup)`;
}
if (!TOKEN && command !== 'setup' && command !== 'terminal')
  die(noTokenMessage('pidge: no identity in this environment.'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The shared header set for every channel-key call — carries the per-request
// agent identity, so every verb (notify/ack/inbox/messages/catchup/…)
// self-identifies without a per-call spread.
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...identityHeaders() };

// fetch with a hard timeout: a wedged edge proxy can stall even a
// short POST forever, and a hung ack on the realtime listen path would pin the
// process past its deadline — worse than going deaf. NOTHING in this CLI should
// await a fetch that can't time out. A held long-poll passes its own (larger)
// timeout; everything else uses the 30 s default.
function fetchT(url, opts = {}, timeoutMs = 30000) {
  const ms = parseInt(process.env.PIDGE_FETCH_TIMEOUT || '', 10) || timeoutMs; // test/ops hook
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error(`timeout after ${ms}ms`)), ms);
  // An external signal (the bridge cutting a held long-poll short to YIELD the
  // channel) aborts the same controller — the timeout stays the outer bound.
  const outer = opts.signal;
  if (outer) {
    if (outer.aborted) ctl.abort(outer.reason);
    else outer.addEventListener('abort', () => ctl.abort(outer.reason), { once: true });
  }
  return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
}

// The server advertises its manifest version on every response. When it's newer
// than what this CLI shipped knowing, nudge on stderr — the agent re-reads the
// manifest (whats_new) and learns the new capabilities without polling.
// The newest server manifest additions this CLI narrates natively: ack
// attribution (acked_by_label/handler_summary on history rows — catchup
// narrates them), stale_from_prior_claim, per-request identity headers,
// whoami consumers/provenance, being_handled_by and sent_note. Also spoken
// natively since: presence refresh on a lease renew (v79), the ack's `skipped`
// cursor report (v88) and handled_state:"drained" on history rows (v112) — the
// number lagged three surfaces behind the code and nagged on servers this CLI
// already understood.
// v115-v123 are the manifest's own diet — a CORE plus `?sections=` on demand, a
// byte-capped whats_new window with the archive on its own route, and a
// conditional GET. This CLI speaks all three natively now (the skill generator
// reads the `sections` index, and every generator fetch revalidates with
// If-None-Match), so the "server has NEW capabilities" nag would be shouting
// about work this version already does.
// v124 is onboarding-copy honesty (PIDGE_AGENT stickiness, hello's block, the
// idle-loop wording) — 0.53.1 ships the CLI half of the same finding set, so
// there is nothing new to nag about.
const KNOWN_MANIFEST_VERSION = 128;
// The hand-authored skill SPINE version. BUMP whenever the SKILL.md spine
// (the non-generated prose in installSkill) changes — an existing install whose
// baked marker is older than this self-heals on its next pidge command, so an
// onboarded agent always runs the latest skill without any human action.
const SKILL_REVISION = 29;
// the LAST line of every generated skill. A file that carries the frontmatter
// marker but not this trailer was torn mid-write (partial write / full disk) —
// ensureSkillFresh treats it as stale and re-heals instead of trusting its rev.
const SKILL_END_MARKER = '<!-- pidge-skill-end -->';
const NAG_TTL_MS = 24 * 60 * 60 * 1000; // at most one nag per 24 h
let newsWarned = false;
// the self-heal runs at most ONCE per process (one regeneration, even when
// many commands/poll-ticks call checkManifestNews). Non-stale checks stay cheap +
// repeatable; this only latches once an actual heal is attempted.
let skillHealed = false;

// a tiny per-install state cache (state.json in the SAME dir as the resolved
// env file — per-agent/per-project/shared alike, so pins and stamps live next
// to the identity they belong to). Best-effort: a read-only
// fs just means the throttle falls back to once-per-process. Date is fine here
// (this is the CLI process, not a workflow script).
function stateFilePath() { return path.join(CONFIG_DIR, 'state.json'); }
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFilePath(), 'utf8')) || {}; } catch { return {}; }
}
function writeState(patch) {
  try {
    const next = { ...readState(), ...patch };
    const dir = CONFIG_DIR;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Atomic: write a temp then rename, so a crash/ENOSPC mid-write can't leave
    // a TRUNCATED state.json (which readState would silently treat as {} and
    // drop the E2E pin — fail-open). rename over the live file is atomic on
    // the same fs. (Shallow-merge race across parallel agents on a SHARED dir
    // stays possible; the multi-agent guidance is PIDGE_AGENT, which isolates
    // the dir — a lost pin re-latches on the next confirmed seal anyway.)
    const tmp = path.join(dir, `state.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, stateFilePath());
  } catch { /* best-effort — the nag just won't persist its throttle */ }
}

// ---------------------------------------------------------------------------
// THE MANIFEST CACHE — one entry per (credential, url), so re-reading the
// contract can cost ZERO bytes.
//
// The manifest answers `If-None-Match` with 304 and a STRONG validator: a digest
// of the exact body. That body moves with `?sections=`, with the channel's own
// state and with live counts, so an ETag belongs to ONE (url, credential) pair
// and must never be reused across calls — which is also why the server sends
// `Vary: Accept, Authorization`. A shared cache that ignored the credential
// would be exactly the bug that header exists to prevent.
//
// The skill generator is this feature's best customer: the self-heal runs on
// EVERY command and regenerates whenever the server's manifest version moved,
// and the generator then re-read the whole core — one full manifest per machine
// per bump. Now a bump that did not change the bytes THIS credential sees costs
// a revalidation and nothing else. (A 304 still spends a rate-limit unit:
// revalidating is cheap for you, not free for the server.)
//
// It lives NEXT TO state.json rather than inside it: state.json is parsed on
// every command for the nag throttle, and parking a ~75 KB body in it would make
// every invocation pay for a document it usually does not need.
//
// An older server sends no ETag at all. Then nothing is stored, no
// `If-None-Match` goes out next time, and the behaviour is identical to before
// this existed.
// ---------------------------------------------------------------------------
const SECTIONED_MANIFEST_VERSION = 120; // first manifest served as a CORE + ?sections=
const MANIFEST_CACHE_ENTRIES = 8;       // urls kept per credential (the generator uses one)

function manifestCacheFilePath() { return path.join(CONFIG_DIR, 'manifest-cache.json'); }
// Keyed by WHICH channel is speaking — as a digest, so the cache file never
// carries the key itself.
function manifestCacheKey(base, token) {
  return `${base}|${crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16)}`;
}
function readManifestCache() {
  try { return JSON.parse(fs.readFileSync(manifestCacheFilePath(), 'utf8')) || {}; } catch { return {}; }
}
function putManifestCache(key, url, entry) {
  try {
    const all = readManifestCache();
    // Nothing to store and nothing stored: a server that sends no validator must
    // not leave a cache file behind at all.
    if (!entry && !(all[key] && all[key][url])) return;
    const forKey = { ...(all[key] || {}) };
    if (entry) forKey[url] = entry; else delete forKey[url];
    // Newest few urls per credential — unbounded, this would grow one body per
    // `?sections=` combination anyone ever asked for.
    all[key] = Object.fromEntries(
      Object.entries(forKey).sort((a, b) => String(b[1].at || '').localeCompare(String(a[1].at || ''))).slice(0, MANIFEST_CACHE_ENTRIES),
    );
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const tmp = path.join(CONFIG_DIR, `manifest-cache.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    fs.renameSync(tmp, manifestCacheFilePath());
  } catch { /* best-effort — a miss just means paying the bytes again */ }
}

// Read a manifest url, revalidating against the stored copy when there is one.
// Returns { body, version, notModified }. `version` comes from the header, which
// rides the 304 too — so staleness can be judged without downloading a body.
async function fetchManifestCached(url, headers, key) {
  const cached = (readManifestCache()[key] || {})[url] || null;
  const conditional = { ...headers };
  if (cached && cached.etag) conditional['if-none-match'] = cached.etag;
  let res = await fetchT(url, { headers: conditional });
  let version = parseInt(res.headers.get('x-pidge-manifest-version') || '', 10) || null;
  if (res.status === 304) {
    if (cached && cached.body) return { body: cached.body, version: version || cached.version || null, notModified: true };
    // A 304 we cannot honour (the entry vanished between the read and now) is
    // not an answer — ask again unconditionally instead of failing.
    res = await fetchT(url, { headers });
    version = parseInt(res.headers.get('x-pidge-manifest-version') || '', 10) || null;
  }
  if (res.status !== 200) throw new Error(`manifest read failed (${res.status})`);
  const body = await res.json();
  const etag = res.headers.get('etag');
  putManifestCache(key, url, etag ? { etag, version, at: new Date().toISOString(), body } : null);
  return { body, version, notModified: false };
}

async function checkManifestNews(res) {
  const ver = parseInt(res.headers.get('x-pidge-manifest-version') || '0', 10);
  // the self-heal runs on EVERY command (its own once-guard + cheap
  // first-line read), BEFORE the nag throttle below — it must fire even when the
  // server isn't ahead of KNOWN_MANIFEST_VERSION (a pure spine bump) and even
  // under QUIET_NAG (which only silences the stderr note, never the regenerate).
  await ensureSkillFresh(ver);
  if (QUIET_NAG || newsWarned) return;
  // (c) only when the server is ahead of what THIS CLI knows.
  if (!(ver > KNOWN_MANIFEST_VERSION)) return;
  // throttle: nag at most once per 24 h, and after that window only when the
  // server version actually CHANGED — so 5 calls in a row (or a steady server)
  // don't re-spam. A recent OR unchanged record suppresses; the record's seenAt is
  // stamped only on a real nag (suppressed runs don't roll the 24 h clock forward).
  const last = readState().manifestVersion;
  if (last && last.seenAt) {
    const recent = (Date.now() - Date.parse(last.seenAt)) < NAG_TTL_MS; // (a)
    const unchanged = last.value === ver;                               // (b)
    if (recent || unchanged) { newsWarned = true; return; }
  }
  newsWarned = true;
  writeState({ manifestVersion: { value: ver, seenAt: new Date().toISOString() } });
  // pidge is a THIN PIPE — a server manifest bump almost never needs a CLI
  // release, because --param carries any new /notify field NOW. So the nudge is
  // "new capabilities + how to use them today", NOT "your CLI is stale, update it".
  // The manifest is PUBLIC — the curl reads the catalog without a key
  // (a key only adds your channel's own config). Updating the CLI is the LAST,
  // optional step (only to gain native flags), never the headline.
  console.error(`pidge: the server has NEW capabilities (manifest v${ver}; this CLI knows v${KNOWN_MANIFEST_VERSION}) — pidge is a thin pipe, so you can use any new /notify field RIGHT NOW via --param KEY=VALUE. Read the catalog (whats_new) in the public manifest:  curl $PIDGE_URL/api/v1/manifest  (public; add -H "Authorization: Bearer $PIDGE_TOKEN" to also see your channel's config). Updating the CLI only matters to gain native flags:  npx pidge-cli@latest  (a pinned ref never self-updates). Silence this with --quiet-nag or PIDGE_QUIET_NAG=1.`);
}

// STRUCTURAL self-heal — keep the LOCAL skill current with zero human action.
// The installed .claude/skills/pidge/SKILL.md is written once at onboarding and then
// goes stale silently (a CLI/skill improvement gives an onboarded agent no signal, so
// it keeps running the old skill). This silently regenerates it when EITHER trigger
// fires: this CLI's hand-authored spine moved (SKILL_REVISION > the baked rev) OR the
// server's manifest moved (serverManifestVersion > the baked manifest) — caught from
// the x-pidge-manifest-version header that already rides every response. So the agent's
// NEXT session is always current. Only REFRESHES an existing skill (creating one is
// onboarding's job, never a side effect of an unrelated command), runs at most once per
// process, and is wholly best-effort: any failure is swallowed — a skill refresh must
// NEVER break the user's actual command.
// locate the self-heal marker ONLY where a generated skill ever put it —
// line 1 (the pre-0.15.3 `<!-- pidge-skill … -->` HTML comment, above the `---`)
// or a line inside the OPENING frontmatter block (the 0.15.3+ `# pidge-skill …`
// YAML comment). Body prose mentioning "pidge-skill" is invisible to this scan.
function findSkillMarker(content) {
  const lines = content.split('\n');
  if (lines[0] && lines[0].includes('pidge-skill')) return lines[0];
  if (lines[0] !== '---') return '';
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break; // closing fence — the marker lives above it
    if (lines[i].includes('pidge-skill')) return lines[i];
  }
  return '';
}

// the TWO locations Claude Code loads a `pidge` skill from — the PROJECT skill
// (.claude/skills/pidge under cwd, where `skill install` writes) AND the HOME skill
// (~/.claude/skills/pidge). Old installs (and hand-copies) live in HOME; the
// cwd-only self-heal never visited it, so a live agent ran 3 WEEKS on a home skill
// frozen at an old rev with NO signal. Both are candidates now; each stale copy
// heals IN PLACE. Deduped when cwd IS home (heal once, never twice).
function skillHealCandidates() {
  const rel = path.join('.claude', 'skills', 'pidge', 'SKILL.md');
  const project = path.join(process.cwd(), rel);
  const home = path.join(os.homedir(), rel);
  // The HOME path requires a pidge MARKER before we touch it — an
  // unmarked ~/.claude/skills/pidge/SKILL.md is an AUTHORIAL skill (the human wrote
  // their own), NOT a pidge install gone stale, and must be left alone. The PROJECT
  // path keeps the current semantics (it heals a marker-less file too, since a project
  // skill only exists because pidge/onboarding put it there — covered by an existing
  // test). Deduped when cwd IS home (heal once, and require the marker then).
  if (project === home) return [{ file: project, requireMarker: true }];
  return [{ file: project, requireMarker: false }, { file: home, requireMarker: true }];
}

// Doctor's nudge for a home skill with NO pidge marker. Such a file is
// left untouched by the self-heal (requireMarker) — correct, since it might be
// the human's OWN authored skill — but a PRE-MARKER pidge copy is indistinguishable
// and would silently stay on old doctrine. So doctor SAYS so (never writes). The fix
// it points at is `skill install` run FROM the home dir (the target is cwd-relative),
// which backs the old file up to .bak. Best-effort: a read failure just skips it.
function warnUnmarkedHomeSkill() {
  try {
    const homeSkill = path.join(os.homedir(), '.claude', 'skills', 'pidge', 'SKILL.md');
    // Skip when cwd IS home: that file is the PROJECT skill, already self-healed.
    if (path.join(process.cwd(), '.claude', 'skills', 'pidge', 'SKILL.md') === homeSkill) return;
    if (!fs.existsSync(homeSkill)) return;
    if (findSkillMarker(fs.readFileSync(homeSkill, 'utf8'))) return; // marked ⇒ self-heals; nothing to say
    console.error(`pidge doctor: ⚠️ ${homeSkill} has NO pidge marker — the self-heal won't touch it, so if it's an OLD pidge copy (not a skill you authored) it may be running STALE doctrine with no other signal. To refresh it, run \`pidge skill install\` FROM your home dir (\`cd ~ && npx pidge-cli skill install\`) — the current file is backed up to .bak first. If you AUTHORED it yourself, ignore this.`);
  } catch { /* best-effort — never break doctor over a skill probe */ }
}

// True when the skill at `file` EXISTS and is stale (torn tail, older spine rev, or
// older baked manifest than the server's). A missing file is never stale — the
// self-heal only REFRESHES an existing skill, it never creates one. When
// `requireMarker` is set, a file with NO pidge marker is treated as NOT ours (an
// authorial skill) and left untouched.
function skillIsStale(file, serverManifestVersion, requireMarker = false) {
  if (!fs.existsSync(file)) return false;
  // The marker rides a `# pidge-skill rev=N manifest=M` YAML comment INSIDE
  // the frontmatter (0.15.3+); pre-0.15.3 installs put `<!-- pidge-skill … -->` as line 1.
  // the scan is ANCHORED to those two positions (line 1, or inside the opening `---`
  // block) — a prose line in the body like "see pidge-skill rev=99" must never be read as
  // the marker and suppress a legitimate heal.
  const content = fs.readFileSync(file, 'utf8');
  const markerLine = findSkillMarker(content);
  // no marker + marker required (the HOME path) ⇒ an authorial skill, not ours.
  if (requireMarker && !markerLine) return false;
  const revM = markerLine.match(/rev=(\d+)/);
  const manM = markerLine.match(/manifest=(\d+)/);
  const installedRev = revM ? parseInt(revM[1], 10) : 0;
  const installedManifest = manM ? parseInt(manM[1], 10) : 0;
  // integrity: a generated skill always ends with SKILL_END_MARKER. A marker whose
  // rev looks current but whose trailer is missing = a TORN write (the marker survived
  // on line ~4, the tail didn't) — without this check the tear would read as "fresh"
  // and never heal. Pre-trailer installs lack the trailer too, but their rev < 4 already
  // marks them stale, so the two triggers compose instead of fighting.
  const torn = installedRev > 0 && !content.trimEnd().endsWith(SKILL_END_MARKER);
  if (torn) return true;
  // A file whose spine rev is NEWER than this CLI's was written by a newer CLI.
  // Regenerating it here would DOWNGRADE the doctrine to this binary's older
  // spine — a newer server manifest is not a license to do that (observed live:
  // a 0.46 install "healed" a rev-22 skill down to rev 21 because the manifest
  // had moved). Leave it; the newer CLI heals its own manifest staleness.
  if (installedRev > SKILL_REVISION) return false;
  return SKILL_REVISION > installedRev || (serverManifestVersion || 0) > installedManifest;
}

async function ensureSkillFresh(serverManifestVersion) {
  if (skillHealed) return;
  try {
    // check BOTH project + home; heal every stale copy in ONE pass (a single
    // process may own two stale skills). A silent home heal is safe in multi-project
    // use: the generated content is agent- AND project-agnostic (it bakes no token —
    // only the server's manifest version + fixed doctrine), so any project's
    // invocation regenerates the SAME skill.
    const stale = skillHealCandidates()
      .filter((c) => skillIsStale(c.file, serverManifestVersion, c.requireMarker))
      .map((c) => c.file);
    if (stale.length === 0) return;
    skillHealed = true; // latch BEFORE the network write — attempt the heal at most once per process
    let manifestVersion = null;
    for (const file of stale) {
      const r = await installSkill(BASE, TOKEN, 'claude', file); // silent: writes the file in place
      manifestVersion = r.manifest_version;
    }
    // Respect QUIET_NAG/PIDGE_QUIET_NAG for the note only — we STILL regenerated.
    if (!QUIET_NAG) {
      const many = stale.length > 1;
      console.error(`pidge: refreshed your local Pidge skill${many ? 's' : ''} (rev ${SKILL_REVISION}, manifest v${manifestVersion}${many ? `; ${stale.length} locations incl. ~/.claude` : ''}) — your next session will use ${many ? 'them' : 'it'}.`);
    }
  } catch { /* best-effort — a skill refresh must never break the user's command */ }
}

// ---------------------------------------------------------------------------
// the health ledger of one blocking session (wait/ask/listen). Drives
//   (a) automatic DEGRADE from held ?wait= polls to plain GETs after
//       DEGRADE_AFTER consecutive failures (an edge that kills held responses
//       leaves short requests fine — the channel stays alive, less instant),
//   (b) ONE aggregated deafness line per minute instead of a line per failure,
//   (c) exit code 4 when the session ends with ZERO healthy round-trips —
//       deafness must exit LOUD, not masked as "the human didn't answer".
// ---------------------------------------------------------------------------
const DEGRADE_AFTER = 3;
// env override = a test/ops hook, not a documented knob
const DEGRADED_INTERVAL_S = parseInt(process.env.PIDGE_DEGRADED_INTERVAL || '45', 10);
// "healthy" has a SHELF LIFE. okEver was a LATCH: inside a long --follow
// session one good round-trip at 09:00 still certified the channel at 17:00, so
// a loop that had been deaf since lunch exited 3 ("relaunch the listener") over
// and over. A round-trip proves the channel was alive THEN — this window is how
// long that proof is worth anything. Past it, the cross-round verdict decides.
const HEALTHY_WINDOW_MS = parseInt(process.env.PIDGE_HEALTHY_WINDOW_MS || '', 10) || 10 * 60000;
// When the blocking session began — so a timeout reports the REAL elapsed
// wall-clock, never the configured deadline. A real bug once shipped: a
// WS close 1006 made the CLI exit "timed out after 28800s" when only seconds had
// passed — the number lied. exitTimeout now reports elapsed since this baseline.
// MONOTONIC on purpose: performance.now() can't be skewed by a wall-clock
// change (NTP step / DST) mid-session — a Date.now() delta could, re-opening the
// "wrong number" failure mode the fix exists to kill.
const SESSION_START_MONO = performance.now();
const health = {
  okEver: false, lastOkAt: 0, fails: 0, firstFailAt: 0, lastNoteAt: 0, degraded: false,
  ok() {
    if (this.fails > 0) console.error(`pidge: channel recovered after ${this.fails} consecutive failure(s)`);
    // one healthy round-trip clears the CROSS-ROUND streak too (once per process)
    if (!this.okEver) clearHealthLedger();
    // MONOTONIC (same reason as SESSION_START_MONO): an NTP step must never
    // make a fresh round-trip look ten minutes old, or vice versa.
    this.okEver = true; this.lastOkAt = performance.now();
    this.fails = 0; this.firstFailAt = 0; this.lastNoteAt = 0;
  },
  // Was the channel proven alive RECENTLY? The exit-3 path ("no answer yet —
  // relaunch") is only honest on a channel that answered inside the window.
  healthyRecently() { return this.lastOkAt > 0 && (performance.now() - this.lastOkAt) <= HEALTHY_WINDOW_MS; },
  fail(what) {
    this.fails++;
    if (!this.firstFailAt) { this.firstFailAt = Date.now(); this.lastNoteAt = Date.now(); }
    if (!this.degraded && this.fails >= DEGRADE_AFTER) {
      this.degraded = true;
      console.error(`pidge: ${this.fails} consecutive failures on held polls — degraded to plain GETs every ~${DEGRADED_INTERVAL_S}s (channel stays ALIVE, just less instant). Latest: ${what}`);
    } else if (this.fails === 1 || Date.now() - this.lastNoteAt >= 60000) {
      this.lastNoteAt = Date.now();
      const mins = Math.round((Date.now() - this.firstFailAt) / 60000);
      console.error(`pidge: deaf for ${mins} min — ${this.fails} consecutive failure(s) (latest: ${what})`);
    }
  },
  async exitTimeout(message, hint, nudge) {
    // REAL elapsed wall-clock — never the configured deadline (the
    // "timed out after 28800s" lie). If only seconds passed, the number says so.
    const elapsed = Math.round((performance.now() - SESSION_START_MONO) / 1000);
    if (this.healthyRecently()) {
      // a healthy channel that heard nothing on exit 3 might not be empty —
      // a message can be UNDER A VISIBILITY LEASE from another read (a selftest,
      // a crashed listener, a bridge), invisible until the lease lapses. Point at
      // the read-only diagnostic that sees the whole queue regardless. Only on
      // exit 3 (channel proven healthy) — on exit 4 (channel broken) it's noise.
      // `nudge` (listen-only, suppressed under --follow) rides the SAME gate:
      // "relaunch the listener" is only true advice on a channel proven healthy.
      console.error(`pidge: ${message} after ${elapsed}s (= 'no answer yet', not a failure)`);
      if (hint) console.error(`pidge: ${hint}`);
      if (nudge) console.error(`pidge: ${nudge}`);
      process.exit(3);
    }
    // No healthy round-trip inside the window — either none at all this round,
    // or one so old (a long --follow session) that it certifies nothing now.
    // One round is NOT a verdict either way: the recommended loop is one round
    // per process, so the streak lives in a file across rounds (cleared by any
    // healthy round-trip), and before accusing anyone we ask the ONE question
    // that separates the two opposite diagnoses: can this host reach the server?
    const prior = readHealthLedger();
    const streak = (prior ? prior.streak : 0) + 1;
    const firstAt = prior ? prior.first_at : Date.now();
    writeHealthLedger({ streak, first_at: firstAt, last_at: Date.now() });
    const spanMs = Date.now() - firstAt;
    const spanMin = Math.max(1, Math.round(spanMs / 60000));
    const up = await probeServerUp();
    if (up) {
      // The server is there — but is the KEY? A rejected key on the REALTIME
      // path never reaches the polling 401 (the handshake just closes, and a
      // short round dies before the fallback), so a rotated key read as
      // "transport blip" rounds forever. One authenticated probe settles it.
      try {
        const who = await fetchT(`${BASE}/api/v1/whoami`, { headers: { authorization: `Bearer ${TOKEN}` } }, 8000);
        if (who.status === 401 || who.status === 403) dieKeyRejected('listen/wait', who.status);
      } catch { /* network flapped mid-verdict — the streak logic below owns it */ }
    }
    if (!up) {
      // Can't reach ANYTHING — that's this host's network (lid just opened,
      // wifi flap, VPN), not the channel. Escalating would be crying wolf...
      if (streak < HEALTH_STREAK_ROUNDS || spanMs < HEALTH_LOCAL_SPAN_MS) {
        console.error(`pidge: ${message} after ${elapsed}s — zero healthy round-trips this round, and the server's /up probe is unreachable too: this HOST's network looks down (laptop waking? wifi flap?), not the channel. Reconnect and relaunch — not escalating (dead round ${streak} of ${HEALTH_STREAK_ROUNDS} before this becomes one).`);
        process.exit(3);
      }
      // ...until it lasts long enough that the human must hear it — through
      // your harness/session, since pidge itself can't fly with no network.
      clearHealthLedger();
      console.error(`pidge: ${message} after ${elapsed}s — NO network from this host for ~${spanMin} min (${streak} dead rounds; even the /up probe fails). The channel may be fine — the HOST is offline. Surface this to your human through your own session; pidge can't carry it.`);
      process.exit(4);
    }
    if (streak < HEALTH_STREAK_ROUNDS || spanMs < HEALTH_STREAK_SPAN_MS) {
      console.error(`pidge: ${message} after ${elapsed}s — zero healthy round-trips this round, but the server answers /up: a transport blip, not a verdict (dead round ${streak} of ${HEALTH_STREAK_ROUNDS} over ${Math.round(spanMs / 1000)}s; escalation needs ${HEALTH_STREAK_ROUNDS} rounds across ${HEALTH_STREAK_SPAN_MS / 1000}s). Relaunch the listener.`);
      process.exit(3);
    }
    clearHealthLedger(); // escalated once — the next escalation must earn a fresh streak
    console.error(`pidge: ${message} after ${elapsed}s — and NOT ONE healthy round-trip in ${streak} consecutive rounds over ~${spanMin} min, while the server answers /up: the CHANNEL/API path looks broken, not the human ignoring you and not your network. Surface this to your human.`);
    process.exit(4);
  },
};

// ---------------------------------------------------------------------------
// Realtime: a minimal ActionCable client over the runtime's native
// WebSocket (Node ≥22). The token rides an extra Sec-WebSocket-Protocol entry
// (the browser-style API can't set headers). The WS is a WAKE-UP + payload
// channel only — every durable read (message backlog, chosen_action) still
// goes over HTTP, so a dropped socket costs latency, never data.
// ---------------------------------------------------------------------------
function wantRealtime() {
  if (v['no-realtime']) return false;
  if (typeof WebSocket !== 'function') {
    if (v.realtime) console.error('pidge: --realtime needs a native WebSocket (Node ≥22) — falling back to polling');
    return false;
  }
  return true;
}

// Speak just enough of the protocol: welcome → subscribe → confirm → frames.
// The server pings every ~3 s — that heartbeat is the liveness check (silence
// >15 s ⇒ the socket is dead even if TCP hasn't noticed; close → caller
// reconnects). Returns {close()} or null if the constructor itself failed.
function cableSubscribe({ channel, params = {}, onUp, onFrame, onDown, base = BASE, token = TOKEN }) {
  let ws;
  try {
    ws = new WebSocket(base.replace(/^http/, 'ws') + '/cable', ['actioncable-v1-json', token]);
  } catch (e) { onDown(e.message); return null; }
  // the per-request identity (fingerprint/label) rides the subscribe
  // params on the REAL consume subscribes (listen/wait/bridge) so the server can
  // attribute presence; the doctor probe passes none (no phantom consumer).
  const identifier = JSON.stringify({ channel, ...params });
  let lastBeat = Date.now();
  let closed = false;
  const die = (why) => {
    if (closed) return; closed = true;
    clearInterval(beatCheck);
    if (appBeat) clearInterval(appBeat);
    try { ws.close(); } catch { /* already closing */ }
    onDown(why);
  };
  const beatCheck = setInterval(() => {
    if (Date.now() - lastBeat > 15000) die('heartbeat lost (server gone?)');
  }, 5000);
  ws.onopen = () => ws.send(JSON.stringify({ command: 'subscribe', identifier }));
  // Client-initiated liveness beat (server ≥ v112): the server refreshes
  // "listening now" ONLY while the CLIENT proves it's alive — a frozen process
  // (laptop lid, suspended container) keeps its TCP socket open, so the server's
  // own timer used to keep the light on for a consumer that couldn't hear.
  // Sent every 30 s on ConversationChannel; InboxChannel has no consumer
  // presence to renew. Transport pings still monitor both subscriptions.
  let appBeat = null;
  const startAppBeat = () => {
    if (channel !== 'ConversationChannel' || appBeat) return;
    appBeat = setInterval(() => {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ command: 'message', identifier, data: JSON.stringify({ action: 'beat' }) })); } catch { /* dying socket — onclose handles it */ }
      }
    }, 30000);
    if (appBeat.unref) appBeat.unref();
  };
  ws.onmessage = (e) => {
    lastBeat = Date.now();
    let f; try { f = JSON.parse(e.data); } catch { return; }
    if (f.type === 'ping' || f.type === 'welcome') return;
    if (f.type === 'confirm_subscription') { startAppBeat(); onUp && onUp(); return; }
    if (f.type === 'reject_subscription') { die('subscription rejected (bad token?)'); return; }
    if (f.identifier === identifier && f.message) onFrame(f.message);
  };
  ws.onerror = () => { /* onclose follows with the code */ };
  // the reconnect log prefixes "realtime socket …", so the reason must NOT
  // start with "socket" again (was "socket socket closed (1006)").
  ws.onclose = (e) => die(`closed (${e.code})`);
  return {
    close: () => { closed = true; clearInterval(beatCheck); if (appBeat) clearInterval(appBeat); try { ws.close(); } catch { /* noop */ } },
  };
}

// Run one WS subscription session until the deadline / an unrecoverable WS
// problem, reconnecting with backoff in between (a deploy = seconds of gap; the
// criterion: hours-long listens must SURVIVE it). onUp/onFrame get a
// `finish(reason)` to end the session (e.g. when the answer landed over HTTP).
// Resolves 'deadline' | 'ws-unavailable'.
async function cableSession({ channel, params = {}, deadline, onUp, onFrame }) {
  let wsFails = 0;      // consecutive drops SINCE the last healthy connect — the degrade gate
  let wsReconnects = 0; // monotonic total this session — what we DISPLAY (never reset)
  while (Date.now() < deadline) {
    const outcome = await new Promise((resolve) => {
      let sub = null;
      let settled = false;
      const finish = (reason) => {
        if (settled) return; settled = true;
        clearTimeout(guard);
        if (sub) sub.close();
        resolve(reason);
      };
      // Clamp: --follow --timeout 0 sets a far-future deadline, and a delay past
      // 2^31-1 ms makes Node fire the timer at once with a TimeoutOverflowWarning.
      const guard = setTimeout(() => finish('deadline'), Math.min(2147483647, Math.max(0, deadline - Date.now())));
      sub = cableSubscribe({
        channel,
        params,
        onUp: () => { wsFails = 0; onUp(finish); },
        onFrame: (frame) => onFrame(frame, finish),
        onDown: (why) => finish(`down: ${why}`),
      });
      if (!sub) finish('down: no socket');
    });
    if (outcome === 'deadline') return 'deadline';
    if (!outcome.startsWith('down: ')) return outcome; // caller-driven finish (e.g. 'answered')
    wsFails++;
    wsReconnects++;
    const MAX_WS_FAILS = 4; // then fall back to polling for the rest of the session
    if (wsFails >= MAX_WS_FAILS) return 'ws-unavailable';
    // env override = a test/ops hook (keeps the forced-1006 degrade test fast)
    const base = parseInt(process.env.PIDGE_WS_BACKOFF_MS || '2000', 10) || 2000;
    const backoff = Math.min(base * wsFails, base * 5);
    // show the MONOTONIC reconnect count, not the consecutive-fail counter —
    // a connect→drop FLAP resets wsFails (onUp forgives a healthy connect), so the
    // old "attempt 1/4" repeated forever and looked like a stuck loop. The cumulative
    // "#N" visibly advances; the polling fallback is spelled out so the ceiling is clear.
    console.error(`pidge: realtime socket ${outcome.replace('down: ', '')} — reconnecting in ${Math.round(backoff / 1000)}s (reconnect #${wsReconnects}; falls back to polling after ${MAX_WS_FAILS} consecutive failures)`);
    await sleep(backoff);
  }
  return 'deadline';
}

// doctor's realtime probe — the failure class an HTTP-only doctor can't
// see (an edge killing held responses, a proxy refusing the upgrade). A
// green HTTP doctor can coexist with a `listen` that's deaf over the socket.
// Open ONE ConversationChannel subscription on /cable (reusing cableSubscribe —
// the same client `listen` holds), wait for confirm_subscription, close — all
// within ≤5 s. Degrade is the CONTRACT, not a failure: an unavailable WS just
// means `listen` polls (works, less instant), so this NEVER changes the exit
// code — it only lets the agent KNOW before the first deaf listen. Resolves
// {ok, ms} | {ok:false, reason} | {skipped:true} (Node <22 has no native
// WebSocket — same gate as wantRealtime, :373).
function probeRealtime(base, token) {
  if (typeof WebSocket !== 'function') return Promise.resolve({ skipped: true });
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let sub = null;
    const done = (result) => {
      if (settled) return; settled = true;
      clearTimeout(guard);
      if (sub) sub.close();
      resolve(result);
    };
    const guard = setTimeout(() => done({ ok: false, reason: 'no confirm_subscription within 5s' }), 5000);
    sub = cableSubscribe({
      channel: 'ConversationChannel',
      base,
      token,
      onUp: () => done({ ok: true, ms: Date.now() - started }),
      onFrame: () => { /* a stray frame during the probe is irrelevant */ },
      onDown: (why) => done({ ok: false, reason: why }),
    });
    if (!sub) done({ ok: false, reason: 'WebSocket constructor failed' });
  });
}

// a custom action id is lowercase letters, digits and underscore (≤40) —
// the same rule the server enforces, validated LOCALLY so a typo fails fast.
const CUSTOM_ACTION_ID = /^[a-z0-9_]{1,40}$/;

// --custom-action "id:label[:destructive][:confirm][:biometric][:terminal]"
function customActionFromSpec(spec) {
  const [id, label, ...flags] = spec.split(':');
  // Fail fast locally — the rule is stable and the server 422 costs a
  // round-trip an agent then has to interpret.
  if (!CUSTOM_ACTION_ID.test(id || '')) {
    die(`pidge: --custom-action id ${JSON.stringify(id)} is invalid — lowercase letters, digits and underscore only (^[a-z0-9_]{1,40}$)`, 1);
  }
  const ca = { id, label };
  if (flags.includes('destructive')) ca.style = 'destructive';
  if (flags.includes('confirm')) ca.confirm = true;
  if (flags.includes('biometric')) ca.biometric = true;
  if (flags.includes('terminal')) ca.terminal = true;
  return ca;
}

// one item of a JSON --actions array → a custom_actions spec. Validates
// {id,label} and passes the optional gating fields the server understands.
function customActionFromJson(item, i) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    die(`pidge: --actions[${i}] must be an object with "id" and "label" (e.g. {"id":"approve","label":"Aprovar agora"})`, 1);
  }
  if (typeof item.id !== 'string' || !CUSTOM_ACTION_ID.test(item.id)) {
    die(`pidge: --actions[${i}].id ${JSON.stringify(item.id)} is invalid — lowercase letters, digits and underscore only (^[a-z0-9_]{1,40}$)`, 1);
  }
  if (typeof item.label !== 'string' || !item.label.trim()) {
    die(`pidge: --actions[${i}].label is required — a non-empty string`, 1);
  }
  const ca = { id: item.id, label: item.label };
  if (item.sf_symbol !== undefined) ca.sf_symbol = item.sf_symbol;
  if (item.style !== undefined) ca.style = item.style;
  if (item.destructive) ca.style = 'destructive';
  if (item.confirm !== undefined) ca.confirm = !!item.confirm;
  if (item.biometric !== undefined) ca.biometric = !!item.biometric;
  if (item.terminal !== undefined) ca.terminal = !!item.terminal;
  return ca;
}

// ---------------------------------------------------------------------------
// E2E wire layer — send/receive integration of wire format v1 (shared with the
// server and the iOS app).
// SEND: with a valid PIDGE_SECRET AND an E2E channel (whoami says — never a
// guess), the content fields leave this machine as envelopes with enc:"v1"+kf;
// otherwise the send is the clear send of always (the server accepts-and-marks
// — a missing secret must NEVER block a notification).
// RECEIVE: every read path gates on the EXPLICIT `enc` flag (never on sniffing
// the "v1:" prefix). Inside a sealed context, an envelope MUST open — a kf that
// isn't ours / a failed tag / a missing AAD anchor is a PRECISE error and the
// field is BLANKED (base64 never reaches the terminal); a value
// that is NOT an envelope is readable text and passes through untouched (a
// built-in action label, or a clear reply typed on a pre-E2E app — the same
// accept-and-mark honesty the iOS app shows).
// ---------------------------------------------------------------------------
// `copy` (tap-to-copy — the field MADE for tokens/codes) and `url`
// (deep link) joined the seal. AAD field names are the payload names verbatim
// ("copy"/"url") — the iOS tap paths decrypt with the same names.
const E2E_CONTENT_FIELDS = ['title', 'subtitle', 'body', 'body_markdown', 'copy', 'url'];
const isEnvelope = (s) => typeof s === 'string' && /^v\d+:/.test(s);

// Parse PIDGE_SECRET ONCE per process. null = absent or invalid (invalid warns
// loudly — the send degrades to clear and the app marks it "⚠️ sem criptografia").
let e2eMat; // undefined = not yet computed
function e2eKeyMaterial() {
  if (e2eMat !== undefined) return e2eMat;
  try {
    const key = e2eParseSecret(e2eLoadSecret());
    e2eMat = key ? { key, kf: e2eKeyFingerprint(key) } : null;
  } catch (e) {
    console.error(`pidge: WARNING — PIDGE_SECRET is INVALID (${e.message}). E2E is OFF for this run: sends go CLEAR (the app marks them "⚠️ sem criptografia") and sealed content can't be opened. Fix: the app's Connect screen shows a separate TERMINAL step that writes PIDGE_SECRET to ~/.config/pidge/env — ask your human to run THAT (never paste the secret in chat); \`pidge doctor\` then confirms it.`);
    e2eMat = null;
  }
  return e2eMat;
}

// The channel's PUBLIC id + e2e_enabled, from whoami — the AAD binds to the id,
// and e2e_enabled is the ONLY thing that turns sealing on (a secret pointing at
// a non-E2E channel is an orphan: send clear; `pidge doctor` warns). Cached per
// process; a failure is NOT cached so a later call may retry.
let e2eChannelCache = null;
async function e2eChannelInfo() {
  if (e2eChannelCache) return e2eChannelCache;
  const { res, data } = await fetchWhoami();
  if (res.status !== 200 || !data.channel) throw new Error(`whoami answered ${res.status}`);
  e2eChannelCache = {
    id: data.channel.id,
    e2eEnabled: !!data.channel.e2e_enabled,
    // media gate: sealed media is SAFE on this channel — E2E on AND every
    // deliverable device runs a build that OPENS sealed blobs. Absent on an
    // older server ⇒ false (never seal into the void).
    e2eMediaReady: !!data.channel.e2e_media_ready,
  };
  return e2eChannelCache;
}

// One stderr line per DISTINCT reason per process — a 50-row backlog sealed
// with another key is one loud line, not 50.
const e2eNoted = new Set();
function e2eNote(msg) {
  if (e2eNoted.has(msg)) return;
  e2eNoted.add(msg);
  console.error(`pidge: E2E — ${msg}`);
}

// The precise pre-flight reason a sealed context can't be opened, or null when
// the key material looks right and the decrypt should be attempted.
function e2eSealedError(enc, theirKf) {
  if (enc !== 'v1') return `sealed with an unknown envelope version ${JSON.stringify(enc)} — this CLI speaks v1 (update pidge-cli)`;
  const mat = e2eKeyMaterial();
  if (!mat) return 'sealed, but no (valid) PIDGE_SECRET is configured — the app\'s Connect screen shows a separate TERMINAL step that writes PIDGE_SECRET to ~/.config/pidge/env; ask your human to run THAT (never paste the secret in chat), then `pidge doctor` confirms it';
  if (theirKf && theirKf !== mat.kf) return `sealed with ANOTHER key (its kf ${theirKf}, your PIDGE_SECRET's kf ${mat.kf}) — your token and secret likely belong to different channels; ask your human to run THIS channel's terminal step from the app's Connect screen (never paste the secret in chat)`;
  return null;
}

// Open ONE value found inside a sealed context (the enc flag gated us in).
// Returns the plaintext; the value UNCHANGED when it isn't an envelope
// (readable text); or null after reporting a precise reason via onError.
function e2eOpenValue({ enc, kf, channelId, cid, field, value, onError }) {
  if (!isEnvelope(value)) return value;
  const reason = e2eSealedError(enc, kf)
    || (!cid && 'sealed but the row carries NO correlation_id (the AAD anchor) — an old server, or a bug: it can never be decrypted')
    || (channelId == null && 'sealed but the channel id is unknown (whoami failed) — the AAD needs it; retry when the server is reachable')
    || null;
  if (reason) { onError(reason); return null; }
  try {
    return e2eDecryptField(e2eKeyMaterial().key, e2eAad(channelId, cid, field), value);
  } catch (e) {
    onError(`${field} failed to open: ${e.message}`);
    return null;
  }
}

// local pin — the anti-downgrade latch. The seal decision used to trust
// server-served flags in BOTH directions: a lying/compromised server answering
// e2e_enabled=false (or just failing whoami) made this CLI send PLAINTEXT
// despite holding the key — breaking the feature's own threat model ("protects
// against the server"). So: the first CONFIRMED sealed context stamps
// state.json (same per-agent dir as the env file), and from then on a clear
// send here is REFUSED (exit 2) unless the human unpins LOCALLY with
// PIDGE_E2E=off (env var or the env file). A server response alone can never
// unpin — that's the whole point.
function e2eOverrideOff() {
  // Fresh read of the resolved file — the unpin override must belong to the
  // SAME scope as the pin it disables (never a stale/other-scope FILE_ENV).
  return String(process.env.PIDGE_E2E || readEnvFile(CONFIG_FILE).PIDGE_E2E || '').toLowerCase() === 'off';
}
// The pin is keyed by a HASH of the channel token — per CHANNEL, not per
// install (one machine can drive an E2E channel and a clear one from the same
// config dir), resolvable with ZERO server help (a whoami-failed refusal must
// still find it), and the token itself never lands in state.json. A re-claim
// rotates the token ⇒ the new token starts unpinned and re-latches on its
// first confirmed seal (the stale entry is inert).
// The channel key — hash(token), resolvable with ZERO server help and never
// storing the token itself in state.json. The E2E pin and the catchup
// cursor both key their state.json entries by THIS, for the same reason:
// one machine can drive two channels from the same config dir, so a per-install
// (unkeyed) entry would let channel A's state leak into channel B.
function channelKeyFor(token) {
  return token ? crypto.createHash('sha256').update(String(token)).digest('base64url').slice(0, 12) : null;
}
function e2ePinKeyFor(token) {
  return channelKeyFor(token);
}
function e2ePinned() {
  const k = e2ePinKeyFor(TOKEN);
  const pins = readState().e2ePins;
  const p = k && pins && pins[k];
  return !!(p && p.v === 1);
}
function e2eStampPin(kf) {
  const k = e2ePinKeyFor(TOKEN);
  if (!k) return;
  const pins = readState().e2ePins || {};
  const cur = pins[k];
  if (cur && cur.v === 1 && cur.kf === kf) return;
  // Spread `cur`: a re-key (new kf, same token) must PRESERVE the media latch
  // — dropping `media:true` here would re-arm the exact server-driven
  // media-downgrade lever the pin exists to deny. e2eStampMediaPin spreads too.
  writeState({ e2ePins: { ...pins, [k]: { ...cur, v: 1, kf, at: new Date().toISOString() } } });
  e2eNote('channel PINNED as E2E on this machine — clear sends here are now refused even if the server claims E2E is off. Genuine toggle-off ⇒ unpin locally with PIDGE_E2E=off (env var or the env file).');
}
const E2E_UNPIN_HINT = 'If your human GENUINELY turned E2E off in the app, unpin locally: PIDGE_E2E=off (env var, or a line in the env file next to PIDGE_TOKEN). A server response alone can never unpin.';

// --- Sealed MEDIA — the deploy gate + its own pin latch. --------------------
// Media sealing is gated on whoami's e2e_media_ready (an iOS build that can
// OPEN sealed blobs is on all the human's devices) because a sealed photo on
// an old device is a broken photo. But a server-served gate is a downgrade
// lever (the same class the E2E pin refuses), so the FIRST confirmed sealed-media send latches
// `media:true` into the channel's pin — from then on a clear-media send is
// REFUSED unless the human sets PIDGE_E2E_MEDIA=off locally. PIDGE_E2E_MEDIA=on
// force-seals (testing before the iOS wave); PIDGE_E2E=off keeps voiding
// everything E2E, media included.
function e2eMediaOverride() {
  // Fresh read of the resolved file — same scope rule as e2eOverrideOff.
  const raw = String(process.env.PIDGE_E2E_MEDIA || readEnvFile(CONFIG_FILE).PIDGE_E2E_MEDIA || '').toLowerCase();
  return raw === 'on' || raw === 'off' ? raw : null;
}
// Pure (exported for tests): should this send seal its media?
function e2eMediaSealDecision({ sealingActive, ready, override }) {
  if (!sealingActive) return false;
  if (override === 'off') return false;
  if (override === 'on') return true;
  return !!ready;
}
function e2eMediaPinned() {
  const k = e2ePinKeyFor(TOKEN);
  const pins = readState().e2ePins;
  const p = k && pins && pins[k];
  return !!(p && p.v === 1 && p.media);
}
function e2eStampMediaPin() {
  const k = e2ePinKeyFor(TOKEN);
  if (!k) return;
  const pins = readState().e2ePins || {};
  const cur = pins[k] || {};
  if (cur.v === 1 && cur.media) return;
  writeState({ e2ePins: { ...pins, [k]: { ...cur, v: 1, media: true, at: cur.at || new Date().toISOString() } } });
  e2eNote('channel PINNED as SEALED-MEDIA on this machine — a send whose media would ride CLEAR here is now refused, even if the server claims the media gate closed. Genuine downgrade (a legacy device joined, or E2E off) ⇒ PIDGE_E2E_MEDIA=off locally.');
}
const E2E_MEDIA_UNPIN_HINT = 'If the downgrade is GENUINE (a legacy device joined the account, or your human turned E2E off), unpin media locally: PIDGE_E2E_MEDIA=off (env var, or a line in the env file). A server response alone can never unpin.';

// Attachment filenames are attacker-influenceable — sanitize before ANY disk
// write: no separators, no dot-leading names, bounded length. null = unusable
// (the caller falls back to attachment-<id>). Exported for tests.
function sanitizeAttachmentName(name) {
  if (typeof name !== 'string') return null;
  const base = path.basename(name.replaceAll('\\', '/')).replace(/^\.+/, '').trim();
  if (!base) return null;
  return base.slice(0, 255);
}

// The media plan for THIS send, decided BEFORE any bytes leave the machine:
//   null                       — clear media (the path of always), or no media;
//   { key, channelId, cid }    — seal each local blob under these + media_enc.
// Refusals (exit 2) happen HERE, pre-upload, so a downgrading/lying server
// never receives clear bytes or a real filename (the pin-refuses-before-upload rule).
async function e2eMediaPlan(payload) {
  const hasMedia = v.image !== undefined || v.file !== undefined;
  if (!hasMedia) return null;
  const mediaPinned = e2eMediaPinned() && e2eMediaOverride() !== 'off' && !e2eOverrideOff();
  const mat = e2eKeyMaterial();
  if (!mat) {
    if (mediaPinned) die(`pidge: REFUSING to send CLEAR MEDIA (exit 2) — this channel is locally PINNED as sealed-media but PIDGE_SECRET is missing/invalid. Fix the secret (the app's Connect screen has the terminal step). ${E2E_MEDIA_UNPIN_HINT}`, 2);
    return null;
  }
  let ch;
  try {
    ch = await e2eChannelInfo();
  } catch (e) {
    if (mediaPinned) die(`pidge: REFUSING to send CLEAR MEDIA (exit 2) — this channel is locally PINNED as sealed-media and the server won't confirm its media gate (${e.message}); retry when it's reachable. ${E2E_MEDIA_UNPIN_HINT}`, 2);
    return null; // the text-seal path warns about the whoami failure already
  }
  const willSeal = e2eMediaSealDecision({
    sealingActive: ch.e2eEnabled && !e2eOverrideOff(),
    ready: ch.e2eMediaReady,
    override: e2eMediaOverride(),
  });
  if (!willSeal) {
    if (mediaPinned) die(`pidge: REFUSING to send CLEAR MEDIA (exit 2) — this machine PINNED the channel as sealed-media but this send's media would ride CLEAR (the server says ${ch.e2eEnabled ? 'the media gate is closed — e2e_media_ready:false' : 'the channel is not E2E'}). ${E2E_MEDIA_UNPIN_HINT}`, 2);
    return null;
  }
  // A public-URL --image can't be sealed (we don't hold its bytes' custody) and
  // a mixed send (media_enc + a clear image_url) would make the phone try to
  // unseal clear bytes — the broken photo the gate exists to prevent. Refuse.
  if (v.image !== undefined && !fs.existsSync(v.image)) {
    die('pidge: --image with a URL/ref cannot ride a SEALED-media send — the bytes must be sealed on this machine. Download the image and pass a local path (or PIDGE_E2E_MEDIA=off to send this one clear).', 2);
  }
  if (!payload.correlation_id) payload.correlation_id = crypto.randomUUID();
  return { key: mat.key, channelId: ch.id, cid: payload.correlation_id };
}

// SEND-side sealing, called by doNotify on the final payload. Mutates it:
// content fields + custom-action LABELS become envelopes (action IDs stay
// clear — the action contract runs on ids), enc:"v1" + kf ride alongside, and
// the correlation_id is ALWAYS minted client-side (the AAD needs it BEFORE the
// server ever sees the payload).
// Server-side length caps on the columns these fields land in
// — the AES-GCM+base64url envelope inflates ~4/3 + a prefix, so a value that
// fits in CLEAR can 422 once sealed. We check locally with a message that names
// the CAUSE (the server's bare "too long" wouldn't tell the agent it was E2E).
const E2E_SEALED_FIELD_CAPS = { copy: 512, url: 1024 };

// The refusal MESSAGE when a PINNED channel would otherwise send CLEAR, or null
// when the send may proceed (sealed, or legitimately clear on an unpinned
// channel). Shared by the pre-upload preflight AND e2eMaybeSeal so the two can
// never diverge — and so the pin can REFUSE before any bytes leave the machine
// (a real bug once: media upload used to precede the gate). whoami is cached,
// so calling this twice per send is cheap; when NOT pinned it returns early and
// pays no whoami, keeping the common clear path fast.
async function e2eRefusalIfPinned() {
  if (!(e2ePinned() && !e2eOverrideOff())) return null;
  if (!e2eKeyMaterial())
    return `pidge: REFUSING to send CLEAR (exit 2) — this channel is locally PINNED as E2E but PIDGE_SECRET is missing/invalid. Fix the secret (the app's Connect screen has the terminal step that writes it). ${E2E_UNPIN_HINT}`;
  try {
    const ch = await e2eChannelInfo();
    if (!ch.e2eEnabled)
      return `pidge: REFUSING to send CLEAR (exit 2) — the server says this channel is NOT E2E, but this machine PINNED it as E2E (a lying/compromised server could be downgrading you to plaintext). ${E2E_UNPIN_HINT}`;
  } catch (e) {
    return `pidge: REFUSING to send CLEAR (exit 2) — this channel is locally PINNED as E2E and the server won't confirm its E2E state (${e.message}). A server that can't answer whoami must not be able to downgrade you to plaintext; retry when it's reachable. ${E2E_UNPIN_HINT}`;
  }
  return null;
}

// Called by doNotify BEFORE resolveMedia: on a pinned channel that would
// downgrade to clear, die HERE — so a compromised server never receives the
// upload bytes/filename (which ride clear when media sealing is off) in the first place.
async function e2ePreflightRefusal() {
  const reason = await e2eRefusalIfPinned();
  if (reason) die(reason, 2);
}

async function e2eMaybeSeal(payload) {
  const reason = await e2eRefusalIfPinned();
  if (reason) die(reason, 2); // pinned + would-be-clear (the preflight already caught this pre-upload; belt and suspenders)
  const mat = e2eKeyMaterial();
  if (!mat) return; // unpinned + no secret ⇒ clear send is the contract
  let ch;
  try {
    ch = await e2eChannelInfo();
  } catch (e) {
    console.error(`pidge: WARNING — couldn't confirm the channel's E2E state (${e.message}); sending CLEAR (an E2E channel accepts-and-marks it "⚠️ sem criptografia")`);
    return;
  }
  if (!ch.e2eEnabled) return; // unpinned orphan secret — clear send; `pidge doctor` warns
  if (!payload.correlation_id) payload.correlation_id = crypto.randomUUID();
  const seal = (field, value) =>
    e2eEncryptField(mat.key, e2eAad(ch.id, payload.correlation_id, field), String(value));
  for (const f of E2E_CONTENT_FIELDS) {
    if (payload[f] !== undefined && payload[f] !== null && payload[f] !== '') payload[f] = seal(f, payload[f]);
  }
  for (const ca of payload.custom_actions || []) {
    if (E2E_NEVER_SEAL_LABEL_IDS.has(ca.id)) continue; // builtin/system id — the label rides CLEAR
    if (typeof ca.label === 'string' && ca.label !== '') ca.label = seal(`action_label_${ca.id}`, ca.label);
  }
  for (const [f, cap] of Object.entries(E2E_SEALED_FIELD_CAPS)) {
    if (typeof payload[f] === 'string' && payload[f].length > cap)
      die(`pidge: --${f} is too long to send ENCRYPTED — its sealed envelope is ${payload[f].length} chars but the server caps ${f} at ${cap} (E2E inflates a value ~33%). Shorten it, or send it in the body.`, 2);
  }
  payload.enc = 'v1';
  payload.kf = mat.kf;
  e2eStampPin(mat.kf); // a CONFIRMED sealed context latches the anti-downgrade pin
  if (payload.media_enc === 'v1') {
    e2eStampMediaPin(); // a CONFIRMED sealed-media send latches the media pin too
    console.error('pidge: E2E — media bytes + filename sealed');
  } else if (payload.image !== undefined || payload.file !== undefined) {
    console.error('pidge: E2E note — this send\'s media BYTES and filename ride CLEAR (the media gate is closed: whoami e2e_media_ready:false until an iOS build that opens sealed media is on all devices; PIDGE_E2E_MEDIA=on forces it). The text fields, copy and url are sealed.');
  }
  console.error(`pidge: E2E — content sealed (kf ${mat.kf}); the server stores and relays ciphertext only`);
}

// Decrypt OUR OWN envelopes in the 201/upsert echo so "trust the echo" keeps
// meaning something on stdout (the wire echo is ciphertext by design). enc/kf
// stay in the printed JSON — they are the wire truth of the send.
function e2eOpenEcho(info, payload) {
  const mat = e2eKeyMaterial();
  if (!mat || !e2eChannelCache || !info || typeof info !== 'object') return null;
  const cid = info.correlation_id || payload.correlation_id;
  if (!cid) return null;
  try {
    for (const f of E2E_CONTENT_FIELDS) {
      if (isEnvelope(info[f])) info[f] = e2eDecryptField(mat.key, e2eAad(e2eChannelCache.id, cid, f), info[f]);
    }
    return JSON.stringify(info);
  } catch { return null; } // an un-openable echo prints as the server sent it
}

// RECEIVE: one row of GET /api/v1/messages. Two sealed shapes exist —
//   kind:"message": the row's own enc/kf/correlation_id; body opens with
//     field ALWAYS "message" (composer AND late-reply — the late reply reuses
//     the answered notification's cid as its correlation_id);
//   kind:"notification_reply": the envelope rides ref/ref_payload — ref.enc
//     gates; text opens with field "reply", ref.title with "title", and a body
//     that is a custom-action LABEL with "action_label_<action_id>".
// On success the plaintext replaces the ciphertext and enc/kf are swapped for
// e2e:"decrypted" (an agent re-gating on `enc` must never mistake plaintext for
// an envelope); on failure the sealed fields are BLANKED and e2e_error says why.
async function e2eOpenMessageRow(m, dl = {}) {
  const refEnc = m.ref && m.ref.enc;
  const out = { ...m };
  const fail = (reason) => { if (!out.e2e_error) out.e2e_error = reason; e2eNote(reason); };
  if (!m.enc && !refEnc) {
    // a clear line renders as always (pre-E2E history) — but a clear ATTACHMENT
    // may still want the opt-in --download save.
    if (m.attachment) await e2eProcessAttachment(m, out, fail, dl);
    return m.attachment ? out : m;
  }
  if (m.enc) {
    out.body = e2eOpenValue({
      enc: m.enc, kf: m.kf, channelId: m.channel_id, cid: m.correlation_id,
      field: 'message', value: m.body, onError: fail,
    });
  }
  if (refEnc) {
    out.ref = { ...m.ref };
    const ctx = { enc: m.ref.enc, kf: m.ref.kf, channelId: m.channel_id, cid: m.ref.correlation_id, onError: fail };
    if (m.text !== undefined && m.text !== null) {
      out.text = e2eOpenValue({ ...ctx, field: 'reply', value: m.text });
      if (m.body === m.text) out.body = out.text; // body mirrors the reply text
    }
    if (m.ref.title !== undefined && m.ref.title !== null) {
      out.ref.title = e2eOpenValue({ ...ctx, field: 'title', value: m.ref.title });
    }
    // No text: the body mirrors the tapped action's LABEL — sealed only for a
    // custom action (a built-in label is server-side clear and passes through).
    if (isEnvelope(out.body) && m.action_id) {
      out.body = e2eOpenValue({ ...ctx, field: `action_label_${m.action_id}`, value: out.body });
    }
    // A1 safety net: an envelope we could not ATTRIBUTE to a field (a label-
    // derived body with no action_id) is still never printed. Compared to the
    // ORIGINAL value so a decrypted plaintext that happens to start with "v1:"
    // can never be blanked by mistake.
    if (isEnvelope(out.body) && out.body === m.body) {
      fail('a sealed field could not be attributed (no action_id on the answer) — not printing ciphertext');
      out.body = null;
    }
  }
  if (m.attachment) await e2eProcessAttachment(m, out, fail, dl); // inbound media
  if (!out.e2e_error) {
    delete out.enc; delete out.kf;
    if (out.ref) { delete out.ref.enc; delete out.ref.kf; }
    out.e2e = 'decrypted';
  }
  return out;
}

// CONTINUITY (gotcha #51): the thread Pidge ALREADY holds, handed to a cold
// session as READ-ONLY provenance. NOTHING here is ackable/consumable (the server
// already excluded gated rows from the entries) and — the load-bearing rule —
// continuity infrastructure NEVER promotes a prior-run statement to a verified
// fact: `epistemic_status`/`note` ride through UNTOUCHED. One sealed entry opens
// best-effort with the SAME per-field/AAD primitives as a message row, but the
// two differences from e2eOpenMessageRow are deliberate:
//   · a failure KEEPS the envelope (context must never blank a human's words) +
//     an e2e_error crumb — the envelope is still the wire truth of that turn;
//   · it NEVER throws — a single broken context row can't kill the batch.
// Field/cid map per kind (AAD = ch<channel_id>:<cid>:<field>):
//   agent_message: title→"title", body→"body"   (cid = entry.correlation_id)
//   human_message: text→"message"                (cid = entry.correlation_id)
//   human_reply:   text→"reply"                  (cid = entry.ref_correlation_id — the answered notification's cid)
async function e2eOpenContinuityEntry(entry) {
  try {
    if (!entry || typeof entry !== 'object') return entry;
    // clear (or a non-text kind like a plain marker) — passes straight through,
    // enc/kf/epistemic_status all preserved verbatim.
    if (!entry.enc) return entry;
    let fields;
    if (entry.kind === 'agent_message') fields = [['title', 'title', entry.correlation_id], ['body', 'body', entry.correlation_id]];
    else if (entry.kind === 'human_message') fields = [['text', 'message', entry.correlation_id]];
    else if (entry.kind === 'human_reply') fields = [['text', 'reply', entry.ref_correlation_id]];
    else return entry; // sealed flag on a kind we don't map — leave the envelope as-is
    const out = { ...entry };
    let opened = false, failed = false;
    for (const [prop, field, cid] of fields) {
      if (!isEnvelope(out[prop])) continue;
      let err = null;
      const plain = e2eOpenValue({
        enc: entry.enc, kf: entry.kf, channelId: entry.channel_id, cid, field,
        value: out[prop], onError: (r) => { err = r; e2eNote(r); },
      });
      if (err || plain === null) { failed = true; if (err && !out.e2e_error) out.e2e_error = err; }
      else { out[prop] = plain; opened = true; }
    }
    // Only a clean, fully-opened entry sheds enc/kf and is stamped decrypted — a
    // partial failure keeps the envelope + e2e_error so no consumer mistakes a
    // still-sealed field for plaintext.
    if (opened && !failed) { delete out.enc; delete out.kf; out.e2e = 'decrypted'; }
    return out;
  } catch { return entry; } // belt-and-suspenders: context decryption can NEVER throw into the batch
}

// Best-effort open every entry of every context. Present-only + never-throws — a
// null/absent list means "old server", and the caller omits the batch key entirely.
async function e2eOpenContinuityContexts(contexts) {
  if (!Array.isArray(contexts) || contexts.length === 0) return null;
  return Promise.all(contexts.map(async (ctx) => {
    if (!ctx || typeof ctx !== 'object' || !Array.isArray(ctx.entries)) return ctx;
    const entries = await Promise.all(ctx.entries.map((e) => e2eOpenContinuityEntry(e)));
    return { ...ctx, entries };
  }));
}

// An attachment url comes off the wire. Relative ⇒ this server. Absolute ⇒
// http(s) only, and off this server it must be https to a public host: a
// hostile or confused server must not turn this CLI into a probe of the
// network it sits on (cloud metadata, a printer, the daemon's own loopback).
function attachmentUrl(u, base = BASE) {
  if (typeof u !== 'string' || !u) throw new Error('attachment url is missing');
  if (u.startsWith('/')) return `${base}${u}`;
  let url;
  try { url = new URL(u); } catch { throw new Error(`attachment url is neither a path on this server nor an absolute http(s) url: ${u}`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`attachment url scheme ${url.protocol} refused — http(s) only`);
  if (url.username || url.password) throw new Error('attachment url carries credentials — refused');
  let baseOrigin = null;
  try { baseOrigin = new URL(base).origin; } catch { /* an unparsable BASE vouches for nothing */ }
  if (baseOrigin && url.origin === baseOrigin) return url.href;
  if (url.protocol !== 'https:') throw new Error(`attachment url off this server must be https (got ${url.origin})`);
  if (isInternalHost(url.hostname)) throw new Error(`attachment url points at an internal address (${url.hostname}) — refused`);
  return url.href;
}
function isInternalHost(h) {
  const host = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) {
    return host === '::' || host === '::1' || host.startsWith('::ffff:') || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }
  return false;
}

// you→agent: one message's attachment. A SEALED one ({enc:"v1"} on the
// block) is ALWAYS downloaded + unsealed to a local file — its signed URL
// serves ciphertext, useless to an agent otherwise; the plaintext lands at
// <config dir>/downloads/<message id>/<sanitized real filename> and rides the
// printed JSON as `attachment.path`. A CLEAR one passes through (its url is
// directly fetchable) unless --download asks for the same save. Failures are
// precise e2e_error/stderr — and ciphertext is NEVER written where a file is
// expected.
async function e2eProcessAttachment(m, out, fail, dl = {}) {
  const att = m.attachment;
  if (!att || typeof att !== 'object') return;
  out.attachment = { ...att };
  // catchup (esp. the --digest session-start ritual) must not re-fetch +
  // re-unseal every attachment every run. `noDownload` skips the bytes entirely
  // (the row already carries the name/sealed flag — enough to LIST it);
  // `skipIfExists` reuses a copy already on disk (byte_size match for clear
  // rows; existence for sealed, whose plaintext size ≠ the ciphertext byte_size).
  const noDownload = !!dl.noDownload;
  const skipIfExists = !!dl.skipIfExists;
  const download = async () => {
    const res = await fetchT(attachmentUrl(att.url));
    if (!(res.status >= 200 && res.status < 300)) throw new Error(`download answered ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const destFor = (filename) => {
    const dir = v['download-dir'] || path.join(CONFIG_DIR, 'downloads');
    // m.id comes off the wire — a hostile server (the E2E threat model)
    // could ship "../.." to steer the decrypted plaintext OUTSIDE the downloads
    // dir. Sanitize the id segment AND the fallback name exactly like any other
    // attacker-influenceable wire string, so both path parts are contained.
    const idSeg = sanitizeAttachmentName(String(m.id)) || 'msg';
    const name = sanitizeAttachmentName(filename) || `attachment-${idSeg}`;
    return path.join(dir, idSeg, name);
  };
  // a copy already on disk (existence for sealed; size match for clear)?
  // a 0-byte file is NEVER cache — a crash mid-write (pre-
  // atomic builds) or an ENOSPC could leave a truncated husk that would
  // otherwise become a permanent "cached" lie. Writes below are tmp+rename
  // (atomic on the same fs), so a partial write can't land at dest at all.
  const cached = (dest) => {
    try {
      const st = fs.statSync(dest); // throws if missing
      if (st.size === 0) return false;
      if (att.enc) return true; // sealed: plaintext already decrypted here once
      return att.byte_size == null || st.size === att.byte_size;
    } catch { return false; }
  };
  // m3: atomic write — tmp in the SAME dir then rename, so a crash/ENOSPC
  // mid-write never leaves a truncated file where cached() would trust it.
  const writeAtomic = (dest, bytes) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, dest);
  };
  if (att.enc) {
    if (att.enc !== 'v1') {
      return fail(`attachment sealed with an unknown envelope version ${JSON.stringify(att.enc)} — this CLI speaks v1 (update pidge-cli)`);
    }
    const reason = e2eSealedError('v1', m.kf)
      || (!m.correlation_id && 'attachment is sealed but the row carries NO correlation_id (the AAD anchor) — it can never be decrypted')
      || null;
    if (reason) return fail(reason);
    const mat = e2eKeyMaterial();
    // The real filename is a "message_filename" envelope on a sealed attachment.
    // Decrypted from the ROW (no network) — so we can name/dest a sealed blob
    // even under --no-download.
    let name = att.filename;
    if (isEnvelope(name)) {
      try {
        name = e2eDecryptField(mat.key, e2eAad(m.channel_id, m.correlation_id, 'message_filename'), name);
        out.attachment.filename = name;
      } catch (e) {
        out.attachment.filename = null;
        return fail(`attachment filename failed to open: ${e.message}`);
      }
    }
    const dest = destFor(name);
    if (noDownload) {
      out.attachment.sealed = true; // present-only marker — bytes NOT fetched
      e2eNote(`attachment ${name || '(sealed)'} not downloaded (--no-download / --digest)`);
      return;
    }
    if (skipIfExists && cached(dest)) {
      out.attachment.path = dest;
      delete out.attachment.enc;
      e2eNote(`attachment already on disk → ${dest} (skipped re-download)`);
      return;
    }
    try {
      const plain = e2eDecryptBlob(mat.key, e2eAad(m.channel_id, m.correlation_id, 'message_blob'), await download());
      writeAtomic(dest, plain); // m3: never a truncated plaintext at dest
      out.attachment.path = dest;
      delete out.attachment.enc;
      e2eNote(`attachment decrypted → ${dest}`);
    } catch (e) {
      fail(`attachment failed to open: ${e.message}`);
    }
  } else if (!noDownload && (v.download || v['download-dir'])) {
    const dest = destFor(att.filename);
    if (skipIfExists && cached(dest)) {
      out.attachment.path = dest; // reuse the copy already saved
      return;
    }
    try {
      const bytes = await download();
      writeAtomic(dest, bytes); // m3: same atomicity for the clear save
      out.attachment.path = dest;
    } catch (e) {
      console.error(`pidge: WARNING — attachment download failed (${e.message}); the url in the JSON is still fetchable`);
    }
  }
}

// RECEIVE: the poll's chosen_action (wait/ask/approve/hello). The notification-
// level enc/kf gate (the poll payload carries them); text opens with field
// "reply", a custom action's label with "action_label_<action_id>". The poll
// payload has no channel id, so whoami resolves it once (cached).
async function e2eOpenChosen(data) {
  const chosen = data.chosen_action;
  if (!data.enc || !chosen) return;
  const fail = (reason) => { if (!chosen.e2e_error) chosen.e2e_error = reason; e2eNote(reason); };
  let channelId = null;
  if (e2eKeyMaterial()) {
    try { channelId = (await e2eChannelInfo()).id; } catch { /* e2eOpenValue names it */ }
  }
  const ctx = { enc: data.enc, kf: data.kf, channelId, cid: data.correlation_id, onError: fail };
  if (chosen.text !== undefined && chosen.text !== null) {
    chosen.text = e2eOpenValue({ ...ctx, field: 'reply', value: chosen.text });
  }
  if (chosen.label !== undefined && chosen.label !== null) {
    if (chosen.action_id) {
      chosen.label = e2eOpenValue({ ...ctx, field: `action_label_${chosen.action_id}`, value: chosen.label });
    } else if (isEnvelope(chosen.label)) {
      // A1 safety net: a sealed label with no action_id can't be attributed —
      // blank it rather than print ciphertext.
      fail('label is sealed but the answer carries no action_id — not printing ciphertext');
      chosen.label = null;
    }
  }
}

// Map CLI flags → the /notify JSON body, including only what was provided. `extra`
// carries subcommand-supplied raw fields (the typed sends' template_kind and
// alert's escalate) — merged below, before the --param escape hatch.
function buildBody(extra = {}) {
  if (!v.title) die('pidge: --title is required', 1);
  const body = { title: v.title };
  if (v.body !== undefined) body.body = v.body;
  if (v['body-markdown-file'] !== undefined) {
    body.body_markdown = v['body-markdown-file'] === '-'
      ? fs.readFileSync(0, 'utf8')
      : fs.readFileSync(v['body-markdown-file'], 'utf8');
  } else if (v['body-markdown'] !== undefined) {
    body.body_markdown = v['body-markdown'];
  }
  if (v.subtitle !== undefined) body.subtitle = v.subtitle;
  if (v.template !== undefined) body.template = v.template;
  if (v.profile !== undefined) body.profile = v.profile;
  if (v['event-at'] !== undefined) body.event_at = v['event-at'];
  if (v['lead-minutes'] !== undefined) body.lead_minutes = parseInt(v['lead-minutes'], 10);
  if (v.urgency !== undefined) body.urgency = v.urgency;
  if (v.url !== undefined) body.url = v.url;
  if (v.copy !== undefined) body.copy = v.copy;
  if (v['deliver-at'] !== undefined) body.deliver_at = v['deliver-at'];
  if (v['reply-to'] !== undefined) body.reply_to = v['reply-to'];
  if (v['correlation-id'] !== undefined) body.correlation_id = v['correlation-id'];
  if (v.thread !== undefined) body.thread_id = v.thread;
  if (v.after !== undefined) body.after = v.after;
  // --note → sent_note — the WHY of this send, attributed to this
  // runtime so a successor reads "who armed what, and why". CLEAR metadata (never
  // sealed on E2E channels, D6) — keep secrets out. Server truncates; it never 422s.
  if (v.note !== undefined) body.sent_note = v.note;
  if (v['collapse-key'] !== undefined) body.collapse_key = v['collapse-key'];

  // --actions: the short comma form (built-in catalog ids → body.actions) OR a
  // JSON array of custom {id,label,…} specs (→ body.custom_actions). A
  // leading '[' selects JSON; bad JSON is a friendly LOCAL error (exit 1), never
  // a silent fall-through that drops the labels and sends a plain notification.
  // --custom-action specs APPEND to whatever the JSON form produced, so both can coexist.
  const customActions = [];
  if (v.actions !== undefined) {
    const trimmed = v.actions.trim();
    if (trimmed.startsWith('[')) {
      let arr;
      try { arr = JSON.parse(trimmed); }
      catch (e) { die(`pidge: --actions looks like JSON but didn't parse (${e.message}). Use a JSON array of {"id","label"} objects, or the short form yes,no (or reply alone)`, 1); }
      if (!Array.isArray(arr)) die('pidge: --actions JSON must be an ARRAY of {"id","label"} objects', 1);
      arr.forEach((item, i) => customActions.push(customActionFromJson(item, i)));
    } else {
      body.actions = trimmed.split(',').filter(Boolean);
    }
  }
  for (const spec of v['custom-action'] || []) customActions.push(customActionFromSpec(spec));
  if (customActions.length) body.custom_actions = customActions;

  // REFUSE a decision button + `reply` in the same send (the skill's
  // anti-slop rule). The human taps the easy Yes/No and you get a useless
  // "Yes" instead of the typed text you wanted. One question per send — enforce
  // it locally (exit 1, no round-trip), don't warn-and-send. (`reply` alongside a
  // non-decision like done/snooze is fine — DONE_REPLY is a real category.)
  if (Array.isArray(body.actions) && body.actions.includes('reply')) {
    const DECISION_ACTIONS = ['yes', 'no', 'approve', 'reject', 'accept', 'decline', 'later'];
    const decisions = body.actions.filter((a) => DECISION_ACTIONS.includes(a));
    if (decisions.length)
      die(`pidge: --actions can't combine a decision button (${decisions.join(',')}) with \`reply\` — the human taps the easy button and you get a useless "${decisions[0]}" instead of the text you wanted. Use \`--actions reply\` ALONE for a typed answer, or drop \`reply\` for a button decision. One question per send.`, 1);
  }

  // --gated synthesizes ONE Face-ID confirm on the consequential action
  // (money/deletion) — the replacement for the retired content_template:sensitive.
  // Skip if the agent already supplied a biometric action (don't double-gate).
  if (v.gated && !(body.custom_actions || []).some((c) => c.biometric)) {
    body.custom_actions = (body.custom_actions || []).concat([
      { id: 'confirm_action', label: 'Confirm', style: 'destructive', confirm: true, biometric: true, terminal: true },
    ]);
  }

  // subcommand-supplied raw fields (template_kind, alert's escalate). Applied
  // before the --param loop so a raw --param can still override in a pinch.
  Object.assign(body, extra);

  // Escape hatch: any raw /notify field, so a NEW server field documented in the
  // manifest works the day it ships — no CLI release needed. JSON values parse
  // (numbers/bools/objects); anything else passes as a string.
  for (const pair of v.param || []) {
    const eq = pair.indexOf('=');
    if (eq < 1) die(`pidge: --param expects KEY=VALUE, got ${JSON.stringify(pair)}`, 1);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    let value = raw;
    try { value = JSON.parse(raw); } catch { /* keep the string */ }
    body[key] = value;
  }
  return body;
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.pdf': 'application/pdf', '.csv': 'text/csv', '.txt': 'text/plain',
  '.md': 'text/markdown', '.json': 'application/json', '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const guessMime = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

// Multipart upload of a local file to POST /api/v1/uploads → the opaque `ref`
// /notify accepts as `image`/`file`. This is how a LOCALLY-generated artifact
// reaches the phone: the agent's machine has no public URL and the push payload
// is far too small to carry a file.
async function uploadFile(filePath) {
  return uploadBlob(fs.readFileSync(filePath), path.basename(filePath), guessMime(filePath));
}

// A SEALED upload carries a generic name + octet-stream — the real
// filename rides the /notify as an envelope, never the multipart.
async function uploadBlob(bytes, filename, type) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), filename);
  let res, raw;
  try {
    res = await fetch(`${BASE}/api/v1/uploads`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, ...identityHeaders() }, body: fd,
    });
    raw = await res.text();
  } catch (e) {
    die(`pidge: upload failed (network): ${e.message}`, 2);
  }
  if (!(res.status >= 200 && res.status < 300)) die(`pidge: upload failed (${res.status}): ${raw}`, 2);
  let ref;
  try { ref = JSON.parse(raw).ref; } catch { /* fall through */ }
  if (!ref) die('pidge: upload returned no ref', 2);
  return ref;
}

// --image / --file: an existing local path is uploaded and swapped for its ref;
// anything else (an https URL on --image, or an already-minted ref) passes through
// untouched — the server 422s self-describingly on an invalid value.
// With a mediaPlan, each local blob is SEALED before upload
// ([0x01][nonce][ct][tag], AAD "ch<id>:<cid>:image_blob|file_blob"), uploads as
// a generic blob.bin, the file's real name becomes a `filename` envelope (AAD
// field "filename") and the send is flagged media_enc:"v1".
async function resolveMedia(body, mediaPlan = null) {
  for (const key of ['image', 'file']) {
    if (v[key] === undefined) continue;
    if (fs.existsSync(v[key])) {
      if (mediaPlan) {
        const sealed = e2eEncryptBlob(
          mediaPlan.key,
          e2eAad(mediaPlan.channelId, mediaPlan.cid, `${key}_blob`),
          fs.readFileSync(v[key])
        );
        body[key] = await uploadBlob(sealed, 'blob.bin', 'application/octet-stream');
        if (key === 'file') {
          body.filename = e2eEncryptField(
            mediaPlan.key, e2eAad(mediaPlan.channelId, mediaPlan.cid, 'filename'),
            path.basename(v[key])
          );
        }
        body.media_enc = 'v1';
      } else {
        body[key] = await uploadFile(v[key]);
      }
    } else if (key === 'file' && (/^[./~]/.test(v[key]) || v[key].includes('/'))) {
      // --file is PATH-only (no URL form) — fail fast on a typo'd path; the remote
      // 422 ("ref invalid — re-upload") would misdirect the agent's self-heal.
      die(`pidge: --file: no such file: ${v[key]}`, 1);
    } else if (mediaPlan) {
      // A pre-minted ref holds bytes this machine never sealed — riding it on a
      // media_enc send would serve clear bytes the phone tries to unseal.
      die(`pidge: --${key} with a pre-minted ref cannot ride a SEALED-media send — pass the local path so the bytes seal here (or PIDGE_E2E_MEDIA=off to send this one clear).`, 2);
    } else {
      body[key] = v[key];
    }
  }
}

// POST /notify. Returns { ok, info, raw }. Emits to STDERR what an agent most
// needs to KNOW (0 devices / no banner buttons / an armed alarm / a policy
// degrade), so stdout stays free for machine output.
async function doNotify(extra = {}) {
  const payload = buildBody(extra);
  // A PINNED channel must refuse BEFORE resolveMedia
  // uploads any bytes — otherwise a lying server captures the file/filename
  // (which ride clear when media sealing is off) even though the /notify is then refused.
  await e2ePreflightRefusal();
  // Decide the media fate BEFORE any bytes leave the machine — the
  // plan seals local blobs in resolveMedia; a media-pinned channel that would
  // downgrade to clear media refuses HERE, pre-upload.
  const mediaPlan = await e2eMediaPlan(payload);
  await resolveMedia(payload, mediaPlan);
  // E2E: seal the content AFTER everything else composed the payload —
  // typed sends, approval/approve/hello custom actions, --param, media refs all
  // pass through here, so every send path is covered by this one call.
  await e2eMaybeSeal(payload);
  let res, raw;
  try {
    res = await fetch(`${BASE}/api/v1/notify`, {
      method: 'POST', headers, body: JSON.stringify(payload),
    });
    raw = await res.text();
  } catch (e) {
    die(`pidge: send failed (network): ${e.message}`, 2);
  }
  await checkManifestNews(res);
  const ok = res.status >= 200 && res.status < 300;
  let info = {};
  try { info = JSON.parse(raw); } catch { /* leave {} */ }
  if (ok && payload.enc === 'v1') {
    // stdout keeps "trust the echo" meaningful: our own envelopes, decrypted
    // for display (the wire/server saw only ciphertext — enc/kf stay printed).
    const display = e2eOpenEcho(info, payload);
    if (display) raw = display;
  }
  if (ok) {
    // the same correlation_id while still scheduled EDITS in place.
    if (info.updated)
      console.error('pidge: updated scheduled notification (same correlation_id, nothing fires twice)');
    if (info.registered_devices === 0)
      console.error('pidge: 0 registered devices — nobody will receive this');
    if (info.render_mode === 'detail_only')
      console.error('pidge: render_mode=detail_only — the banner shows NO buttons; the user must open the app to act (use a banner-eligible action shape if you want quick taps)');
    const esc = info.escalation;
    if (esc && (esc.state === 'pending' || esc.state === 'armed')) {
      const when = esc.after_minutes != null ? `${esc.after_minutes} min after delivery` : 'on delivery';
      console.error(`pidge: ESCALATES TO ALARM if unanswered ${when} (answering/snoozing defuses it)`);
    }
    if (info.degraded)
      console.error(`pidge: DEGRADED by channel policy — ${info.degrade_reason} (delivered anyway, quieter; the human's setting, don't retry harder)`);
    // threads — remind the agent how to keep the conversation grouped.
    if (info.thread_id)
      console.error(`pidge: thread=${info.thread_id} — send follow-ups with the same --thread to group them on the phone`);
  } else {
    console.error(`pidge: send failed (${res.status}): ${raw}`);
  }
  return { ok, info, raw };
}

// The RESPONSE axis: true when the send carries SOME way for the human
// to answer with a tap — built-in actions, custom actions, or a content --template
// that supplies them. Free-text reply is ALWAYS available, so this is only about
// buttons. `ask` requires it; `approval` injects a default pair when it's absent.
const hasAnswerAffordance = () =>
  v.actions !== undefined || (v['custom-action'] || []).length > 0 || v.template !== undefined;

// The `approval` recipe's default button pair. Sent as
// CUSTOM actions, NOT built-ins: only custom_actions can carry `biometric` (Face
// ID), and a custom id may NOT reuse a built-in id like approve/reject (the server
// 422s "collides with a built-in") — so the ids are grant/deny. Face ID gates the
// consequential "Approve"; "Reject" is the safe (destructive-styled) out. A gated
// action is detail-screen only (no banner buttons), by design.
const APPROVAL_ACTIONS = [
  { id: 'grant', label: 'Approve', biometric: true, terminal: true },
  { id: 'deny', label: 'Reject', style: 'destructive', terminal: true },
];

// The married catalog of 5: one send, stamped with the canonical
// `template_kind` (message/important/urgent/event/live). The RESPONSE axis is
// orthogonal: with `wait:false` it's fire-and-forget (print the raw 201, exit);
// with `wait:true` it mints a cid, sends, and BLOCKS until a terminal answer
// (print chosen_action JSON). `requireAnswerable` gates `ask`. `extra` carries
// raw fields (urgent's escalate:true, approval's injected custom_actions).
async function doTypedSend(kind, { wait = false, extra = {}, requireAnswerable = false, label = kind } = {}) {
  if (!v.title) die('pidge: --title is required', 1);
  // `live` is status-only — it never produces an answer, so --wait would block the
  // full timeout believing the human is deciding. Refuse it (mirror the old ask guard).
  if (wait && (kind === 'live' || v.profile === 'tracking'))
    die(`pidge: \`${label}\`${kind === 'live' ? '' : ' --profile tracking'} can't --wait — ${kind === 'live' ? '`live` is' : 'tracking is'} status-only and never produces an answer (drop --wait, or ask with a real type)`, 1);
  if (requireAnswerable && !hasAnswerAffordance())
    die(`pidge: --actions required for ${label}. Add buttons with --actions yes,no (or approve,reject) or --custom-action id:label.`, 1);

  if (!wait) {
    const { ok, info, raw } = await doNotify({ template_kind: kind, ...extra });
    console.log(raw);
    if (ok && info.correlation_id)
      console.error(`pidge: correlation_id=${info.correlation_id} (use: pidge wait ${info.correlation_id})`);
    process.exit(ok ? 0 : 2);
  }

  // validate the wait knobs BEFORE the send — a typo must die here (exit 1),
  // not hang the poll loop forever nor leave a ghost notification behind a post-send die.
  const timeoutArg = numStrict(v.timeout, '--timeout', NaN);
  const intervalArg = numStrict(v.interval, '--interval', 30);
  // --wait: the cid is minted CLIENT-side when not given, and printed as the FIRST
  // stderr line (greppable) — a killed/crashed wait always leaves the handle behind,
  // so the agent can `pidge wait <cid>` instead of re-sending.
  const cid = v['correlation-id'] || crypto.randomUUID();
  v['correlation-id'] = cid;
  console.error(`pidge: correlation_id=${cid}`);
  const { ok, info } = await doNotify({ template_kind: kind, ...extra });
  if (!ok) process.exit(2);
  console.error(`pidge: sent (${info.registered_devices} device(s)) — waiting on ${cid}`);
  // no --timeout ⇒ obey the template's suggestion from the 201 echo (human
  // decisions take 30-40 min; a 600 s default misreads them as silence). Explicit wins.
  let timeout = timeoutArg;
  if (!Number.isFinite(timeout)) {
    if (info.suggested_ask_timeout) {
      timeout = info.suggested_ask_timeout;
      console.error(`pidge: timeout ${Math.round(timeout / 60)} min — suggested by template ${info.template || v.template} (override with --timeout)`);
    } else if (info.requires_action) {
      timeout = 3600;   // a human decision (buttons present) takes 30-40 min, not 600 s of "silence"
      console.error(`pidge: no template suggestion — defaulting --wait to 60 min for a decision (override with --timeout)`);
    } else {
      timeout = 600;
    }
  }
  await waitForAnswer(cid, { timeout, interval: intervalArg });
}

// `pidge live` — the wrapper over the three
// /live_activities endpoints. By default the write lands as an ENTRY of the
// user's consolidated status-center card; the response's `operation` echo
// (started|updated|noop|rotated|ended) is the truth of what happened. The old
// behavior (template_kind:live → a silently-degraded message-profile /notify)
// is dead.
async function doLive() {
  if (v.wait)
    die("pidge: `live` can't --wait — a status card never produces an answer (drop --wait, or ask with a real type)", 1);
  if (v.paused && v.resume) die('pidge: pass --paused OR --resume, not both', 1);
  const cid = parsed.positionals[1] || v['correlation-id'];

  // --step N/M is SUGAR: there is no steps field on the wire — it becomes
  // progress + the fraction label the bar renders.
  let progress; let progressLabel;
  if (v.step !== undefined) {
    if (v.progress !== undefined) die('pidge: pass --step OR --progress, not both', 1);
    const m = String(v.step).match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!m || Number(m[2]) === 0) die('pidge: --step must look like 3/5 (done/total)', 1);
    progress = Math.min(1, Number(m[1]) / Number(m[2]));
    progressLabel = `${m[1]}/${m[2]}`;
  } else if (v.progress !== undefined) {
    progress = Number(v.progress);
    if (!Number.isFinite(progress)) die(`pidge: --progress ${JSON.stringify(v.progress)} is not a number (0..1)`, 1);
  }

  const prune = (obj) => Object.fromEntries(Object.entries(obj).filter(([, x]) => x !== undefined));
  let method; let apiPath;
  let body;
  if (v.end) {
    if (!cid) die('pidge: usage: pidge live <correlation_id> --end [--outcome "…"] [--linger N]', 1);
    method = 'POST';
    apiPath = `/api/v1/live_activities/${encodeURIComponent(cid)}/end`;
    body = prune({
      status: v.status, symbol: v.symbol, detail: v.detail, progress,
      outcome: v.outcome,
      linger_seconds: v.linger !== undefined ? numStrict(v.linger, '--linger', undefined) : undefined,
    });
  } else {
    body = prune({
      correlation_id: cid,
      title: v.title, status: v.status, symbol: v.symbol, detail: v.detail,
      progress, progress_label: progressLabel,
      started_at: v['starts-at'], ends_at: v['ends-at'],
      is_running: v.paused ? false : (v.resume ? true : undefined),
      presentation: v.dedicated ? 'dedicated' : undefined,
    });
    if (v.title !== undefined) {
      // POST upserts by correlation_id — start OR update in one shape.
      method = 'POST';
      apiPath = '/api/v1/live_activities';
    } else {
      if (!cid)
        die('pidge: pass --title to start a card, or <correlation_id> (or --correlation-id) to update one', 1);
      method = 'PATCH';
      apiPath = `/api/v1/live_activities/${encodeURIComponent(cid)}`;
      delete body.correlation_id;
    }
  }

  let res; let raw;
  try {
    res = await fetch(`${BASE}${apiPath}`, { method, headers, body: JSON.stringify(body) });
    raw = await res.text();
  } catch (e) {
    die(`pidge: live ${v.end ? 'end' : 'write'} failed (network): ${e.message}`, 2);
  }
  await checkManifestNews(res);
  console.log(raw); // machine output: the full response JSON (operation/degraded included)
  const ok = res.status >= 200 && res.status < 300;
  let info = {};
  try { info = JSON.parse(raw); } catch { /* leave {} */ }
  if (!ok) {
    if (res.status === 404 && method === 'PATCH')
      console.error(`pidge: no card with correlation_id=${cid} on this channel — add --title to START it (POST upserts)`);
    else
      console.error(`pidge: live ${v.end ? 'end' : 'write'} failed (${res.status})`);
    process.exit(2);
  }
  if (info.correlation_id)
    console.error(`pidge: correlation_id=${info.correlation_id} (update: pidge live ${info.correlation_id} --status "…" · end: pidge live ${info.correlation_id} --end --outcome "…")`);
  if (info.degraded)
    console.error(`pidge: DEGRADED — ${info.reason || 'over budget'}: the card landed as a status-center entry, not a dedicated one (nothing was dropped)`);
  if (info.operation === 'noop')
    console.error('pidge: noop — identical to the current state (your staleness TTL was refreshed; no push burned)');
  if (info.operation === 'rotated')
    console.error('pidge: rotated — the device card had been dismissed; it was re-created via push-to-start');
  if (info.renderable_devices === 0)
    console.error('pidge: 0 devices can render Live Activities — the card goes nowhere (open the app once to register)');
  process.exit(0);
}

// `pidge approve` — a hook-shaped, DENY-DEFAULT permission gate. Sends a
// Face-ID approval and BLOCKS, then maps the human's tap to an exit code: ONLY an
// explicit allow is exit 0; deny, timeout, a dead channel or any ambiguity is
// non-zero (exit 1) so a PreToolUse hook fails CLOSED. A thin wrapper over the
// ask/wait long-poll: it fixes the two gated actions and swaps print-and-exit-0
// for the exit-code mapping (via waitForAnswer's onAnswer/onTimeout).
async function doApprove() {
  const question = parsed.positionals[1] || v.title;
  if (!question)
    die('pidge: usage: pidge approve "<question>" [--body TEXT] [--timeout N] [--allow-label L] [--deny-label L]', 1);
  // a typo in the knobs must die HERE (exit 1, fail-closed), before the
  // approval is even sent — a NaN deadline would hang this gate open forever.
  const timeout = numStrict(v.timeout, '--timeout', 300);
  const interval = numStrict(v.interval, '--interval', 30);
  // an interrupt mid-wait is NOT an approval — exit 1 loudly (deny-default),
  // like every other unanswered path out of this gate.
  process.on('SIGINT', () => {
    console.error('pidge: interrupted before an answer — DENIED (deny-default; nothing was approved). exit 1');
    process.exit(1);
  });
  v.title = question;
  const allowLabel = v['allow-label'] || 'Allow';
  const denyLabel = v['deny-label'] || 'Deny';
  // allow = Face-ID confirm (both confirm+biometric) · deny = destructive out.
  // Both terminal, both gated ⇒ the server resolves the push to a detail-only
  // category: approving is a deliberate in-app Face-ID tap, never a one-tap banner.
  const customActions = [
    { id: 'allow', label: allowLabel, confirm: true, biometric: true, terminal: true },
    { id: 'deny', label: denyLabel, style: 'destructive', terminal: true },
  ];
  const cid = v['correlation-id'] || crypto.randomUUID();
  v['correlation-id'] = cid;
  console.error(`pidge: correlation_id=${cid}`);
  // mirror_reply:false — approve is a CLOSED CIRCUIT (this process blocks on the
  // cid below, deny-default), so the answer must NOT also mirror onto the
  // /messages queue: a bridge would wake a fresh handler with the bare
  // allow-label ("Submit") reading like a new imperative command. Losing the
  // mirror is safe HERE ONLY because no-answer already means deny; a normal
  // --wait ask keeps the mirror (its crash fallback). Old servers (< manifest
  // v83) ignore the param — the bridge-side ref.gated filter covers them.
  const { ok, info } = await doNotify({ template_kind: 'important', custom_actions: customActions, mirror_reply: false });
  if (!ok) {
    // Couldn't even ask the human ⇒ fail closed. (doNotify already narrated the
    // HTTP failure; a raw network error exits 2 inside doNotify — also non-zero.)
    console.error('pidge: could NOT send the approval — DENIED (deny-default; nothing was approved). exit 1');
    process.exit(1);
  }
  console.error(`pidge: approval sent (${info.registered_devices} device(s)) — waiting on ${cid} (only an explicit "${allowLabel}" is exit 0)`);
  await waitForAnswer(cid, {
    timeout,
    interval,
    onAnswer: (chosen) => {
      console.log(JSON.stringify(chosen, null, 2)); // machine output on stdout
      if (chosen && chosen.action_id === 'allow') {
        console.error('pidge: ALLOWED — the human approved (Face ID). exit 0');
        return exitFlushed(0); // return: nothing below may run before the exit
      }
      console.error(`pidge: DENIED — the human chose "${(chosen && chosen.action_id) || '?'}" (deny-default: only an explicit allow is exit 0). exit 1`);
      return exitFlushed(1);
    },
    onTimeout: () => {
      console.log(JSON.stringify({ decision: 'deny', reason: 'timeout', correlation_id: cid }));
      console.error('pidge: no answer before the timeout — DENIED (deny-default; a gate must fail closed). exit 1');
      return exitFlushed(1);
    },
  });
}

// A compat alias: the OLD type name still works, mapped to the new
// canonical one — a one-line note points at the rename so muscle-memory migrates.
function warnRenamed(oldName, newName) {
  console.error(`pidge: \`pidge ${oldName}\` was renamed → use \`pidge ${newName}\` (the married catalog of 5; the alias keeps working).`);
}

// `pidge notify` / `pidge send` (no type) are deprecated — they still send, and the
// server falls back to the channel default. Prefer a typed send. Warning is local.
function warnDeprecatedSend(name) {
  console.error(`pidge: \`pidge ${name}\` is deprecated — use a TYPE instead: message · important · urgent · event · live (or the ask/approval shortcuts; see \`pidge help\`). It still sends (no template_kind ⇒ the server picks the channel default).`);
}

// --- Composer-wake (0.32, server manifest v91) ------------------------------
// The blindspot this kills: a blocking wait used to watch ONE notification
// while the human's composer messages piled up unread on the /messages queue —
// to the human it's ONE conversation (they type in the same chat where they
// tap your buttons), and the answer they typed was silently diverted to a
// queue nobody was reading. Now every default wait ALSO asks the server to
// wake on a deliverable composer message (?wake_on_message=true) and, when the
// response says messages_pending, DRAINS the queue through the one consume
// path (GET /messages — the delivered-lease/ack contract stays intact) and
// returns it as a TYPED result (kind:"human_message"). Skipped when a running
// `pidge bridge` owns this channel's queue (the bridge wakes your handler
// itself) and on onAnswer flows (`approve` keeps its exit-code contract — a
// free-text composer line can never approve).
async function drainComposerQueue() {
  try {
    const res = await fetchT(`${BASE}/api/v1/messages?continuity=true`, { headers });
    if (res.status !== 200) return null;
    const data = await res.json().catch(() => ({}));
    warnStalePriorClaim(data);
    warnConsumerConflict(data);
    const raw = data.messages || [];
    if (!raw.length) return null; // raced — another consumer took them; keep waiting
    const msgs = annotateVoiceAttachments(await Promise.all(raw.map((m) => e2eOpenMessageRow(m))));
    const contexts = await e2eOpenContinuityContexts(data && data.continuity_contexts);
    return { msgs, contexts };
  } catch { return null; }
}

// Print the drained composer messages as the wait's typed result and exit 0.
// kind:"human_message" is the discriminator — a chosen_action parser switching
// on kind sees a NEW kind, never a mis-shaped answer. The notification stays
// unanswered: the note says so, and says how to resume.
async function exitWithComposerMessages(cid, { msgs, contexts }) {
  for (const ctx of contexts || []) console.log(JSON.stringify({ type: 'continuity_context', ...ctx }));
  const upTo = Math.max(...msgs.map((m) => m.id));
  console.log(JSON.stringify({
    kind: 'human_message',
    note: `the human wrote in the channel composer while you waited — handle it FIRST. Your notification ${cid} is STILL unanswered: resume with \`pidge wait ${cid}\` afterwards (or answer the human with a new send, reusing thread_id). Working on it for more than ~15 s before you answer? Run \`pidge typing\` first — the human sees the three dots instead of silence.`,
    pending_notification: cid,
    messages: msgs,
  }, null, 2));
  console.error(`pidge: ${msgs.length} composer message(s) DELIVERED (gray ✓✓), NOT done — ACK AFTER you handle them: \`pidge ack --up-to ${upTo}\` (the ~10-min lease re-serves un-acked rows).`);
  // the drained messages are on stdout — drain the PIPE before exiting, or a
  // slow reader gets a truncated batch (see exitFlushed). Callers must await.
  return exitFlushed(0);
}

// Poll GET /notifications/:cid until a TERMINAL answer, print chosen_action JSON to
// stdout, exit 0. A snooze (snooze / reschedule-to-a-time) is non-terminal — it
// re-fires — so keep waiting through it. Exits 3 on timeout.
// 0.32: the same wait also hears the composer plane (see drainComposerQueue
// above) — a composer message arriving mid-wait returns kind:"human_message".
// Long-poll: each GET carries ?wait=N (≤55 s) and the SERVER holds it until
// the user acts — answer latency ~instant, ~1 request/min. --interval is only the
// fallback pace against an old server that ignores `wait` (returns immediately).
// onAnswer(chosen)/onTimeout() let a caller (approve) MAP the outcome to an
// exit code instead of the default print-chosen+exit-0 / exitTimeout. Both
// callbacks MUST exit the process; when omitted the wait/ask behavior stands.
async function doWait(cid, { timeout, interval, onAnswer, onTimeout } = {}) {
  const deadline = Date.now() + timeout * 1000;
  let firedNotice = false;
  // Composer-wake (0.32): only the default print-and-exit contract returns
  // typed human messages; an onAnswer flow (approve) stays notification-only.
  // A live consumer (a bridge, or your own `listen`) owns the queue — a wait
  // must never double-consume it, and the asymmetry is narrated, not silent.
  const consumer = bridgeLockHolder();
  narrateLiveConsumer(consumer);
  const wakeQueue = !onAnswer && !consumer;
  for (;;) {
    // Degraded: a held poll keeps dying behind some edge — switch to
    // PLAIN GETs (the requests that kept working in the wild) on a slow pace.
    const waitS = health.degraded ? 0 : Math.max(0, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)));
    // wake_on_message rides even the degraded plain GETs — the flag is
    // computed on any read; only the HOLD needs ?wait=.
    const qs = new URLSearchParams();
    if (waitS > 0) qs.set('wait', String(waitS));
    if (wakeQueue) qs.set('wake_on_message', 'true');
    const url = `${BASE}/api/v1/notifications/${encodeURIComponent(cid)}${qs.size ? `?${qs}` : ''}`;
    const askedAt = Date.now();
    try {
      const res = await fetchT(url, { headers }, (waitS + 10) * 1000);
      await checkManifestNews(res);
      if (res.status === 200) {
        health.ok();
        const data = await res.json().catch(() => ({}));
        if (data.responded) {
          await e2eOpenChosen(data); // sealed answer → plaintext (gated on data.enc)
          const chosen = data.chosen_action || {};
          // The answer never masks the backlog: say the queue is non-empty
          // BEFORE exiting (deliberately not drained here — draining would
          // lease the rows and make the suggested `pidge listen` read empty).
          if (data.messages_pending)
            console.error('pidge: your queue ALSO holds composer message(s) from the human — read them before moving on: `pidge listen` (or `pidge catchup`, read-only).');
          if (chosen.kind === 'snoozed') {
            console.error(`pidge: snoozed until ${chosen.snooze_until || chosen.at} — re-fires then, still waiting`);
          } else if (onAnswer) {
            return onAnswer(chosen);
          } else {
            console.log(JSON.stringify(chosen, null, 2));
            await exitFlushed(0); // the answer is on stdout — drain the pipe first
          }
        } else if (wakeQueue && data.messages_pending) {
          const drained = await drainComposerQueue();
          if (drained) await exitWithComposerMessages(cid, drained);
          // raced empty (another consumer took the rows) — keep waiting
        } else if (!firedNotice && data.escalation && data.escalation.state === 'fired') {
          firedNotice = true;
          // stopping the ring on-device now reports `seen` (seen_at flips);
          // snoozing it is a real snoozed event this loop narrates.
          console.error('pidge: the escalation alarm FIRED and there is still no answer — seen_at tells you if the human at least silenced it; keep waiting or back off');
        }
      } else if (res.status === 404) {
        health.ok(); // the server ANSWERED an AUTHORIZED read — the channel is fine, the cid isn't known (yet)
        console.error(`pidge: no notification for correlation_id=${cid}`);
        // keep polling — the agent may call wait/ask before the send round-trips
      } else if (res.status === 401 || res.status === 403) {
        dieKeyRejected('wait', res.status); // a wall, not a timeout — never health.ok()
      } else if (res.status >= 500) {
        health.fail(`poll error ${res.status}`); // aggregated — no line per failure
      } else {
        // Any other 4xx: the server answered, but NOT with the round-trip this
        // loop exists to prove. Never ok() (it would certify a channel that
        // answered "no"), never a verdict on its own either — just a failure.
        health.fail(`poll error ${res.status}`);
        console.error(`pidge: poll error ${res.status}`);
      }
    } catch (e) {
      health.fail(`network: ${e.message}`);
    }

    if (Date.now() >= deadline) {
      if (onTimeout) return onTimeout();
      await health.exitTimeout(`no answer on ${cid}`);
    }
    // A server WITH long-poll just held us for waitS — loop right back. One that
    // ignored `wait`, an error, or degraded mode returned fast: pace ourselves.
    const pace = health.degraded ? DEGRADED_INTERVAL_S : interval;
    if (Date.now() - askedAt < 2000) {
      await sleep(Math.min(pace, Math.max(1, Math.ceil((deadline - Date.now()) / 1000))) * 1000);
    }
  }
}

// Realtime wait: hold an InboxChannel subscription and treat every frame
// for OUR cid as a wake-up; the durable answer is always re-read over HTTP
// (doWait prints + exits). A safety re-check every 60 s covers a frame lost in
// a reconnect gap. Returns only when WS can't carry us — caller falls back.
// 0.32: the same hold also hears the composer plane — a ConversationChannel
// subscription (plus the safety probe's messages_pending) wakes the drain.
async function realtimeWait(cid, { timeout, interval, onAnswer, onTimeout } = {}) {
  const deadline = Date.now() + timeout * 1000;
  // Same gate as doWait: default contract only, never over a live consumer
  // (a bridge or your own `listen`) — narrated once, never refused.
  const consumer = bridgeLockHolder();
  narrateLiveConsumer(consumer);
  const wakeQueue = !onAnswer && !consumer;
  // 'answered' | 'composer' | false — one authoritative HTTP read for both planes.
  const probe = async () => {
    try {
      const res = await fetchT(`${BASE}/api/v1/notifications/${encodeURIComponent(cid)}${wakeQueue ? '?wake_on_message=true' : ''}`, { headers });
      if (res.status !== 200) return false;
      const data = await res.json().catch(() => ({}));
      if (data.responded && data.chosen_action && data.chosen_action.kind !== 'snoozed') return 'answered';
      if (wakeQueue && data.messages_pending) return 'composer';
      return false;
    } catch { return false; }
  };
  let safety = null;
  let finishInbox = null;
  const check = () => probe().then((r) => r && finishInbox && finishInbox(r));
  const sessions = [cableSession({
    channel: 'InboxChannel',
    params: wsIdentityParams(),
    deadline,
    onUp: (finish) => {
      health.ok();
      finishInbox = finish;
      // catch an answer (or a queued composer message) that landed while we
      // were connecting/offline
      check();
      clearInterval(safety);
      safety = setInterval(check, 60000);
    },
    onFrame: (m, finish) => {
      if (m.type !== 'event' || m.correlation_id !== cid) return;
      if (m.kind === 'delivered') console.error('pidge: delivered to the phone');
      else if (m.kind === 'seen') console.error('pidge: the human OPENED it (no answer yet)');
      else if (m.kind === 'snoozed') console.error(`pidge: snoozed until ${m.snooze_until || m.at} — re-fires then, still waiting`);
      else if (m.responded) finish('answered');
    },
  })];
  // Composer plane: messages broadcast on ConversationChannel, not Inbox — a
  // second subscription wakes the same typed-result path (the queue is the
  // ledger; the loser session leaks until exit, harmless in a one-shot process).
  if (wakeQueue) {
    sessions.push(cableSession({
      channel: 'ConversationChannel',
      params: wsIdentityParams(),
      deadline,
      onUp: () => {},
      onFrame: (m, finish) => { if (m.type === 'message') finish('composer'); },
    }));
  }
  const outcome = await Promise.race(sessions);
  clearInterval(safety);
  if (outcome === 'composer') {
    const drained = await drainComposerQueue();
    if (drained) await exitWithComposerMessages(cid, drained);
    // raced empty (another consumer took the rows) — hand the remaining budget
    // to the poller, which re-holds with the wake armed. Not a WS failure, so
    // no "realtime unavailable" line.
    return Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
  }
  if (outcome === 'answered') {
    // fetch + resolve (print+exit, or the caller's onAnswer/onTimeout mapping) via
    // the poller (one quick authoritative read)
    await doWait(cid, { timeout: Math.max(10, Math.ceil((deadline - Date.now()) / 1000)), interval, onAnswer, onTimeout });
  }
  // Only exit-as-timeout if the REAL deadline genuinely passed. An EARLY
  // 'deadline' (a spurious guard, a WS oddity) must degrade to polling for the
  // remaining budget, NOT exit lying that the full timeout elapsed.
  if (outcome === 'deadline' && Date.now() >= deadline - 1500) {
    if (onTimeout) return onTimeout();
    await health.exitTimeout(`no answer on ${cid}`);
  }
  console.error(`pidge: realtime unavailable (${outcome}) — falling back to HTTP polling for this wait (same contract, less instant); the socket is tried again on the next command`);
  return Math.max(1, Math.ceil((deadline - Date.now()) / 1000)); // remaining budget
}

// wait/ask entry: WS when we can, polling as the universal fallback.
// onAnswer/onTimeout thread through to both paths so `approve` can map the
// outcome to an exit code; omit them for the default print-and-exit-0 behavior.
async function waitForAnswer(cid, { timeout, interval, onAnswer, onTimeout } = {}) {
  let budget = timeout;
  if (wantRealtime()) budget = await realtimeWait(cid, { timeout, interval, onAnswer, onTimeout });
  await doWait(cid, { timeout: budget, interval, onAnswer, onTimeout });
}

const num = (val, fallback) => (val !== undefined ? parseInt(val, 10) : fallback);

// STRICT variant for the blocking knobs (--timeout/--interval). parseInt('abc')
// → NaN would make doWait's deadline NaN — never reached — so wait/ask/approve/hello
// would poll FOREVER; on `pidge approve` that turns the deny-default gate into an
// agent hung open. An unparseable value dies IMMEDIATELY (exit 1), before any send.
const numStrict = (val, flag, fallback) => {
  if (val === undefined) return fallback;
  const n = parseInt(val, 10);
  if (!Number.isFinite(n))
    die(`pidge: ${flag} ${JSON.stringify(val)} is not a number of seconds — refusing to wait forever (fail-closed). exit 1`, 1);
  return n;
};

// message-queue ids are STRICT integers. parseInt alone is lazy —
// parseInt("9f2e7c31-…") === 9 — so an agent that pastes a correlation_id where
// the numeric listen id belongs would silently ack messages 1..9 it never
// handled (at-least-once loss, the exact class the strict --timeout parse killed).
// Full-string digits or die loud, BEFORE any HTTP.
const idStrict = (val, flag) => {
  const s = String(val).trim();
  if (!/^\d+$/.test(s))
    die(`pidge: ${flag} ${JSON.stringify(val)} is not a numeric message id — it takes the NUMERIC id from listen output, never the correlation_id. exit 1`, 1);
  return parseInt(s, 10);
};

// ---------------------------------------------------------------------------
// Onboarding v2: setup --claim / doctor / whoami / skill install.
// ---------------------------------------------------------------------------

// (CONFIG_DIR/CONFIG_FILE are defined early — right after TOKEN — so the identity
// headers can hash CONFIG_FILE at the module-level `headers` const.)
// True when we're reading the LEGACY shared file (no PIDGE_AGENT, no env var,
// NOT the project scope) — the multi-agent footgun. doctor warns on it. A
// FUNCTION (not a load-time const): setup retargets CONFIG_DIR mid-process, and
// a project-scoped identity must never be scolded as "the shared file".
function onSharedFile() {
  return !AGENT_ID && !ENV_TOKEN_SET && CONFIG_DIR === pidgeBaseDir()
    && !!readEnvFile(CONFIG_FILE).PIDGE_TOKEN;
}

// Where the token came from — doctor narrates it, setup respects precedence.
function tokenSource() {
  if (ENV_TOKEN_SET) return 'env var (per-agent)';
  if (FILE_ENV.PIDGE_TOKEN) {
    const scope = AGENT_ID ? ` (PIDGE_AGENT=${AGENT_ID})`
      : CONFIG_DIR === PROJECT_CONFIG_DIR ? ' (this project)' : ' (shared)';
    return CONFIG_FILE + scope;
  }
  return null;
}

// GET /whoami — which channel does this key speak for. Returns {res, data}.
async function fetchWhoami(base = BASE, token = TOKEN) {
  const res = await fetchT(`${base}/api/v1/whoami`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...identityHeaders() },
  });
  let data = {};
  try { data = await res.json(); } catch { /* leave {} */ }
  return { res, data };
}

// identity ownership: a STABLE, privacy-safe per-install fingerprint (a
// HASH, never raw hostname/PII) so the server can tell THIS install apart from a
// different agent that grabbed the same key. The label is the human-readable
// self-name (PIDGE_LABEL, else PIDGE_AGENT, else the hostname).
//
// SALT (hardening for the server's retry-safe claim, which re-exchanges a bound
// code to the SAME fingerprint within its TTL): without one, the fingerprint is
// derivable from public machine facts (hostname|username|agent|path) — an
// attacker who swept the pasted prompt AND can guess those could hijack the
// retry window. A FRESH identity dir mints a random per-install salt
// (fp-salt, 0600) BEFORE any claim binds, making the fingerprint unguessable.
// COMPAT IS LOAD-BEARING: an EXISTING install (env file present, no salt file)
// keeps the legacy unsalted derivation FOREVER — its fingerprint is already
// bound into server claims and provenance, and changing it would break the
// v84 mid-setup retry and re-identify the fleet. The salt-file check wins over
// the env-file check, so a fresh setup that minted a salt and then crashed
// before writing env stays on ITS salt (the claim it bound is still
// re-exchangeable — the same retry-safety the salt exists to protect).
// (FP_SALT_CACHE is declared up by CONFIG_FILE — identityHeaders() reads it at
// module load, so it must be initialized before then, not here.)
function fingerprintSalt() {
  if (FP_SALT_CACHE && FP_SALT_CACHE.dir === CONFIG_DIR) return FP_SALT_CACHE.salt;
  let salt = '';
  const saltFile = path.join(CONFIG_DIR, 'fp-salt');
  try {
    salt = fs.readFileSync(saltFile, 'utf8').trim();
  } catch {
    // No salt file. Existing install (env already on disk) ⇒ legacy, no salt —
    // NEVER re-identify it. Brand-new identity dir ⇒ mint + persist one now
    // (before any claim can bind). Persist failure ⇒ degrade to legacy ('')
    // rather than an UNSTABLE random-per-process identity: a fingerprint that
    // changes every invocation would break claim retry and "(you)" markers.
    if (!fs.existsSync(CONFIG_FILE)) {
      try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
        const minted = crypto.randomBytes(16).toString('hex');
        fs.writeFileSync(saltFile, minted + '\n', { mode: 0o600 });
        salt = minted;
      } catch { salt = ''; }
    }
  }
  FP_SALT_CACHE = { dir: CONFIG_DIR, salt };
  return salt;
}
function agentFingerprint() {
  const parts = [ os.hostname(), os.userInfo().username || '', AGENT_ID, CONFIG_FILE ];
  // Legacy compat is byte-exact: no salt ⇒ the material is IDENTICAL to the
  // pre-salt formula (no trailing separator) — an existing install's
  // fingerprint must never move.
  const salt = fingerprintSalt();
  if (salt) parts.push(salt);
  const material = parts.join('|');
  return 'fp_' + crypto.createHash('sha256').update(material).digest('hex').slice(0, 24);
}
function agentLabel() {
  const raw = (process.env.PIDGE_LABEL || AGENT_ID || os.hostname() || 'pidge-cli').slice(0, 80);
  // .slice(0, 80) cuts by CODE UNIT and can split a
  // surrogate pair (an astral char — emoji — at the 80 boundary). A lone
  // surrogate makes encodeURIComponent THROW URIError, and identityHeaders()
  // feeds the module-level `headers` const — so EVERY verb would die at load,
  // purely input-dependent. Sanitize to well-formed UTF-16: toWellFormed()
  // (Node ≥20) swaps lone surrogates for U+FFFD; the regex fallback (engines
  // allow Node ≥18) strips them instead — either way, encodable.
  return raw.toWellFormed
    ? raw.toWellFormed()
    : raw.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

// Multi-runtime v2: the per-REQUEST agent identity, sent on EVERY HTTP
// call as headers. Same fingerprint/label the claim computes — the claim
// becomes the server's FALLBACK; these headers are the primary. The label is
// URI-encoded (PIDGE_LABEL may be UTF-8, and raw bytes >127 are undefined across
// proxies/undici; the server decodes + sanitizes). Advisory, never auth (any key
// holder can wear any identity). An OLDER server ignores
// unknown headers, so this is harmless against an older server (release is gated
// on S1+S2 only so the PRINTED features exist, not because headers need lockstep).
// v126 (a live migration's finding): the bridge and the interactive watch share
// one fingerprint, so whoami could not tell "the stand-in answered" from "the
// live agent answered". The consumer says what it IS: watch (a harness-owned
// session-length watch), listen (one interactive round), bridge (the daemon).
// Sent only by the consuming commands; a send/whoami/doctor carries none.
function consumerKind() {
  if (command === 'bridge' && parsed.positionals[1] === undefined) return 'bridge';
  if (command === 'listen' || command === 'online') {
    const t = v.timeout === undefined ? NaN : Number(v.timeout);
    return v.follow && t === 0 ? 'watch' : 'listen';
  }
  return null;
}
function identityHeaders() {
  const kind = consumerKind();
  return {
    'x-pidge-fingerprint': agentFingerprint(),
    'x-pidge-label': encodeURIComponent(agentLabel()),
    ...(kind ? { 'x-pidge-consumer-kind': kind } : {}),
    // SIGN the call with the execution when a run bearer is in the env — so the
    // human sees which run spoke. Present-only: no run ⇒ unsigned (identical to
    // before). Advisory (never auth) and rides EVERY channel-key call because
    // this set feeds the shared `headers` const + whoami/claim/contract/skill.
    ...(RUN_TOKEN ? { 'x-pidge-run': RUN_TOKEN } : {}),
  };
}
// WS transport: identity rides the ActionCable subscribe params as
// JSON (NOT URI-encoded — it's a JSON string value, not a header). Passed only on
// the REAL consume subscribes (listen/wait/bridge), never the doctor realtime
// probe — a read-only diagnosis must not mint a phantom consumer.
function wsIdentityParams() {
  const kind = consumerKind();
  return { fingerprint: agentFingerprint(), label: agentLabel(), ...(kind ? { kind } : {}) };
}

// first-run notice: show the ack-after-work BREAKING-flip contract ONCE PER
// INSTALL (a stamp under the config dir), not every invocation — a turn-based
// agent runs a FRESH process per turn, so an in-process flag would shout every
// time. Best-effort: if the stamp can't be persisted (env-var-only install /
// read-only fs) the caller's per-process guard still shows it once per run.
const ACK_NOTICE_STAMP = path.join(CONFIG_DIR, '.ack_notice_seen');
function ackNoticeAlreadySeen() {
  try { return fs.existsSync(ACK_NOTICE_STAMP); } catch { return false; }
}
function markAckNoticeSeen() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(ACK_NOTICE_STAMP, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch { /* best-effort — per-process guard covers it */ }
}

// Shared by `doctor` AND `whoami`: narrate HONEST device reach —
// `deliverable` (push-enabled AND on the live APNs environment) can be lower than
// the headline pushable count. Returns true when reach is BROKEN: devices exist
// but NONE are deliverable (a send reaches nobody). doctor exits 2 on that.
function reportDeviceReach(data) {
  const reach = data.device_reach;
  if (!reach) return false;
  // Three counts, three meanings — name them, or the human reads two denominators
  // in one output: `devices` (the headline above) counts PUSHABLE registrations;
  // reach.total counts EVERY registration incl. push-disabled ones; deliverable
  // is what a real push lands on. Say total explicitly so 3 pushable / 3-of-6
  // deliverable stops reading as a contradiction.
  console.error(`pidge: reach — ${reach.deliverable} of ${reach.total} registered device(s) (incl. push-disabled/old ones) will actually receive a push (${reach.apns_environment} APNs)`);
  if (reach.total > reach.deliverable)
    console.error(`pidge: WARNING — ${reach.total - reach.deliverable} registered device(s) are UNREACHABLE (disabled, or on the wrong APNs environment): a send lands on ${reach.deliverable}, not ${reach.total} ("você pensa que alcança ${reach.total}, alcança ${reach.deliverable}").`);
  return reach.total > 0 && reach.deliverable === 0;
}

// Shared by `doctor` AND `whoami`: SHOUT when a DIFFERENT install claimed
// this channel since we set up. Returns 'hard' (different fingerprint AND higher
// generation), 'soft' (we never claimed locally — informational), or null.
function reportClaimMismatch(data) {
  if (!data.claim) return null;
  // Fresh read of the RESOLVED config file, not the load-time FILE_ENV: inside
  // `setup` the scope was retargeted and the generation/fingerprint were just
  // appended — comparing against a stale (possibly other-scope) snapshot made
  // the post-setup doctor scream "ANOTHER AGENT" about the claim it had itself
  // made seconds earlier.
  const storedEnv = readEnvFile(CONFIG_FILE);
  const localGen = parseInt(storedEnv.PIDGE_CLAIM_GENERATION || '', 10);
  const ourFp = storedEnv.PIDGE_FINGERPRINT || agentFingerprint();
  const srvGen = data.claim.claim_generation;
  const srvFp = data.claim.claimed_by_fingerprint;
  if (srvFp && srvFp !== ourFp && Number.isFinite(localGen) && srvGen > localGen) {
    console.error(`pidge: ⚠️  ANOTHER AGENT CLAIMED THIS CHANNEL — server generation ${srvGen} > yours ${localGen}, now owned by "${data.claim.claimed_by_label}". Your sends may go out as a DIFFERENT identity. If that's not intended, give THIS agent its own PIDGE_AGENT=<id> (isolated config — keep the var set on every later command) or PIDGE_TOKEN, then re-run setup.`);
    return 'hard';
  }
  if (srvFp && srvFp !== ourFp && !Number.isFinite(localGen)) {
    console.error(`pidge: note — this channel is owned by "${data.claim.claimed_by_label}" (generation ${srvGen}); THIS install hasn't claimed it. If you are its agent, run setup to claim ownership (so a future swap becomes detectable).`);
    return 'soft';
  }
  return null;
}

// POST /claim/ownership — stamp WHICH install wears this channel's key, so
// a multi-agent machine can DETECT a silent key swap. Best-effort: a server that
// predates it 404s (skip silently); a network blip never breaks setup. Returns
// the server's claim block or null.
async function claimOwnership(base, token) {
  try {
    const res = await fetchT(`${base}/api/v1/claim/ownership`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...identityHeaders() },
      body: JSON.stringify({ fingerprint: agentFingerprint(), label: agentLabel() }),
    });
    if (res.status !== 200) return null;
    const data = await res.json().catch(() => ({}));
    return data.claim || null;
  } catch { return null; }
}

// step 5: after onboarding, DECLARE how this agent operates so the human
// knows what to expect from this channel. ADVISORY — Pidge enforces nothing; it's
// metadata the human reads. The default is the common case (a turn-based agent:
// one-shot listen, no keep-alive); `--listen-mode always_on` flips it for a
// long-lived supervisor. Non-interactive by design (the safe default is narrated);
// best-effort — a 422/blip never breaks setup. Returns the declared mode or null.
async function declareOperatingContract(base, token, channelId) {
  if (!channelId) return null;
  const mode = v['listen-mode'];
  let contract;
  // turn_based holds no connection; persistent/external_daemon/always_on all keep one
  // alive (a supervisor or daemon holding the listen).
  if (!mode || mode === 'turn_based') contract = { listen_mode: 'turn_based', keep_connection_alive: false };
  else if (['persistent', 'external_daemon', 'always_on'].includes(mode)) contract = { listen_mode: mode, keep_connection_alive: true };
  else { console.error(`pidge: --listen-mode must be turn_based | persistent | external_daemon (got "${mode}") — skipping the contract declaration`); return null; }
  try {
    const res = await fetchT(`${base}/api/v1/channels/${channelId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...identityHeaders() },
      body: JSON.stringify({ operating_contract: contract }),
    });
    if (res.status >= 200 && res.status < 300) {
      const hint = mode ? '' : ' (default — pass --listen-mode always_on for a long-lived supervisor)';
      console.error(`pidge: declared listen_mode=${contract.listen_mode}${hint} — ADVISORY, how you operate (the human sees it; Pidge enforces nothing). Change anytime: pidge contract set listen_mode=...`);
      return contract.listen_mode;
    }
    console.error(`pidge: note — couldn't declare the operating_contract (${res.status}); set it later with \`pidge contract set listen_mode=turn_based\``);
  } catch (e) {
    console.error(`pidge: note — couldn't declare the operating_contract (network: ${e.message}); set it later with \`pidge contract set\``);
  }
  return null;
}

// the CLOSED allowlist (mirrors the server's closed allowlist of contract keys) — so
// `contract set` and `setup` reject an unknown key / bad value type LOCALLY (exit
// 1) before the round-trip, instead of leaning on the server's 422.
const OPERATING_CONTRACT_SPEC = {
  keep_connection_alive: 'boolean',
  mirror_in_origin_session: 'boolean',
  // Match your RUNTIME. turn_based (no event loop — block-and-exit) · persistent
  // (a supervisor holding the socket, --follow) · external_daemon (a daemon outside the
  // session). always_on stays as a tolerated deprecated alias of persistent.
  listen_mode: ['turn_based', 'persistent', 'external_daemon', 'always_on'],
  quiet_when_idle: 'boolean',
};
// Coerce + validate one operating_contract value against the allowlist. Returns
// the typed value, or throws an Error whose message the caller die()s with (exit 1).
function coerceContractValue(key, raw) {
  const spec = OPERATING_CONTRACT_SPEC[key];
  if (!spec) throw new Error(`unknown operating_contract key "${key}" (allowed: ${Object.keys(OPERATING_CONTRACT_SPEC).join(', ')})`);
  if (spec === 'boolean') {
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
    throw new Error(`operating_contract.${key} must be true or false`);
  }
  const value = String(raw);
  if (!spec.includes(value)) throw new Error(`operating_contract.${key} must be one of: ${spec.join(', ')}`);
  return value;
}

// operating_contract: DECLARE how you operate. ADVISORY, never policy —
// nothing derives urgency/ceiling from it and Pidge enforces nothing; you declare,
// the human registers their own expectation and SEES if you honor it.
//   pidge contract show           → print the channel's operating_contract
//   pidge contract set key=value  → PATCH it (key ∈ the closed allowlist above)
async function runContract() {
  const sub = parsed.positionals[1];
  if (sub !== 'show' && sub !== 'set' && sub !== undefined)
    die('pidge: usage: pidge contract set <key>=<value> | pidge contract show', 1);

  // For `set`: parse + validate the key/value LOCALLY (exit 1) BEFORE any network
  // — an unknown key / bad type never reaches the server (the allowlist is closed
  // and known client-side; the server would 422, but a local usage error is
  // faster and clearer, and avoids a needless round-trip).
  let key, value;
  if (sub === 'set') {
    const assignment = parsed.positionals[2];
    if (!assignment || !assignment.includes('=')) die('pidge: usage: pidge contract set <key>=<value>  (e.g. listen_mode=turn_based)', 1);
    const eq = assignment.indexOf('=');
    key = assignment.slice(0, eq);
    const raw = assignment.slice(eq + 1);
    try { value = coerceContractValue(key, raw); } catch (e) { die(`pidge: ${e.message}`, 1); }
  }

  let who;
  try { who = await fetchWhoami(); } catch (e) { die(`pidge: contract failed (network): ${e.message}`, 2); }
  if (who.res.status !== 200) die(`pidge: contract: whoami failed (${who.res.status})`, 2);
  const channelId = who.data.channel && who.data.channel.id;

  if (sub === 'show' || sub === undefined) {
    const oc = who.data.operating_contract || {};
    console.log(JSON.stringify(oc, null, 2));
    const keys = Object.keys(oc);
    console.error(keys.length
      ? `pidge: operating_contract — ${keys.map((k) => `${k}=${JSON.stringify(oc[k].value)}${oc[k].locked ? ' (registered by your human)' : ''}`).join(', ')}`
      : 'pidge: no operating_contract declared yet — set one with `pidge contract set listen_mode=turn_based`');
    process.exit(0);
  }

  let res, body;
  try {
    res = await fetch(`${BASE}/api/v1/channels/${channelId}`, {
      method: 'PATCH', headers, body: JSON.stringify({ operating_contract: { [key]: value } }),
    });
    body = await res.text();
  } catch (e) {
    die(`pidge: contract set failed (network): ${e.message}`, 2);
  }
  await checkManifestNews(res);
  if (!(res.status >= 200 && res.status < 300)) die(`pidge: contract set failed (${res.status}): ${body}`, 2);
  // stdout = ONLY the operating_contract, never the raw channel JSON. The
  // /channels PATCH echoes the whole channel — INCLUDING "key":"hld_…" — and
  // dumping it would land this agent's OWN key in its stdout/transcript/logs
  // (the one thing the whole claim flow exists to avoid). Print just the contract.
  let parsedBody = {};
  try { parsedBody = JSON.parse(body); } catch { /* leave {} */ }
  console.log(JSON.stringify({
    operating_contract: parsedBody.operating_contract || {},
    operating_contract_ignored: parsedBody.operating_contract_ignored
  }, null, 2));
  console.error(`pidge: declared ${key}=${JSON.stringify(value)} (ADVISORY, never policy — the human sees if you honor it; Pidge enforces nothing)`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// `pidge typing [SECONDS|off]` — the phone's three-dot "agent is working on a
// reply" indicator. It is EPHEMERAL, ADVISORY and DISPLAY-ONLY: nothing
// downstream reads it, no push is sent, no history is kept. Two properties make
// it safe to fire and forget: it SELF-EXPIRES on a server-side TTL (an agent
// that dies never leaves the human staring at dots), and any real send on the
// channel clears it at the source (the human sees words, not dots).
// The range is the SERVER's rule, not ours — we warn, we never wall.
// ---------------------------------------------------------------------------
const TYPING_DEFAULT_TTL_S = 60;   // matches the server default; sent explicitly
const TYPING_MIN_TTL_S = 3;
const TYPING_MAX_TTL_S = 300;
// The TTL the automatic bridge/--exec signal asks for (see fireAutoTyping).
const TYPING_AUTO_TTL_S = 120;

async function runTyping() {
  const arg = parsed.positionals[1];
  const usage = `pidge: usage: pidge typing [SECONDS|off]  — bare = ${TYPING_DEFAULT_TTL_S}s · a number = that many seconds (server range ${TYPING_MIN_TTL_S}–${TYPING_MAX_TTL_S}) · \`off\` (or 0) clears it`;
  let ttl;
  if (arg === undefined) ttl = TYPING_DEFAULT_TTL_S;
  else {
    const raw = String(arg).trim().toLowerCase();
    if (raw === 'off') ttl = 0;
    else if (/^\d+$/.test(raw)) ttl = parseInt(raw, 10);
    // Strict, like every other numeric argument here: `pidge typing 2m` must
    // not silently become 2 seconds of dots.
    else die(`${usage}\n  got ${JSON.stringify(arg)}`, 1);
  }
  // Advisory about the server's clamp, never a second wall: the contract lives
  // on the server, and a CLI that re-implements it drifts from it.
  if (ttl > 0 && (ttl < TYPING_MIN_TTL_S || ttl > TYPING_MAX_TTL_S))
    console.error(`pidge: typing ${ttl}s is outside the server's range (${TYPING_MIN_TTL_S}–${TYPING_MAX_TTL_S}s) — the server will CLAMP it. To hold the indicator longer, run \`pidge typing\` again before it lapses.`);
  let res, raw;
  try {
    res = await fetchT(`${BASE}/api/v1/typing`, { method: 'POST', headers, body: JSON.stringify({ ttl_seconds: ttl }) });
    raw = await res.text();
  } catch (e) {
    die(`pidge: typing failed (network): ${e.message}`, 2);
  }
  await checkManifestNews(res);
  if (res.status === 401 || res.status === 403) dieKeyRejected('typing', res.status);
  if (res.status === 404)
    die('pidge: typing — this server predates the typing indicator (/typing 404). Nothing was shown and nothing broke: the signal is display-only. Update the server, or just keep sending.', 2);
  console.log(raw);
  if (!(res.status >= 200 && res.status < 300)) die(`pidge: typing failed (${res.status}): ${raw}`, 2);
  let data = {};
  try { data = JSON.parse(raw); } catch { /* leave {} */ }
  if (ttl === 0 || data.typing === false) {
    console.error('pidge: typing off — the indicator is cleared (it would have self-expired on its own anyway).');
    process.exit(0);
  }
  // Trust the server's `typing_until` over our own arithmetic — it applied the
  // clamp, so it is the only honest answer to "when do the dots go away?".
  const until = data.typing_until ? new Date(data.typing_until) : null;
  const clearsAt = until && !Number.isNaN(until.getTime())
    ? `clears at ${until.toTimeString().slice(0, 8)}`
    : `clears in ~${ttl}s`;
  console.error(`pidge: typing on · ${clearsAt} or on your next send — any real send (message/important/ask/…) turns it off at the source. Run \`pidge typing\` again to extend it; it is display-only, so nothing waits on it.`);
  process.exit(0);
}

// The AUTOMATIC half of the same signal: a batch just arrived from the human and
// a handler is about to think about it, so the phone should show the dots
// without anyone remembering to ask. FIRE-AND-FORGET by construction — it is
// never awaited, its failure is never narrated and it can never delay, fail or
// otherwise touch the round (an old server 404s, a wedged proxy hangs, and the
// handler runs exactly the same). The TTL means a handler that crashes still
// stops the dots on its own; the handler's own reply clears them at the source.
// Opt out with PIDGE_NO_AUTO_TYPING=1.
function fireAutoTyping(ttlSeconds = TYPING_AUTO_TTL_S) {
  if (process.env.PIDGE_NO_AUTO_TYPING === '1') return;
  if (!TOKEN) return;
  try {
    fetchT(`${BASE}/api/v1/typing`, {
      method: 'POST', headers, body: JSON.stringify({ ttl_seconds: ttlSeconds }),
    }, 5000)
      // Drain the body so the socket can close, then swallow EVERYTHING: this
      // call has no verdict anyone is allowed to act on.
      .then((r) => r.text().catch(() => ''))
      .catch(() => { /* display-only signal — a failure here is not news */ });
  } catch { /* never let a synchronous throw reach the spawn path */ }
}

// The OTHER half of the automatic signal, and the one that makes it HONEST: the
// handler is done, so the dots go out NOW instead of coasting to their TTL.
// Without this the phone says "working on it" for up to TYPING_AUTO_TTL_S after
// the work stopped — measured live 2026-08-25, ~50 s of dots with no consumer
// alive at all ("nao sei se vc esta trabalhando ou nao... era pra aparecer
// somente se o agent estiver de fato trabalhando para mim"). A handler that
// REPLIED already cleared them at the source; this covers the one that finished
// silently, failed, timed out or was killed. Same fire-and-forget contract as
// its sibling: never awaited, never narrated, never a verdict.
// Returns a promise that ALWAYS resolves — the caller awaits it only to be sure
// the write LEFT the process, never to learn anything from it.
function clearAutoTyping() {
  if (process.env.PIDGE_NO_AUTO_TYPING === '1') return Promise.resolve();
  if (!TOKEN) return Promise.resolve();
  try {
    return fetchT(`${BASE}/api/v1/typing`, {
      method: 'POST', headers, body: JSON.stringify({ ttl_seconds: 0 }),
    }, 5000)
      .then((r) => r.text().catch(() => ''))
      .then(() => {}, () => {});   // display-only signal — a failure here is not news
  } catch { return Promise.resolve(); /* a teardown path must never throw */ }
}

// How long a round may spend making sure "not typing" actually left the process.
// NOT a wait on a verdict — the batch's outcome is decided before we get here.
// It exists because fire-and-forget loses the race against a prompt
// `process.exit()`, and a dropped clear is exactly the lie being fixed: a FAILED
// handler exits fast enough to lose it (proven by test, found on a real phone).
const TYPING_CLEAR_GRACE_MS = 1200;

// Orphan-zombie guard: when `npx pidge-cli listen` is launched as a
// background task and the harness later kills the npx wrapper, the node LEAF can
// orphan and keep consuming the channel forever without ever waking the agent. A
// long-running listen polls its parent: if it had a real parent at startup and that
// parent dies (re-parented to pid 1), it exits so it stops eating the queue. Skipped
// when started detached (ppid 1 already — e.g. an external_daemon under systemd).
// The ancestry this process was launched under, oldest last: [{pid, comm}].
// `ps` works on Linux and macOS alike; a missing ps yields [] (pid-only guard).
function ancestry(maxDepth = 12) {
  const out = [];
  try {
    const { spawnSync } = require('node:child_process');
    let pid = process.ppid;
    for (let i = 0; i < maxDepth && pid > 1; i++) {
      // args, not comm: on some builds node's main thread is named "MainThread"
      // and comm reports THAT (measured on a CI runner — the harness went unpinned).
      const r = spawnSync('ps', ['-o', 'ppid=,args=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 });
      const m = /^\s*(\d+)\s+(.*)$/.exec((r.stdout || '').trim());
      if (!m) break;
      const argv0 = (m[2].trim().split(/\s+/)[0] || '');
      out.push({ pid, comm: path.basename(argv0) });
      pid = Number(m[1]);
    }
  } catch { /* no ps — pid-only guard below */ }
  return out;
}
const HARNESS_COMM = /^(claude|codex|gemini|node)$/; // the agent runtimes that own a watch
function installOrphanWatchdog() {
  if (process.ppid === 1) return; // already detached — nothing to orphan from
  // The HARNESS is what must stay alive, not the shell between us. Measured:
  // three watches outlived their dead Claude Code sessions for hours because
  // the `bash -c`/`sh -c` wrappers survived — the server stayed green while
  // nobody read a line (deaf consumers). Pin the nearest ancestor that looks
  // like an agent runtime at start and exit the moment it is gone.
  const chain = ancestry();
  const harness = chain.find((a) => HARNESS_COMM.test(a.comm) && a.pid !== process.ppid) || chain.find((a) => HARNESS_COMM.test(a.comm)) || null;
  // Say what was pinned (once, stderr): a watchdog that silently pinned nothing
  // is indistinguishable from one that works — until a session dies.
  if (process.env.PIDGE_WATCHDOG_TRACE === '1' || v.follow)
    console.error(`pidge: watchdog — ${harness ? `pinned harness ${harness.comm} (pid ${harness.pid})` : 'no agent-runtime ancestor found'}; ancestry: ${chain.map((a) => `${a.comm}:${a.pid}`).join(' ← ') || '(ps unavailable)'}`);
  const t = setInterval(() => {
    if (process.ppid === 1) {
      console.error('pidge: parent process died — exiting so I stop consuming the channel (orphan-zombie guard). Relaunch from your harness.');
      process.exit(0);
    }
    if (harness && !pidAlive(harness.pid)) {
      console.error(`pidge: the harness that launched me (${harness.comm}, pid ${harness.pid}) is gone — exiting so the channel reads OFFLINE instead of a deaf consumer. Relaunch the watch from a live session.`);
      process.exit(0);
    }
  }, 2000);
  if (t.unref) t.unref(); // never keep the process alive just for the watchdog
}

// ---------------------------------------------------------------------------
// The digest's per-row state — THREE states, not two. Deriving it
// from acked_by_label/handler_summary ALONE (the old two-state code) marked a row
// PENDING whenever the ack carried no note — even when the server had stamped
// `processed_at`. In the anti-redo tool, that's the worst lie: a successor reads
// PENDING and re-does finished work. So:
//   · handler_summary present        → `handled by X: <summary>`   (done, with a note)
//   · processed (processed_at OR a    → `✓ acked[ by X] (no note)`  (done, silently)
//     label) but no note                …or, when the server says the ack was
//                                       MUTE: `(mute — no note, nothing sent after)`
//   · neither                         → `PENDING`                    (genuinely not done)
function digestHandledState(m) {
  if (m.handler_summary) {
    const who = m.acked_by_label || 'another consumer';
    return `handled by ${who}: ${String(m.handler_summary).replace(/\s+/g, ' ').trim()}`;
  }
  if (m.processed_at || m.acked_by_label) {
    // A DRAINED row (server ≥ v112) is a MUTE ack: processed, no note, and
    // nothing sent afterwards — plumbing, not work. It used to render exactly
    // like a quiet-but-real ack, so a successor read "someone handled this"
    // where the truth is "someone made it disappear". Absent field (older
    // server) keeps the old text — never a claim built on a missing field.
    if (m.handled_state === 'drained')
      return `✓ acked${m.acked_by_label ? ` by ${m.acked_by_label}` : ''} (mute — no note, nothing sent after)`;
    return `✓ acked${m.acked_by_label ? ` by ${m.acked_by_label}` : ''} (no note)`;
  }
  return 'PENDING';
}

// stale_from_prior_claim — newer servers serve it (Bool, top-level) on the
// channel-key GET /messages and on /whoami: the channel holds un-acked messages
// whose arrival PREDATES this install's ownership claim — probably a previous
// owner's leftover work, not fresh asks for you. ADVISORY in tone by design:
// the anchor has known false negatives (claim-code exchange doesn't set
// claimed_at) and false positives (a same-fingerprint re-doctor refreshes the
// anchor — benign, self-clears on drain). Surfaces:
// listen (session header), doctor, catchup, and the bridge boot.
// Warned ONCE per process (a long-lived bridge doesn't re-shout every poll).
let stalePriorClaimWarned = false;
const STALE_PRIOR_CLAIM_HINT = 'Run `pidge catchup` (read-only) to see what they are before acting on them.';
function warnStalePriorClaim(data, hint = STALE_PRIOR_CLAIM_HINT) {
  if (!data || data.stale_from_prior_claim !== true || stalePriorClaimWarned) return;
  stalePriorClaimWarned = true;
  console.error(`pidge: ⚠️ this channel holds unprocessed messages from a PRIOR claim — probably a previous owner's leftover work, not fresh asks for you (advisory). ${hint}`);
}

// ---------------------------------------------------------------------------
// Multi-runtime v2 surfacing — all PRESENT-ONLY: an older server omits the
// fields, so it yields silence, never a break.
// ---------------------------------------------------------------------------

// whoami/doctor: the channel's LIVE consumers. "(you)" is marked CLIENT-side
// by fingerprint compare — the server stays symmetric (no `you` flag).
// ⚠️ on consumer_conflict; a nudge on unattributed_listening.
function reportConsumers(data) {
  if (!Array.isArray(data.consumers)) return; // older server / no block
  const ours = agentFingerprint();
  const live = data.consumers.filter((c) => c && c.live);
  if (!live.length) {
    console.error('pidge: consumers — none live on this channel right now');
  } else {
    const line = live.map((c) => {
      const you = c.fingerprint === ours ? ' (you)' : '';
      const listening = c.listening ? ', listening' : '';
      return `${c.label || c.fingerprint || 'unknown'}${you}${listening}`;
    }).join(' · ');
    console.error(`pidge: consumers — ${live.length} live: ${line}`);
  }
  if (data.consumer_conflict === true)
    console.error('pidge: ⚠️  consumer_conflict — 2+ live consumers on this channel. One channel = one consumer: if that\'s a bridge/daemon, SITUATE with `pidge catchup` and do NOT `listen` here (double-consume).');
  if (data.unattributed_listening === true)
    console.error('pidge: note — an UNIDENTIFIED consumer is listening here (an old CLI, pre-0.25). It won\'t show above; upgrade it so its identity surfaces.');
}

// whoami/doctor: the predecessor's ack hygiene (the provenance block) — the
// "left N acks blind" nudge the successor reads first.
function reportProvenance(data) {
  const p = data.provenance;
  if (!p || typeof p !== 'object') return; // older server / no block
  const bits = [];
  if (p.processed != null) bits.push(`${p.processed} processed`);
  if (p.processed_without_summary) bits.push(`${p.processed_without_summary} acked WITHOUT a note`);
  if (p.processed_unattributed) bits.push(`${p.processed_unattributed} with no identity at all`);
  if (!bits.length) return;
  const since = p.since ? ` (since ${p.since})` : '';
  console.error(`pidge: provenance${since} — ${bits.join(' · ')}. A note-less ack means the work was done SILENTLY (\`pidge catchup\` can't say what) — get in the habit of \`ack --summary\`.`);
}

// The stay-online nudge — the product's core loop, said out loud at the moments
// an agent decides what to do NEXT (setup/hello/doctor just succeeded). Presence
// is a LOOP, not a state: listen (background, harness-tracked) → handle → ack →
// RELAUNCH. The relaunch is the step turn-based agents forget — the queue keeps
// messages safe meanwhile, but the human sees "offline" until something listens.
// stderr ONLY (stdout stays parseable JSON for agents), and SUPPRESSED when the
// channel already has a live consumer: nudging `listen` next to a live
// bridge/daemon would bait the exact double-consume the lockfile exists to stop.
// 0.53.2 (the Codex zero-test finding): an agent with no relaunching harness
// ran ONE synchronous listen, exited, and told its human "currently online" —
// while the server measured offline. Prose alone demonstrably does not stop
// that (the loop reference already carried the bridge fork and was read). What
// bites is a PROOF STEP: selftest turns "I think I'm online" into a measured
// FAIL the agent must confront, and whoami is the state the human actually sees.
const STAY_ONLINE_NUDGE = 'pidge: NEXT — stay online, as YOU: your human expects to reach the session they are talking to, from the phone, like a chat — never another agent answering in your place. A listener inside your session dies WITH your session (the harness kills a background task when the turn ends — observed), so run a session-length watch your harness OWNS: Claude Code → Monitor({command:\'pidge online --follow --ndjson --timeout 0\', persistent:true}); no such tool → run `npx -y pidge-cli@latest online` in the FOREGROUND and run it again each time it returns (it blocks until a message, up to 10 min): you are online while you keep calling — NEVER in a background terminal that does not wake you (a deaf consumer: green for the server, silent for your human). Stop calling and you are offline; say so. Handle → reply through `pidge message` → `pidge ack --up-to <id>`. When your session ends your human sees you OFFLINE — correct; never claim otherwise (`pidge whoami` shows what they see; `pidge selftest` PROVES a live watch). A bridge is another agent: only if your human asked for a stand-in.';
async function nudgeStayOnline(data = null) {
  try {
    if (!data) data = (await fetchWhoami()).data; // hello has no whoami in hand — best-effort
  } catch { return; } // the nudge must never fail the command that just succeeded
  const live = Array.isArray(data.consumers) ? data.consumers.filter((c) => c && c.live) : [];
  if (live.length) return; // someone IS online — the nudge would be wrong here
  console.error(STAY_ONLINE_NUDGE);
}

// listen + bridge: consumer_conflict, warned ONCE per process. The field rides
// whoami (bridge boot) AND the consume GET /messages (listen loop) — so a
// consuming loop learns a sibling started consuming without a second call.
let consumerConflictWarned = false;
function warnConsumerConflict(data) {
  if (!data || data.consumer_conflict !== true || consumerConflictWarned) return;
  consumerConflictWarned = true;
  console.error('pidge: ⚠️  another consumer is live on this channel (consumer_conflict). One channel = one consumer: you may be double-consuming a bridge/daemon\'s queue. Situate with `pidge catchup`; if a bridge owns this channel, stop this `listen`.');
}

// The in-flight lease holder on a delivered-but-unprocessed row, self-FILTERED
// — the CLI suppresses the block when the holder is its own fingerprint
// (self-noise). Returns a one-line "being handled by X since T" or null
// (absent block, or held by us).
function beingHandledLine(m) {
  const b = m && m.being_handled_by;
  if (!b || typeof b !== 'object') return null;
  if (b.fingerprint && b.fingerprint === agentFingerprint()) return null; // self
  // Execution attribution: a run-only lease (no fingerprint header on the serve)
  // identifies the holder by run seal — recognize OURSELF on that axis too, so a
  // run-signed caller never stands down for its own in-flight work.
  if (b.run_seal && process.env.PIDGE_RUN_SEAL && b.run_seal === process.env.PIDGE_RUN_SEAL) return null; // self (by run)
  const who = b.label || (b.run_seal ? `run ${b.run_seal}` : null) || b.fingerprint || 'another consumer';
  const since = b.since ? ` since ${b.since}` : '';
  return `being handled by ${who}${since}`;
}

// ---------------------------------------------------------------------------
// `pidge bridge --exec '<handler>'` — the 1st-class, model-agnostic
// supervisor. The bridge is deliberately DUMB: no local queue, no retry ledger
// of its own — durability lives in the server's ack/lease (reimplementing a
// local queue is an explicit non-goal).
//   loop: long-poll GET /messages?all=true (the robust long-poll floor; a realtime
//   socket, when available, is presence + early wake, never the data path)
//   → ONE handler invocation per batch (the whole tick as JSON on stdin — one
//   LLM invocation per batch, not per message) → handler exit 0 ⇒ ack --up-to
//   <last id> · non-zero ⇒ NOT acked (the ~10-min server lease re-serves).
// ---------------------------------------------------------------------------

// --- the single-consumer lock. PER-CHANNEL on purpose: keyed by
// hash(token) and living in the BASE ~/.config/pidge — PIDGE_AGENT is IGNORED
// here, because two agents wearing the SAME key are still one channel and MUST
// collide (a per-agent dir would hide exactly the double-consume this kills).
function bridgeLockBaseDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pidge');
}
function bridgeLockPath() {
  const h = crypto.createHash('sha256').update(String(TOKEN)).digest('hex').slice(0, 16);
  return path.join(bridgeLockBaseDir(), `bridge-${h}.lock`);
}

// --- The cross-round health ledger (one-shot loops made exit 4 honest) ---
// The recommended loop is ONE round per process, so "not one healthy round-trip
// all session" used to mean "this 50-second window" — a wifi blip (or the host
// waking from sleep) read as "the CHANNEL looks broken" and the ONLY exit code
// that tells an agent to escalate fired in FALSE (observed three times in one
// real QA). The streak now persists across rounds in a tiny file keyed by the
// token hash (same posture as the lock: two processes wearing one key are one
// channel). A healthy round-trip anywhere clears it.
const HEALTH_STREAK_ROUNDS = 3;          // dead rounds before an escalation
const HEALTH_STREAK_SPAN_MS = 120000;    // ...spread over at least this long
const HEALTH_LEDGER_STALE_MS = 15 * 60000; // an old streak is a PAST outage, not this one
const HEALTH_LOCAL_SPAN_MS = 10 * 60000; // local-network blame still escalates eventually
function healthLedgerPath() {
  const h = crypto.createHash('sha256').update(String(TOKEN)).digest('hex').slice(0, 16);
  return path.join(bridgeLockBaseDir(), `health-${h}.json`);
}
function readHealthLedger() {
  try {
    const d = JSON.parse(fs.readFileSync(healthLedgerPath(), 'utf8'));
    if (!d || !Number.isInteger(d.streak) || !Number.isFinite(d.first_at) || !Number.isFinite(d.last_at)) return null;
    if (Date.now() - d.last_at > HEALTH_LEDGER_STALE_MS) return null; // a past outage
    return d;
  } catch { return null; }
}
function writeHealthLedger(d) {
  try {
    fs.mkdirSync(bridgeLockBaseDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(healthLedgerPath(), JSON.stringify(d), { mode: 0o600 });
  } catch { /* best-effort — a broken disk must not mask the health verdict */ }
}
function clearHealthLedger() {
  try { fs.unlinkSync(healthLedgerPath()); } catch { /* absent is the goal */ }
}
// Can we reach the SERVER at all? Rails' bare /up answers without auth. This is
// what separates "the channel/API is broken — escalate" from "this HOST has no
// network (lid just opened, wifi flap) — reconnect, don't cry wolf".
async function probeServerUp() {
  try {
    const r = await fetchT(`${BASE}/up`, {}, 8000);
    return r.status >= 200 && r.status < 500; // any answer = the server is THERE
  } catch { return false; }
}
function readBridgeLock(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && Number.isInteger(d.pid) ? d : null;
  } catch { return null; } // missing or garbage — the caller treats it as stale
}
// Is that pid a live process? Signal 0 probes without touching it. EPERM =
// "exists, but not ours to signal" — SUSPICIOUS, so treated as ALIVE: when we
// can't prove the holder is dead, refusing beats double-consuming.
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// The holder's process START TIME (Linux: field 22 of /proc/<pid>/stat, in
// clock ticks since boot). A pid is NOT an identity — pids wrap, so a reused
// number makes a corpse look alive and the channel stays locked out of every
// listen on that machine until a human deletes the file. Start time + pid is.
// Field 2 (comm) is parenthesised and may contain spaces AND ')', so parse
// after the LAST ')': the remainder starts at field 3, putting field 22 at
// index 19. Unreadable (not Linux, hardened /proc, a container) ⇒ null, and
// the pid-only behavior stands — an unknown answer, never a wrong one.
function procStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 1).trim();
    const field = tail.split(/\s+/)[19];
    return /^\d+$/.test(field) ? field : null;
  } catch { return null; }
}
// Is the lock's holder still THAT process? pidAlive says "something has this
// pid"; the recorded start time says "the SAME something". Either side missing
// (an old lock, a platform with no /proc) falls back to pid-only — when we
// can't prove the holder is dead, refusing beats double-consuming.
function lockHolderAlive(cur) {
  if (!cur || !pidAlive(cur.pid)) return false;
  const now = procStartTime(cur.pid);
  if (!now || !cur.proc_started_at) return true;
  return now === String(cur.proc_started_at);
}
// Whoever holds the channel lock RIGHT NOW (a live holder), or null. `listen`
// checks this to refuse double-consuming a channel a running bridge owns.
function bridgeLockHolder() {
  const cur = readBridgeLock(bridgeLockPath());
  return cur && lockHolderAlive(cur) ? cur : null;
}
// `tag` names the CALLER in every line this can print (bridge | listen) — the
// lock itself is one lock: whoever holds it is the channel's consumer.
function acquireBridgeLock(tag = 'bridge') {
  const file = bridgeLockPath();
  fs.mkdirSync(bridgeLockBaseDir(), { recursive: true, mode: 0o700 });
  // proc_started_at pins the pid to THIS process (see lockHolderAlive); omitted
  // where /proc can't answer, and a lock without it is read exactly as before.
  const procStarted = procStartTime(process.pid);
  const payload = JSON.stringify({
    pid: process.pid,
    ...(procStarted ? { proc_started_at: procStarted } : {}),
    started_at: new Date().toISOString(),
    label: agentLabel(),
    kind: consumerKind() || tag, // watch | listen | bridge — the same vocabulary whoami serves
  }) + '\n';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600); // atomic create-exclusive — the file IS the lock
      fs.writeSync(fd, payload);
      fs.closeSync(fd);
    } catch (e) {
      if (e.code !== 'EEXIST') die(`pidge: ${tag} — can't create the lock at ${file}: ${e.message}`, 2);
      const cur = readBridgeLock(file);
      if (cur && lockHolderAlive(cur))
        die(`pidge: ${tag} — REFUSED: another consumer already holds this channel (pid ${cur.pid}${cur.label ? `, "${cur.label}"` : ''}, since ${cur.started_at || '?'}). One consumer per channel — a second bridge/listen double-consumes. Stop it first, or read with \`pidge catchup\` (read-only). If you are CERTAIN no consumer is running (e.g. the pid belongs to an unrelated process), delete the lockfile yourself: rm "${file}"`, 2);
      // Stale lock: the holder is gone — dead, or that pid number now belongs
      // to an unrelated process (a crashed consumer never releases; that's WHY
      // the lock stores a pid AND its start time) — or the file is garbage. So:
      // CLAIM the corpse by atomic RENAME — on the same fs exactly ONE racer's
      // rename succeeds; the loser gets ENOENT and refuses. This closes the
      // unlink-race window where two starters both saw the same stale pid and
      // the second unlinked the first's FRESH lock.
      const corpse = `${file}.stale.${process.pid}`;
      try {
        fs.renameSync(file, corpse);
      } catch (re) {
        die(`pidge: ${tag} — lost the stale-lock takeover race (${re.code}: another starter claimed it first) — refusing to double-consume. Re-run if you believe it also crashed.`, 2);
      }
      try { fs.unlinkSync(corpse); } catch { /* best-effort cleanup of the claimed corpse */ }
      console.error(`pidge: ${tag} — recovered a STALE lock (pid ${cur ? cur.pid : '?'} is gone, or that number now belongs to an unrelated process; crashed consumer / power loss). Taking over.`);
      continue; // retry the exclusive create ONCE — a racing NEW starter makes us EEXIST → re-check above
    }
    // Paranoia re-read (belt on top of the rename): whoever the file names now
    // is the holder; if it isn't us, back off.
    const now = readBridgeLock(file);
    if (!now || now.pid !== process.pid)
      die(`pidge: ${tag} — lost the lock race to pid ${now ? now.pid : '?'} — refusing to double-consume.`, 2);
    return file;
  }
  die(`pidge: ${tag} — couldn't acquire the lock (raced twice); try again.`, 2);
}
function releaseBridgeLock(file) {
  // Remove only OUR lock: after a crash + takeover the file may name another pid.
  const cur = readBridgeLock(file);
  if (cur && cur.pid !== process.pid) return;
  try { fs.unlinkSync(file); } catch { /* best-effort */ }
}

// A blocking wait (wait/ask/approval/hello) on a channel whose consumer lock is
// HELD is a legitimate, common pattern — your own listener holds it while your
// handler asks a question. It is never refused; it is NARRATED, once, because
// the asymmetry bites otherwise: this wait hears the ANSWER to its notification
// and nothing else, while everything the human TYPES belongs to the listener.
let liveConsumerNarrated = false;
function narrateLiveConsumer(holder) {
  if (!holder || liveConsumerNarrated) return;
  liveConsumerNarrated = true;
  console.error(`pidge: this channel already has a LIVE consumer (${holder.label ? `"${holder.label}", ` : ''}pid ${holder.pid}) — this wait hears ONLY the answer to your notification; anything the human TYPES goes to that listener's queue. Send-and-go and collect it there instead of waiting twice.`);
}

// Take the handler down — AND everything it started. `--exec` runs through
// `sh -c`, so the child we hold is the SHELL: signalling only that pid leaves a
// script's own children alive, reparented to init (measured live: a `sleep 300`
// still running 22 s after the SIGTERM that was supposed to have ended it).
// So the handler is spawned into its OWN process group (`detached: true`) and
// every teardown signals the GROUP. `process.kill(-pid)` fails with ESRCH once
// the group is gone and with EPERM where groups don't work like this — both
// degrade to the single-pid kill, which is exactly today's behaviour.
// Three callers: --handler-timeout, the listen signal teardown, the bridge's.
function killHandlerGroup(child, sig) {
  if (!child || !child.pid) return;
  try { process.kill(-child.pid, sig); } catch {
    try { child.kill(sig); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// ONE handler invocation — shared by `pidge bridge` (a batch per loop tick) and
// `pidge listen --exec` (one round, no daemon). Both hand the batch to a command
// on stdin and let its EXIT CODE decide the ack, so everything hard lives here
// exactly once: the shell spawn (into its own process GROUP, so a kill reaches
// the handler's own children), the settle (process exit AND stdout EOF, with a
// short grace when a grandchild keeps the pipe open), the STREAMED scan for the
// last `pidge-summary:` marker, the stdout tee with backpressure, the
// --handler-timeout SIGTERM (SIGKILL 5 s later), the periodic stderr heartbeat,
// and the lease/presence renew of the batch's EXACT ids while the handler thinks.
// It NEVER acks and never exits: it returns {outcome, summary, seconds} and the
// caller owns the verdict. `tag` names the caller in every line printed here.
// ---------------------------------------------------------------------------
function runHandlerOnce({
  tag, handlerCmd, batch, batchIds, env = process.env,
  handlerTimeoutS, narrateMs, renewMs, onSpawn = null, onSettle = null,
}) {
  const { spawn } = require('node:child_process');
  // capture the handler's summary from a MARKER LINE on its stdout —
  // `pidge-summary: <text>`. We STREAM, never buffer the whole output: stdout is
  // teed to our own stdout (the log/pipe is preserved) while a bounded
  // line-scanner keeps only the LAST marker's value (cap 1000). A handler that
  // dumps megabytes, or closes stdout early, can neither wedge the caller nor
  // grow memory. No marker ⇒ no summary (we NEVER invent one).
  let lastSummary = null;
  let markerTail = '';
  const MARKER_TAIL_CAP = 2048; // a marker value is ≤1000; this head is plenty to still recognize the prefix
  const takeMarker = (line) => {
    const m = /^pidge-summary:[ \t]?(.*)$/.exec(line.trim());
    if (m) lastSummary = m[1].trim().slice(0, 1000);
  };
  const scanStdout = (text) => {
    // Split once (O(n)); the last part is the unterminated tail carried forward.
    const parts = (markerTail + text).split('\n');
    markerTail = parts.pop();
    for (const line of parts) takeMarker(line);
    // Bound the unterminated tail — keep only the HEAD (a marker must start at
    // the line start); a single line longer than the cap can't be a marker we'd
    // keep, and truncating the head preserves the prefix + a full ≤1000 value.
    if (markerTail.length > MARKER_TAIL_CAP) markerTail = markerTail.slice(0, MARKER_TAIL_CAP);
  };
  // Did the tee end MID-LINE? A handler whose last chunk has no trailing
  // newline leaves our stdout parked mid-line, and the caller's machine line
  // (handler_failed / ack_failed) would then be glued to the handler's own text
  // — one unparseable line, exactly where the agent wakes up. The caller gets
  // this flag and writes the missing newline first.
  let teeMidLine = false;
  const t0 = Date.now();
  // The batch ALSO rides a temp file, named to the handler as $PIDGE_BATCH_FILE.
  // Reason (observed live): `claude -p` DISCARDS its prompt argument whenever
  // stdin is a pipe — and under --exec stdin is ALWAYS the batch pipe — so the
  // most natural LLM handler silently lost its instructions. With the file, the
  // recipe becomes: prompt through stdin, batch from $PIDGE_BATCH_FILE. The
  // stdin batch stays byte-identical (programmatic handlers keep their contract).
  let batchFile = null;
  try {
    batchFile = path.join(os.tmpdir(), `pidge-batch-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(batchFile, JSON.stringify(batch) + '\n', { mode: 0o600 });
  } catch { batchFile = null; /* tmp unwritable — stdin still carries the batch */ }
  const cleanupBatchFile = () => { if (batchFile) { try { fs.unlinkSync(batchFile); } catch { /* gone */ } batchFile = null; } };
  return new Promise((resolve) => {
    const finish = (outcome) => { cleanupBatchFile(); resolve({ outcome, summary: lastSummary, seconds: Math.round((Date.now() - t0) / 1000), teeMidLine }); };
    // The ONE place both consumers (`bridge` and `listen --exec`) hand a human's
    // batch to a handler — so it is the one place that can honestly say "the
    // agent read you and is working on it". Fire-and-forget, before the spawn,
    // so a slow/absent /typing can never delay the work by a millisecond.
    fireAutoTyping();
    let child;
    try {
      const childEnv = batchFile ? { ...env, PIDGE_BATCH_FILE: batchFile } : env;
      // detached: the handler leads its OWN process group, so every kill path
      // below reaches its grandchildren instead of just the `sh -c` wrapper.
      child = spawn(handlerCmd, { shell: true, stdio: ['pipe', 'pipe', 'inherit'], env: childEnv, detached: true });
    } catch (e) { return finish({ code: null, error: e.message }); }
    if (onSpawn) onSpawn(child);
    let timedOut = false;
    let hardKill = null;
    let settled = false;
    let exited = null;        // {code, signal} once the process exits
    let stdoutEnded = false;  // true once the stdout pipe reaches EOF
    let graceT = null;
    // A hung handler must not wedge the channel forever (the lease keeps
    // re-serving to a consumer that never finishes a batch). --handler-timeout
    // (default 30 min) → SIGTERM (SIGKILL 5 s later), treated EXACTLY like a
    // failed handler: no ack.
    const killT = setTimeout(() => {
      timedOut = true;
      console.error(`pidge: ${tag} — handler exceeded --handler-timeout (${handlerTimeoutS}s) — SIGTERM to its whole process group (SIGKILL in 5s). Treated as a FAILED batch: NOT acked.`);
      killHandlerGroup(child, 'SIGTERM');
      hardKill = setTimeout(() => killHandlerGroup(child, 'SIGKILL'), 5000);
      if (hardKill.unref) hardKill.unref();
    }, handlerTimeoutS * 1000);
    if (killT.unref) killT.unref();
    // Periodic heartbeat on stderr while the handler runs — a log that goes
    // silent for 25 minutes reads as "dead", not "thinking".
    const narrate = setInterval(() => {
      const elapsed = Date.now() - t0;
      const shown = elapsed < 60000 ? `${Math.round(elapsed / 1000)}s` : `${Math.round(elapsed / 60000)} min`;
      console.error(`pidge: ${tag} — handler running for ${shown} (SIGTERM at --handler-timeout ${handlerTimeoutS}s)`);
    }, narrateMs);
    if (narrate.unref) narrate.unref();
    // Lease/presence heartbeat while the handler thinks: renew the batch's EXACT
    // ids every renewMs — POST /ack {ids, state:"delivered"}. Two jobs in one
    // ping: (a) the visibility lease can't lapse mid-run (a 30-min handler
    // outlives the ~10-min lease — without this the batch re-serves WHILE it's
    // being worked), and (b) servers ≥ manifest v79 refresh "listening now"
    // presence on a renew that actually renewed rows — so the human never sees
    // "offline" during a long handler run even when the WS is down (older
    // servers: lease renewal only, harmless). First ping only after a full
    // interval — a fast handler never pings. Cleared in done(), BEFORE the
    // ack/failure verdict: a FAILED batch must lapse back to the queue, so we
    // never renew after the child exits. Failures are NON-FATAL and can never
    // touch the handler or the batch outcome: narrate the FIRST one, then stay
    // silent (a line per ping would drown a long outage's log).
    let renewFailed = false;
    const renew = batchIds.length === 0 ? null : setInterval(() => {
      // The dots ride the SAME heartbeat as the lease: a handler that thinks for
      // longer than TYPING_AUTO_TTL_S must not go dark mid-thought, and renewing
      // is just calling again. Fire-and-forget, like every other typing call.
      fireAutoTyping();
      fetchT(`${BASE}/api/v1/messages/ack`, {
        method: 'POST', headers, body: JSON.stringify({ ids: batchIds, state: 'delivered' }),
      }).then((r) => {
        if (r.status >= 200 && r.status < 300) return;
        if (renewFailed) return;
        renewFailed = true;
        console.error(`pidge: ${tag} — renew heartbeat failed (${r.status}) — non-fatal: the handler keeps running; the lease may lapse early (at-least-once covers a re-serve)`);
      }).catch((e) => {
        if (renewFailed) return;
        renewFailed = true;
        console.error(`pidge: ${tag} — renew heartbeat failed (network: ${e.message}) — non-fatal: the handler keeps running; the lease may lapse early (at-least-once covers a re-serve)`);
      });
    }, renewMs);
    if (renew && renew.unref) renew.unref();
    const done = (o) => {
      if (settled) return; settled = true;
      clearTimeout(killT); if (hardKill) clearTimeout(hardKill); clearInterval(narrate);
      if (renew) clearInterval(renew);
      // The handler stopped — so does the signal that said it was working. Every
      // settle path lands here (clean exit, non-zero, spawn error, --handler-timeout
      // kill), which is exactly the point: there is no way out of a batch that
      // leaves the dots on.
      const cleared = clearAutoTyping();
      if (graceT) clearTimeout(graceT);
      // A final marker line with NO trailing newline still counts.
      if (markerTail) { takeMarker(markerTail); markerTail = ''; }
      if (onSettle) onSettle();
      // Give that write a BOUNDED moment to land before the round ends and the
      // process exits under it. Capped hard and never consulted: `o` was decided
      // above and nothing here can change it.
      Promise.race([cleared, new Promise((r) => { const t = setTimeout(r, TYPING_CLEAR_GRACE_MS); if (t.unref) t.unref(); })])
        .then(() => finish(o), () => finish(o));
    };
    // finalize only when the process has exited AND its stdout has drained,
    // so a marker on the LAST unflushed chunk is never missed (the 'exit' event
    // can fire before the pipe's trailing data is read). If stdout stays open past
    // exit (a grandchild inherited the pipe), a short grace caps the wait.
    const finishIfReady = () => { if (exited && stdoutEnded) done({ code: exited.code, signal: exited.signal, timedOut }); };
    child.on('error', (e) => done({ code: null, error: e.message }));
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      if (stdoutEnded) return finishIfReady();
      graceT = setTimeout(() => done({ code, signal, timedOut }), 2000);
      if (graceT.unref) graceT.unref();
    });
    child.stdout.on('data', (chunk) => {
      scanStdout(chunk.toString('utf8'));
      if (chunk.length) teeMidLine = chunk[chunk.length - 1] !== 0x0a; // \n
      // Tee to our own stdout (preserve the log) WITH backpressure — a slow sink
      // pauses the child rather than buffering a big dump in memory.
      if (!process.stdout.write(chunk)) {
        child.stdout.pause();
        process.stdout.once('drain', () => { try { child.stdout.resume(); } catch { /* child gone */ } });
      }
    });
    child.stdout.on('end', () => { stdoutEnded = true; finishIfReady(); });
    // A broken read side must never crash the caller; treat it as drained.
    child.stdout.on('error', () => { stdoutEnded = true; finishIfReady(); });
    // EPIPE guard: a handler may exit without reading stdin — its exit code
    // still decides the batch; the write failure itself is not a verdict.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(batch) + '\n');
  });
}

// Ack the batch's EXACT ids, never `up_to`.
// The server's up_to flips EVERY unprocessed row ≤ id — including rows under
// lease from an EARLIER batch the handler FAILED on (or never saw): a later
// success would stamp "processed" on work that never happened. ids:[…] can
// only stamp what this handler demonstrably just handled. `summary` is the
// handler's own marker line or nothing — never an invented one.
async function ackExactIds(tag, ids, summary, runToken) {
  const body = { ids };
  if (summary) body.summary = String(summary).slice(0, 1000); // server slices; we cap
  // Sign the ack with THIS batch's run (the handler that just did the work),
  // never the parent's — so the human sees who processed the message.
  const ackHeaders = runToken ? { ...headers, 'x-pidge-run': runToken } : headers;
  try {
    const res = await fetchT(`${BASE}/api/v1/messages/ack`, {
      method: 'POST', headers: ackHeaders, body: JSON.stringify(body),
    });
    if (res.status >= 200 && res.status < 300) {
      // The server's own count, not our optimism: a 2xx that acked NOTHING used
      // to print the same green ✓✓ line as a real ack. And a note-less ack is
      // "drained" on the server — a green tick that can't say what happened —
      // so it gets its own line instead of borrowing the good one.
      const adata = await res.json().catch(() => ({}));
      const acked = Number(adata.acked);
      const skipped = Number(adata.skipped) > 0
        ? ` · ${adata.skipped} skipped (a sibling's in-flight work, or never-served rows — they stay queued and re-serve)` : '';
      const n = Number.isFinite(acked) ? acked : ids.length;
      if (Number.isFinite(acked) && acked === 0)
        console.error(`pidge: ${tag} — the server acked 0 of ${ids.length} message(s)${skipped}: no ✓✓ turned green here. They were already processed, or a sibling holds them — situate with \`pidge catchup --digest\` before treating this batch as done.`);
      else if (body.summary)
        console.error(`pidge: ${tag} — acked ${n} message(s) (exact ids of the batch — green ✓✓)${skipped} · summary: ${body.summary.length > 80 ? body.summary.slice(0, 77) + '…' : body.summary}`);
      else
        console.error(`pidge: ${tag} — acked ${n} message(s) (exact ids of the batch) with NO note${skipped} — the server files this as DRAINED: \`pidge catchup\` can't say what happened, and to the human that ✓✓ claims work it can't see.`);
      return true;
    }
    console.error(`pidge: ${tag} — WARNING: ack failed (${res.status}) — the batch re-serves after the lease; the handler will see it again`);
  } catch (e) {
    console.error(`pidge: ${tag} — WARNING: ack failed (network: ${e.message}) — the batch re-serves after the lease`);
  }
  return false;
}

// Gate hygiene (server ≥ manifest v83) — the ONE implementation, shared by the
// `bridge` loop and the `listen`/`online` watch (they consume the same queue;
// only one of them used to know this rule, and a Face-ID answer surfaced by the
// watch read as a fresh imperative command — a money order nearly executed
// twice). A notification_reply whose `ref` carries gated:true is the outcome of
// a Face-ID gate (`pidge approve` / `approval grant` / `--gated` confirm): the
// asker already heard it on its own wait/webhook, and its bare label ("Submit")
// must never reach an autonomous consumer looking like work. So: ack it HERE
// (loudly, with a summary so provenance says WHY) and return only the rows that
// ARE work. Old servers never set ref.gated ⇒ nothing matches, behavior
// unchanged. `what` names what did NOT happen, in the caller's own vocabulary.
async function siftGatedReplies(tag, msgs, { what = 'spawning a handler', runToken = null } = {}) {
  const gated = msgs.filter((m) => m && m.kind === 'notification_reply' && m.ref && m.ref.gated === true);
  if (!gated.length) return msgs;
  console.error(`pidge: ${tag} — ${gated.length} Face-ID gate answer(s) acked WITHOUT ${what} (a gate outcome is not a command; the asker already heard it — canonical answer stays on the notification)`);
  const gatedIds = gated.map((m) => Number(m.id)).filter(Number.isInteger);
  if (gatedIds.length)
    await ackExactIds(tag, gatedIds, `Face-ID gate answer — auto-acked by the ${tag}, no handler spawned`, runToken);
  return msgs.filter((m) => !gated.includes(m));
}

// A LOCAL alert for the two "only a human can fix this" failures (401 —
// rotated key? — and a channel with no healthy round-trip). We can't pidge —
// that's exactly what's broken — so local is all there is: the stderr line is
// the alert of record (launchd/systemd capture it in the log), and a desktop
// notification is attempted best-effort. PIDGE_BRIDGE_ALERT=0 disables the
// desktop part (test/ops hook — tests must not pop notifications).
// `tag` names the loop that raised it (bridge | listen | wait): the same
// "only a human can fix this" wall exists on every blocking loop, not just the
// daemon, and an alert that says "bridge" from a `listen` sends its reader
// hunting for a daemon that isn't running.
function localAlert(title, msg, tag = 'bridge') {
  console.error(`pidge: ${tag} — 🔔 LOCAL ALERT: ${title} — ${msg}`);
  if (process.env.PIDGE_BRIDGE_ALERT === '0') return;
  try {
    const { spawn } = require('node:child_process');
    const [cmd, args] = process.platform === 'darwin'
      ? ['osascript', ['-e', `display notification ${JSON.stringify(msg)} with title ${JSON.stringify(`pidge ${tag}: ${title}`)}`]]
      : ['notify-send', [`pidge ${tag}: ${title}`, msg]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch { /* the stderr line above is the alert of record */ }
}

// 401/403 on a blocking loop is a WALL, not a blip: the key was rotated or
// revoked and every poll from here fails identically. The old code counted it as
// a healthy round-trip (`else { health.ok() }` — the server DID answer, which is
// true and useless), so the round ended exit 3 "relaunch the listener" and the
// agent relaunched into the same wall until a human happened to look. Only a
// human can fix this, so: loud, local, exit 2 — never a timeout, never a nudge
// to try again.
function dieKeyRejected(tag, status) {
  const msg = `the server REJECTED this channel key (${status}) — rotated or revoked. This is NOT a timeout and NOT a blip: every poll from here fails the same way, so relaunching changes nothing. A human must re-onboard this agent: \`pidge setup --claim <code>\` (Pidge app → Canais → o canal → copiar prompt de setup), then \`pidge doctor\`.`;
  console.error(`pidge: ${tag} — ❌ ${msg}`);
  localAlert('key rejected', msg, tag);
  process.exit(2);
}

// Cheap local-connectivity corroboration for classifyBridgeFailure: no
// non-internal interface with an address ⇒ this machine is offline (Wi-Fi
// down / airplane mode / mid-wake) — a failure then is LOCAL by definition.
// A probe error answers "network looks fine" so a real server outage is never
// suppressed by a broken probe.
function hasNonInternalNetwork() {
  try {
    for (const addrs of Object.values(os.networkInterfaces()))
      for (const a of addrs || []) if (!a.internal) return true;
    return false;
  } catch { return true; }
}

// ── execution attribution (runs) ────────────────────────────────────────────
// A run is a server-issued, per-execution SIGNATURE — attribution, never a
// credential (the channel key still authenticates; the run token only stamps who
// spoke). An old server (/runs 404) makes every run verb degrade honestly.
const RUN_MODES = ['interactive', 'poll', 'bridge', 'custom'];
const RUN_ROLES = ['main', 'worker', 'subagent'];

async function runRunCommand() {
  const sub = parsed.positionals[1];
  if (sub === 'start') return runRunStart();
  if (sub === 'end') return runRunEnd();
  if (sub === 'status') return runRunStatus();
  die('pidge: usage: pidge run start [--mode M] [--role R] [--label L] [--parent-seal S] [--ephemeral] [--ttl N] [--json]  |  pidge run end  |  pidge run status', 1);
}

async function runRunStart() {
  const mode = (v.mode || 'custom').trim().toLowerCase();
  if (!RUN_MODES.includes(mode))
    die(`pidge: run start --mode must be ${RUN_MODES.join(' | ')} (got ${JSON.stringify(v.mode)})`, 1);
  let role = null;
  if (v.role !== undefined) {
    role = String(v.role).trim().toLowerCase();
    if (!RUN_ROLES.includes(role))
      die(`pidge: run start --role must be ${RUN_ROLES.join(' | ')} (got ${JSON.stringify(v.role)})`, 1);
  }
  const label = (v.label !== undefined ? String(v.label) : agentLabel()).slice(0, 80);
  const body = { mode, label };
  if (role) body.role = role;
  if (v['parent-seal']) body.parent_seal = String(v['parent-seal']);
  if (v.ephemeral) body.ephemeral = true;
  if (v.ttl !== undefined) body.ttl_seconds = numStrict(v.ttl, '--ttl', undefined);
  let res, data;
  try {
    res = await fetchT(`${BASE}/api/v1/runs`, { method: 'POST', headers, body: JSON.stringify(body) });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    die(`pidge: run start failed (network): ${e.message}`, 1);
  }
  await checkManifestNews(res);
  if (res.status === 404)
    die('pidge: run start — this server predates execution attribution (/runs 404). Update the server, or just keep sending: the channel key works unsigned.', 1);
  if (res.status < 200 || res.status >= 300 || !data.run_token)
    die(`pidge: run start failed (${res.status}): ${JSON.stringify(data)}`, 1);
  if (v.json) { console.log(JSON.stringify(data, null, 2)); process.exit(0); }
  const run = data.run || {};
  // stdout is EXACTLY the two export lines so `eval "$(pidge run start …)"`
  // arms the session; every narration goes to stderr (never pollutes the eval).
  console.log(`export PIDGE_RUN_TOKEN=${data.run_token}`);
  console.log(`export PIDGE_RUN_SEAL=${run.seal || ''}`);
  console.error(`pidge: run ${run.seal || '?'} started · mode ${run.mode || mode}${run.role ? ` · role ${run.role}` : ''}${run.ephemeral ? ' · ephemeral' : ''} — messages you send now are SIGNED with this execution (attribution, not a credential). End it with \`pidge run end\`.`);
  process.exit(0);
}

async function runRunEnd() {
  // env-ONLY, like every run bearer — never from FILE_ENV.
  const token = process.env.PIDGE_RUN_TOKEN || null;
  if (!token) {
    console.error('pidge: run end — no PIDGE_RUN_TOKEN in the environment; nothing to end (no-op).');
    process.exit(0);
  }
  let res, data;
  try {
    res = await fetchT(`${BASE}/api/v1/runs/end`, { method: 'POST', headers: { ...headers, 'x-pidge-run': token } });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    console.error(`pidge: run end — best-effort POST failed (network: ${e.message}); the server expiry reaps the run.`);
    process.exit(0);
  }
  await checkManifestNews(res);
  if (res.status >= 200 && res.status < 300)
    console.error(`pidge: run ${data.seal || process.env.PIDGE_RUN_SEAL || ''} ended.`);
  else
    console.error(`pidge: run end — server said ${res.status} (best-effort; the run expires on its own).`);
  process.exit(0);
}

async function runRunStatus() {
  let res, data;
  try {
    res = await fetchT(`${BASE}/api/v1/runs/active`, { headers });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    die(`pidge: run status failed (network): ${e.message}`, 1);
  }
  await checkManifestNews(res);
  if (res.status === 404)
    die('pidge: run status — this server predates execution attribution (/runs 404).', 1);
  if (res.status < 200 || res.status >= 300)
    die(`pidge: run status failed (${res.status}): ${JSON.stringify(data)}`, 1);
  const runs = Array.isArray(data.runs) ? data.runs : [];
  const own = process.env.PIDGE_RUN_SEAL || null; // mark THIS execution's row with a *
  if (runs.length === 0) { console.log('(no live runs)'); process.exit(0); }
  const header = ['RUN', 'MODE', 'ROLE', 'LABEL', 'LAST SEEN'];
  const rows = runs.map((r) => [
    (own && r.seal === own ? '*' : ' ') + (r.seal || '?'),
    r.mode || '-', r.role || '-', (r.label || '-').slice(0, 24), r.last_seen_at || '-',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => String(row[i]).length)));
  const fmt = (cols) => cols.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(fmt(header));
  for (const row of rows) console.log(fmt(row));
  process.exit(0);
}

async function runBridge() {
  const handlerCmd = v.exec;
  if (!handlerCmd)
    die('pidge: bridge needs --exec \'<handler command>\' — invoked ONCE per batch with the batch JSON on stdin (also at $PIDGE_BATCH_FILE); exit 0 acks the batch, non-zero leaves it for the server lease to re-serve. LLM handler? Pipe the PROMPT via stdin and read the batch from the file — `claude -p` discards a prompt ARGUMENT when stdin is piped, and here it always is. E.g.: pidge bridge --exec \'printf "read $PIDGE_BATCH_FILE, reply via pidge message, end with pidge-summary: …" | claude -p --allowedTools Bash,Read,Write\'', 1);

  // NO orphan watchdog here, deliberately (that guard is for `listen`): the bridge is
  // MEANT to outlive its launcher (nohup, a closed terminal, launchd) — its
  // lifecycle belongs to the supervisor and the lock, not to the parent pid.
  // THE HANDOFF (the human's "talk to the agent itself"): an interactive session
  // that runs `pidge listen` is the human's real agent — the one with the
  // conversation in its head. The bridge is the on-call stand-in for when that
  // session is gone. So the bridge never fights a live listen for the channel:
  // at boot it STANDS BY while a listen holds the lock (instead of dying and
  // flap-restarting under systemd), a listen that starts while the bridge holds
  // it asks the bridge to YIELD (SIGUSR2 — a signal an old bridge treats as
  // plain termination, which is why listen only sends it to a lock that says
  // kind:"bridge"), and the bridge takes the channel back the moment the listen
  // exits. Nothing is lost either way: the queue is at-least-once.
  const STANDBY_POLL_MS = parseInt(process.env.PIDGE_BRIDGE_STANDBY_POLL || '', 10) || 3000;
  let lockFile = null;
  let lockReleased = true;
  let yieldRequested = false;
  const releaseOnce = () => { if (!lockReleased && lockFile) { lockReleased = true; releaseBridgeLock(lockFile); } };
  process.on('exit', releaseOnce);
  // Acquire, or stand by while an interactive listen holds the channel. Another
  // BRIDGE holding it is a configuration error (two daemons) and still refuses.
  const acquireOrStandby = async () => {
    let announced = false;
    for (;;) {
      const cur = readBridgeLock(bridgeLockPath());
      if (cur && lockHolderAlive(cur) && (cur.kind === 'listen' || cur.kind === 'watch')) {
        if (!announced) {
          announced = true;
          console.error(`pidge: bridge — STANDING BY: an interactive listener holds this channel (pid ${cur.pid}${cur.label ? `, "${cur.label}"` : ''}, since ${cur.started_at || '?'}) — your human is talking to that session. The bridge takes over the moment it exits.`);
        }
        await sleepInterruptible(STANDBY_POLL_MS); // ref'd on purpose: an unref'd timer alone lets Node exit 0 mid-standby
        if (shuttingDown) return false;
        continue;
      }
      lockFile = acquireBridgeLock(); // stale/absent ⇒ ours; a live BRIDGE ⇒ refuses (exit 2)
      lockReleased = false;
      if (announced) console.error('pidge: bridge — the interactive listener left — taking the channel back');
      return true;
    }
  };
  // An interactive listen asked for the channel: finish what is in flight (a
  // held long-poll, or a running handler + its ack), then release and stand by.

  // Pacing knobs. The env overrides are test/ops hooks, not documented knobs.
  const intervalS = numStrict(v.interval, '--interval', 5);
  // How long ONE handler invocation may run before SIGTERM
  // (default 30 min — an LLM handler can legitimately think for many minutes).
  const handlerTimeoutS = numStrict(v['handler-timeout'], '--handler-timeout', 1800);
  const HANDLER_NARRATE_MS = parseInt(process.env.PIDGE_BRIDGE_NARRATE || '', 10) || 300000; // 5 min
  // Lease/presence renew pace while a handler runs (issue #82) — see the heartbeat below.
  const RENEW_MS = parseInt(process.env.PIDGE_BRIDGE_RENEW || '', 10) || 60000; // 60 s
  const BACKOFF_BASE_MS = parseInt(process.env.PIDGE_BRIDGE_BACKOFF_BASE || '', 10) || 2000;
  const BACKOFF_MAX_MS = parseInt(process.env.PIDGE_BRIDGE_BACKOFF_MAX || '', 10) || 120000;
  const BACKOFF_LONG_MS = parseInt(process.env.PIDGE_BRIDGE_BACKOFF_LONG || '', 10) || 300000;
  const BROKEN_AFTER = 5;
  // how long a dropped realtime socket waits before reconnecting (env = test hook)
  const WS_RETRY_MS = parseInt(process.env.PIDGE_BRIDGE_WS_RETRY || '', 10) || 15000;
  // Jitter EVERY retry sleep: N bridges restarting after the
  // same server deploy must not stampede back in lockstep.
  const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.5));

  let shuttingDown = false;
  let currentChild = null;
  let wake = null; // resolves the current sleep early (realtime frame / shutdown)
  let pollAbort = null; // the in-flight long-poll's controller — a yield cuts it short
  const sleepInterruptible = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(t); wake = null; resolve(); };
  });

  // Hard case: SIGTERM/SIGINT must be CLEAN — forward the signal to an
  // in-flight handler, NEVER ack the in-flight batch (the lease re-serves it;
  // at-least-once is the contract, the handler must tolerate a replay), release
  // the lock, exit 0. The `shuttingDown` flag also closes the handler-exit→ack
  // race: an ack decision reached after the signal is refused even when the
  // handler finished 0 — acking during teardown could stamp "processed" on work
  // whose own side effects (the handler's sends) were cut short.
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`pidge: bridge — ${sig}: shutting down cleanly. An in-flight batch is NOT acked (the server lease re-serves it).`);
    const finish = () => { releaseOnce(); process.exit(0); };
    if (currentChild && currentChild.exitCode === null && currentChild.signalCode === null) {
      // the GROUP, not just the `sh -c` wrapper — a handler's own children must
      // not survive the shutdown as orphans still working the batch.
      killHandlerGroup(currentChild, 'SIGTERM');
      const hardKill = setTimeout(() => { killHandlerGroup(currentChild, 'SIGKILL'); finish(); }, 5000);
      if (hardKill.unref) hardKill.unref();
      currentChild.once('exit', () => { clearTimeout(hardKill); finish(); });
    } else {
      if (wake) wake(); // not strictly needed (finish exits) — but never leave a sleep dangling
      finish();
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGUSR2', () => {
    if (!yieldRequested) console.error('pidge: bridge — an interactive listener asked for the channel — yielding after the current cycle (a running handler finishes and is acked first)');
    yieldRequested = true;
    if (wake) wake();
    // A held long-poll (up to 25 s) must not delay the handoff: abort it. The
    // loop treats that abort as "yield now", never as a transport failure.
    if (pollAbort) pollAbort.abort(new Error('yield'));
  });

  if (!(await acquireOrStandby())) return;
  console.error(`pidge: bridge — up (pid ${process.pid}, lock ${path.basename(lockFile)}) · handler: ${handlerCmd}`);
  console.error('pidge: bridge — ONE handler invocation per batch, batch JSON on stdin; exit 0 = acked, non-zero = re-served by the server lease (make the handler idempotent).');

  // Boot: narrate reach + declare listen_mode=external_daemon when it isn't
  // already (the honest advisory — a bridge IS an external daemon).
  // Best-effort by design: a 401 at boot does NOT kill the process (a daemon
  // that dies on 401 just flap-restarts under launchd/systemd — the loop below
  // owns the narrate + long-backoff treatment).
  try {
    const who = await fetchWhoami();
    if (who.res.status === 200 && who.data.channel) {
      console.error(`pidge: bridge — canal "${who.data.channel.name}" · ${who.data.devices ?? '?'} device(s)`);
      warnStalePriorClaim(who.data); // the boot warning
      warnConsumerConflict(who.data); // another consumer live at boot (whoami)
      const oc = who.data.operating_contract || {};
      if (!(oc.listen_mode && oc.listen_mode.value === 'external_daemon')) {
        v['listen-mode'] = 'external_daemon';
        await declareOperatingContract(BASE, TOKEN, who.data.channel.id);
      }
    }
  } catch (e) {
    console.error(`pidge: bridge — boot whoami failed (network: ${e.message}) — the loop keeps trying`);
  }
  if (shuttingDown) return;

  // Realtime as PRESENCE + EARLY WAKE only: a frame cuts the current
  // idle/backoff sleep short and the human sees "ouvindo agora"; every batch
  // still comes from the durable long-poll GET (a dropped socket costs latency,
  // never data — the existing WS→long-poll degrade, with long-poll as floor).
  if (wantRealtime()) {
    // `announced` latches the UP line for one connected stretch, not for the
    // process: it announced "the human sees 'ouvindo agora'" once and then went
    // silent through every drop, so a log could promise live presence for hours
    // after the last socket died. It retracts on the way down and re-announces
    // on the way back up. The set tracks which channels are actually up, so one
    // of the two dropping doesn't declare an outage the other isn't having.
    let announced = false;
    let noSocketAnnounced = false;
    const upChannels = new Set();
    const connectWs = (channel) => {
      if (shuttingDown) return;
      const sub = cableSubscribe({
        channel,
        params: wsIdentityParams(),
        onUp: () => {
          upChannels.add(channel);
          if (!announced) { announced = true; console.error('pidge: bridge — realtime socket up (the human sees "ouvindo agora"); the long-poll stays the data path'); }
          if (wake) wake();
        },
        onFrame: () => { if (wake) wake(); },
        onDown: () => {
          upChannels.delete(channel);
          if (announced && upChannels.size === 0) {
            announced = false;
            console.error(`pidge: bridge — realtime socket DOWN — presence now rides the LONG-POLL only, so the human may stop seeing "ouvindo agora" for a while. Reconnecting in ~${Math.round(WS_RETRY_MS / 1000)}s; the queue is untouched (the long-poll is the data path, never the socket).`);
          }
          const t = setTimeout(() => connectWs(channel), jitter(WS_RETRY_MS));
          if (t.unref) t.unref();
        },
      });
      if (!sub && !noSocketAnnounced) {
        noSocketAnnounced = true;
        console.error('pidge: bridge — no realtime socket — the long-poll floor carries the loop (same contract, less instant)');
      }
    };
    connectWs('ConversationChannel');
    connectWs('InboxChannel'); // --all semantics: notification answers too
  }

  let firstBatch = true;      // history_hint rides the first batch post-restart
  let transportFails = 0;     // consecutive network/5xx failures (drives the backoff ladder)
  let handlerFails = 0;       // consecutive non-zero handler exits
  let alerted401 = false;     // ONE local alert per outage, not one per retry
  // The "channel looks broken" DESKTOP alert is sleep-aware (the stderr log
  // still narrates every failure): only server-shaped streaks that persisted
  // ≥10 min of awake wall-clock alert, at most once per 4 h — a laptop's
  // sleep/wake cycle must never buzz the human. The 401 alert stays immediate
  // (only a human can fix a rotated key). Env knobs are test hooks.
  const alertPolicy = createBridgeAlertPolicy({
    brokenAfter: BROKEN_AFTER,
    minStreakMs: parseInt(process.env.PIDGE_BRIDGE_ALERT_STREAK || '', 10) || 600000,    // 10 min
    cooldownMs: parseInt(process.env.PIDGE_BRIDGE_ALERT_COOLDOWN || '', 10) || 14400000, // 4 h
  });
  let lastSleepAt = 0;        // when the wall-clock gap detector last said "the machine slept"
  // A detected system sleep makes the failure streak stale evidence: reset it
  // and stamp lastSleepAt so the next failures classify as wake turbulence.
  const detectSleep = (expectedMs, actualMs) => {
    if (!sleptThrough(expectedMs, actualMs)) return false;
    lastSleepAt = Date.now();
    if (transportFails > 0)
      console.error(`pidge: bridge — wall-clock gap (~${Math.round((actualMs - expectedMs) / 1000)}s past schedule) says the machine SLEPT — failure streak reset (a sleeping laptop is not a broken channel)`);
    transportFails = 0;
    alertPolicy.sleptReset();
    return true;
  };
  // Every retry/idle nap measures itself: waking far past the deadline means
  // the OS suspended our timers mid-nap (sleep), never that the nap was slow.
  const napDetectingSleep = async (ms) => {
    const t0 = Date.now();
    await sleepInterruptible(ms);
    detectSleep(ms, Date.now() - t0);
  };

  // Execution attribution — the bridge mints ONE run per handler invocation so
  // each spawned handler signs the messages it answers. A server that predates
  // runs (/runs 404) latches OFF for the whole process: no vars are injected and
  // the bridge behaves EXACTLY as before (attribution can never gate messages).
  let runsUnsupported = false;
  // Polite poller: hold back when a live INTERACTIVE run is the human's turn —
  // a client-side courtesy (delivery is unchanged server-side). Bounded so a
  // dead-but-unexpired interactive run can never wedge the bridge forever.
  let politeUnsupported = false;       // /runs/active 404 ⇒ turn the courtesy off
  let deferSince = null;               // when THIS continuous deference streak began
  const deferEnabled = !v['no-defer']; // --no-defer opts out entirely
  const DEFER_CAP_MS = parseInt(process.env.PIDGE_BRIDGE_DEFER_CAP || '', 10) || 600000; // 10 min ceiling

  // Mint a bridge run for ONE handler. 404 ⇒ latch runsUnsupported (old server);
  // any other failure ⇒ spawn UNSIGNED (a message must never fail to be handled
  // because attribution hiccuped). Returns {token, seal} or null.
  const startBridgeRun = async () => {
    if (runsUnsupported) return null;
    try {
      const res = await fetchT(`${BASE}/api/v1/runs`, {
        method: 'POST', headers,
        // ttl_seconds: a per-batch run must EXPIRE like one. The server default
        // is 24 h (sized for interactive sessions) — a bridge handler that dies
        // ungracefully (SIGTERM teardown skips the best-effort run end below)
        // would otherwise haunt the app as a "live" persona for a day. Twice
        // the handler timeout covers the longest legal handler with margin,
        // floored at 1 h (the server clamps to its own range anyway); expiry is
        // SLIDING, so every signed call the handler makes re-arms it.
        body: JSON.stringify({ mode: 'bridge', ephemeral: true, label: agentLabel(),
                               ttl_seconds: Math.max(3600, handlerTimeoutS * 2) }),
      });
      if (res.status === 404) { runsUnsupported = true; return null; }
      if (res.status < 200 || res.status >= 300) {
        console.error(`pidge: bridge — run start failed (${res.status}) — handling this batch WITHOUT execution attribution`);
        return null;
      }
      const data = await res.json().catch(() => ({}));
      if (!data.run_token) return null;
      return { token: data.run_token, seal: (data.run && data.run.seal) || '' };
    } catch (e) {
      console.error(`pidge: bridge — run start failed (network: ${e.message}) — handling this batch WITHOUT execution attribution`);
      return null;
    }
  };
  // Best-effort run end (idempotent; server expiry covers a miss).
  const endBridgeRun = async (token) => {
    if (!token) return;
    try {
      await fetchT(`${BASE}/api/v1/runs/end`, {
        method: 'POST', headers: { ...headers, 'x-pidge-run': token },
      });
    } catch { /* best-effort — the server reaps it on expiry */ }
  };
  // The polite-poller probe: a live interactive run (last seen < 120 s, not our
  // own seal) ⇒ return it. 404 ⇒ latch politeUnsupported. Any error ⇒ null (never
  // block the loop on a bad probe).
  const liveInteractiveRun = async () => {
    if (politeUnsupported) return null;
    try {
      const res = await fetchT(`${BASE}/api/v1/runs/active`, { headers });
      if (res.status === 404) { politeUnsupported = true; return null; }
      if (res.status < 200 || res.status >= 300) return null;
      const data = await res.json().catch(() => ({}));
      const runs = Array.isArray(data.runs) ? data.runs : [];
      const own = process.env.PIDGE_RUN_SEAL || null;
      const now = Date.now();
      for (const r of runs) {
        if (r.mode !== 'interactive') continue;
        if (own && r.seal === own) continue;
        const seen = r.last_seen_at ? Date.parse(r.last_seen_at) : NaN;
        if (Number.isFinite(seen) && now - seen < 120000) return r;
      }
      return null;
    } catch { return null; }
  };

  // Ack the batch's EXACT ids, never `up_to` (see ackExactIds).
  const ackBatch = (ids, summary, runToken) => ackExactIds('bridge', ids, summary, runToken);

  for (;;) {
    if (shuttingDown) return;
    if (yieldRequested) {
      yieldRequested = false;
      releaseOnce();
      console.error('pidge: bridge — channel handed to the interactive listener; standing by');
      // Wait for the listener to actually TAKE the lock before looking again: a
      // fixed nap raced the listen's own poll (it looks every 500 ms) and this
      // bridge re-took its own lock from under the very listen that asked —
      // measured in CI, twice. A listen that never shows up within the grace
      // period gets the channel handed back (nobody else is consuming).
      const grace = Date.now() + (parseInt(process.env.PIDGE_BRIDGE_YIELD_GRACE || '', 10) || 10000);
      while (Date.now() < grace) {
        const cur = readBridgeLock(bridgeLockPath());
        if (cur && lockHolderAlive(cur) && (cur.kind === 'listen' || cur.kind === 'watch')) break;
        await sleepInterruptible(200);
        if (shuttingDown) return;
      }
      if (!(await acquireOrStandby())) return;
      continue;
    }

    // Polite poller (CLIENT-side courtesy — server delivery is UNCHANGED): if a
    // live interactive run is the human's turn, hold this cycle so the daemon
    // doesn't consume a message meant for the person at the keyboard. Bounded to
    // DEFER_CAP_MS of CONTINUOUS deference (then consume anyway — a stuck
    // interactive run must never wedge the bridge); the budget resets only when
    // the interactive run clears. For anyone who never started an interactive
    // run, `other` is always null ⇒ behaviour is IDENTICAL to before.
    if (deferEnabled && !politeUnsupported) {
      const other = await liveInteractiveRun();
      if (shuttingDown) return;
      if (other) {
        if (deferSince === null) deferSince = Date.now();
        if (Date.now() - deferSince < DEFER_CAP_MS) {
          console.error(`pidge bridge: deferring to interactive run ${other.seal}`);
          await sleepInterruptible(jitter(intervalS * 1000));
          continue;
        }
        // past the ceiling — consume this cycle, but keep deferSince set so we
        // don't re-arm the whole budget while the interactive run lingers.
      } else {
        deferSince = null; // interactive run gone → the courtesy budget resets
      }
    }

    let res = null, data = null, failWhat = null, failCode = null;
    const waitS = 25;
    const askedAt = Date.now();
    try {
      // continuity=true asks the server to hand this cold handler the thread it
      // already holds (gotcha #51 — read-only provenance, not messages). Unknown
      // to an old server ⇒ ignored, behaviour identical.
      const qs = new URLSearchParams({ all: 'true', wait: String(waitS), continuity: 'true' });
      pollAbort = new AbortController();
      res = await fetchT(`${BASE}/api/v1/messages?${qs}`, { headers, signal: pollAbort.signal }, (waitS + 10) * 1000);
      await checkManifestNews(res);
    } catch (e) {
      failWhat = `network: ${e.message}`;
      failCode = (e && (e.code || (e.cause && e.cause.code))) || null; // undici rides the errno on cause
    } finally {
      pollAbort = null;
    }
    if (shuttingDown) return;
    // The poll was cut short by a yield request: hand the channel over NOW —
    // no failure streak, no backoff (the top of the loop does the handoff).
    if (failWhat && yieldRequested) continue;

    if (res && res.status === 200) {
      data = await res.json().catch(() => null);
      if (data === null) failWhat = 'unparseable 200 body';
    } else if (res && res.status === 401) {
      // A 401 must not die silent NOR re-loop blind — narrate, alert
      // locally ONCE per outage, retry with LONG jittered backoff. The key may
      // have been rotated; only the human can fix that.
      if (!alerted401) {
        alerted401 = true;
        localAlert('key rejected (401)', `the server rejected the channel key — probably ROTATED. The bridge is deaf until a human re-onboards (\`pidge setup --claim <code>\`). Retrying every ~${Math.round(BACKOFF_LONG_MS / 1000)}s.`);
      } else {
        console.error(`pidge: bridge — still 401 (rotated key?) — next retry in ~${Math.round(BACKOFF_LONG_MS / 1000)}s`);
      }
      await sleepInterruptible(jitter(BACKOFF_LONG_MS));
      continue;
    } else if (res) {
      failWhat = `listen error ${res.status}`;
    }

    if (failWhat) {
      // Sleep detection FIRST: a long-poll that comes back hours past its own
      // timeout measured the lid closing, not the server — that failure is not
      // evidence of anything and must not count toward any streak.
      if (detectSleep((waitS + 10) * 1000, Date.now() - askedAt)) {
        console.error(`pidge: bridge — poll interrupted by system sleep (${failWhat}) — not counted; retrying fresh`);
        await napDetectingSleep(jitter(BACKOFF_BASE_MS));
        continue;
      }
      transportFails++;
      const shape = classifyBridgeFailure({
        status: res ? res.status : null,
        code: failCode,
        hasNetwork: hasNonInternalNetwork(),
        justWoke: Date.now() - lastSleepAt < 60000,
      });
      // The exit-4 class (a channel with NO healthy round-trip) becomes, in a
      // daemon, "long backoff + (at most) ONE local alert" — never a blind hot
      // re-loop and never a silent death. The DESKTOP alert is gated by the
      // sleep-aware policy (server-shaped + ≥10 min awake + 4 h cool-down);
      // local/offline failures only ever narrate to stderr.
      const verdict = alertPolicy.fail(shape, Date.now());
      if (verdict) {
        localAlert('channel looks broken', `${transportFails} consecutive failures reaching ${BASE} over ~${Math.max(1, Math.round(verdict.awakeMs / 60000))} min while the local network looks fine (latest: ${failWhat}) — server or path, not the human. The bridge keeps retrying with long backoff.`);
      } else {
        console.error(`pidge: bridge — ${failWhat} (${transportFails} consecutive, looks ${shape === 'local' ? 'LOCAL — this machine/network, no desktop alert' : 'server-shaped'}) — backing off`);
      }
      await napDetectingSleep(jitter(transportFails >= BROKEN_AFTER
        ? BACKOFF_MAX_MS
        : Math.min(BACKOFF_BASE_MS * 2 ** (transportFails - 1), BACKOFF_MAX_MS)));
      continue;
    }

    // A successful poll can still have SLEPT mid-hold (long-poll + lid close):
    // stamp the wake so a stale-socket failure right after classifies as local.
    if (sleptThrough((waitS + 10) * 1000, Date.now() - askedAt)) lastSleepAt = Date.now();

    // A healthy round-trip: narrate recovery once, reset the failure ledgers.
    const hadBrokenAlert = alertPolicy.recovered(); // closes the outage; true ⇒ the desktop alert HAD fired
    if (transportFails > 0 || alerted401 || hadBrokenAlert) {
      console.error(`pidge: bridge — channel recovered${transportFails ? ` after ${transportFails} consecutive failure(s)` : ''}`);
      // Quiet closure ONLY when the loud alert fired — the human who was told
      // "broken" deserves the "it healed"; nobody else needs a popup.
      if (hadBrokenAlert) localAlert('channel recovered', `the round-trip to ${BASE} is healthy again — the earlier "channel looks broken" alert is resolved.`);
      transportFails = 0; alerted401 = false;
    }
    warnStalePriorClaim(data); // newer servers serve the flag on this GET too
    warnConsumerConflict(data); // the consume GET flags a live sibling

    const allMsgs = Array.isArray(data.messages) ? data.messages : [];
    // Gate hygiene — a Face-ID gate answer is acked here and NEVER spawns a
    // handler. The rule and the reasoning live in siftGatedReplies (shared with
    // the listen/online watch, which consumes this same queue).
    const msgs = await siftGatedReplies('bridge', allMsgs);
    if (msgs.length === 0) {
      // The long-poll hold IS the pacing; only a fast empty return sleeps (a
      // server that doesn't hold ?wait= must not become a hot loop). The
      // sleep-detecting nap stamps a wake if the machine dozed off mid-idle.
      if (Date.now() - askedAt < 2000) await napDetectingSleep(jitter(intervalS * 1000));
      continue;
    }

    // ONE handler invocation per batch — the whole tick as JSON on stdin.
    // Sealed rows are opened BEFORE the handler sees them (same path as listen).
    // …and a voice note reaches the handler NAMED (kind/duration + the
    // no-transcription hint), not as an anonymous blob it might narrate blind.
    const opened = annotateVoiceAttachments(await Promise.all(msgs.map((m) => e2eOpenMessageRow(m))));
    const batchIds = opened.map((m) => Number(m.id)).filter(Number.isInteger);
    const batch = { messages: opened, ...(firstBatch ? { history_hint: true } : {}) };
    // gotcha #51: continuity contexts are READ-ONLY provenance, NOT messages —
    // they ride the batch as `continuity` but nothing in them is ackable (batchIds
    // above stays messages-only) and continuity infra never promotes a prior-run
    // statement to a verified fact. Present-only: an old server omits the field ⇒
    // the batch has no `continuity` key (byte-identical to before).
    const continuity = await e2eOpenContinuityContexts(data.continuity_contexts);
    if (continuity) batch.continuity = continuity;
    console.error(`pidge: bridge — batch of ${opened.length} message(s) → handler${firstBatch ? ' (history_hint: first batch since this bridge started — the handler may want `pidge catchup` to situate)' : ''}`);
    // Mint ONE run for this handler and inject its bearer + seal — the handler's
    // own pidge calls (and this batch's ack) then sign with it. null ⇒ old server
    // or a hiccup: spawn unsigned, exactly as before.
    const runInfo = await startBridgeRun();
    if (runInfo) console.error(`pidge: bridge — run ${runInfo.seal || '?'} signs this batch`);
    // ONE handler invocation. Everything mechanical (spawn, the settle on
    // exit+EOF, the streamed `pidge-summary:` scan, the stdout tee, the
    // --handler-timeout kill, the heartbeat and the lease renew) lives in the
    // shared runHandlerOnce — `pidge listen --exec` runs the SAME machinery.
    // The bridge keeps only what is its own: the child handle its SIGTERM
    // teardown forwards to.
    const { outcome, summary: lastSummary, seconds: secs } = await runHandlerOnce({
      tag: 'bridge',
      handlerCmd,
      batch,
      batchIds,
      // Inject the run bearer + seal so the handler's pidge calls self-sign;
      // no run ⇒ plain process.env (unchanged behaviour).
      env: runInfo
        ? { ...process.env, PIDGE_RUN_TOKEN: runInfo.token, PIDGE_RUN_SEAL: runInfo.seal }
        : process.env,
      handlerTimeoutS,
      narrateMs: HANDLER_NARRATE_MS,
      renewMs: RENEW_MS,
      onSpawn: (child) => { currentChild = child; },
      onSettle: () => { currentChild = null; },
    });
    // Hard case: the handler-exit → ack race. A signal that landed while the
    // handler ran (or right as it exited) means shutdown() is tearing us down —
    // do NOT ack: the batch stays leased and re-serves. A duplicate delivery
    // beats a batch stamped "processed" during a teardown.
    if (shuttingDown) return;
    // A timed-out handler NEVER acks — even if it trapped SIGTERM and exited 0:
    // its work was cut short by definition.
    if (outcome.code === 0 && !outcome.timedOut) {
      handlerFails = 0;
      if (batchIds.length === 0) {
        console.error('pidge: bridge — WARNING: batch had no numeric ids — nothing to ack (server bug?)');
      } else if (await ackBatch(batchIds, lastSummary, runInfo && runInfo.token)) {
        // Only a DELIVERED + ACKED first batch retires the hint: if the ack
        // failed, the re-served batch is still effectively "first post-restart".
        firstBatch = false;
      }
    } else {
      handlerFails++;
      const why = outcome.error ? `couldn't run (${outcome.error})`
        : outcome.timedOut ? `timed out (--handler-timeout ${handlerTimeoutS}s)`
          : outcome.signal ? `killed by ${outcome.signal}` : `exit ${outcome.code}`;
      console.error(`pidge: bridge — handler ${why} after ${secs}s — batch NOT acked (the server lease re-serves it in ~10 min; ${handlerFails} consecutive handler failure(s))`);
      // Backoff BEFORE the next poll: fresh arrivals would re-invoke a handler
      // that's evidently broken — escalate so a dead handler doesn't burn one
      // LLM call per message. Jittered like every other sleep.
      await sleepInterruptible(jitter(Math.min(BACKOFF_BASE_MS * 2 ** (handlerFails - 1), BACKOFF_MAX_MS)));
    }
    // End the handler's run AFTER the ack (which had to sign with it). Best-effort:
    // a miss is reaped by the server's run expiry.
    await endBridgeRun(runInfo && runInfo.token);
  }
}

// `pidge bridge install` — the ONE command that takes an agent "online" in the
// sense a human means it: reachable from the phone at any hour, and answering.
//
// Why a preset handler exists (paid for on three fresh-agent runs, 2026-08/09):
// the pasted prompt said "stay online: run `listen --all` as a tracked
// background task"; the harness killed that task the moment the turn ended with
// nothing else to do, the human saw "offline", and the agent — told to relaunch
// — either relaunched forever or stopped and went quiet. What finally held was
// a bridge under systemd. To get there the agent hand-wrote ~60 lines of
// handler (batch to a temp file, prompt through stdin, cwd, PATH, a fallback
// summary line, the "system-only batch" rule), added the WorkingDirectory the
// template lacked (the project-scoped key resolves by cwd — the daemon started
// in $HOME found no key), and installed the CLI globally to escape the npx
// cache. Every agent would rewrite exactly that, each with its own bugs. So:
// `--handler claude|codex|gemini` generates the handler + an editable prompt
// file, the template carries WorkingDirectory + a durable ExecStart, `--enable`
// starts it, and a selftest PROVES the round-trip before anything says "online".
//
// The template NEVER embeds the key — it stays in the config file (token
// hygiene); only the non-secret env (PIDGE_URL/PIDGE_AGENT/XDG_CONFIG_HOME/PATH)
// rides along.
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
// systemd unit-file quoting: double quotes with backslash escapes, PLUS the
// unit-file expansions: '$' would be variable-expanded in command
// lines ($$ = literal $) and '%' is a specifier everywhere (%% = literal %) —
// a handler like `claude -p "$x is 100%"` must arrive verbatim.
function systemdQuote(s) {
  return '"' + String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, () => '$$')
    .replace(/%/g, '%%') + '"';
}
// POSIX single-quote: safe inside a generated shell script.
function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// The three model CLIs a fresh agent is likely to BE. Each entry is how to run
// one headless turn with the PROMPT ON STDIN (a prompt ARGUMENT is unreliable
// once stdin is a pipe — `claude -p` discards it outright) and tools allowed
// without a human at the keyboard.
const HANDLER_PRESETS = {
  claude: {
    bin: 'claude',
    invoke: 'claude -p "${RESUME[@]}" --allowedTools "$TOOLS" --max-turns 40 --output-format text',
    tools: 'Bash,Read,Edit,Write,Grep,Glob',
    // ONE continuous session across batches: the on-call Claude remembers what
    // the human said an hour ago instead of being born cold per message.
    resume: true,
  },
  codex: {
    bin: 'codex',
    invoke: 'codex exec --full-auto --skip-git-repo-check -', // `-` = instructions from stdin
    tools: null,
  },
  gemini: {
    bin: 'gemini',
    invoke: 'gemini --yolo', // non-interactive when stdin is piped; --yolo auto-approves tools
    tools: null,
  },
};
function whichOnPath(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const f = path.join(d, bin);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}
// Pick the preset: an explicit --handler, else the FIRST model CLI found on
// PATH (claude, codex, gemini — the order is popularity, not preference).
function resolveHandlerPreset() {
  const asked = (v.handler || '').trim().toLowerCase();
  if (asked) {
    if (!HANDLER_PRESETS[asked]) die(`pidge: bridge install — unknown --handler "${asked}" (one of: ${Object.keys(HANDLER_PRESETS).join(', ')}), or pass your own --exec '<command>'`, 1);
    return { name: asked, ...HANDLER_PRESETS[asked], found: whichOnPath(HANDLER_PRESETS[asked].bin) };
  }
  for (const name of Object.keys(HANDLER_PRESETS)) {
    const found = whichOnPath(HANDLER_PRESETS[name].bin);
    if (found) return { name, ...HANDLER_PRESETS[name], found };
  }
  return null;
}

// How the daemon (and the handler's own `pidge` calls) must invoke THIS CLI so
// it survives the launcher's absence: an npx-cache path is EPHEMERAL (npx
// prunes), so a template pointing into it dies on the next prune — observed,
// and the reason agents used to `npm i -g` first. From the cache we pin
// `npx -y pidge-cli@<this version>` (npx sits next to node); from a real
// install we call node + this file directly.
function durableCliInvocation() {
  const nodeBin = process.execPath;
  const cli = __filename;
  if (/[\\/]_npx[\\/]/.test(cli)) {
    const npx = path.join(path.dirname(nodeBin), 'npx');
    let ver = 'latest';
    try { ver = require(path.join(__dirname, '..', 'package.json')).version || 'latest'; } catch { /* keep latest */ }
    if (fs.existsSync(npx)) return { argv: [npx, '-y', `pidge-cli@${ver}`], via: 'npx' };
    console.error('pidge: bridge install — WARNING: this CLI is running from the npx CACHE and no `npx` sits next to node — the generated files point into the cache and BREAK when npx prunes. Install it durably (npm i -g pidge-cli) and re-run `pidge bridge install`.');
  }
  return { argv: [nodeBin, cli], via: 'path' };
}

// The daemon's PATH: the current one (what the human/agent just tested with —
// launchd/systemd give services a MINIMAL PATH and a homebrew/nvm/mise
// `claude` would exit 127) with node's own dir in front, so the handler's
// `$NODE` and the shim's `npx` resolve even under a bare service PATH.
function daemonPath() {
  const seen = new Set();
  const parts = [path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter)]
    .filter((p) => p && !seen.has(p) && seen.add(p));
  return parts.join(path.delimiter);
}

function renderBridgeHandler({ preset, workdir, promptFile, shimDir, nodeBin, sessionFile }) {
  const toolsLine = preset.tools
    ? `TOOLS="\${PIDGE_HANDLER_TOOLS:-${preset.tools}}"   # what the model may use headless (no human to approve)\n`
    : '';
  // Session continuity (claude): the first batch mints a session id and keeps
  // it in a file; every later batch RESUMES it. A resumed run that fails drops
  // the file so the next batch starts fresh — memory is a courtesy, delivery is
  // the contract (the lease re-serves the batch either way).
  const resumeLines = preset.resume ? [
    `SESSION_FILE=${shQuote(sessionFile)}`,
    '# One resumed session per DAY: continuity within a conversation, a bounded context',
    '# across days (a session resumed forever re-bills its whole history on every cold batch).',
    'TODAY="$(date +%F)"',
    'if [ -s "$SESSION_FILE" ] && [ "$(head -c 10 "$SESSION_FILE")" = "$TODAY" ]; then',
    '  RESUME=(--resume "$(cut -c12- "$SESSION_FILE")")',
    'else',
    '  SID="$("$NODE" -e \'console.log(require("crypto").randomUUID())\')"; printf \'%s %s\' "$TODAY" "$SID" > "$SESSION_FILE"',
    '  RESUME=(--session-id "$SID")',
    'fi',
  ] : [];
  const resumeFail = preset.resume ? [
    'if [ "$code" -ne 0 ] && [ "${RESUME[0]}" = "--resume" ]; then',
    '  rm -f "$SESSION_FILE"; echo "pidge-handler: the resumed session failed (exit $code) — the next batch starts a fresh one" >&2',
    'fi',
  ] : [];
  return [
    '#!/usr/bin/env bash',
    `# generated by \`pidge bridge install --handler ${preset.name}\` (${new Date().toISOString().slice(0, 10)}).`,
    '# The bridge runs this ONCE per batch of your human\'s messages: the batch JSON',
    '# is on stdin and at $PIDGE_BATCH_FILE. Exit 0 => the bridge acks the batch;',
    '# non-zero => nothing is acked and the server re-serves it in ~10 min (keep it',
    '# idempotent). The LAST stdout line `pidge-summary: <one sentence>` becomes the',
    '# ack note the next session reads in `pidge catchup`.',
    `# Edit freely. The prompt lives in ${promptFile}.`,
    '# Re-running `pidge bridge install` overwrites both (a .bak of each is kept).',
    'set -uo pipefail',
    `cd ${shQuote(workdir)} || { echo "pidge-handler: cannot cd to ${workdir}" >&2; exit 1; }`,
    '# `pidge` resolves to the SAME CLI the bridge runs, whatever PATH says.',
    `export PATH=${shQuote(shimDir)}:"$PATH"`,
    `NODE=${shQuote(nodeBin)}`,
    `PROMPT_FILE=${shQuote(promptFile)}`,
    toolsLine.trimEnd(),
    '',
    'TMP_BATCH=""',
    'OUT="$(mktemp "${TMPDIR:-/tmp}/pidge-handler-out.XXXXXX")"',
    'cleanup() { rm -f "$OUT" ${TMP_BATCH:+"$TMP_BATCH"}; }',
    'trap cleanup EXIT',
    'BATCH="${PIDGE_BATCH_FILE:-}"',
    'if [ -z "$BATCH" ] || [ ! -r "$BATCH" ]; then',
    '  TMP_BATCH="$(mktemp "${TMPDIR:-/tmp}/pidge-batch.XXXXXX")"; cat > "$TMP_BATCH"; BATCH="$TMP_BATCH"',
    'fi',
    ...resumeLines,
    '',
    '# A batch of ONLY system rows (a selftest nonce, a contract change) is not your',
    '# human: answer nothing. Still check that the model CLI resolves under the',
    '# daemon\'s environment — PATH is the #1 way a daemon breaks — so a selftest',
    '# catches it here instead of the first real message.',
    "if \"$NODE\" -e 'const b=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"));const m=Array.isArray(b.messages)?b.messages:[];process.exit(m.length&&m.every(x=>x&&x.kind===\"system\")?0:1)' \"$BATCH\"; then",
    `  command -v ${preset.bin} >/dev/null 2>&1 || { echo "pidge-handler: '${preset.bin}' not found on PATH under the daemon (PATH=$PATH)" >&2; exit 127; }`,
    '  echo "pidge-summary: system-only batch (selftest / contract update) — nothing to answer"',
    '  exit 0',
    'fi',
    '',
    '# The prompt goes through STDIN (a model CLI\'s prompt argument is unreliable',
    '# once stdin is a pipe); the batch file is named at its end. stdout is tee\'d:',
    '# the bridge scans it for the last `pidge-summary:` line.',
    '{ cat "$PROMPT_FILE"; printf \'\\n\\nThe batch file to read now: %s\\n\' "$BATCH"; } \\',
    `  | ${preset.invoke} | tee "$OUT"`,
    'code=${PIPESTATUS[1]}',
    ...resumeFail,
    '',
    '# No summary line from the model? Synthesize one from the TAIL of its output — only then;',
    '# never overwrite its own. A successor reading `catchup` gets what happened, not a shrug.',
    'if [ "$code" -eq 0 ] && ! grep -q \'^pidge-summary:\' "$OUT"; then',
    '  tail_line="$(tr \'\\n\' \' \' < "$OUT" | sed \'s/  */ /g\' | tail -c 180)"',
    '  echo "pidge-summary: (auto) ${tail_line# }"',
    'fi',
    'exit "$code"',
    '',
  ].filter((l) => l !== null).join('\n');
}

function renderBridgePrompt({ preset, workdir, channelName }) {
  const who = channelName ? ` (channel "${channelName}")` : '';
  return `You are the on-call agent for the project in ${workdir}${who}, reached by your human through Pidge — to them this is a chat with you on their phone: answer fast, short, and in the language they wrote in.

You are ONE continuous session across batches when your runtime supports resuming: what you and your human said in earlier batches is in your context — use it like a person would, and never re-introduce yourself.

A batch of their messages is in the JSON file named at the end of this prompt ({"messages":[…], "continuity":[…]}). Each message has "body" (their text) and sometimes "attachment" (a photo, a file or a voice note — a short-lived "url" to download; a voice note needs transcribing, and if no transcriber is available say so instead of guessing). "continuity" is read-only thread context (their earlier messages, prior agent turns, what is still open): treat what a PRIOR agent run claims as unverified.

Before anything: run pidge whoami and confirm the channel is the one named above${channelName ? '' : ' (this project\'s channel)'} — if it is not, exit non-zero without touching anything (wrong identity). Then situate in ONE read: pidge catchup --digest (read-only). Delivery is at-least-once, so a batch can come back after a failed run: a line already marked "handled by …" is done — do not redo it.

Reading budget: about one minute. Your human is waiting on the phone. Read the project's CLAUDE.md / AGENTS.md / README only when the request needs project knowledge — for a greeting or a quick answer, answer from what you have.

Rules:
1. REPLY THROUGH PIDGE, never in your stdout (it is a log nobody reads). From this directory run: pidge message --title "<up to 60 chars>" --body "<up to 140 chars>" [--body-markdown "<the detail>"]. Need a decision? pidge important --actions yes,no --title "…" --body "…" (send and exit — the answer comes back as a later batch). One reply per question. Never put a secret (a key, a PIN, a password) in --title or --body — they show on the lock screen; only in --body-markdown.
2. Small and clear (a question, a lookup, a small edit, a status check): DO IT, then reply with the result. If it touched code, run the project's tests before you say it works, and commit with a clear message. Deploy only when explicitly asked.
3. Big or ambiguous: do not start halfway. Reply with what you understood, say it needs a full session in ${workdir}, and ask the ONE question that unblocks it.
4. A "notification_reply" row is an ANSWER to a question someone asked earlier — its "ref" (correlation_id, title) says which. A bare "Yes"/"Done"/"Submit" body without a ref that clearly matches a question of yours is ambiguous: never act on it, ask back with context. Silence is a valid reply to an FYI; do not pile sends on an unanswered stack.
5. Never run pidge setup, listen, online, bridge, or ack — the bridge owns the queue and acks for you when you exit 0. If you could NOT handle the batch, exit non-zero so it comes back.
6. You are the on-call STAND-IN, not the main session your human works with. Say what you did or what you need — never that you are "online" or "listening" (the bridge listens; the server measures it). When a request needs the main session's context or a real work session, say so plainly and tell them to reopen it there.
7. If the project keeps a log or journal, append one line saying what you did; if you changed files, commit with a one-line message. Use a stable, prefixed correlation_id (--param correlation_id=<project>-<topic>) on any send you might repeat, so a re-run upserts instead of duplicating.
8. End with exactly one final line: pidge-summary: <one sentence on what you did> — it becomes the ack note the next session reads. Could NOT handle the batch (wrong channel, an error, a timeout coming)? Print no summary and exit non-zero — the queue re-serves it.
`;
}

// Write a file, keeping a .bak of an existing one whose content differs.
function writeWithBackup(file, content, mode) {
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== content) fs.copyFileSync(file, `${file}.bak`);
  } catch { /* best-effort backup */ }
  fs.writeFileSync(file, content, { mode });
  try { fs.chmodSync(file, mode); } catch { /* pre-existing looser file */ }
}

function bridgeServiceName() {
  const nameSuffix = AGENT_ID ? `.${AGENT_ID}` : '';
  return { label: `sh.pidge.bridge${nameSuffix}`, unit: `pidge-bridge${nameSuffix}.service` };
}
function bridgeServiceFile(platform) {
  const { label, unit } = bridgeServiceName();
  if (platform === 'darwin') return { file: path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`), label, unit };
  return { file: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', unit), label, unit };
}
function runServiceSteps(steps) {
  const { spawnSync } = require('node:child_process');
  for (const [cmd, args] of steps) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    const shown = `${cmd} ${args.join(' ')}`;
    if (r.error) return { ok: false, command: shown, error: r.error.message };
    if (r.status !== 0) return { ok: false, command: shown, error: (r.stderr || r.stdout || '').trim() || `exit ${r.status}` };
  }
  return { ok: true };
}
// "Is the bridge up?" — the server's live-consumer list when it reports one,
// else the local lock (a PID-checked file the running bridge holds).
async function waitForBridgeLive(ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const cur = readBridgeLock(bridgeLockPath());
    const lockLive = !!(cur && lockHolderAlive(cur));
    let serverLive = null;
    try {
      const { res, data } = await fetchWhoami();
      if (res.status === 200 && Array.isArray(data.consumers)) serverLive = data.consumers.some((c) => c && c.live);
    } catch { /* unknown */ }
    if (serverLive === true || (serverLive === null && lockLive)) return { live: true, lock: lockLive, server: serverLive };
    if (Date.now() >= deadline) return { live: false, lock: lockLive, server: serverLive };
    await sleep(1000);
  }
}

async function runBridgeInstall() {
  // PIDGE_BRIDGE_PLATFORM: test hook so BOTH templates are exercised on any OS.
  const platform = process.env.PIDGE_BRIDGE_PLATFORM || process.platform;
  const workdir = PROJECT_ROOT || process.cwd();
  const { file, label, unit } = bridgeServiceFile(platform);
  const cliInv = durableCliInvocation();

  if (v.exec && v.handler) die("pidge: bridge install — pass EITHER --handler <claude|codex|gemini> (a generated handler) OR --exec '<command>' (your own), not both", 1);
  let handlerCmd = v.exec;
  let handlerInfo = null;
  if (!handlerCmd) {
    const preset = resolveHandlerPreset();
    if (!preset)
      die(`pidge: bridge install needs a handler — none of ${Object.keys(HANDLER_PRESETS).map((n) => HANDLER_PRESETS[n].bin).join('/')} is on PATH to generate one. Either --handler <claude|codex|gemini> (with that CLI installed), or --exec '<the exact command the daemon runs once per batch>'.`, 1);
    if (!preset.found && v.handler)
      console.error(`pidge: bridge install — WARNING: --handler ${preset.name} but \`${preset.bin}\` is not on PATH right now; the daemon inherits THIS PATH, so the handler will exit 127 until it is installed.`);
    // The handler, its prompt and the `pidge` shim live in the identity's own
    // config dir (project-scoped when run inside a project): identity, handler
    // and daemon travel together, and the repo stays untouched.
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const shimDir = path.join(CONFIG_DIR, 'bin');
    fs.mkdirSync(shimDir, { recursive: true, mode: 0o700 });
    const shim = path.join(shimDir, 'pidge');
    writeWithBackup(shim, `#!/usr/bin/env bash\n# generated by \`pidge bridge install\` — the exact CLI the bridge runs.\nexec ${cliInv.argv.map(shQuote).join(' ')} "$@"\n`, 0o700);
    const promptFile = path.join(CONFIG_DIR, 'bridge-prompt.md');
    const script = path.join(CONFIG_DIR, 'bridge-handler.sh');
    let channelName = null;
    try { const who = await fetchWhoami(); if (who.res.status === 200 && who.data.channel) channelName = who.data.channel.name; } catch { /* prompt just omits it */ }
    writeWithBackup(promptFile, renderBridgePrompt({ preset, workdir, channelName }), 0o600);
    writeWithBackup(script, renderBridgeHandler({ preset, workdir, promptFile, shimDir, nodeBin: process.execPath, sessionFile: path.join(CONFIG_DIR, 'bridge-session-id') }), 0o700);
    handlerCmd = script;
    handlerInfo = { kind: preset.name, script, prompt: promptFile, shim };
    console.error(`pidge: bridge install — handler: ${preset.name} (${preset.found || preset.bin}) → ${script}; its prompt (edit it to taste): ${promptFile}`);
  }

  const envPairs = {};
  if (process.env.PIDGE_URL) envPairs.PIDGE_URL = process.env.PIDGE_URL;
  if (process.env.PIDGE_AGENT) envPairs.PIDGE_AGENT = process.env.PIDGE_AGENT;
  if (process.env.XDG_CONFIG_HOME) envPairs.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  envPairs.PATH = daemonPath();

  if (!FILE_ENV.PIDGE_TOKEN && (process.env.PIDGE_TOKEN || process.env.HERALD_TOKEN))
    console.error(`pidge: bridge install — WARNING: your key lives ONLY in this shell's env; the daemon won't inherit it (the template NEVER embeds secrets). Put it in the config file first — re-run \`pidge setup --claim <code>\`, or write PIDGE_TOKEN=… to ${CONFIG_FILE} yourself (chmod 600).`);

  let enableCmd;
  if (platform === 'darwin') {
    const envBlock = `  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(envPairs).map(([k, val]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(val)}</string>`).join('\n')}\n  </dict>\n`;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<!-- generated by \`pidge bridge install\`. Enable with
     launchctl load -w <this file>
     The channel key stays in the pidge config dir — NEVER embedded here. -->
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${[...cliInv.argv, 'bridge', '--exec', handlerCmd].map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')}
  </array>
  <!-- the project this identity belongs to: the project-scoped key resolves by cwd -->
  <key>WorkingDirectory</key><string>${xmlEscape(workdir)}</string>
  <key>RunAtLoad</key><true/>
  <!-- Restart=on-failure: a clean exit 0 (SIGTERM shutdown / launchctl unload) stays down -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
${envBlock}  <key>StandardOutPath</key><string>${xmlEscape(path.join(CONFIG_DIR, 'bridge.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(CONFIG_DIR, 'bridge.err.log'))}</string>
</dict>
</plist>
`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, plist);
    enableCmd = `launchctl load -w "${file}"`;
  } else {
    const envLines = Object.entries(envPairs).map(([k, val]) => `Environment=${systemdQuote(`${k}=${val}`)}`).join('\n');
    const unitText = `# generated by \`pidge bridge install\`. Enable with
#   systemctl --user daemon-reload && systemctl --user enable --now ${unit}
# The channel key stays in the pidge config dir — NEVER embedded here.
[Unit]
Description=pidge bridge — supervised Pidge consumer (one handler invocation per batch)
# Wants + After: After alone only ORDERS against the target if
# something else pulls it in — Wants actually pulls it into the transaction.
Wants=network-online.target
After=network-online.target

[Service]
# The project this identity belongs to: the project-scoped key resolves by cwd,
# and the handler works in it.
WorkingDirectory=${workdir}
ExecStart=${cliInv.argv.map(systemdQuote).join(' ')} bridge --exec ${systemdQuote(handlerCmd)}
Restart=on-failure
RestartSec=10
${envLines}
StandardOutput=append:${path.join(CONFIG_DIR, 'bridge.log')}
StandardError=append:${path.join(CONFIG_DIR, 'bridge.err.log')}

[Install]
WantedBy=default.target
`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, unitText);
    enableCmd = `systemctl --user daemon-reload && systemctl --user enable --now ${unit}`;
  }
  console.error(`pidge: bridge install — service written to ${file} (Restart=on-failure semantics; WorkingDirectory ${workdir}; logs → ${path.join(CONFIG_DIR, 'bridge.log')})`);

  // Declare listen_mode=external_daemon (ADVISORY, honest — the "same instance
  // forever" sharp edge the human should see). Best-effort like setup's declaration.
  let declared = null;
  try {
    const who = await fetchWhoami();
    if (who.res.status === 200 && who.data.channel) {
      v['listen-mode'] = 'external_daemon';
      declared = await declareOperatingContract(BASE, TOKEN, who.data.channel.id);
    } else {
      console.error(`pidge: bridge install — couldn't declare listen_mode=external_daemon (whoami ${who.res.status}); do it later: pidge contract set listen_mode=external_daemon`);
    }
  } catch (e) {
    console.error(`pidge: bridge install — couldn't declare listen_mode=external_daemon (network: ${e.message}); do it later: pidge contract set listen_mode=external_daemon`);
  }

  const out = {
    ok: true, file, platform: platform === 'darwin' ? 'launchd' : 'systemd', workdir,
    cli: cliInv.via, handler: handlerInfo, listen_mode_declared: declared === 'external_daemon',
    enabled: null, selftest: null,
  };
  if (!v.enable) {
    console.error(`pidge: enable it with:  ${enableCmd}`);
    console.error('pidge: then PROVE it: `pidge selftest --window 120` (a live bridge acks the nonce; nothing listening = FAIL). Or do both in one step next time: `pidge bridge install --enable`.');
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  // --enable: start it under the OS supervisor, wait for it to be live, PROVE
  // the round-trip. "Online" is what the selftest says, never what this
  // command claims.
  const steps = platform === 'darwin'
    ? [['launchctl', ['load', '-w', file]]]
    : [['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', '--now', unit]]];
  const en = runServiceSteps(steps);
  if (!en.ok) {
    out.ok = false; out.enabled = false; out.enable_error = en.error;
    console.error(`pidge: ❌ bridge install — enabling FAILED at \`${en.command}\`: ${en.error}. The service file is written; fix the cause and enable it by hand:  ${enableCmd}`);
    console.log(JSON.stringify(out, null, 2));
    process.exit(2);
  }
  out.enabled = true;
  console.error(`pidge: bridge install — enabled (${platform === 'darwin' ? label : unit}); waiting for the bridge to come up…`);
  const up = await waitForBridgeLive(parseInt(process.env.PIDGE_BRIDGE_UP_WAIT || '', 10) || 30000);
  if (!up.live) {
    out.ok = false;
    console.error(`pidge: ❌ bridge install — the service is enabled but no live consumer showed up in time (server: ${up.server === null ? 'unknown' : up.server}, local lock: ${up.lock}). Read its log: ${path.join(CONFIG_DIR, 'bridge.err.log')}${platform === 'darwin' ? '' : `  (or: journalctl --user -u ${unit} -n 50)`}. Typical causes: the key is not in the config file (the daemon never sees your shell env), or a PATH the daemon lacks.`);
    console.log(JSON.stringify(out, null, 2));
    process.exit(2);
  }
  // The generated handler answers a system-only batch WITHOUT calling the
  // model, so this proves the daemon, its PATH, its cwd/identity and the ack
  // round-trip — the parts that break — in seconds; the model itself is proven
  // by the first real message. A custom --exec handler that runs a model on
  // every batch gets the full window.
  const windowS = parseInt(process.env.PIDGE_SELFTEST_WINDOW || '', 10) || 120; // env = test hook
  const st = await selftestRoundTrip(windowS);
  out.selftest = st;
  out.ok = st.status === 'passed';
  if (out.ok) {
    console.error(`pidge: ✅ STAND-IN ONLINE — the bridge answers this channel as ANOTHER agent (a resumed model session), from ${workdir}, and survives this session; it yields to a live listen/watch and takes over again after. From now on in THIS session: read with \`pidge catchup --digest\` and send with \`pidge message\` — never \`listen\`/\`online\` here (the bridge holds the channel; a second consumer is refused). Logs: ${path.join(CONFIG_DIR, 'bridge.log')}. Stop it: \`pidge bridge uninstall\`.`);
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(2);
}

// `pidge presence` — ONE line, built for a session-start hook: is anyone
// listening on this channel right now? A fresh session (or one just cleared or
// compacted) reads it before it reads anything else, so "start the watch" is
// something the harness TELLS the agent, not something the agent must remember.
async function runPresence() {
  let who = null;
  try { who = await fetchWhoami(); } catch { /* unknown */ }
  if (!who || who.res.status !== 200 || !who.data.channel) {
    console.log('Pidge: channel state UNKNOWN from here (no identity in this environment, or the server is unreachable) — `pidge doctor`.');
    process.exit(0);
  }
  const d = who.data;
  const live = Array.isArray(d.consumers) ? d.consumers.filter((c) => c && c.live) : [];
  // The server's measured presence decides; the consumer list only names who.
  // Right after a session dies the consumer row lingers for ~35 s while the
  // presence already reads offline — printing "offline — X holds the queue"
  // was measured, and it is exactly the contradiction a fresh session must not read.
  const state = d.listening_state || (live.length ? 'listening' : 'offline');
  if (state === 'listening') {
    console.log(`Pidge (channel "${d.channel.name}"): ${state} — ${live.map((c) => `${c.label || 'a consumer'}${c.kind ? ` [${c.kind}]` : ''}`).join(', ') || 'a consumer'} holds the queue. Read with \`pidge catchup --digest\`; never start a second listener.`);
  } else {
    console.log(`Pidge (channel "${d.channel.name}"): OFFLINE — nobody is listening, your human cannot reach you. Start the watch now: Monitor({command:'pidge online --follow --ndjson --timeout 0', description:'Pidge: messages from my human', persistent:true}) — then answer through \`pidge message\` and \`pidge ack\`.`);
  }
  process.exit(0);
}
// The SessionStart hook: `.claude/settings.json` of the PROJECT (the identity
// is project-scoped), one entry tagged by its command, safe to re-run and to
// remove. Runs on startup, resume, /clear and /compact — exactly the moments
// an agent forgets it was supposed to be listening.
function projectClaudeSettingsPath() {
  return path.join(PROJECT_ROOT || process.cwd(), '.claude', 'settings.json');
}
function presenceHookCommand() {
  // Durable across upgrades: a `pidge` on PATH (a global install) is preferred;
  // from the npx cache the hook follows @latest rather than pinning the version
  // that happened to install it (a hook pinned to a worktree path was measured).
  // The IDENTITY rides along: a per-agent install (PIDGE_AGENT) or a relocated
  // config (XDG_CONFIG_HOME) is invisible to a hook that inherits a bare env —
  // measured: "channel state UNKNOWN", exit 0, a hook born mute.
  const inv = durableCliInvocation();
  const envPrefix = [
    process.env.PIDGE_AGENT ? `PIDGE_AGENT=${shQuote(process.env.PIDGE_AGENT)}` : null,
    process.env.XDG_CONFIG_HOME ? `XDG_CONFIG_HOME=${shQuote(process.env.XDG_CONFIG_HOME)}` : null,
  ].filter(Boolean).map((e) => `${e} `).join('');
  if (inv.via === 'npx') return `${envPrefix}${shQuote(inv.argv[0])} -y pidge-cli@latest presence`;
  const onPath = whichOnPath('pidge');
  if (onPath) return `${envPrefix}pidge presence`;
  return `${envPrefix}${inv.argv.map(shQuote).join(' ')} presence`;
}
// A global `pidge` older than this CLI is what a human typing `pidge` gets —
// say so once, where the hook is written (measured: global 0.54.2 behind npx 0.54.3).
function warnStaleGlobalPidge() {
  const onPath = whichOnPath('pidge');
  if (!onPath || onPath === __filename) return;
  try {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(onPath, ['--version'], { encoding: 'utf8', timeout: 5000 });
    const mine = require(path.join(__dirname, '..', 'package.json')).version;
    const theirs = (r.stdout || '').trim();
    if (/^\d+\.\d+\.\d+$/.test(theirs) && theirs !== mine && theirs.split('.').map(Number).some((n, i) => n !== Number(mine.split('.')[i])) && theirs.localeCompare(mine, undefined, { numeric: true }) < 0)
      console.error(`pidge: note — the \`pidge\` on your PATH (${onPath}) is ${theirs}, behind this ${mine}; \`pidge update\` brings it up (a shell typing \`pidge\` gets the old one until then).`);
  } catch { /* best-effort */ }
}
function isPidgePresenceHook(entry) {
  return entry && Array.isArray(entry.hooks) && entry.hooks.some((h) => h && typeof h.command === 'string' && /\bpresence$/.test(h.command.trim()) && /pidge/.test(h.command));
}
function installSessionStartHook() {
  warnStaleGlobalPidge();
  const file = projectClaudeSettingsPath();
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`${file} is not valid JSON — fix it by hand first (${e.message})`); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${file} is not a JSON object`);
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const list = Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : [];
  const entry = { matcher: '', hooks: [{ type: 'command', command: presenceHookCommand(), timeout: 20 }] };
  const idx = list.findIndex(isPidgePresenceHook);
  const changed = idx < 0 || JSON.stringify(list[idx]) !== JSON.stringify(entry);
  if (idx < 0) list.push(entry); else list[idx] = entry;
  settings.hooks.SessionStart = list;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { ok: true, file, hook: 'SessionStart', command: entry.hooks[0].command, changed };
}
function uninstallSessionStartHook() {
  const file = projectClaudeSettingsPath();
  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: true, file, removed: false }; }
  const list = settings && settings.hooks && Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : [];
  const kept = list.filter((e) => !isPidgePresenceHook(e));
  if (kept.length === list.length) return { ok: true, file, removed: false };
  settings.hooks.SessionStart = kept;
  if (!kept.length) delete settings.hooks.SessionStart;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { ok: true, file, removed: true };
}

// `pidge bridge uninstall` — stop and remove the service; the handler and its
// prompt stay (they are yours). Declares listen_mode=turn_based again: an
// honest contract says what is actually running.
async function runBridgeUninstall() {
  const platform = process.env.PIDGE_BRIDGE_PLATFORM || process.platform;
  const { file, label, unit } = bridgeServiceFile(platform);
  const existed = fs.existsSync(file);
  let stopped = null;
  if (existed) {
    const steps = platform === 'darwin'
      ? [['launchctl', ['unload', '-w', file]]]
      : [['systemctl', ['--user', 'disable', '--now', unit]]];
    const r = runServiceSteps(steps);
    stopped = r.ok;
    if (!r.ok) console.error(`pidge: bridge uninstall — \`${r.command}\` failed (${r.error}); removing the file anyway`);
    try { fs.unlinkSync(file); } catch (e) { console.error(`pidge: bridge uninstall — couldn't remove ${file}: ${e.message}`); }
    if (platform !== 'darwin') runServiceSteps([['systemctl', ['--user', 'daemon-reload']]]);
  } else {
    console.error(`pidge: bridge uninstall — no service at ${file} (nothing to stop)`);
  }
  let declared = null;
  try {
    const who = await fetchWhoami();
    if (who.res.status === 200 && who.data.channel) {
      v['listen-mode'] = 'turn_based';
      declared = await declareOperatingContract(BASE, TOKEN, who.data.channel.id);
    }
  } catch { /* advisory */ }
  console.error(`pidge: bridge uninstall — ${existed ? `removed ${platform === 'darwin' ? label : unit}` : 'nothing removed'}; listen_mode ${declared === 'turn_based' ? 'declared turn_based' : 'NOT re-declared (do it: pidge contract set listen_mode=turn_based)'}. This channel is OFFLINE until something listens again.`);
  console.log(JSON.stringify({ ok: true, file, existed, stopped, listen_mode_declared: declared === 'turn_based' }, null, 2));
  process.exit(0);
}

// `pidge bridge status` — the three facts, measured: the service (installed?
// active?), the local lock (a bridge process holding the channel), the server
// (live consumers + the listening state the human sees).
async function runBridgeStatus() {
  const platform = process.env.PIDGE_BRIDGE_PLATFORM || process.platform;
  const { file, label, unit } = bridgeServiceFile(platform);
  const installed = fs.existsSync(file);
  let active = null;
  if (installed) {
    const { spawnSync } = require('node:child_process');
    const r = platform === 'darwin'
      ? spawnSync('launchctl', ['list', label], { encoding: 'utf8' })
      : spawnSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' });
    active = !r.error && r.status === 0;
  }
  const cur = readBridgeLock(bridgeLockPath());
  const lock = cur && lockHolderAlive(cur) ? { pid: cur.pid, since: cur.started_at || null, label: cur.label || null, kind: cur.kind || null } : null;
  // A unit made by hand (any name) that runs `pidge bridge` is a bridge too —
  // `installed:false` used to read as "nothing holds the channel" during a
  // migration whose hand-made unit was very much active (measured).
  let other_units = [];
  if (platform !== 'darwin') {
    try {
      const { spawnSync } = require('node:child_process');
      const r = spawnSync('systemctl', ['--user', 'list-units', '--type=service', '--all', '--plain', '--no-legend'], { encoding: 'utf8' });
      const names = (r.stdout || '').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((n) => n && n.endsWith('.service') && n !== unit);
      for (const n of names) {
        const show = spawnSync('systemctl', ['--user', 'show', n, '-p', 'ExecStart', '-p', 'ActiveState'], { encoding: 'utf8' });
        if (/pidge\S*\s+(?:\S+\s+)*?bridge\b/.test(show.stdout || '')) other_units.push({ unit: n, active: /ActiveState=active/.test(show.stdout || '') });
      }
    } catch { /* no systemd — nothing to scan */ }
  }
  let server = null;
  try {
    const { res, data } = await fetchWhoami();
    if (res.status === 200) {
      server = {
        listening_state: data.listening_state || null,
        live_consumers: Array.isArray(data.consumers) ? data.consumers.filter((c) => c && c.live).map((c) => `${c.label || c.fingerprint || '?'}${c.kind ? ` [${c.kind}]` : ''}`) : null,
      };
    }
  } catch { /* unknown */ }
  // ONE answer: the server's MEASURED presence when it reports one (a lingering
  // consumer row or a local lock never overrules it); the local lock only when
  // the server cannot say.
  const verdict = server && server.listening_state
    ? (server.listening_state === 'listening' ? 'ONLINE' : 'OFFLINE')
    : (lock || (server && server.live_consumers && server.live_consumers.length) ? 'ONLINE' : 'OFFLINE');
  const units = other_units.length ? ` · other bridge unit(s): ${other_units.map((u) => `${u.unit}${u.active ? ' (active)' : ''}`).join(', ')}` : '';
  console.error(`pidge: bridge status — service ${installed ? `installed (${active ? 'active' : 'NOT active'})` : 'not installed'}${units} · local lock ${lock ? `held by pid ${lock.pid}${lock.kind ? ` (${lock.kind})` : ''}` : 'none'} · server ${server ? `${server.listening_state || '?'}, live consumers: ${server.live_consumers ? server.live_consumers.join(', ') || 'none' : 'not reported'}` : 'unreachable'} → ${verdict}`);
  console.log(JSON.stringify({ file, installed, active, other_units, lock, server, verdict }, null, 2));
  process.exit(verdict === 'ONLINE' ? 0 : 3);
}

async function liveConsumers() {
  try {
    const { res, data } = await fetchWhoami();
    if (res.status !== 200 || !Array.isArray(data.consumers)) return { known: false, count: 0 };
    return { known: true, count: data.consumers.filter((c) => c && c.live && c.listening !== false).length };
  } catch { return { known: false, count: 0 }; }
}

// selftest: prove the listener works by ROUND-TRIP, not prose. Fire a nonce onto
// our own queue, then WATCH — read-only — for something ELSE to pick it up and
// ack it inside the window. PASS = a real consumer did it.
//
// It NEVER consumes its own nonce. The old loop polled the CONSUME path
// (all=true&lease=60), acked the nonce itself and then reported "your listener
// received the nonce and acked it in time" — a green manufactured out of its own
// read and its own ack, printed on channels where nothing was listening at all.
// It also leased every row it served, blacking them out for the real reader.
// The verdict now comes from GET /selftest/:id alone (read-only: it reports
// whether the nonce was PROCESSED), so a channel with nobody listening FAILS
// here — which is the truth, and the whole point of a self-test.
async function doSelftest() {
  // Guard the parse: a non-numeric --window (e.g. "30s", a typo) must NOT become NaN
  // — that would make the deadline NaN, skip the poll loop entirely, and mis-report a
  // perfectly fine listener as "orphaned/dead" (the most misleading failure possible).
  const rawWindow = num(v.window, 30);
  // Cap 600 (was 120): a bridge whose handler runs a model on EVERY batch acks
  // only when the model returns, and a cold `claude -p` alone can take longer
  // than two minutes — observed live, a healthy bridge reported FAILED.
  const windowS = Math.max(5, Math.min(600, Number.isFinite(rawWindow) ? rawWindow : 30));
  const st = await selftestRoundTrip(windowS);
  console.log(JSON.stringify(st));
  process.exit(st.status === 'passed' ? 0 : 2);
}
// The round-trip itself, shared by `selftest` and `bridge install --enable`:
// narrates on stderr, returns the verdict object (never exits).
async function selftestRoundTrip(windowS) {
  let fired;
  try {
    const res = await fetchT(`${BASE}/api/v1/selftest`, {
      method: 'POST', headers, body: JSON.stringify({ window_seconds: windowS }),
    });
    await checkManifestNews(res);
    if (res.status < 200 || res.status >= 300) die(`pidge: selftest: the server refused (${res.status}) — is your key valid? try \`pidge doctor\``, 2);
    fired = await res.json();
  } catch (e) {
    die(`pidge: selftest failed (network): ${e.message}`, 2);
  }
  const id = fired.id;
  // An older server clamps the window itself (5..120 before manifest v125);
  // watch for what IT granted, so a wider ask never reads a late ack as a pass.
  const granted = Number.isFinite(Number(fired.window_seconds)) ? Number(fired.window_seconds) : windowS;
  if (granted !== windowS) console.error(`pidge: self-test — the server clamped the window to ${granted}s`);
  console.error(`pidge: self-test fired (id ${id}) — watching READ-ONLY for up to ${granted}s. PASS needs SOMETHING ELSE (your \`listen\`, a bridge) to pick the nonce up and ack it: this command never consumes its own nonce, so a channel with nobody listening FAILS here.`);

  const deadline = Date.now() + granted * 1000;
  // The verdict endpoint ONLY — no consume read, no ack. `readFail` carries the
  // last read's failure so an unreadable verdict is reported as exactly that
  // (a 500 here used to fall through and blame the listener instead).
  let verdict = null;
  let readFail = null;
  for (;;) {
    try {
      const res = await fetchT(`${BASE}/api/v1/selftest/${id}`, { headers });
      if (res.status === 200) {
        readFail = null;
        verdict = await res.json().catch(() => ({}));
        if (verdict.status && verdict.status !== 'pending') break;
      } else {
        verdict = null;
        readFail = `the server answered ${res.status}`;
      }
    } catch (e) {
      verdict = null;
      readFail = `network: ${e.message}`;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.max(200, Math.min(1000, deadline - Date.now())));
  }

  if (verdict && verdict.status === 'passed') {
    console.error('pidge: ✅ SELF-TEST PASSED — a consumer OTHER than this command picked the nonce up and acked it inside the window. The round-trip is real.');
    return { status: 'passed', id, window_seconds: granted };
  }
  if (!verdict) {
    // An unreadable verdict says NOTHING about the listener — say THAT, and
    // never dress a broken read up as a dead loop.
    console.error(`pidge: ⚠️  SELF-TEST INCONCLUSIVE — the nonce went out (id ${id}) but its verdict couldn't be READ (${readFail}). This is a failure of the read, not evidence about your listener: the round-trip may well have worked. Check the server with \`pidge doctor\`, then re-run.`);
    return { status: 'unknown', id, reason: 'verdict_unreadable' };
  }
  // FAILED — and the first question is whether anyone was even listening.
  const live = await liveConsumers();
  const cause = !live.known
    ? 'the nonce was not acked inside the window, and this server doesn\'t report who is consuming (or the whoami read failed) — so: either nothing consumed it, or something read it and never acked. Start ONE consumer — `pidge bridge install --enable` (a daemon that outlives your session) or one tracked `pidge listen --all` round — and re-run.'
    : live.count === 0
      ? 'nothing is listening on this channel — the nonce reached the queue and sat there. This proved the WIRE (key, send, queue), NOT your loop. Start a consumer — `pidge bridge install --enable` (the daemon: it answers for you around the clock, proven by this very test) or, for one round inside your session, `pidge listen --all` as a tracked background task (the nonce is a system row: a plain `listen` NEVER sees it) — and re-run.'
      : `${live.count} consumer(s) ARE live and none acked the nonce inside the window — a loop that READS without acking (deaf), a handler slower than --window (a model that runs on every batch can need minutes: widen it, up to 600), or one wedged mid-batch. Look at what that consumer did: \`pidge catchup --digest\`, and its log if it is a bridge.`;
  console.error(`pidge: ❌ SELF-TEST FAILED — ${cause}`);
  return { status: verdict.status || 'failed', id, consumers_live: live.known ? live.count : null };
}

// Name a warning line in ONE word, for the machine line's `warning_kinds`.
// Substrings of the warnings themselves — a renamed warning falls back to
// "other" (a wrong count is a lie; a vague kind is only less useful).
const DOCTOR_WARNING_KINDS = [
  [/0 devices/, 'no_devices'],
  [/UNREACHABLE/, 'device_reach'],
  [/CLAIMED THIS CHANNEL/, 'claim_mismatch'],
  [/PRIOR claim/i, 'stale_prior_claim'],
  [/consumer_conflict/, 'consumer_conflict'],
  [/un-acked on this channel/, 'unacked_queue'],
  [/lost their lease/, 'deaf_consumer'],
  [/MUTE ack/, 'mute_ack'],
  [/SHARED file/, 'shared_config'],
  [/PIDGE_SECRET|E2E|criptografia/, 'e2e'],
  [/NO pidge marker/, 'unmarked_skill'],
];
function doctorWarningKind(line) {
  for (const [re, kind] of DOCTOR_WARNING_KINDS) if (re.test(line)) return kind;
  return 'other';
}
// A probe that KNOWS its own kind says so, instead of leaving the counter to
// re-derive it from the probe's own prose. Sniffing the line works until
// somebody rewrites the wording — then the finding quietly files itself as
// "other" and nobody notices, which is the exact failure `warning_kinds` exists
// to prevent. Set for the duration of one console.error call.
let doctorPendingKind = null;
function doctorWarn(kind, line) {
  doctorPendingKind = kind;
  try { console.error(line); } finally { doctorPendingKind = null; }
}

// doctor: validate the setup WITHOUT exposing secrets. Narration on stderr,
// a compact machine-readable line on stdout. Exit 0 healthy / 2 broken.
async function runDoctor(base = BASE, token = TOKEN, sourceLabel = null) {
  // "all good" over three ⚠️ lines is the doctor lying about its own output —
  // and `{ok:true}` made a script agree with it. Count every warning the run
  // prints, wherever it comes from (this function, or the shared reporters it
  // calls), at the ONE seam they all pass through. A counter threaded through
  // eight helpers would go stale the first time a ninth one warns.
  const warnings = [];
  const printErr = console.error;
  console.error = (...a) => {
    const line = a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ');
    if (/WARNING|⚠️/.test(line)) warnings.push(doctorPendingKind || doctorWarningKind(line));
    printErr(...a);
  };
  // sourceLabel is passed by setup (it knows exactly where the key went —
  // a per-agent file, the shared file, or NOWHERE for --print); the bare
  // `doctor` command computes it from the env/file precedence.
  const source = sourceLabel || (token === TOKEN ? tokenSource() : CONFIG_FILE);
  if (!token) {
    console.error(noTokenMessage('pidge doctor: NO TOKEN.'));
    process.exit(2);
  }
  note(`pidge doctor: token found (${source || 'passed in'}) — never displayed`);
  note(`pidge doctor: server ${base}`);
  let out;
  try {
    out = await fetchWhoami(base, token);
  } catch (e) {
    console.error(`pidge doctor: server UNREACHABLE — ${e.message} (check the URL; is it ${base}?)`);
    process.exit(2);
  }
  const { res, data } = out;
  await checkManifestNews(res);
  if (res.status === 401) {
    console.error('pidge doctor: server reachable but the key is INVALID/REVOKED — re-onboard: ask your human for a fresh claim code (Pidge app → Canais → o canal → copiar prompt de setup)');
    process.exit(2);
  }
  if (res.status === 404) {
    // Older server: no /whoami yet — the key may still be fine; prove it on the manifest.
    const m = await fetchT(`${base}/api/v1/manifest`, { headers: { authorization: `Bearer ${token}`, ...identityHeaders() } }).catch(() => null);
    if (m && m.status === 200) {
      console.error('pidge doctor: key VALID (server predates /whoami — channel/device detail unavailable; update the server to see it)');
      console.log(JSON.stringify({ ok: true, base_url: base, channel: null, devices: null }));
      process.exit(0);
    }
    console.error(`pidge doctor: unexpected ${m ? m.status : 'network error'} on the manifest — server looks broken`);
    process.exit(2);
  }
  if (res.status !== 200) {
    console.error(`pidge doctor: unexpected ${res.status} from /whoami — ${JSON.stringify(data)}`);
    process.exit(2);
  }
  // On newer servers /whoami is either-track — a SESSION token (ses_) gets
  // a 200 with NO channel block. Pre-v57 that misconfig 401ed loudly; without
  // this branch the doctor would print key valid — canal "undefined" and exit 0,
  // hiding the error until the first send 401s.
  if (!data.channel) {
    console.error('pidge doctor: this token is a SESSION token (ses_), not a channel key — the CLI needs the hld_ channel key (Pidge app → Canais → your channel). Sends would 401.');
    console.log(JSON.stringify({ ok: false, reason: 'session_token_not_channel_key' }));
    process.exit(2);
  }
  const devices = data.devices ?? 0;
  note(`pidge doctor: key valid — canal "${data.channel && data.channel.name}" · ${devices} device(s)`);
  if (devices === 0)
    console.error('pidge doctor: WARNING — 0 devices: sends will reach NOBODY until the human installs/opens the Pidge app on their iPhone');
  // device-reach honesty + install ownership — shared with whoami.
  const unreachable = reportDeviceReach(data);
  reportClaimMismatch(data);
  // Live consumers on this channel + predecessor ack hygiene (present-only —
  // an older server omits them and these no-op).
  reportConsumers(data);
  reportProvenance(data);
  // SHOUT on a stale prior-claim backlog (advisory tone — the anchor has
  // known false ±). Warning only, never exit 2: the messages are
  // real and drainable; the human/agent decides what they're worth.
  warnStalePriorClaim(data, 'Run `pidge catchup` (read-only) to see them before any listen/ack.');
  // doctor ALWAYS reports the prior-claim state — a CONFIRMATION on false, not
  // just a warning on true. "I didn't see the warning" ≠ "there is no orphaned
  // backlog"; a silent doctor can't confirm health. The warning above covers true;
  // here we speak the healthy case. Only when the field is EXPLICITLY false:
  // an older server that omits it can't confirm either way, so stay silent then.
  if (data.stale_from_prior_claim === false)
    console.error('pidge doctor: prior-claim backlog: none ✓ (no un-acked messages predate your ownership claim)');
  // Composer-backlog honesty (0.32): the /messages queue is the OTHER input
  // plane — the human typing in the app's composer. Count unprocessed rows
  // with a READ-ONLY history probe (never consumes, never leases) and shout
  // when they're piling up with nobody reading: waiting on one notification
  // is NOT being online (a pre-0.32 wait never read this queue at all).
  try {
    const hres = await fetchT(`${BASE}/api/v1/messages?history=true`, { headers });
    if (hres.status === 200) {
      const hdata = await hres.json().catch(() => ({}));
      const rows = Array.isArray(hdata.messages) ? hdata.messages : [];
      const anyLive = Array.isArray(data.consumers) && data.consumers.some((c) => c && c.live);
      const pending = rows.filter((mm) => !mm.processed_at && !mm.consumed_at).length;
      if (pending > 0) {
        const noEar = ' Nobody is consuming this queue — a `--wait` on one notification does NOT read it (CLI ≥0.32 waits DO wake on it): run `pidge listen`/`pidge online`, or `pidge catchup` first (read-only).';
        console.error(`pidge doctor: ⚠️ ${pending} composer message(s) un-acked on this channel's queue — the human wrote and no ack marked them handled.${anyLive ? ' A live consumer exists; make sure it acks after the work.' : noEar}`);
      } else {
        console.error('pidge doctor: composer queue: no un-acked messages ✓');
      }
      // A DEAF consumer is worse than none: something reads the queue, takes the
      // delivery, lets the lease lapse and never acks — presence says "listening
      // now" while nothing is being handled. The shape is visible from the
      // read-only history alone: still unprocessed, delivered a while ago, and
      // the delivery's own lease already expired ⇒ it was served and dropped.
      // Only worth saying when a consumer IS live: with nobody consuming, the
      // "nobody is consuming this queue" line above is the true diagnosis.
      const now = Date.now();
      const ms = (t) => { const n = t ? Date.parse(t) : NaN; return Number.isFinite(n) ? n : null; };
      const deaf = rows.filter((mm) => {
        if (mm.processed_at || mm.consumed_at) return false;
        const delivered = ms(mm.delivered_at);
        const expires = ms(mm.delivery_expires_at);
        return delivered !== null && expires !== null && expires < now && delivered < now - 120000;
      }).length;
      if (deaf > 0 && anyLive)
        console.error(`pidge doctor: ⚠️ ${deaf} message(s) were DELIVERED to a consumer, lost their lease and are still un-acked — something is reading this queue without handling it (a blind parser? a loop that drains and never acks?). Presence can read "listening now" while nothing lands. Check what consumes here, and ack only AFTER the work: \`pidge ack --ids <ids> --summary "<what you did>"\`.`);
      // A MUTE ack is the other half: the row is processed, but nothing was
      // written back and no note says what happened — plumbing, not work. The
      // server names it `handled_state:"drained"`; an older one omits the field
      // entirely, and then this probe stays silent (never a warning ABOUT the
      // missing field).
      if (rows.some((mm) => mm.handled_state !== undefined)) {
        const drained = rows.filter((mm) => {
          if (mm.handled_state !== 'drained') return false;
          const done = ms(mm.processed_at);
          return done === null || done > now - 24 * 3600 * 1000;
        }).length;
        if (drained > 0)
          doctorWarn('mute_ack', `pidge doctor: ⚠️ ${drained} message(s) acked in the last 24h with NO note and no answer sent afterwards — a MUTE ack (the server files it as "drained"). To the human that green ✓✓ claims work that left no trace. In an automated loop the note belongs to the handler (\`pidge listen --exec\` / \`pidge bridge\` take it from its \`pidge-summary:\` line); by hand, use \`ack --summary\`.`);
      }
    }
  } catch { /* advisory probe — never fails the doctor */ }
  // An UNMARKED home skill is one the self-heal (correctly) won't touch
  // (requireMarker) — so a PRE-MARKER pidge copy silently stays on old doctrine
  // with no signal (a real incident: an install ran months-stale doctrine
  // unnoticed). doctor can't fix it (it might be an
  // AUTHORED skill), but it can SAY so — a nudge, never a write.
  warnUnmarkedHomeSkill();
  // E2E: validate PIDGE_SECRET when present (32 bytes after base64url;
  // kf = base64url(SHA-256(key)[0..3])) and cross-check it against the channel:
  //   e2e_enabled + no secret   → sends go CLEAR-and-marked; point at the app's Connect-screen terminal step
  //   secret + non-E2E channel  → an ORPHAN secret (never used); warn
  //   e2e_enabled + bad/mismatched secret → BROKEN (exit 2): the seal promise can't hold
  const e2e = reportE2eHealth(data);
  if (onSharedFile())
    console.error(`pidge doctor: WARNING — reading the SHARED file ${CONFIG_FILE}. If another agent runs on this machine, it reads the SAME key and you'll send as each other (a real incident, not a hypothetical). Isolate: run setup from inside your project directory (git — the key gets its own per-project file), or set PIDGE_AGENT=<id> at this agent's launch, or give it its own PIDGE_TOKEN.`);
  // devices exist but 0 are deliverable ⇒ a send reaches NOBODY — BROKEN
  // (exit 2). (0 devices total stays a warning above: a fresh setup before the
  // app is installed isn't "broken".) The claim mismatch SHOUTS but stays exit 0
  // — the warning is the contract (the severity split is a judgment call).
  if (unreachable) {
    console.error('pidge doctor: BROKEN (exit 2) — devices exist but 0 are reachable (all disabled or on the wrong APNs environment): a send reaches nobody.');
    process.exit(2);
  }
  if (e2e.broken) {
    console.error(`pidge doctor: BROKEN (exit 2) — this channel is E2E but the PIDGE_SECRET cannot seal/open anything on it. The app's Connect screen shows a separate TERMINAL step that writes PIDGE_SECRET — ask your human to run THAT (never paste the secret in chat) and make sure the line lands in THIS install's config file (${CONFIG_FILE}), then re-run \`pidge doctor\`.`);
    process.exit(2);
  }
  // probe the realtime path (the held-poll failure class an HTTP-only doctor
  // misses). Exit stays 0 either way — an unavailable WS degrades to polling.
  const rt = await probeRealtime(base, token);
  let realtime;
  if (rt.skipped) {
    realtime = 'skipped';
    note('pidge doctor: realtime: skipped — this Node lacks a native WebSocket (need Node ≥22); `listen` will poll. Upgrade Node for instant delivery.');
  } else if (rt.ok) {
    realtime = 'ok';
    note(`pidge doctor: realtime: ok (ws connect + subscribe em ${rt.ms}ms)`);
  } else {
    realtime = 'unavailable';
    note(`pidge doctor: realtime: INDISPONÍVEL — ${rt.reason}. O \`listen\` degrada pra polling (funciona, menos instantâneo); use --no-realtime pra fixar o piso.`);
  }
  // lead with `pidge hello` — the first-contact WOW (send + wait in one),
  // the same debut the /agent-setup guide leads with. (no --template hint —
  // `pidge hello` IS the entry point; the content_template surface is off the menu.)
  // --quiet collapses ALL of the above to this single status line.
  // The verdict must AGREE with the lines above it. "all good" is reserved for
  // a run that printed no warning at all; anything else is healthy-with-caveats
  // and says how many, so nobody scrolls past three ⚠️ into a green summary.
  const warnKinds = [...new Set(warnings)];
  const warnTail = warnings.length ? ` — ${warnings.length} warning(s) above (${warnKinds.join(', ')}): read them` : '';
  if (QUIET)
    console.error(`pidge: ✓ setup ok — canal "${data.channel && data.channel.name}" · ${devices} device(s) · realtime ${realtime}${warnings.length ? ` · ${warnings.length} warning(s) above` : ''} (run \`pidge doctor\` for the full check)`);
  else if (warnings.length)
    console.error(`pidge doctor: healthy${warnTail}. Then: pidge hello   (first-contact WOW — send + wait in one)`);
  else
    console.error('pidge doctor: all good — try: pidge hello   (first-contact WOW — send + wait in one)');
  // setup/doctor just proved the channel works — say what keeps it WORKING.
  // Consumer-gated: silent when someone (a bridge, another session) is live.
  // Deliberately printed even under --quiet: the loop IS the product's pitch,
  // and the pasted-prompt onboarding (which uses --quiet) is exactly who needs it.
  await nudgeStayOnline(data);
  // ok:true still means "usable channel" — the warnings ride ALONGSIDE it so a
  // script can gate on them instead of reading `ok` as "nothing to see here".
  console.log(JSON.stringify({ ok: true, base_url: base, channel: data.channel, devices, manifest_version: data.manifest_version, realtime, warnings: warnings.length, warning_kinds: warnKinds, e2e: { channel: e2e.channelOn, secret: e2e.status, kf: e2e.kf, pinned: !!e2e.pinned } }));
  process.exit(0);
}

// doctor's E2E block: validate the secret locally, cross it with the channel's
// e2e_enabled (whoami), and — when the server exposes the channel's expected
// fingerprint — compare kfs so a token-of-one-channel + secret-of-another mixup
// is named BEFORE the first garbled send. Returns {status, kf, channelOn, broken}.
function reportE2eHealth(data) {
  const channelOn = !!(data.channel && data.channel.e2e_enabled);
  const raw = e2eLoadSecret();
  const out = { status: 'absent', kf: null, channelOn, broken: false };
  if (!raw) {
    if (channelOn)
      console.error('pidge doctor: WARNING — this channel is E2E (e2e_enabled) but NO PIDGE_SECRET is configured: sends go CLEAR and the app marks them "⚠️ sem criptografia". The app\'s Connect screen shows a separate TERMINAL step that writes PIDGE_SECRET to ~/.config/pidge/env — ask your human to run THAT (never paste the secret in chat); `pidge doctor` then confirms it.');
    return out;
  }
  const source = process.env.PIDGE_SECRET ? 'env var' : 'config file';
  let key;
  try {
    key = e2eParseSecret(raw);
  } catch (e) {
    out.status = 'invalid';
    out.broken = channelOn;
    console.error(`pidge doctor: ${channelOn ? 'BROKEN' : 'WARNING'} — PIDGE_SECRET (${source}) is INVALID: ${e.message}. ${channelOn ? 'Sends go CLEAR on an E2E channel.' : ''} Fix: the app's Connect screen shows a separate TERMINAL step that rewrites PIDGE_SECRET in ~/.config/pidge/env (never paste the secret in chat).`);
    return out;
  }
  out.status = 'ok';
  out.kf = e2eKeyFingerprint(key);
  note(`pidge doctor: e2e secret found (${source}, 32 bytes, kf ${out.kf}) — never displayed`);
  // Compare with the channel's own fingerprint when the server exposes one
  // (additive/forward-compatible — whoami serves only e2e_enabled today).
  const serverKf = data.channel && (data.channel.e2e_kf || data.channel.key_fingerprint);
  if (channelOn && serverKf && serverKf !== out.kf) {
    out.broken = true;
    console.error(`pidge doctor: BROKEN — your PIDGE_SECRET (kf ${out.kf}) is NOT this channel's key (kf ${serverKf}): the token and the secret belong to different channels. Ask your human to run THIS channel's terminal step from the app's Connect screen (never paste the secret in chat).`);
  } else if (channelOn) {
    note('pidge doctor: e2e ON — sends are sealed end-to-end (the server relays ciphertext only)');
    e2eStampPin(out.kf); // doctor CONFIRMED the sealed context — latch the pin
  } else if (e2ePinned() && !e2eOverrideOff()) {
    console.error(`pidge doctor: WARNING — the server says this channel is NOT E2E, but this machine PINNED it as E2E: every send here is REFUSED (exit 2) instead of going clear — a lying server must not downgrade you to plaintext. ${E2E_UNPIN_HINT}`);
  } else {
    console.error('pidge doctor: WARNING — PIDGE_SECRET present but this channel is NOT E2E (secret órfão): sends stay CLEAR and the secret is never used. Either the human turns on E2E for this channel in the app, or drop the secret.');
  }
  out.pinned = e2ePinned() && !e2eOverrideOff();
  return out;
}

// setup --claim: exchange the single-use code for the key, store it ourselves
// (the secret never appears on screen or in the chat the prompt was pasted in),
// then prove the loop with doctor.
async function runSetup() {
  const code = v.claim;
  if (!code) die('pidge: usage: pidge setup --claim <code> [--url <base>]   (the human copies the code from the Pidge app)', 1);

  // --from-computer: derive PIDGE_SECRET from this machine's paired-computer
  // key instead of receiving it — both sides derive, NO secret travels.
  // Preconditions checked BEFORE any network so a machine that cannot derive
  // never consumes the code. The two secret sources must not half-mix: an
  // ambient PIDGE_SECRET alongside --from-computer is a confused invocation.
  let computerKeyForDerivation = null;
  if (v['from-computer']) {
    if (process.env.PIDGE_SECRET) {
      die('pidge setup --from-computer: PIDGE_SECRET is already set in this environment — the two secret sources must not mix. Unset it, or drop --from-computer.', 1);
    }
    const tcore = require('../src/terminal/core');
    const tenv = tcore.loadTerminalEnv();
    if (!tenv.secret) {
      die('pidge setup --from-computer: this machine holds no paired-computer key (' + tcore.ENV_FILE() + ').\n' +
        'Pair it first — `pidge terminal connect --qr` (or the app\'s Settings → Computers one-liner) — or drop --from-computer and deliver PIDGE_SECRET via the connect screen\'s terminal step.', 2);
    }
    try { computerKeyForDerivation = e2eParseSecret(tenv.secret); } catch (e) {
      die(`pidge setup --from-computer: the stored computer key is unusable (${e.message}) — re-pair with \`pidge terminal connect --qr --replace\`.`, 2);
    }
  }

  // WHERE the key will live — decided BEFORE anything touches the network so
  // the fingerprint that binds the claim (identityHeaders hashes CONFIG_FILE)
  // is the identity this install will actually resolve on its next command.
  // PIDGE_AGENT (explicit) → agent file · --global → the shared machine file ·
  // inside a git project (the default) → the project-scoped file · no project →
  // the shared file. Retargeting the module-level CONFIG_DIR/CONFIG_FILE also
  // points state.json / ownership at the same home.
  if (!AGENT_ID) {
    if (v.global || !PROJECT_CONFIG_DIR) {
      CONFIG_DIR = pidgeBaseDir();
    } else {
      CONFIG_DIR = PROJECT_CONFIG_DIR;
    }
    CONFIG_FILE = path.join(CONFIG_DIR, 'env');
  } else if (v.global) {
    die('pidge: --global conflicts with PIDGE_AGENT — unset one (PIDGE_AGENT is already an isolated scope).', 1);
  }
  const projectScoped = !AGENT_ID && !v.global && CONFIG_DIR === PROJECT_CONFIG_DIR;

  // Everything scope-derived below reads the TARGET file, never the load-time
  // FILE_ENV (which may belong to a DIFFERENT scope after the retarget): the
  // URL fallback, the clobber guard's key, and the E2E secret all follow the
  // file this setup will actually write.
  const targetEnv = readEnvFile(CONFIG_FILE);
  const base = (v.url || process.env.PIDGE_URL || targetEnv.PIDGE_URL || FILE_ENV.PIDGE_URL || 'https://api.pidge.sh').replace(/\/+$/, '');

  // THE CLOBBER GUARD (a real incident: a shared config file let one agent's
  // setup hijack another's cron). Only the FILE path can collide; --print
  // writes nothing, so skip it there. Project/agent scopes collide only with
  // THEMSELVES (a re-setup of the same project/agent), the shared file with any
  // process that reads it — refuse to clobber a file that still authenticates
  // as some channel unless --force. Checked BEFORE the exchange so the code
  // survives the refusal (and since server v84 even a consumed code retries).
  // The stored key is validated against the TARGET file's OWN server when it
  // names one — whoami-ing it against an unrelated base would 401 and read as
  // "dead key", silently waving the clobber through (the incident class again).
  if (!v.print && !v.force && targetEnv.PIDGE_TOKEN) {
    const guardBase = (targetEnv.PIDGE_URL || base).replace(/\/+$/, '');
    let owner = null;
    try {
      const { res: wres, data: wdata } = await fetchWhoami(guardBase, targetEnv.PIDGE_TOKEN);
      if (wres.status === 200 && wdata.channel) owner = wdata.channel.name;
      else if (wres.status !== 401) owner = 'um canal (servidor não confirmou)';
      // 401 ⇒ the stored key is dead — overwriting a corpse needs no --force.
    } catch {
      owner = 'um canal (servidor inalcançável para confirmar)';
    }
    if (owner) {
      // The reader of this message is almost always an AGENT mid-onboarding
      // (the human pasted the prompt into it) — lead with the agent-correct
      // exits. --print exists but is NOT offered here on purpose: an agent
      // running --print would land the key in its own context.
      const suggestion = (path.basename(process.cwd()).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 32) || 'meu-agente');
      const exits = projectScoped
        ? `Este PROJETO já fala como esse canal. Se a intenção é REAPONTAR o projeto para o canal novo, re-rode com --force. Se você é um SEGUNDO agente convivendo neste mesmo diretório, re-rode com PIDGE_AGENT=<seu-id> na frente (env isolado por agente — e TODO comando seguinte precisa da mesma var): PIDGE_AGENT=${suggestion} npx -y pidge-cli@latest setup --claim ${code}`
        : `Como conectar SEM colidir: rode este MESMO comando de dentro da pasta do seu projeto (git) — cada projeto ganha um env isolado automaticamente. Sem projeto? Re-rode com PIDGE_AGENT=<seu-id> na frente (e mantenha a var em TODO comando seguinte): PIDGE_AGENT=${suggestion} npx -y pidge-cli@latest setup --claim ${code}. Substituir o arquivo compartilhado mesmo assim (você sabe que nenhum outro processo lê ele)? --force.`;
      die(`pidge: ${CONFIG_FILE} já guarda a chave de "${owner}". Sobrescrever faria qualquer processo que lê esse arquivo enviar como o canal novo (incidente real: um cron foi sequestrado assim). ${exits} (o claim code continua válido — nada foi consumido; num servidor v84+ até um retry pós-exchange funciona dentro do TTL de 15 min).`, 2);
    }
  }

  // Prove the identity's home is WRITABLE before the single-use code is spent.
  // Measured on a fresh Codex run: its default workspace-write sandbox cannot
  // touch ~/.config, the exchange succeeded server-side, the write failed, and
  // the retry (a new fingerprint) was refused — the code was burned. A probe
  // costs nothing and turns that into a clear exit with the code intact.
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const probe = path.join(CONFIG_DIR, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok', { mode: 0o600 });
    fs.unlinkSync(probe);
  } catch (e) {
    die(`pidge: setup — ${CONFIG_DIR} is NOT writable from here (${e.code || e.message}); the claim code was NOT consumed. A sandbox that only allows writes inside the project (Codex workspace-write, for one) needs the config INSIDE it: export XDG_CONFIG_HOME="$PWD/.pidge" (add .pidge to .gitignore), then re-run this exact command — and keep that variable for every later pidge command.`, 2);
  }

  let res, data = {};
  try {
    res = await fetchT(`${base}/api/v1/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...identityHeaders() },
      body: JSON.stringify({ code }),
    });
    try { data = await res.json(); } catch { /* leave {} */ }
  } catch (e) {
    die(`pidge: claim failed (network): ${e.message} — is the server URL right? (${base})`, 2);
  }
  if (res.status === 404)
    die('pidge: claim code unknown, EXPIRED (15 min TTL) or already used — ask your human for a fresh one (Pidge app → Canais → o canal → copiar prompt de setup)', 2);
  if (!(res.status >= 200 && res.status < 300) || !data.key)
    die(`pidge: claim failed (${res.status}): ${JSON.stringify(data)}`, 2);

  const finalBase = (data.base_url || base).replace(/\/+$/, '');
  const channelName = data.channel && data.channel.name;
  const channelId = data.channel && data.channel.id;

  // The claim exchange ROTATES the channel key (server contract) — the key this
  // setup just received is a NEW one, and the previous holder is revoked on the
  // spot: its sockets drop, its sessions end. Nothing said so, so the surprise
  // landed on the OTHER install — a bridge or a cron that worked a minute ago
  // and now 401s with no idea why. One line, at the moment we cause it.
  // `claim` is the ownership block we already hold (no extra request): a
  // generation past the first means a DIFFERENT install owned this channel, so
  // there is a real holder to lock out, not just a hypothetical one.
  const narrateKeyRotation = (claim) => {
    const gen = claim && Number(claim.claim_generation);
    const prior = Number.isFinite(gen) && gen >= 2
      ? ` A different install owned this channel before (generation ${gen}) — that one is who just lost the key.` : '';
    note(`pidge: this claim ROTATED the channel key — the previous key is now REVOKED. Any OTHER install still holding it (a bridge, a cron, another machine) gets 401 from here until a human re-onboards it with a fresh code.${prior}`);
  };

  // --from-computer: the derivation itself (§ the info string binds the key to
  // this channel's PUBLIC id, so the id must be known).
  let derivedSecret = null;
  if (computerKeyForDerivation) {
    if (channelId === undefined || channelId === null) {
      die('pidge setup --from-computer: the server did not report the channel id, so there is nothing to bind the derivation to — update the server, or drop --from-computer.', 2);
    }
    const derivedKey = e2eDeriveChannelKey(computerKeyForDerivation, channelId);
    derivedSecret = derivedKey.toString('base64url');
    note(`pidge: PIDGE_SECRET DERIVED from this computer's key (channel kf ${e2eKeyFingerprint(derivedKey)}) — the phone derives the same key; no secret traveled.`);
  }

  // step 5: DECLARE how this agent operates (operating_contract) right after
  // the claim succeeds — ADVISORY metadata, the same for --print and the file
  // path. Done here (before the branch) so both onboarding modes declare it.
  await declareOperatingContract(finalBase, data.key, channelId);

  // --print: the pure per-agent path — emit the export lines (the HUMAN runs
  // this in THEIR terminal and pastes them into the agent's launcher). Stores
  // nothing; the key shows on screen, so DON'T let an agent run --print (the
  // key would land in its context — that's what the file path is for). stdout
  // is eval-able; the guidance goes to stderr.
  if (v.print) {
    console.log(`export PIDGE_URL=${finalBase}`);
    console.log(`export PIDGE_TOKEN=${data.key}`);
    // E2E: the {TOKEN, SECRET} pair travels together from ONE source — when this
    // environment already carries PIDGE_SECRET (the human exported it before
    // running setup), emit it alongside. (the secret comes from the app's
    // Connect-screen terminal step, never from the chat prompt.)
    if (derivedSecret) console.log(`export PIDGE_SECRET=${derivedSecret}`);
    else if (process.env.PIDGE_SECRET) console.log(`export PIDGE_SECRET=${process.env.PIDGE_SECRET}`);
    narrateKeyRotation(null); // --print never stamps ownership, so there is no generation to name
    console.error(`pidge: canal "${channelName}" — modo POR-AGENTE (nada gravado em disco). Cole as duas linhas no ambiente de lançamento DESTE agente (systemd/launcher/cron/profile). Cada agente tem a SUA chave; perdeu, é só pegar outro código no app e re-rodar (a chave do canal é a MESMA). NÃO rode --print de dentro de um agente — a chave apareceria no contexto dele.`);
    await fuseSkillAndHello(finalBase, data.key);
    await runDoctor(finalBase, data.key, 'fresh claim (per-agent env — not stored on disk)');
    return;
  }

  // File path (default): the CLI writes the key — the agent never sees it
  // (token hygiene). Per-agent when PIDGE_AGENT is set; otherwise the legacy shared file.
  // E2E: the {TOKEN, SECRET} pair travels together from ONE source — persist
  // PIDGE_SECRET next to the token when this env already carries it (it
  // gets there via the app's Connect-screen terminal step, never the chat
  // prompt), and never silently DROP a secret the file already held: the human
  // may be re-claiming the same E2E channel with a fresh code.
  // TARGET scope only (never load-time FILE_ENV): re-claiming the same identity
  // must keep ITS secret, but a secret from a DIFFERENT scope must never bleed
  // into a new channel's file (it belongs to another channel's E2E).
  const e2eSecret = derivedSecret || process.env.PIDGE_SECRET || targetEnv.PIDGE_SECRET || null;
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Heal permissions the mkdir can't: every CLI mkdir passes mode 0o700 (which
  // is umask-immune), but a dir that PRE-EXISTS looser is kept as-is by
  // mkdirSync — observed live: an agents/<id> dir born 0775 on a box whose
  // group is shared across users. chmod at the moment the key lands, config
  // dirs only (never ~/.config itself). Best-effort per dir.
  {
    const base = pidgeBaseDir();
    const dirs = new Set([base, CONFIG_DIR]);
    const parent = path.dirname(CONFIG_DIR); // agents/ or projects/ intermediate
    if (parent.startsWith(base + path.sep)) dirs.add(parent);
    for (const dir of dirs) { try { fs.chmodSync(dir, 0o700); } catch { /* e.g. not the owner */ } }
  }
  fs.writeFileSync(CONFIG_FILE,
    `PIDGE_URL=${finalBase}\nPIDGE_TOKEN=${data.key}\n${e2eSecret ? `PIDGE_SECRET=${e2eSecret}\n` : ''}`,
    { mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* mode set on create */ }
  const scopeNote = projectScoped
    ? ` — escopo DESTE projeto (${PROJECT_ROOT}): qualquer sessão futura rodando dentro dele me encontra sozinha`
    : AGENT_ID ? ` — escopo do agente "${AGENT_ID}": TODO comando pidge daqui em diante precisa de PIDGE_AGENT=${AGENT_ID} no ambiente` : '';
  note(`pidge: canal "${channelName}" configurado — chave em ${CONFIG_FILE} (chmod 600, nunca exibida)${scopeNote}`);
  if (e2eSecret) note('pidge: PIDGE_SECRET stored next to the token (the {TOKEN, SECRET} pair travels together) — E2E sends seal automatically when the channel is E2E');
  // claim ownership of the channel for THIS install and record the
  // generation locally, so a later `pidge doctor` can DETECT a silent key swap
  // by a different agent (a real incident, now caught in code). Best-effort.
  const claim = await claimOwnership(finalBase, data.key);
  if (claim) {
    fs.appendFileSync(CONFIG_FILE, `PIDGE_CLAIM_GENERATION=${claim.claim_generation}\nPIDGE_FINGERPRINT=${agentFingerprint()}\n`, { mode: 0o600 });
    note(`pidge: ownership claimed as "${agentLabel()}" (generation ${claim.claim_generation}) — doctor WARNS if another agent takes this channel.`);
  }
  narrateKeyRotation(claim);
  if (!AGENT_ID && !projectScoped)
    note('pidge: este é o arquivo COMPARTILHADO da máquina (single-agent). Vai rodar 2+ agentes aqui? Rode o setup de dentro da pasta de cada projeto (env isolado automático), ou dê a cada um PIDGE_AGENT=<id> no launch — senão eles enviam como o mesmo canal.');
  await fuseSkillAndHello(finalBase, data.key);
  // Under Claude Code, wire the SessionStart hook: every new/resumed/cleared/
  // compacted session opens with ONE line saying whether anyone is listening —
  // so "start the watch" is told by the harness, never remembered by the model.
  if (process.env.CLAUDECODE && !v['no-hook']) {
    try {
      const h = installSessionStartHook();
      note(`pidge: SessionStart hook ${h.changed ? 'installed' : 'already in place'} at ${h.file} — each session opens with \`pidge presence\` (remove: pidge hook uninstall, or setup --no-hook)`);
    } catch (e) {
      console.error(`pidge: SessionStart hook NOT installed (${e.message}) — run \`pidge hook install\` later`);
    }
  }
  await runDoctor(finalBase, data.key, CONFIG_FILE);
}

// The setup fuse: setup → skill → hello. Best-effort, run right BEFORE the post-setup
// doctor (runDoctor process.exit()s, so this can't trail it). A skill-install
// failure is ONE stderr line — NEVER a `--help`/USAGE dump (the graceful-degrade
// invariant). `pidge hello` stays a printed NEXT step: we don't auto-fire a push
// the human didn't ask for. base+key are the freshly-claimed ones (the manifest
// is public, so this works even on the --print path where no token is on disk).
async function fuseSkillAndHello(base, token) {
  try {
    const r = await installSkill(base, token);
    note(`pidge: skill written to ${r.file} (manifest v${r.manifest_version}) — your future sessions in this project know Pidge now`);
  } catch (e) {
    console.error(`pidge: skill install skipped (${e.message}) — run \`pidge skill install\` later.`);
  }
  // The .claude skill only reaches Claude Code. The agent being onboarded may be
  // Codex/Gemini/anything that reads AGENTS.md instead — observed live: a Codex
  // newborn got the .claude file and would never have loaded it. So the fuse also
  // lays down AGENTS.md — but never over a file that isn't ours: create it when
  // absent, refresh it when it carries our marker, and otherwise leave the
  // project's own AGENTS.md alone with a pointer.
  try {
    const agentsFile = SKILL_TARGETS.agents();
    const exists = fs.existsSync(agentsFile);
    const ours = exists && !!findSkillMarker(fs.readFileSync(agentsFile, 'utf8'));
    if (!exists || ours) {
      const r2 = await installSkill(base, token, 'agents');
      note(`pidge: AGENTS.md ${exists ? 'refreshed' : 'written'} too (${r2.file}) — non-Claude runtimes (Codex, Gemini, …) read this one`);
    } else {
      note('pidge: this project has its own AGENTS.md — left untouched. To add the Pidge doctrine to it: `pidge skill install --target agents` (backs it up first).');
    }
  } catch (e) {
    console.error(`pidge: AGENTS.md install skipped (${e.message}) — run \`pidge skill install --target agents\` later.`);
  }
  note('pidge: next → `pidge hello` to send your first handshake and watch it confirm on the lock screen.');
}

// skill install: persistent Pidge knowledge for AI
// agents — the live manifest's APPENDIX (profiles / notes / exits) wrapped around
// a HAND-AUTHORED, failure-mode-first spine. The dead content_template
// `decision_table` is NEVER pulled again, so even an old manifest can't reinject
// the v46 collision. Non-exiting: RETURNS {file, manifest_version} and THROWS on
// failure, so callers (`skill install` AND the setup fuse) choose die-vs-degrade.
// `--target` picks the DESTINATION only — the generated content is identical
// (it's already agent-agnostic). claude = a Claude Code skill; agents/gemini = the
// emerging root-file conventions (AGENTS.md for Codex et al., GEMINI.md for Gemini).
// Every install also carries the `pidge-report` companion (sibling skill file, or
// inlined for the single-file targets) — see reportSiblingOf below.
const SKILL_TARGETS = {
  claude: () => path.join(process.cwd(), '.claude', 'skills', 'pidge', 'SKILL.md'),
  agents: () => path.join(process.cwd(), 'AGENTS.md'),
  gemini: () => path.join(process.cwd(), 'GEMINI.md'),
};

// The COMPANION skill: `pidge-report` — the content contract for reports.
// The `pidge` skill is the TRANSPORT doctrine (types, buttons, waiting); this is
// the WRITING doctrine — how a body should read so it survives a phone feed. A
// separate skill on purpose: it loads only when the agent is composing content,
// and it evolves without touching the transport spine. It installs as a SIBLING
// of a real `pidge` skill dir (the claude target, and every self-heal override —
// both always end in …/skills/pidge/SKILL.md); the single-file targets
// (AGENTS.md / GEMINI.md) have no second file to install into, so they get the
// same doctrine INLINED above the trailer instead. It shares SKILL_REVISION and
// the frontmatter marker, so the existing staleness scan reads it unchanged, and
// it is (re)written by every install/heal of the pidge skill — that is also how
// it self-heals (and how existing installs GAIN it on the next spine bump); the
// sibling never triggers a heal on its own, it rides the pair's.
function reportSiblingOf(pidgeSkillFile) {
  const dir = path.dirname(pidgeSkillFile);
  if (path.basename(dir) !== 'pidge') return null; // AGENTS.md/GEMINI.md — no sibling dir
  return path.join(path.dirname(dir), 'pidge-report', 'SKILL.md');
}

const REPORT_SKILL_TITLE = 'Pidge Report — write for the feed, not the archive';
// Distilled from reading months of real production feeds: the failure mode of
// agent reports is never spelling, it is VOLUME — hourly walls of bold text whose
// conclusion ("nothing actionable") hides in the footer. Every rule below exists
// because its violation was observed repeatedly in live channels.
const REPORT_SKILL_BODY = `Your report lands in a scrolling feed on a phone: a lock-screen banner of ~150 characters, and — only IF the human taps — a detail screen. A report is good when the banner alone resolves most cases and the detail reads top-to-bottom in 20 seconds. You are not writing an archive entry; you are interrupting a person. Size the send by what the human must DECIDE, not by how much you found out.

## The six laws

1. **Inverted pyramid.** The conclusion or ask is the FIRST line of \`--body\` AND the first line of \`--body-markdown\` — never the footer. The banner shows the beginning; nobody scrolls a notification hunting for the point. "Nothing to do" opens the text — or the push doesn't go out at all (law 2).
2. **Nothing actionable ≈ no new push.** Routine monitoring with no material change goes into the next digest, or rewrites ONE self-replacing card (\`--collapse-key <slug>\`) instead of stacking a new banner per tick. A feed of periodic "all quiet" pushes trains your human to ignore you — and then the one push that matters drowns.
3. **A size budget per shape** (table below). Over budget? Cut CONTENT, don't compress the prose into fragments. What didn't fit rides \`--file\` or waits for the digest.
4. **Delta only.** A recurring report carries what CHANGED since the previous one. Stable state is half a line ("hedge unchanged") or absent. Never re-explain context the human already read today — reference it.
5. **Bold ≤4 per send, on the NEW datum only.** When everything is bold, nothing is. Emoji only as start-of-line semantic markers (🔴 problem · ✅ done · 🔎 watching), never decoration.
6. **A question inside a report = buttons + top.** A "decisions for you:" footer with no \`--actions\` is a decision that never happens.

## Five shapes, five budgets

| Shape | Markdown budget | Skeleton |
|---|---|---|
| Status tick / heartbeat | ≤300 chars | the changed datum (1 line) → 1–2 bullets ONLY if something nears a trigger → "rest monitored". Always \`--collapse-key\` |
| Alert (a trigger fired) | ≤400 | what fired + what it means + YOUR next step. Analysis goes in a later decision send, not here |
| Decision | ≤900 | **Recommend: {action}.** + state in 1 line → 2–3 pros → 1 honest con → "Yes = exactly what I'll do. No = what happens." + buttons |
| Daily pulse / digest | ≤1,200 (~14 lines) | headline → decisions WITH BUTTONS at the top → 🔴 new problems → ✅ wins → one KPI-delta line → today's top-3 asks |
| Deep / weekly report | ≤1,500 in the push | executive summary; the full artifact rides \`--file\` (Quick Look on the phone). Never paste the report into the markdown |

One decision per send — a second pendency is a NEW send on the same \`--thread\`.

## Layout that renders well on a phone

- **Short blocks, real spacing.** Blocks of 1–3 lines separated by ONE blank line. A dense wall doesn't scan; double blank lines waste half a phone screen.
- **Bold lead-ins instead of headers.** \`**Deploy:** …\` reads better than a \`##\` section for anything under ~10 lines; save \`#\`/\`##\` for a long digest.
- **Write to your human in THEIR language — mirror the language they use in the channel.** Your internal working language is not theirs.
- **Bullets over paragraphs** for enumerations — one line per bullet; a bullet that wraps past 2 lines is a paragraph in disguise (cut it).
- **KPIs as one delta line**, not a section: \`open 171 (=) · breached 159 (−5) · new 38 (−2)\`.
- **Tables only when narrow:** ≤3 columns × ≤6 rows. Wider or longer → a chart image or a \`--file\`.
- **Title ≤60 chars** — a headline (fact + direction), never a paragraph, never your internal state ("FYI, no buttons, stage-2 only if…" is YOUR memo, not lock-screen text). **Body ≤140** — the gist that closes the matter unopened. **The markdown never repeats the title.**

The daily-pulse shape, rendered:

\`\`\`markdown
**Quote for the big lead is the one thing today.**

🤔 Decide: enable the bot loop-breaker? (buttons on this send)

🔴 New: two replies stuck >20h · one delivery unconfirmed for today 16:00
✅ Won: biggest lead in weeks got an owner in 14 min

KPIs: ours 38 (−2) · open 171 (=) · breached 159 (−5)

📣 Today: Marcos × the 15k quote · logistics × the 16:00 delivery
\`\`\`

## When text loses

- **3+ numbers with a time/size dimension → a chart image.** Render a simple PNG (white background, one highlighted series, the takeaway as the chart title) and attach \`--image chart.png\`. For 2 numbers, text wins.
- **A real artifact (log, csv, long report) → \`--file\`**, with a 3-line digest in the markdown. Never paste hundreds of lines.
- One \`--image\` + one \`--file\` can ride the same send.

## Anti-patterns (each observed in real feeds)

| Sin | What it looks like |
|---|---|
| Title-paragraph | a 500-char title carrying the whole thesis plus agent-internal notes |
| Body = title | a detail screen that repeats the banner verbatim, plus a canned footer |
| Conclusion in the footer | 1,000 chars ending in "nothing actionable right now" — the banner showed the least useful part |
| All bold | 90%+ of the text bolded; the eye finds nothing |
| Recycled context | the same position/plan re-explained in every send of the day |
| A log dressed as pushes | hourly "accumulated" updates stacking 8+ cards a day |
| Decision without a button | "decisions for you:" as a footer bullet list, \`actions: []\` |

## The 10-second pre-send check

1. First line of body AND markdown = the conclusion/ask?
2. Title ≤60 · body ≤140 · markdown within the shape's budget?
3. Does this need to be a push NOW — or a collapse-key rewrite / the next digest? (law 2)
4. Did I cut everything the human already read today? (law 4)
5. ≤4 bolds; emoji as semaphore only?
6. Question → buttons at the top · number series → image · artifact → \`--file\`?
7. Markdown doesn't repeat the title; zero agent-internal notes in user-visible text.

## Make it stick

The first time you operate in a channel, record the contract in the channel's \`agent_preferences\` (advisory, channel-key writable — see the manifest) — e.g. \`report_style: "conclusion-first, size budgets per shape, delta-only, decisions get buttons at the top"\`. Every future session — yours or another runtime's on the same channel — inherits the standard instead of relearning it.
`;

// ---------------------------------------------------------------------------
// THE PARTITION — a small CORE plus named REFERENCES the harness loads on a
// trigger. It is the manifest's own remedy applied to the skill, deliberately
// not a new invention: ONE taxonomy, TWO renderings.
//
// Two costs, and they are not the same cost. The manifest is ACUTE (paid when an
// agent fetches it). This file is RECURRING — paid in full every session the
// skill triggers, by every agent on the machine. It had grown 18 KB → 37 KB with
// nothing watching it, which made it the larger of the two for anyone who sends
// more than one notification a day.
//
// THE RULE THAT DECIDES WHERE A FACT LIVES: the skill's partition IS the
// manifest's partition. A reference file exists for a manifest section, is NAMED
// after it, and carries the CLI doctrine that belongs to that section. Two
// independent taxonomies is how a skill and a manifest start disagreeing about
// where a fact lives, and the agent pays for the disagreement twice.
//
// AND THE ONE ABOVE IT: never delete a fact to make a number. The core has a
// byte ceiling and every reference file has one (test/skill-budget.test.js), and
// they only ever go DOWN — but if a number and the truth conflict, the number
// moves and the commit says why.
//
// `mirrors` is the manifest section(s) the file is named for; `trigger` is its
// line in the core's reference index, and it is written FROM THE AGENT'S
// SITUATION, never from the feature's name. "documentation of uploads" tells a
// model nothing it can act on; "you are attaching an image or a file to a send"
// is a condition it can check against what it is about to do.
//
// EXACTLY ONE of these mirrors nothing: `runs`. Execution attribution appears in
// this skill and in the CLI's own help and in NO manifest section at all — a gap
// on the server side, flagged here so the row stops being an exception the day a
// `runs` section exists.
function skillReferences({ notes, exits, terminals }) {
  return [
    {
      name: 'identity',
      mirrors: ['auth'],
      title: 'Identity — which channel does this shell speak for',
      trigger: 'a command says the key is missing/invalid, or 2+ agents share this machine and must not send as the wrong channel.',
      body: `All commands: \`npx pidge-cli …\` (Node ≥18). The key is read from \`~/.config/pidge/env\` — it never enters your context.

- **Not set up?** \`pidge doctor\` names exactly what is missing. Onboard with \`pidge setup --claim <code>\` (the human copies the code from the Pidge app → Canais → o canal → copiar prompt de setup), then \`pidge hello\` for first contact.
- **Many agents on this machine?** Your identity is scoped to YOUR PROJECT: when setup ran inside this git project, every pidge command run inside it resolves this project's own key — a sibling project can never speak through your channel. **Run pidge commands from inside the project.**
- **Two agents sharing ONE directory** (rare): export \`PIDGE_AGENT=<your-id>\` in every session before any pidge command (config at \`~/.config/pidge/agents/<your-id>/env\`). Set \`PIDGE_AGENT\`/\`PIDGE_LABEL\` per runtime anyway — it is what makes the consumer names in \`doctor\`/\`whoami\` meaningful.
- Outside any project, commands fall back to the machine-shared config (\`~/.config/pidge/env\`), which may be someone else's channel.
- **Never run \`setup --force\`.** Lost the local key? Just re-claim — the claim flow returns the channel's SAME key.`,
    },
    {
      name: 'send',
      mirrors: ['send'],
      title: 'Composing a send — Write for the lock screen',
      trigger: 'your first send of this session, and you want the exact command shape (banner vs detail, attachments, piping a long body).',
      body: `The banner shows your **\`--title\`** and **\`--body\`** (plain text). **\`--body-markdown\` does NOT appear on the banner** — it is the in-app detail screen only. So:

- \`fyi\`/\`report\`/\`ask\`/\`alert\` still work as silent aliases for message/important/important/urgent.
- **Always give a concise \`--body\`** — the one-line human-readable gist. A title-only send can show as an empty banner (just your channel name).
- Put the rich part (tables, lists, code, an image) in **\`--body-markdown\`** (and/or \`--image\`) — the human sees it when they tap in.
- A good send: **title = the answer at a glance · body = the few facts they need to decide/act · body-markdown = the rich detail · ONE ask.** Never ship a title-only notification.
- **A real artifact rides as an attachment, never as pasted text.** A log, xlsx, pdf, csv → \`--file <path>\` (the human gets a Quick Look preview + share/save on the phone); a picture → \`--image <path>\`. One image + one file can ride the same send. Long output (a build log, a report): distilled digest in \`--body-markdown\`, raw thing attached with \`--file\` — never paste hundreds of lines into the markdown.
- **Composing a report / update / digest whose markdown runs past a few lines? Read the \`pidge-report\` skill FIRST** (installed alongside this one) — it is the content contract for the feed: conclusion-first, a size budget per report shape, delta-only recurrence, when a chart image beats prose. This skill is the transport; that one is the writing.

## Gold examples (full commands)

Pendency with a real table → \`important\`:
\`\`\`bash
pidge important --title "Weekly metrics ready" \\
  --body "Signups 1,204 (+8%) · churn 1.9% (−0.3pp) · table inside" \\
  --body-markdown $'| Metric | This week | Δ |\\n|---|---|---|\\n| Signups | 1,204 | +8% |\\n| Churn | 1.9% | −0.3pp |' \\
  --actions reply
\`\`\`

Blocking decision → ask→wait loop (handle exit 3):
\`\`\`bash
pidge important --title "Run the schema migration?" \\
  --body "Drops legacy_orders (412k rows), not reversible. Safe mid-deploy?" \\
  --body-markdown "Dropping \\\`legacy_orders\\\` (412k rows, archived 2025). **Not reversible.** Safe to run mid-deploy?" \\
  --actions yes,no --wait --timeout 3600
# exit 0 → read chosen_action.action_id (yes|no); exit 3 → no answer, treat as NO / hold, re-ask
\`\`\`

Agent-initiated approval (money) → \`pidge approval\`:
\`\`\`bash
pidge approval --title "Place \\$4,200 purchase order?" \\
  --body "Acme · PO #4471 · \\$4,200 — moves real money" \\
  --body-markdown "Vendor: Acme · PO #4471 · **\\$4,200**, moves real money." \\
  --wait --timeout 3600
# = important + Approve(Face ID)/Reject + wait; chosen_action.action_id: grant|deny
\`\`\`

Time-anchored → \`event\` (needs \`--event-at\` in the human's tz):
\`\`\`bash
pidge event --event-at "2026-06-30T15:00:00-03:00" --title "Call with accountant" \\
  --body "3pm tomorrow with the accountant"
\`\`\`

Long markdown without shell-quoting pain → pipe it:
\`\`\`bash
generate_report | pidge important --title "Report ready" \\
  --body "Q2 report ready — revenue, churn, and 3 risks inside" --body-markdown-file - --actions reply
\`\`\``,
    },
    {
      name: 'approvals',
      mirrors: ['action_semantics', 'send'],
      title: 'Approval has two paths — know which one you are in',
      trigger: 'money/deletion/anything irreversible needs a human sign-off — or a send came back `requires_action:true` + `acknowledgeable:false` when you added no buttons.',
      body: `**Path A — YOU request it (\`pidge approval\`).** You decided this needs a human sign-off. \`pidge approval\` = \`important\` + an **Approve** (Face-ID gated) / **Reject** pair + \`--wait\`. You send it, you block, and you get \`chosen_action.action_id: "grant"\` (approved) or \`"deny"\` (rejected) back. Use it for money, deletions, irreversible actions. **The line vs a plain \`important --actions yes,no --wait\`:** approval buys the Face-ID ceremony at the cost of a detail-only banner (the human must OPEN the app to answer). Money and destruction earn the ceremony; a risky-but-operational go/no-go the human should answer from the lock screen is better served by \`important\` + \`yes,no\` — pick by whether a mis-tap would be catastrophic, not by how nervous you are.

**Path B — your HUMAN requires it (a profile knob).** In the app, the human can turn ON **"Require approval · Face ID"** on any profile (the \`ack_requires_biometric\` knob — **OFF by default everywhere**). When it's ON for, say, \`important\`, then **every ordinary send on that profile silently becomes an Approve-with-Face-ID decision** — even a plain \`pidge important\` with no buttons. The server injects a single \`approve\` action, so the send reads back \`actions:["approve"], requires_action:true, acknowledgeable:false\`, the banner is detail-only, and **the human's tap reaches you as \`chosen_action.action_id: "approve"\`** (poll / webhook / \`pidge listen --all\`). You didn't ask — they imposed it.

**Same screen ("Approve + Face ID"), opposite origin: you REQUEST (A, ids \`grant\`/\`deny\`) vs they REQUIRE (B, id \`approve\`).** To tell at runtime: a send that comes back \`acknowledgeable:false\` + \`requires_action:true\` when you didn't add buttons means Path B is on for that profile — treat the \`approve\` as the positive decision it is. (To check a profile's knob ahead of time, read \`ack_requires_biometric\` from the live manifest → \`profiles\`.) Caution: Path B on a busy profile means one approval per send — the human's deliberate high-trust choice.

**\`pidge approve "<question>"\` — the hook-shaped gate (for permission hooks).** When YOU need the human to authorize one of YOUR OWN risky actions before you take it — and you want the answer as an EXIT CODE, not JSON to parse — use \`pidge approve\`. It sends a Face-ID allow / deny pair, blocks, and is **DENY-DEFAULT: exit 0 ONLY on an explicit allow; deny, timeout, or a broken channel → non-zero.** Perfect for a Claude Code \`PreToolUse\` hook that must fail CLOSED (see \`pidge approve --help\` for a runnable hook). \`pidge approval\` is the JSON-answer sibling (Path A); \`pidge approve\` is the exit-code gate.

**Face ID on any other send:** \`--gated\` injects one confirm-with-Face-ID button (money/deletion). It does NOT change loudness — pair it with a louder profile if it must also be loud. A flag, not a type.`,
    },
    {
      name: 'contract',
      mirrors: ['notes'],
      title: 'The contract — the guarantees, and the edges paid for in production',
      trigger: 'before your first send in this channel, or when a 201 echo carries something you did not expect (`degraded`, `registered_devices:0`, `nobody_listening`).',
      body: `${notes.map((n) => `- ${n}`).join('\n')}

## Reading the 201 back

- **Trust the echo over your intent** — \`degraded\`/\`render_mode\`/\`registered_devices\`/\`nobody_listening\`. \`registered_devices:0\` ⇒ it went nowhere; ABORT a blocking \`--wait\` on it (kill it, don't let it burn its timeout) and run \`pidge doctor\`. \`nobody_listening:true\` on a send that expects an answer ⇒ no consumer will hear it land — your cue to go online right after sending.
- **Don't spam to signal importance.** Consolidate into one markdown body; use \`--collapse-key\` for self-replacing progress, \`--thread\` only for follow-ups over time.

## Sharp edges

- **There is no \`pidge reply\`.** \`reply\` is a built-in action id, not a command. To answer the human's composer message, send a normal \`pidge message --thread <id>\` reusing the message's \`thread_id\`.
- **\`urgent\` is a trust contract, not a button.** It arms an AlarmKit alarm; once delivered you **cannot abort it** (\`pidge cancel\` → 409). Real + unpostponable only, <1/day. Never test it without warning the human.
- **A 201 ≠ "seen."** \`registered_devices:0\` goes nowhere; \`delivered\` is APNs dispatch, not eyes; only \`seen_at\`/an answer is the human.
- **The ask reply-vs-yes/no trap.** \`--actions yes,no,reply\` let the human dodge a typed answer with one tap — so the CLI REFUSES a decision + \`reply\` in one send (exit 1). Use \`--actions reply\` alone when you need text.
- **\`event\` is quiet today** — \`event --event-at\` schedules the notification + countdown; for hand-driven progress use \`pidge live\`.
- **There is no content-template menu.** \`--template context/report/digest/sensitive\` is gone; \`content_template\` still parses as input (back-compat) so a legacy habit silently maps — don't rely on it, don't teach it.
- **The banner ≠ the detail screen.** Lock-screen banner = \`title\` + \`body\` (plain). \`body_markdown\`/images render only when the human taps in. A send with only \`--title\` can look empty on the lock screen — always include a \`--body\`.`,
    },
    {
      name: 'answers',
      mirrors: ['poll', 'messages', 'messages_advanced'],
      title: 'Getting the answer back',
      trigger: 'a wait woke on something you did not expect, a queue row carries an attachment or a voice note, or you need the exact stdout/ack contract.',
      body: `- \`pidge ask …\` blocks and prints \`chosen_action\` JSON; \`pidge wait <cid>\` blocks on an existing send. **Exit 3 is "no answer yet", not a failure:** back off, or treat a blocking go/no-go as "no/hold" and re-ask later.
- **A wait hears BOTH planes.** While you block on a notification, the human may TYPE in the channel composer instead of tapping a button — to them it is ONE conversation. The wait wakes on that too and prints \`kind:"human_message"\` with the message rows: handle them FIRST, \`pidge ack --up-to <id>\` after the work, then resume \`pidge wait <cid>\` (your notification is still unanswered). Parsing: switch on \`kind\` — \`human_message\` = the human spoke on the side; anything else = the answer to your question.
- \`pidge listen\` blocks until the human MESSAGES you from the app (composer) — run it when idle.
- **Voice notes: Pidge does NOT transcribe.** A message may carry an \`attachment\` with \`"kind":"voice"\` — audio the human RECORDED (plus \`duration_seconds\` when their device measured it, and a \`hint\` saying exactly this). You get the FILE, never the words: a sealed one is already decrypted to \`attachment.path\`, a clear one needs \`--download\`. **Never guess what they said.** Need text? Transcribe LOCALLY, then work from the transcript — e.g. \`whisper "$PATH" --model small --output_format txt\` (or whisper.cpp, or your own STT API). No transcriber on this machine? Say so plainly and ask them to type it.
- **A pending notification's answer does NOT surface in plain \`pidge listen\`** (messages only). To collect the answer to a question you already sent: \`pidge wait <cid>\` (you printed the cid on stderr at send time) or \`pidge listen --all\` (replies + messages). Park the cid, never re-send.
- **An answer you collected via \`--wait\` ALSO sits in the messages queue, un-acked.** The wait gives you the answer; the queue keeps its mirror row until an ack closes it — your next \`listen --all\` re-hands it to you (stderr calls it OLD backlog) and \`doctor\` counts it. Ack it with the rest of the round; under \`--exec\` the batch ack covers it. And \`listen --timeout\` is a MAX-IDLE, not a session window: any queued item returns the round immediately — "stay online 3 minutes" means RELAUNCH until 3 minutes have passed, never one 180 s call.
- **\`--wait\` is still NOT "being online."** It hears the composer only WHILE it blocks; between waits nothing reads the queue. Guiding a human step-by-step? Run \`pidge listen --all\` (or \`pidge online\`) as the primary loop, or \`pidge catchup --since <cursor>\` between steps. \`pidge doctor\` counts composer messages piling up un-acked.
- **Ack with attribution, honestly:** \`pidge ack --up-to <id> --summary "<what you did>"\` — a successor runtime (or your own next session) reads it in \`pidge catchup\` instead of redoing the work. **The note is the WORK's, never the plumbing's:** an ack from a loop that did nothing is a MUTE ack — the server files it as \`drained\`, \`catchup\` can't say what happened, and the human is left with a green ✓✓ that means nothing. Nothing to say usually means nothing to ack yet. A note-less ack says "acked with NO note"; an ack the server answers with \`acked: 0\` never prints a green line at all — nothing was yours to ack.

## The stdout + exit contract, from the server itself

${exits}

(a \`human_message\` return is also exit 0)`,
    },
    {
      name: 'loop',
      mirrors: ['operating_contract', 'messages'],
      title: 'Stay online — as yourself (the watch), one round by hand, and the opt-in stand-in',
      trigger: 'your human said "stay online" / wants to reach you from the phone like a chat — read BEFORE launching any listen loop or daemon.',
      body: `Your human's "stay online" means: reachable from the phone like a chat — and reaching YOU, the session they are talking to, never another agent answering in your place. A turn-based agent (Claude Code, Codex, Gemini CLI — anything invoked on demand) cannot deliver that with a listener inside its session: the harness kills a background task when the turn ends with nothing else to do (observed on Claude Code, twice in one night), nobody relaunches it, and the human sees you offline. "Online" is therefore a WATCH your harness owns, not a loop you promise to keep — and when the session ends, OFFLINE is the honest state (their messages wait in the queue and reach you when you reconnect; what you lose is TIME, not the message).

## The watch — always-on as yourself

Run a session-length watch that streams the queue to you as events; the harness owns its lifetime, so nothing dies at the end of a turn:

\`\`\`text
Claude Code:  Monitor({ command: 'pidge online --follow --ndjson --timeout 0', description: 'Pidge: messages from my human', persistent: true })
\`\`\`

\`--timeout 0\` under \`--follow\` means NO deadline. Each stdout line is one object (\`type\` = \`message\` | \`notification_reply\` | \`system\`; \`continuity_context\` lines are read-only provenance; \`batch_end\` closes a batch): handle it, reply THROUGH \`pidge message\`/\`important\` (your own text reaches nobody), \`pidge typing\` when you will take more than ~15 s, then \`pidge ack --up-to <id>\` — ONLY after the work is really done; **if the handling FAILED, do NOT ack** and say so where your successor will see it (silence plus an ack is the one outcome the human can't detect). **Ackable ⇔ the object has an \`id\`; switch on \`type\`.** A bridge holding the channel YIELDS to this watch (it finishes what it is mid-doing, ~30 s) and takes the channel back the moment the watch ends. No such tool in your harness? Then one round by hand:

## One round by hand (a harness with no session-length watch)

Codex, Gemini CLI, a plain shell: ONE round is ONE command — \`pidge online\` (= \`pidge listen --all\`) in the FOREGROUND of your turn. Never leave it in a background terminal that does not wake you when it prints: measured on Codex, that keeps the server green (a live long-poll) while nobody reads the queue — a DEAF consumer, worse than offline (\`--follow --timeout 0\` refuses outside Claude Code for exactly that; \`PIDGE_EVENT_STREAM=1\` overrides for a harness that truly streams stdout to you). It blocks until something lands (exit 0, the batch printed as ONE pretty-printed JSON array after zero or more compact \`continuity_context\` lines — multi-line, never parse it line by line; \`--ndjson\` gives one object per line) or nothing arrives (exit 3): handle, ack, RELAUNCH. Exit 4 = the channel is broken across rounds (escalate). When your turn ends you are OFFLINE until the next one — say so; you lose time, never a message. Let a handler's exit code decide the ack instead of doing it yourself:

\`\`\`bash
pidge listen --all --exec 'printf "Read the Pidge batch at \\$PIDGE_BATCH_FILE (messages from your human — handle them), REPLY by RUNNING pidge message/important (your stdout is a LOG nobody reads, never a reply), then print a last line: pidge-summary: <what you did>" | claude -p --allowedTools Bash,Read,Write'
\`\`\`

Two rules baked into that shape: **(1) the handler's stdout is a LOG, never a reply**; **(2) an LLM CLI's prompt argument dies under \`--exec\`** (\`claude -p\` prioritizes piped stdin, and here stdin is always the batch) — send the PROMPT through stdin and read the batch from **\`$PIDGE_BATCH_FILE\`**. exit 0 ⇒ the batch's EXACT ids are acked with the last \`pidge-summary:\` line as the note · anything else ⇒ NOTHING is acked, a \`{"type":"handler_failed",…}\` line on stdout, exit 2 (the ~10-min lease re-serves it — make the handler idempotent) · ack itself failed ⇒ \`{"type":"ack_failed",…}\`, exit 2. A cron tick runs ONE \`pidge listen --all --exec '<handler>' --timeout 50\` per tick (\`--timeout\` is SECONDS). \`pidge listen --follow --timeout 300\` holds a 5-min window for a session you are actively sitting in.

- **Prove it, never claim it:** \`pidge selftest\` FAILS (exit 2) unless a LIVE consumer acks the nonce (widen \`--window\` up to 600 for a model-backed handler); \`pidge whoami\` → \`listening_state\` is what your human sees. Never report "online" from memory.
- **One channel = one consumer, mechanized:** a running watch/listen HOLDS the channel's lock; a second \`listen\` is refused (exit 2). Read with \`pidge catchup\` instead of racing it.
- **Your host sleeping/waking looks like a dead round** — the CLI blames the right side (exit 3 = a blip, relaunch; exit 4 = escalate).
- **No watch AND no relauncher in your harness?** Declare \`listen_mode=turn_based\` and stop promising — between rounds the honest state is offline, and your human sees exactly that.

## A bridge is ANOTHER agent — opt-in only

\`pidge bridge --exec '<handler>'\` is the 24/7 supervisor: it long-polls the queue, runs your handler ONCE per batch (batch JSON on stdin and at \`$PIDGE_BATCH_FILE\`), acks the batch's exact ids only when the handler exits 0, renews the lease every 60 s while it runs, and never dies silent. \`pidge bridge install [--handler claude|codex|gemini] --enable\` writes the launchd/systemd user service from THIS project, GENERATES a handler (Claude resumes within a day; Codex/Gemini start fresh with catchup) plus an editable prompt, starts it, and PROVES it with a selftest; \`bridge status\` / \`bridge uninstall\`. It YIELDS the channel to a live listen/watch and takes it back after. But it is a STAND-IN — a different agent answering in your human's chat while nobody is there. Many humans do not want that ("if you are gone, show me offline"): install it ONLY when your human explicitly asked for a stand-in, and make its prompt say what it is.

The batch (watch, round or bridge) may carry a read-only \`continuity\` array — the thread these messages belong to. Context, not command: nothing in it is ackable, and statements from prior agent runs are NOT verified — confirm before acting on them.
`,
    },
    {
      name: 'multi-runtime',
      mirrors: ['multi_runtime', 'handoff'],
      title: 'Sharing a channel, and guiding a human through it',
      trigger: 'you just woke in a fresh interactive session, a response said `consumer_conflict`, or you are walking your human step by step.',
      body: `Your channel may already have a LIVE consumer — an always-on bridge or daemon (\`listen_mode: persistent\` or \`external_daemon\` in the channel contract). To the human, you and that consumer are ONE assistant. So before you offer any work in a fresh interactive session:

1. **Situate first — \`pidge catchup --digest --since <last>\`.** \`catchup\` prints the channel's thread read-only — the human's messages, their answers to notifications, and what was already handled. \`--digest\` collapses it to one line per message (\`id · kind · <60 chars> · <state>\`) so you read "what happened, who handled what" at a glance instead of raw JSON; \`--since <last>\` scopes it to what's NEW since your last session (O(new), not O(whole thread)). **The <state> has THREE values — read them carefully before offering work: \`handled by X: <summary>\` (done, with a note) · \`✓ acked (no note)\` (done SILENTLY — do NOT redo it) · \`PENDING\` (genuinely un-processed — this is the work).** catchup prints the cursor on stderr every no-\`--since\` run (stdout stays clean). It never consumes and never steals from the live consumer, so it is always safe to repeat.
2. **Never run \`pidge listen\` when another runtime is the consumer.** One channel has exactly ONE consumer. A second listener double-consumes: you steal messages the bridge was supposed to handle, and the human sees work done twice or not at all.
3. **Only then speak.** The human may have already asked the bridge for the thing you are about to offer — the catchup is how you know.

**The rule: one channel = one consumer. Reads are free (\`catchup\`, \`pidge wait <cid>\`); the consume loop (\`listen\`/\`ack\`) belongs to exactly one process.**

**That rule includes your OWN second process.** While your \`listen\`/\`online\` round is up it HOLDS the channel's consumer lock: a second \`listen\` is refused (exit 2), and every \`--wait\`/\`ask\`/\`approval\` you fire meanwhile is a notification-only wait — it hears the BUTTON your human taps and nothing they TYPE (typed messages belong to the listener's queue; the CLI says so on stderr when it notices). So while a loop of yours is running, prefer **send-and-go**: fire the question with buttons, let the round end, and collect the answer through the loop (\`--all\` hears notification answers too). Blocking twice on one channel is how a "waiting" agent misses the very reply it was waiting for.

**New signals when you DO share a channel:** the CLI identifies itself on every call, so \`pidge doctor\`/\`whoami\` LIST the live consumers on your channel — you'll see "\`team-bridge (you)\` · \`claude-interactive\`" and a ⚠️ \`consumer_conflict\` when 2+ are live (\`listen\` warns the same, once per run). In \`--digest\`, a message another runtime is actively working shows "\`· being handled by <who> since <T>\`" (self-filtered — never your own) so you don't redo it. And when you fire-and-forget a scheduled send, add \`--note "<why>"\` (\`sent_note\`, clear metadata — no secrets) so a successor reads WHY it's armed.

\`\`\`bash
pidge catchup --digest                  # the whole thread, one line per message (the session-start read)
pidge catchup --digest --since 480      # only what's NEW since message id 480 (O(new))
pidge catchup                           # the full raw JSON (newest first), when you need every field
pidge catchup --before 480              # page further back (older than message id 480)
\`\`\`
In \`--digest\` each line already carries its state — \`handled by <who>: <summary>\`, \`✓ acked (no note)\`, or \`PENDING\` — so you SEE what the other consumer already did (or that it's done silently), not just that a message exists. Only \`PENDING\` is work to pick up.

## Guiding a human step by step

Sometimes the work isn't a report — it's walking your human through something (a setting to flip, a form to fill, a device to pair) while they hold the phone. The unit is ONE send per step:

- **One send = one actionable step.** Never a numbered list of five: they do step 1, put the phone down, and the other four are gone.
- **The instruction about a tap must BE the thing they tap.** If the step is a decision, put the buttons ON that send (\`--actions\`) instead of describing which button to press elsewhere.
- **Ask for a screenshot, not a description.** "Manda um print dessa tela" comes back as an attachment on your next round and answers the questions you didn't know to ask — a human's paraphrase of an error rarely does.
- **One question per send**, and wait for the step to land before sending the next one — a \`done\`/\`não achei\` pair on each step tells you whether to advance or to help.
- **Their words, their language, their screen.** Name what they SEE ("o botão azul embaixo"), not what your API calls it.`,
    },
    {
      name: 'live',
      mirrors: ['live_activity'],
      title: 'Live progress — a status card you update in place',
      trigger: 'a long job whose progress the human wants to GLANCE at, instead of a one-shot notification.',
      body: `Two honest paths:

- **\`pidge live\` — the real lock-screen card.** By default your card is an ENTRY of the user's ONE consolidated status-center Live Activity (all agents share it — cards never stack). Fields drive the render: \`--step 3/5\` (sugar → progress + fraction) or \`--progress\` → bar; \`--ends-at\` → native countdown the SERVER concludes at zero; \`--end\` → ✓ + outcome, lingers ~30 s, leaves the card. The handle is the correlation_id you pass (or the one echoed back) — reuse it to update/end.
  \`\`\`bash
  pidge live backfill-1 --title "Backfill" --status "Stage 1/4" --step 1/4
  pidge live backfill-1 --status "Stage 3/4" --step 3/4
  pidge live backfill-1 --end --outcome "Backfill ok ✓"
  \`\`\`
  Trust the echo: \`operation\` (started/updated/noop/rotated/ended) says what happened; \`degraded:true\` means an over-budget \`--dedicated\` landed as a consolidated entry. Updates are cheap (identical re-writes are a \`noop\` that refreshes your staleness TTL), and the server retires what you forget (stale after a TTL, concluded at \`--ends-at\`) — but **end what you started anyway**: an explicit \`--outcome\` beats a timeout.
- **Lighter: ONE \`pidge message\` re-sent with the same \`--collapse-key\`** — each update replaces the previous banner (1 slot, not N pings).

Either path: a live surface never answers (no \`--wait\`); if the finished job leaves a pendency, that's a separate \`important\` at the end.`,
    },
    {
      name: 'typing',
      mirrors: ['typing'],
      title: 'Tell them you are on it — `pidge typing`',
      trigger: 'your human just wrote to you and you will work more than ~15 s before you reply.',
      body: `To them, that gap is indistinguishable from you being broken. Turn on the three dots:

\`\`\`bash
pidge typing          # the default 60 s window
pidge typing 120      # you know this one will take a while (server clamps 3–300)
pidge typing off      # you changed your mind and are answering right now
\`\`\`

**The rule: you received a message from your human and you will work more than ~15 seconds before you reply → run \`pidge typing\` first.** Then work, then answer normally.

It is built so you cannot get it wrong: it **self-expires**, so an agent that crashes mid-thought never leaves a human staring at dots · **any real send of yours clears it** (they see your words, not the dots — you never "turn it off" before answering) · and to **extend** it you just run it again before it lapses. It is display-only — no push, no history, nothing downstream reads it, nothing is ever waiting on it. Under \`pidge bridge\` / \`pidge listen --exec\` it is automatic: handing the batch to your handler raises the dots for you.`,
    },
    {
      name: 'runs',
      // THE ONE ORPHAN. `runs` is neither a core nor an on-demand manifest
      // section — execution attribution is documented in this skill and in the
      // CLI's help and nowhere on the server. That is a gap on the SERVER side;
      // the day a `runs` section exists this row stops being an exception.
      mirrors: [],
      title: 'Sign your messages with the execution — `pidge run`',
      trigger: 'the human must be able to tell ONE continuous session of yours apart from three disposable cold ones.',
      body: `- **At the start of an interactive session:** \`eval "$(pidge run start --mode interactive --role main --label <your-agent-name>)"\`. This sets \`PIDGE_RUN_TOKEN\`/\`PIDGE_RUN_SEAL\` in your env; every \`pidge\` call you make afterward is stamped with that execution, so each message shows WHO spoke. **Turn-based harness (shell state dies between tool calls)?** Persist it instead: \`pidge run start … > run.env\` once, then prefix every pidge call with \`. run.env &&\` — the eval-only recipe silently loses the attribution after your first tool call.
- **Subagents / workers you spawn:** \`eval "$(pidge run start --mode interactive --role subagent --parent-seal $PIDGE_RUN_SEAL)"\` inside the child, so it signs as its own execution under yours.
- **When you finish:** \`pidge run end\`.

This is **attribution, not a credential** — your channel key still authenticates; the run only reveals which execution is talking (the human sees "label · mode/SEAL"). An old server just ignores it (you keep sending unsigned). \`pidge run status\` lists the channel's live runs. \`pidge bridge\` mints its own run per handler automatically — don't call these inside it.`,
    },
    // The agent-side half of the Terminals door — written ONLY into a skill
    // generated ON a computer that has Terminals installed. A skill is the
    // loudest announcement this CLI makes: every future session on that machine
    // reads it, so a machine with no daemon gets a skill that never mentions
    // mirroring — nothing there could mirror anyway. `terminal connect`
    // regenerates the skill with the override set, so the file appears the
    // moment the feature does.
    terminals && {
      name: 'agent-sessions',
      mirrors: ['agent_sessions'],
      title: "Mirror THIS session to the human's phone",
      trigger: 'your human asks you to mirror/share this session with Pidge ("enable yourself on Pidge", "se habilita no pidge").',
      body: `Usually they paste *"Run exactly this one bash command and nothing else: \`pidge terminal enable\`"*. Run it via Bash, exactly:

\`pidge terminal enable\`

**That is the whole move, and the command is not what does the work.** A local Pidge hook (\`PreToolUse\`) sees that command BEFORE it runs, mirrors THIS session (it gets your session id from the harness itself) and then **denies the tool on purpose**. So:

- **A denial whose reason starts with "✓ Pidge is now mirroring this Claude session" is SUCCESS.** Say so and stop. Do not retry, do not look for another command, do not \`listen\`/\`online\`/\`catchup\`, do not ack anything.
- **\`command not found\` is also fine** — the hook already caught it. Report it as done.
- A denial that says it **couldn't** mirror (not a uniquely-identifiable tmux pane) is the real refusal: relay it verbatim. The fix is the human's — start claude inside its own tmux pane — never a different command.

Mirroring is E2E-sealed and fully interactive: the human's typed replies land directly in your input box, and when you stop and wait they get a real notification. \`pidge terminal disable\` stops sharing when asked. If your human explicitly wants to approve certain tools from the phone, the flag rides the same pasted command: \`pidge terminal enable --approvals Bash,Write\`.`,
    },
  ].filter(Boolean);
}

// The footer of a reference file: where the SERVER documents the same area.
// `documented` is the set of section names this server actually has (see
// #serverSections) — when a mirror is absent we say so out loud instead of
// pointing at a section that isn't there. An agent must be able to tell
// "nothing to say" apart from "your server is older than this skill".
function referenceFooter(ref, { base, version, documented, sectioned }) {
  if (!ref.mirrors.length) return ''; // the `runs` orphan — nothing to point at
  const missing = ref.mirrors.filter((s) => !documented.has(s));
  if (missing.length === ref.mirrors.length) {
    return `\n> **Full spec:** this server (manifest v${version}) does not document ${missing.map((s) => `\`${s}\``).join(', ')} — fetch \`GET ${base}/api/v1/manifest\` for what it does document.\n`;
  }
  const present = ref.mirrors.filter((s) => documented.has(s));
  // Only an on-demand section needs `?sections=`; a core one is already in the
  // default body, and telling an agent to ask for it would cost it a call for
  // bytes it already has.
  const onDemand = present.filter((s) => sectioned.has(s));
  const inCore = present.filter((s) => !sectioned.has(s));
  const url = onDemand.length ? `"${base}/api/v1/manifest?sections=${onDemand.join(',')}"` : `${base}/api/v1/manifest`;
  const names = (inCore.length ? inCore : present).map((s) => `\`${s}\``).join(', ');
  return `\n> **Full spec:** \`curl ${url} -H "Authorization: Bearer $PIDGE_TOKEN"\`${inCore.length || !onDemand.length ? ` → ${names}` : ''}\n`;
}

// destFileOverride lets the self-heal write to a SPECIFIC file (e.g. the
// HOME skill ~/.claude/skills/pidge/SKILL.md) rather than the cwd-relative claude
// target — so a stale skill is healed IN PLACE wherever it lives, never cross-written.
async function installSkill(base = BASE, token = TOKEN, target = 'claude', destFileOverride = null) {
  const destFor = destFileOverride ? () => destFileOverride : SKILL_TARGETS[target];
  if (!destFor) throw new Error(`unknown skill target ${JSON.stringify(target)} — use claude, agents or gemini`);
  const hdrs = { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...identityHeaders() };
  let m;
  try {
    // ONE call, and only the CORE. `?sections=` only ever ADDS to the core, so a
    // second call would re-pay the whole core for a section this generator does
    // not render — everything it needs about the on-demand sections (their names,
    // their triggers, their URLs) is already in the core's `sections` index.
    ({ body: m } = await fetchManifestCached(`${base}/api/v1/manifest`, hdrs, manifestCacheKey(base, token)));
  } catch (e) {
    // Keep the server's own verdict verbatim when it gave one — only a genuine
    // network/parse failure gets the "could not read" wrapper.
    throw new Error(/^manifest read failed/.test(e.message) ? e.message : `could not read the manifest: ${e.message}`);
  }

  // AN UNRECOGNIZED `?sections=` NAME IS NEVER AN ERROR ON THE WIRE — it is
  // ignored and echoed here. Silence is how a generated file quietly loses a
  // section, so read it and refuse the install instead.
  const notRecognized = (m.sections && m.sections.not_recognized) || [];
  if (notRecognized.length) {
    throw new Error(`the server did not recognize the manifest section(s) ${notRecognized.join(', ')} — refusing to write a skill built from a request it ignored`);
  }

  // THE GENERATOR'S OWN READS FAIL LOUDLY (never silently default). An absent key
  // does not raise in JavaScript — it reads as "feature off" — and each of these
  // four has a documented silent failure: an empty "How it intrudes" heading, an
  // empty "The contract", a dangling sentence where the exit codes were, and a
  // marker reading `manifest=undefined`, which makes skillIsStale() fall back to
  // 0 and re-install the skill on EVERY command, forever. An old, complete skill
  // beats a fresh, hollow one — so collect them all and write nothing.
  //
  // `agent_sessions.limits` is NOT on this list on purpose: it is read by
  // `pidge terminal connect`, on a different code path, where the correct
  // behaviour for a long-lived client against an unknown server is exactly the
  // DEFAULT_CAPS fallback it already has. Throwing there would break connect
  // against every server older than the deploy that introduced the key.
  const profileTable = (m.profiles && m.profiles.decision_table) || [];
  const notes = m.notes || [];
  const exits = (m.cli && m.cli.output) || '';
  const version = m.manifest_version;
  const missing = [];
  if (!profileTable.length) missing.push('profiles.decision_table');
  if (!notes.length) missing.push('notes');
  if (!exits) missing.push('cli.output');
  if (!version) missing.push('manifest_version');
  if (missing.length) {
    throw new Error(`manifest is missing ${missing.join(', ')} — refusing to write a skill with holes in it`);
  }

  // BRANCH ON THE VERSION, NEVER ON THE PRESENCE OF A KEY. A server older than
  // the sectioned manifest ignores `?sections=` and inlines EVERYTHING, so the
  // sections it documents are its own top-level keys; a sectioned server
  // documents the union of what it served and what its index offers.
  const { documented, sectioned } = serverSections(m);
  const refs = skillReferences({ notes, exits, terminals: announceTerminals() });
  const refCtx = { base, version, documented, sectioned };

  // m.templates.* is deliberately UNREAD — the dead content_template menu must
  // never be reinjected, not even by an old manifest that still serves it.
  const skill = `---
name: pidge
description: Send rich, actionable iPhone notifications to your human and get their decision back (Pidge). Every send is a TYPE (message/important/urgent/event/live) plus an OPTIONAL response (buttons + send-and-go vs wait). Use when finishing long tasks, needing a decision/approval, sending updates with substance, or anything time-anchored. Also covers reading the human's replies back.
# pidge-skill rev=${SKILL_REVISION} manifest=${version}
---

# Pidge — notify your human, get answers back

Generated from manifest v${version} of ${base}. Commands: \`npx pidge-cli …\` (Node ≥18); the key comes from \`~/.config/pidge/env\`, never your context. Not set up, or 2+ agents here? → \`identity\`.

## One breath

Every send is **a TYPE + a markdown body + an OPTIONAL response**. The TYPE (one of five) decides how much it may intrude — the human already configured how each arrives. **There is no content "template" to choose.**

## THE PICKER — situation → exact command

| Your situation | Run |
|---|---|
| Just inform — a result/log, no action needed | \`pidge message\` |
| A pendency they should act on (can wait) ⭐ DEFAULT | \`pidge important\` |
| You need a decision and CAN'T proceed without it | \`pidge important --actions yes,no --wait\` |
| YOU are asking for a formal go/no-go (money/risk) | \`pidge approval\` — a RECIPE: gated Approve/Reject + \`--wait\` baked in; \`--actions\` un-gates it |
| Gate your OWN risky tool behind a human OK (a hook) | \`pidge approve "<question>"\` (exit 0 = allow) |
| A thing with a known TIME | \`pidge event --event-at <ISO8601>\` |
| A live status you'll keep updating | \`pidge live <id> --status "…"\` |
| WAKE them now — rare, real, <1/day | \`pidge urgent\` |
| Waking up where a bridge/daemon may already consume the channel | \`pidge catchup\` first (read-only; NEVER \`listen\`) |

⭐ On the fence between informing and asking, pick \`important\`; \`message\` is only for a true no-action FYI. **Always send a real \`--title\` AND \`--body\`** — the banner is title+body, plain text; \`--body-markdown\` shows only when they tap in. \`pidge <type> --help\` for flags.

## The response axis (composes on ANY type)

- **Buttons** — a BUILT-IN catalog action FIRST; those tap right on the banner: \`--actions yes,no\` · \`approve,reject\` · \`accept,decline\` · \`later\` · \`done\` · \`snooze\` · \`reply\`. \`--custom-action id:label\` and \`--gated\` (Face ID) are **detail-only** — they must open the app. Free text always works too.
- **Typed answer? \`--actions reply\` ALONE** — never a decision + \`reply\` together (they tap the easy button and you get a useless "Yes"; the CLI refuses it, exit 1). **ONE question per send.**
- **send-and-go vs wait** — default: fire and continue, the answer arrives later in \`pidge listen --all\`. \`--wait\` (or \`pidge ask\`) **blocks** until they answer — use it when you can't proceed.

## How it intrudes (profiles the human owns)

${profileTable.map((r) => `- ${r}`).join('\n')}

## Getting the answer

- \`pidge ask …\` blocks, printing \`chosen_action\` JSON · \`pidge wait <cid>\` blocks on a send already made · \`pidge listen --all\` reads the queue (replies + messages) · \`pidge catchup --digest\` reads the thread WITHOUT consuming it.
- **Exit codes:** \`0\` answered · **\`3\` no answer yet → NOT a failure** · \`4\` no healthy round-trip all session — the channel itself looks broken · \`2\` error · \`1\` usage.
- **Ack only AFTER the work is durably done:** \`pidge ack --up-to <id> --summary "<what you did>"\`.

## The version handshake

Every API response carries \`X-Pidge-Manifest-Version\`. **A value above ${version} (the \`manifest=\` in this file's marker) means this skill is out of date** — \`pidge skill install\` regenerates it, and any pidge command does it for you when it notices.

## References — \`references/<name>.md\`, open one ONLY when its trigger fires

${refs.map((r) => `- **${r.name}** — ${r.trigger}`).join('\n')}
- **pidge-report** (a sibling SKILL, not a file) — you are composing a report/update/digest past ~2 lines.

## Full spec

\`curl ${base}/api/v1/manifest -H "Authorization: Bearer $PIDGE_TOKEN"\` — the always-current contract, itself a CORE plus sections on demand: its \`sections\` index names each part and when to read it, and \`?sections=a,b\` adds them in ONE call.

${SKILL_END_MARKER}
`;
  // The companion report skill (see reportSiblingOf above): a sibling file for
  // skill-dir destinations, the same doctrine inlined above the trailer for the
  // single-file targets. It carries the SAME marker line, so the staleness scan
  // and the torn-write check treat it exactly like the main skill.
  const reportSkill = `---
name: pidge-report
description: How to WRITE a report, update or digest that reads well in the Pidge feed on a phone. The pidge skill is the transport (types, buttons, waiting); this is the content contract — conclusion-first, a size budget per report shape, delta-only recurrence, bold/emoji discipline, phone-friendly layout, when a chart image or file attachment beats prose. Read it BEFORE composing any send whose markdown body runs past ~2 lines, and before designing any recurring report.
# pidge-skill rev=${SKILL_REVISION} manifest=${version}
---

# ${REPORT_SKILL_TITLE}

${REPORT_SKILL_BODY}
${SKILL_END_MARKER}
`;
  const file = destFor();
  const reportFile = reportSiblingOf(file);
  const refFiles = refs.map((r) => ({
    file: path.join(path.dirname(file), 'references', `${r.name}.md`),
    content: `# ${r.title}\n\n${r.body}\n${referenceFooter(r, refCtx)}\n${SKILL_END_MARKER}\n`,
  }));
  // A single-file target (AGENTS.md / GEMINI.md) has nowhere to put a reference
  // TREE, so it carries the same doctrine INLINED above the trailer — same rule
  // as the report companion. Zero facts are lost by choosing a target.
  const inlined = refFiles.length
    ? `${refs.map((r) => `# ${r.title}\n\n${r.body}\n${referenceFooter(r, refCtx)}`).join('\n')}\n`
    : '';
  const content = reportFile
    ? skill
    : skill.replace(`${SKILL_END_MARKER}\n`, `${inlined}\n# ${REPORT_SKILL_TITLE}\n\n${REPORT_SKILL_BODY}\n${SKILL_END_MARKER}\n`);
  writeSkillFile(file, content);
  if (reportFile) {
    writeSkillFile(reportFile, reportSkill);
    for (const r of refFiles) writeSkillFile(r.file, r.content, false);
  }
  return {
    file,
    report_file: reportFile,
    reference_files: reportFile ? refFiles.map((r) => r.file) : [],
    manifest_version: version,
  };
}

// Which manifest sections does THIS server document, and which of them are
// served on demand? Branch on the VERSION, never on the presence of a key
// (a v119 server ignores `?sections=` and inlines everything, so its top-level
// keys ARE its sections; a sectioned server documents what it served PLUS
// everything its index offers).
function serverSections(m) {
  const documented = new Set(Object.keys(m || {}));
  const sectioned = new Set();
  if (Number(m && m.manifest_version) >= SECTIONED_MANIFEST_VERSION && m.sections) {
    for (const name of Object.keys(m.sections.available || {})) {
      documented.add(name);
      sectioned.add(name);
    }
    for (const name of m.sections.served || []) {
      documented.add(name);
      sectioned.add(name);
    }
  }
  return { documented, sectioned };
}

// never clobber silently — the installed skill may have been customized.
// When the file being replaced differs from what we're writing, keep the old
// content as <dest>.bak and say so in one stderr line.
// `backup: false` is for the REFERENCE files: they are pure derivatives of the
// core install, rewritten on every heal, and there are a dozen of them — parking
// a timestamped copy of each on every manifest bump would turn a doctrine
// refresh into unbounded litter inside the skill directory. The files a human
// might plausibly have edited (SKILL.md, the report companion, and any
// AGENTS.md/GEMINI.md we take over) keep the backup.
function writeSkillFile(file, content, backup = true) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let previous = null;
  try { previous = fs.readFileSync(file, 'utf8'); } catch { /* no existing file */ }
  if (previous === content) return; // a no-op heal must not churn the mtime either
  if (backup && previous !== null && previous !== content) {
    // NEVER clobber an existing .bak. The FIRST install
    // to a shared target (agents/gemini) parks the user's ORIGINAL file (e.g. their
    // hand-written AGENTS.md) at <dest>.bak; a later re-install whose generated
    // content changed would otherwise overwrite that .bak with our now-stale skill,
    // destroying the only copy of their work.
    //
    // But there are TWO kinds of "previous", and only one of them is irreplaceable.
    // NO pidge marker ⇒ the file is THEIRS and unregenerable, so every one of them
    // survives under a timestamped sibling. A pidge marker ⇒ it is OUR OWN prior
    // output, and one of those is minted on EVERY manifest bump, forever: keeping
    // each turned a routine doctrine refresh into unbounded litter in the user's
    // repo (a single dev checkout accumulated 78 SKILL.md.bak.* and 45
    // AGENTS.md.bak.*). Exactly one of ours is worth keeping — the LAST, the only
    // one that can still hold a hand-edit — so ours roll through a single fixed
    // <dest>.bak.prev once <dest>.bak is occupied. Backups are bounded at two:
    // their original, and our previous. (Date is fine here — the CLI process,
    // not a workflow script.)
    const ours = findSkillMarker(previous) !== '';
    let bak = `${file}.bak`;
    if (fs.existsSync(bak)) bak = ours ? `${file}.bak.prev` : `${file}.bak.${Date.now()}`;
    fs.writeFileSync(bak, previous);
    // Name the ACTUAL destination file, not a hardcoded "SKILL.md"
    // (a --target agents/gemini install writes AGENTS.md/GEMINI.md).
    console.error(`pidge: the previous ${path.basename(file)} differed from the regenerated one — saved to ${bak}`);
  }
  // Sweep the litter older CLIs left on EVERY install (measured: 45 before, 45
  // after, when the sweep only ran inside the "content differed" branch): OUR
  // timestamped backups — a pidge marker inside. The human's own stay.
  let pruned = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(`${path.basename(file)}.bak.`) || !/\.bak\.\d+$/.test(f)) continue;
      const full = path.join(dir, f);
      if (findSkillMarker(fs.readFileSync(full, 'utf8')) !== '') { fs.unlinkSync(full); pruned++; }
    }
  } catch { /* best-effort */ }
  if (pruned) console.error(`pidge: swept ${pruned} old skill backup(s) this CLI had left in ${dir}`);
  // ATOMIC replace — write a per-process tmp, then rename. A killed process or
  // a full disk leaves the OLD skill intact instead of a torn file whose surviving
  // marker reads as "fresh" (the 0.15.2→0.15.3 corruption class, one version on);
  // concurrent heals each rename a WHOLE file (last one wins), never interleaved bytes.
  const tmp = path.join(dir, `.SKILL.md.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw e;
  }
}

(async () => {
  switch (command) {
    case 'setup': {
      await runSetup(); // exits via runDoctor
      break;
    }
    case 'doctor': {
      await runDoctor();
      break;
    }
    case 'presence': { await runPresence(); break; }
    case 'hook': {
      const sub = parsed.positionals[1];
      if (sub === 'install') { console.log(JSON.stringify(installSessionStartHook(), null, 2)); process.exit(0); }
      if (sub === 'uninstall') { console.log(JSON.stringify(uninstallSessionStartHook(), null, 2)); process.exit(0); }
      die('pidge: usage: pidge hook install | uninstall   (a Claude Code SessionStart hook that runs `pidge presence`)', 1);
    }
    case 'whoami': {
      const { res, data } = await fetchWhoami().catch((e) => { die(`pidge: whoami failed (network): ${e.message}`, 2); });
      await checkManifestNews(res);
      if (res.status !== 200) die(`pidge: whoami failed (${res.status}): ${JSON.stringify(data)}`, 2);
      console.log(JSON.stringify(data, null, 2));
      console.error(`pidge: you are canal "${data.channel && data.channel.name}" · ${data.devices ?? '?'} device(s)`);
      // whoami MUST also report HONEST reach + SHOUT on a claim swap,
      // not just doctor — the same shared helpers (deliverable, ANOTHER AGENT…).
      reportDeviceReach(data);
      reportClaimMismatch(data);
      // live consumers + predecessor provenance (present-only).
      reportConsumers(data);
      reportProvenance(data);
      await exitFlushed(0); // the whoami body is on stdout — drain it (gotcha: pipes)
      break;
    }
    case 'skill': {
      if (parsed.positionals[1] !== 'install') die('pidge: usage: pidge skill install [--target claude|agents|gemini]', 1);
      // --target picks the DESTINATION (claude → .claude skill · agents →
      // AGENTS.md · gemini → GEMINI.md); the generated content is identical.
      const target = (v.target || 'claude').trim().toLowerCase();
      if (!SKILL_TARGETS[target])
        die(`pidge: unknown --target ${JSON.stringify(v.target)} — use claude (default), agents or gemini`, 1);
      let r;
      try { r = await installSkill(BASE, TOKEN, target); } catch (e) { die(`pidge: ${e.message}`, 2); }
      const refCount = (r.reference_files || []).length;
      console.error(`pidge: skill written to ${r.file}${r.report_file ? ` + companion ${r.report_file}` : ''}${refCount ? ` + ${refCount} reference files` : ''} (target ${target}, manifest v${r.manifest_version}) — your future sessions in this project know Pidge now`);
      console.log(JSON.stringify({ ok: true, file: r.file, report_file: r.report_file, reference_files: r.reference_files, target, manifest_version: r.manifest_version }));
      process.exit(0);
    }
    // === AXIS 1 — the married catalog of 5. Each stamps the
    // canonical template_kind. AXIS 2 (response) is orthogonal: --actions/
    // --custom-action add buttons, --wait blocks on the answer (else fire-and-
    // forget). notify/send = the deprecated typeless path; ask/approval = the
    // two shortcuts that bundle a type + response. ===
    case 'message':
      await doTypedSend('message', { wait: !!v.wait });
      break;
    case 'important':
      await doTypedSend('important', { wait: !!v.wait });
      break;
    case 'urgent':
      // --escalate ⇒ escalate:true (ask the Urgente profile for an AlarmKit alarm
      // that breaks through silent/Focus; the human's profile still decides).
      await doTypedSend('urgent', { wait: !!v.wait, extra: v.escalate ? { escalate: true } : {} });
      break;
    case 'event': {
      // event needs a TIME — validate locally (ISO8601) so the agent fails fast
      // instead of taking the server's event_at_required 422 round-trip.
      if (v['event-at'] === undefined)
        die('pidge: --event-at required for event. Use ISO8601: --event-at 2026-06-26T14:00-03:00', 1);
      if (Number.isNaN(Date.parse(v['event-at'])))
        die(`pidge: --event-at ${JSON.stringify(v['event-at'])} is not a valid ISO8601 datetime. Use e.g. --event-at 2026-06-26T14:00-03:00`, 1);
      await doTypedSend('event', { wait: !!v.wait });
      break;
    }
    case 'live':
      // the verb drives the REAL /live_activities endpoints now — the
      // old silent degrade (template_kind:live → a message-profile /notify 201
      // with no card) is dead. --wait is refused inside (status never answers).
      await doLive();
      break;
    // --- compat aliases: old type names → the new canonical 5. They
    // map to the new template_kind and still honor --wait/--actions, so scripts
    // and muscle-memory keep working; a one-line note points at the new name.
    case 'fyi':
      warnRenamed('fyi', 'message');
      await doTypedSend('message', { wait: !!v.wait, label: 'fyi' });
      break;
    case 'report':
      warnRenamed('report', 'important');
      await doTypedSend('important', { wait: !!v.wait, label: 'report' });
      break;
    case 'alert':
      warnRenamed('alert', 'urgent');
      await doTypedSend('urgent', { wait: !!v.wait, extra: v.escalate ? { escalate: true } : {}, label: 'alert' });
      break;
    // `approval` = the RECIPE: important + Approve/Reject
    // (Face ID on Approve) + --wait. A shortcut for an explicit go/no-go; the human
    // can override the pair with their own --actions/--custom-action.
    case 'approval': {
      const extra = hasAnswerAffordance() ? {} : { custom_actions: APPROVAL_ACTIONS };
      await doTypedSend('important', { wait: true, extra, label: 'approval' });
      break;
    }
    // — the hook-shaped, deny-default permission gate (allow→0, everything
    // else→non-zero). See doApprove + `pidge approve --help` (PreToolUse example).
    case 'approve': {
      await doApprove();
      break;
    }
    case 'notify':
    case 'send': {
      warnDeprecatedSend(command);
      const { ok, info, raw } = await doNotify();
      console.log(raw);
      if (ok && info.correlation_id)
        console.error(`pidge: correlation_id=${info.correlation_id} (use: pidge wait ${info.correlation_id})`);
      process.exit(ok ? 0 : 2);
      break;
    }
    case 'hello': {
      // — the first-contact WOW: fire the onboarding handshake and block on
      // your human's confirmation. The SERVER narrates a 3-stage Live Activity on
      // the lock screen (Conectando → toque para confirmar → Concluído ✓) so your
      // human SEES the agent→human→agent loop close. One command: send + wait.
      // Run it as your FIRST contact on a fresh channel. A thin wrapper over `ask`:
      // it just pins template=onboarding and friendly default copy.
      if (v.profile === 'tracking')
        die('pidge: `hello --profile tracking` makes no sense — the handshake waits for a confirmation, which tracking (Live-Activity-only) never produces', 1);
      v.template = 'onboarding';
      if (v.title === undefined) v.title = 'Your agent is ready 🐦';
      if (v.body === undefined) v.body = 'Tap Done ✓ to confirm you received me — proves the round-trip works.';
      // validate the knobs BEFORE the send — a typo dies here (exit 1) instead
      // of hanging the handshake forever on a NaN deadline.
      // --timeout defaults to 120 s (was the onboarding template's ~3600 s, which
      // let `hello` pin a fresh session indefinitely — a live agent had to KILL it).
      // The handshake is durable: a missing confirmation is "not yet", never lost.
      const timeoutArg = numStrict(v.timeout, '--timeout', 120);
      const intervalArg = numStrict(v.interval, '--interval', 30);
      const cid = v['correlation-id'] || crypto.randomUUID();
      v['correlation-id'] = cid;
      console.error(`pidge: correlation_id=${cid}`);
      const { ok, info } = await doNotify();
      if (!ok) process.exit(2);
      console.error(`pidge: WOW sent (${info.registered_devices} device(s)) — watch the lock screen narrate the handshake; waiting up to ${timeoutArg}s for your human to confirm on ${cid}`);
      // a timeout exits 3 NARRATED (mirrors the ask/wait contract) — the
      // confirmation is safe in the queue; `pidge listen --all` collects it later.
      await waitForAnswer(cid, {
        timeout: timeoutArg,
        interval: intervalArg,
        // the default print-and-exit-0, plus the stay-online nudge — the
        // handshake closing is EXACTLY when the agent decides what to do next.
        // nudgeStayOnline fetches whoami itself (best-effort, consumer-gated).
        onAnswer: async (chosen) => {
          console.log(JSON.stringify(chosen, null, 2));
          await nudgeStayOnline();
          await exitFlushed(0);
        },
        // The debut goes through the SAME health verdict as wait/listen. Its
        // own exit-3 line bypassed it, so a hello on a channel that never had
        // ONE healthy round-trip — a wrong URL, a dead network, a broken
        // path — reported "your human hasn't tapped yet": the friendliest
        // possible lie, on the first command an agent ever runs. exitTimeout
        // owns the code now (3 = still waiting · 4 = the channel is the
        // problem) and it is async, so it must be awaited.
        onTimeout: async () => {
          await health.exitTimeout(
            `no confirmation on ${cid}`,
            'the handshake is DURABLE: it stays in your queue (at-least-once, nothing lost) — `pidge listen --all` collects the tap whenever it comes. Launch it now — best as a session-length watch (`pidge online --follow --ndjson --timeout 0` under a monitor your harness owns); then `pidge selftest` PROVES you are reachable (it FAILS when nothing is listening) — never claim online from memory.',
          );
        },
      });
      break;
    }
    case 'ask': {
      // `ask` = the preserved shortcut: important + --wait + REQUIRES a way to
      // answer. There is no `ask` TYPE in the married catalog —
      // asking is "a type + buttons + wait". The legacy alias keeps working because
      // it always ships with buttons. `live`/tracking is refused (it never answers).
      await doTypedSend('important', { wait: true, requireAnswerable: true, label: 'ask' });
      break;
    }
    case 'wait': {
      const cid = parsed.positionals[1];
      if (!cid) die('pidge: usage: pidge wait <correlation_id> [--timeout N] [--interval N]', 1);
      // strict — a NaN deadline would make this wait eternal (fail-closed instead)
      await waitForAnswer(cid, { timeout: numStrict(v.timeout, '--timeout', 300), interval: numStrict(v.interval, '--interval', 30) });
      break;
    }
    case 'cancel': {
      // withdraw a still-scheduled notification (also kills a snooze re-fire).
      // Exit 0 cancelled (idempotent) · 2 otherwise (404 unknown, 409 too late).
      const cid = parsed.positionals[1];
      if (!cid) die('pidge: usage: pidge cancel <correlation_id>', 1);
      let res, raw;
      try {
        res = await fetch(`${BASE}/api/v1/notifications/${encodeURIComponent(cid)}`, {
          method: 'DELETE', headers,
        });
        raw = await res.text();
      } catch (e) {
        die(`pidge: cancel failed (network): ${e.message}`, 2);
      }
      await checkManifestNews(res);
      console.log(raw);
      if (res.status >= 200 && res.status < 300) {
        console.error(`pidge: cancelled ${cid} — nothing will fire`);
        process.exit(0);
      }
      console.error(`pidge: cancel failed (${res.status}) — ${res.status === 409 ? 'too late, it already reached the phone' : 'unknown correlation_id?'}`);
      process.exit(2);
      break;
    }
    case 'ack': {
      // read-receipt split: mark messages PROCESSED (green ✓✓) AFTER you've
      // durably handled them — `listen` only DELIVERS them now. --renew
      // (state=delivered) instead RENEWS the visibility-timeout lease, a
      // heartbeat for a long task so the reservation doesn't lapse and re-serve.
      //
      // `--summary` is a global BOOLEAN (for `inbox --summary`), so the
      // module-level parse would read `ack --summary "text"` as boolean-true and
      // drop "text" to an ignored positional — a SILENT no-op on an attribution
      // field. Re-parse THIS command's argv with `summary` typed as a string so
      // the value survives; a bare `--summary` (no value) now THROWS → usage
      // error, never a no-op. Everything else parses identically to the global.
      let av;
      try {
        av = parseArgs({ options: { ...OPTIONS, summary: { type: 'string' } }, allowPositionals: true }).values;
      } catch (e) {
        die(`pidge: ack: ${e.message}\n  usage: pidge ack --up-to <id> | --ids a,b [--renew] [--summary "<what you did>"]`, 1);
      }
      const ackBody = {};
      if (av['up-to'] !== undefined && av.ids !== undefined)
        die('pidge: pass EITHER --up-to <id> OR --ids a,b, not both', 1);
      // strict ids — a lazy parse here silently acks the wrong watermark
      // (and the old .filter(Number.isFinite) silently DROPPED bad ids).
      if (av['up-to'] !== undefined) ackBody.up_to = idStrict(av['up-to'], '--up-to');
      else if (av.ids !== undefined) ackBody.ids = av.ids.split(',').map((s) => idStrict(s, '--ids'));
      else die('pidge: usage: pidge ack --up-to <id> | --ids a,b [--renew] [--summary "<what you did>"]', 1);
      if (av.renew) ackBody.state = 'delivered';
      // attribution — the successor session sees WHAT this handler did
      // (server handler_summary on the history row, shown by `pidge catchup`).
      // A present-but-EMPTY --summary is a usage error, never a silent no-op; the
      // server caps the field, we also send at most 1000 chars.
      if (av.summary !== undefined) {
        const s = String(av.summary).trim();
        if (!s) die('pidge: ack --summary needs a value (e.g. --summary "restarted the worker") — pass text or omit the flag', 1);
        ackBody.summary = s.slice(0, 1000);
      }
      let res, raw;
      try {
        res = await fetch(`${BASE}/api/v1/messages/ack`, { method: 'POST', headers, body: JSON.stringify(ackBody) });
        raw = await res.text();
      } catch (e) {
        die(`pidge: ack failed (network): ${e.message}`, 2);
      }
      await checkManifestNews(res);
      console.log(raw);
      if (!(res.status >= 200 && res.status < 300)) die(`pidge: ack failed (${res.status}): ${raw}`, 2);
      let adata = {};
      try { adata = JSON.parse(raw); } catch { /* leave {} */ }
      // The green line is EARNED: it needs rows actually acked AND a note that
      // says what happened. 0 acked never gets it (nothing turned green), and a
      // note-less ack says what the server will file — "drained" — instead of
      // promising the human a ✓✓ that stands for nothing.
      const ackedN = Number(adata.acked ?? 0);
      if (av.renew) console.error(`pidge: lease renewed on ${adata.renewed ?? 0} message(s) (still yours; ack again when done)`);
      else if (ackedN === 0) console.error('pidge: 0 acked — the server processed NOTHING from this call: no ✓✓ turned green. These rows were already processed, or a sibling is mid-batch below your cursor. Check with `pidge catchup --digest`.');
      else if (ackBody.summary) console.error(`pidge: processed ${ackedN} message(s) with a summary (visible in \`pidge catchup\`) — green ✓✓ (the human sees "lida pelo agente")`);
      else console.error(`pidge: processed ${ackedN} message(s) with NO note — the server files this as DRAINED: \`pidge catchup\` can't say what happened, and to the human that ✓✓ claims work it can't see. Pass --summary "<what you did>" whenever there IS work to name.`);
      // the ack may have annotated messages a PRIOR
      // consumer already acked without a note — narrate it (present-only; a
      // an older server omits `annotated`).
      if (Number(adata.annotated) > 0)
        console.error(`pidge: annotated ${adata.annotated} previously-acked message(s) — filled in the attribution a prior consumer left blank.`);
      // v88 (present-only; older servers omit it): the up_to cursor refused
      // rows it may not finish — a sibling's live in-flight work, or rows never
      // served to any consumer. They are NOT lost: they stay queued and
      // re-serve normally. Seeing this on a solo channel usually means another
      // consumer (a bridge?) is mid-batch below your cursor.
      if (Number(adata.skipped) > 0)
        console.error(`pidge: skipped ${adata.skipped} message(s) below the cursor (a sibling's in-flight work, or never-served rows) — they stay queued and re-serve; ack them by exact ids if they're truly yours.`);
      // The "what next" line, LAST so it reads as the next step. Only a real
      // ack (work done) — a --renew is a mid-task heartbeat, the listener is
      // deliberately NOT running then. The bridge never takes this path (its
      // internal ackBatch above owns that loop), so no suppression needed here.
      //
      // 0.53.3 (the round-3 zero-agent retest): the line carries the server-MEASURED presence,
      // not just advice. The round-3 agent read "Relaunch your listener…",
      // said "Relaunching now", ran nothing, and told its human a listener
      // was live — advice is ignorable, a measured "server sees you: OFFLINE"
      // sitting in its own transcript is a lie it has to author over.
      // Best-effort + read-only (whoami never mints presence; present-only on
      // older servers), and only on this agent-driven path — never the bridge.
      if (!av.renew) {
        let seen = '';
        try {
          const w = await fetchT(`${BASE}/api/v1/whoami`, { headers }, 6000);
          if (w.ok) {
            const wd = await w.json();
            if (wd && wd.listening_state) seen = ` Server-measured presence right now: ${String(wd.listening_state).toUpperCase()}.`;
          }
        } catch { /* best-effort — the line still reads without the probe */ }
        console.error(ackedN > 0
          ? `pidge: ✓ acked.${seen} Relaunch your listener for the next round — or keep a session-length watch up (\`pidge online --follow --ndjson --timeout 0\` under a monitor your harness owns) — then \`pidge selftest\` PROVES it. Never claim online from memory.`
          : `pidge: nothing was acked — but the loop still needs you: relaunch your listener (\`pidge listen --all\`) to stay online.${seen}`);
      }
      await exitFlushed(0); // the server body is on stdout — drain it
      break;
    }
    case 'contract': {
      await runContract();
      break;
    }
    case 'typing': {
      // the three dots on the human's phone while you work on a reply.
      // Ephemeral, advisory, display-only — and self-expiring, so forgetting to
      // turn it off is not a failure mode.
      await runTyping();
      break;
    }
    case 'run': {
      // execution attribution — start/end/status. start exits after printing
      // the eval-friendly export lines; end/status exit inside their handlers.
      await runRunCommand();
      break;
    }
    case 'update': {
      // Self-update. The installed base is the failure mode: `npx pidge-cli`
      // prefers a copy the machine already has, so an onboarded user can sit on
      // a version that predates half the subcommands (measured: 0.28.0 vs the
      // published 0.40.0) and every new flag reads as "unknown option".
      const { runUpdate } = require(path.join(__dirname, '..', 'src', 'update'));
      const r = await runUpdate({ manager: v.manager || undefined });
      process.exit(r.ok ? 0 : 2);
      break;
    }
    case 'terminal': {
      // Agent Sessions / Terminals (pidge repo docs/agent-sessions-spec.md):
      // the unit is a tmux PANE — mirror a Claude session as structured
      // conversation data, or share/spawn a plain terminal pane. connect once
      // per computer, E2E always. Lives in src/terminal/ (its own
      // machine-scoped identity slot, independent of TOKEN above).
      const { runTerminal } = require(path.join(__dirname, '..', 'src', 'terminal', 'commands'));
      // Trailing positionals ride through for the settings verb
      // (`pidge terminal config remote_spawn on`): a capability grant is a
      // decision, and it should read like one.
      await runTerminal(parsed.positionals[1], v, parsed.positionals.slice(2));
      break;
    }
    case 'bridge': {
      // the 1st-class supervisor. `bridge install` writes the launchd/
      // systemd template; bare `bridge --exec` runs the loop (forever — its
      // lifecycle belongs to the OS supervisor / the human, not a timeout).
      const sub = parsed.positionals[1];
      if (sub === 'install') { await runBridgeInstall(); break; }
      if (sub === 'uninstall') { await runBridgeUninstall(); break; }
      if (sub === 'status') { await runBridgeStatus(); break; }
      if (sub !== undefined)
        die("pidge: usage: pidge bridge install [--handler claude|codex|gemini | --exec '<handler>'] [--enable]  |  pidge bridge uninstall  |  pidge bridge status  |  pidge bridge --exec '<handler>' (run the loop here)", 1);
      await runBridge();
      break;
    }
    case 'selftest': {
      // prove reachability by round-trip. Fire a nonce, run the listener,
      // confirm it picks it up + acks in time. PASS exit 0 / FAIL exit 2.
      await doSelftest();
      break;
    }
    case 'inbox': {
      // what this channel sent — the list (default), the pending slice
      // (--pending = delivered + still unanswered) or the one-call summary
      // (--summary = counts + answer latency). stdout = raw server JSON.
      const qs = new URLSearchParams();
      if (v.all) qs.set('all', 'true');
      let inboxPath = '/api/v1/inbox/summary';
      if (!v.summary) {
        inboxPath = '/api/v1/notifications';
        if (v.pending) qs.set('pending', 'true');
        if (v.limit !== undefined) qs.set('limit', v.limit);
      }
      let res, raw;
      try {
        res = await fetch(`${BASE}${inboxPath}${qs.size ? `?${qs}` : ''}`, { headers });
        raw = await res.text();
      } catch (e) {
        die(`pidge: inbox failed (network): ${e.message}`, 2);
      }
      await checkManifestNews(res);
      console.log(raw);
      if (!(res.status >= 200 && res.status < 300)) die(`pidge: inbox failed (${res.status})`, 2);
      let data = {};
      try { data = JSON.parse(raw); } catch { /* leave {} */ }
      if (v.summary) {
        const latency = data.avg_response_seconds != null
          ? `, human answers in ~${Math.round(data.avg_response_seconds / 60)} min` : '';
        console.error(`pidge: ${data.total} sent (${data.scope}) — ${data.pending} pending${latency}`);
      } else {
        const rows = data.notifications || [];
        const pendingCount = rows.filter((r) => r.status === 'delivered' && !r.responded).length;
        console.error(`pidge: ${rows.length} notification(s)${v.pending ? ' pending' : ` — ${pendingCount} pending`} (add --summary for counts+latency)`);
        // E2E: the index is a raw passthrough by design — sealed rows echo YOUR
        // OWN envelopes as stored. Say so instead of letting it read as garbage.
        const sealed = rows.filter((r) => r.enc).length;
        if (sealed)
          console.error(`pidge: ${sealed} of them are E2E-sealed — the index echoes your envelopes as stored (ciphertext); \`pidge wait <cid>\` decrypts an answer, the app shows plaintext`);
      }
      // the whole server body went to stdout above — drain it before exiting
      // (a `--limit 200` inbox is hundreds of KB; a bare exit cuts it at the pipe).
      await exitFlushed(0);
      break;
    }
    case 'catchup': {
      // READ-ONLY situational read. GET /messages?history=true&all=true — the
      // WHOLE thread (server never consumes/stamps delivered/opens a lease on the
      // history read), answers (notification_reply) included. This verb
      // NEVER acks and NEVER holds a lease: it's the safe way to SITUATE yourself at
      // the start of an interactive session on a channel whose real consumer is
      // ANOTHER runtime (a 24/7 bridge/daemon) — you read what's already handled
      // without stealing a message. One consumer per channel: catchup here, and
      // NEVER `listen` (which would double-consume). Exit 0 (printed, even empty) / 2.
      const qs = new URLSearchParams();
      qs.set('history', 'true');
      // --all is default-ON for catchup (the situational read WANTS the answers to
      // earlier notifications, not just composer messages) — always request them.
      qs.set('all', 'true');
      // The server IGNORES `limit` on the ?history=true
      // path (it always returns the whole thread), so --limit must be enforced
      // LOCALLY — a slice of the newest N after the sort below. --before IS honored
      // server-side (older-than paging); we still forward both (harmless if a future
      // server learns limit), but the local slice is the guarantee, not the query.
      let catchupLimit = null;
      if (v.limit !== undefined) {
        catchupLimit = parseInt(v.limit, 10);
        if (!Number.isInteger(catchupLimit) || catchupLimit < 1)
          die(`pidge: --limit must be a positive integer (got ${JSON.stringify(v.limit)})`, 1);
        qs.set('limit', String(catchupLimit));
      }
      if (v.before !== undefined) qs.set('before', v.before);
      // --since <id> — the incremental cursor. STRICT numeric (same class as
      // --up-to/--ids: a lazy parse would silently read the wrong watermark). Forwarded
      // to the server AND enforced locally below, so "since my last session" is
      // O(new) regardless of whether this server paginates history by id.
      let catchupSince = null;
      if (v.since !== undefined) {
        catchupSince = idStrict(v.since, '--since');
        qs.set('since', String(catchupSince));
      }
      // the cursor the LAST catchup left, keyed by CHANNEL (hash(token)) — the
      // same keying the E2E pin uses, so a catchup on channel A never contaminates
      // the --since suggested for channel B from the same config dir. Read BEFORE we
      // overwrite it below; a no-`--since` run suggests it so the agent situates in
      // O(new) next time.
      const channelKey = channelKeyFor(TOKEN);
      const priorCursor = v.since === undefined && channelKey
        ? ((readState().catchupLastSeen || {})[channelKey] || null) : null;
      let res, data;
      try {
        res = await fetchT(`${BASE}/api/v1/messages?${qs}`, { headers });
        data = await res.json().catch(() => ({}));
      } catch (e) {
        die(`pidge: catchup failed (network): ${e.message}`, 2);
      }
      await checkManifestNews(res);
      if (!(res.status >= 200 && res.status < 300))
        die(`pidge: catchup failed (${res.status}): ${JSON.stringify(data)}`, 2);
      // note the flag when the history carries it — the reader is looking
      // at the very rows the warning is about.
      warnStalePriorClaim(data, 'They are included in the thread below — note which predate you before acting on them.');
      // Open sealed rows locally (E2E history is ciphertext on the wire) — same path
      // listen uses; on a channel with no secret / clear rows this is a passthrough.
      const rows = Array.isArray(data.messages) ? data.messages : [];
      // catchup re-runs constantly (the --digest session-start ritual), so
      // don't re-fetch/re-unseal attachments each time. --digest (rarely needs the
      // bytes) OR explicit --no-download ⇒ skip the download; a full catchup reuses
      // a copy already on disk (skip-if-exists) instead of re-downloading.
      const catchupDl = { noDownload: !!(v.digest || v['no-download']), skipIfExists: true };
      const opened = await Promise.all(rows.map((m) => e2eOpenMessageRow(m, catchupDl)));
      // Newest first (the situational read wants the latest context up top); the
      // server orders history this way already, but sort defensively by id desc.
      opened.sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
      // the highest id in the WHOLE thread (before any --since/--limit slice) —
      // the cursor to persist so the NEXT no-`--since` catchup can suggest it.
      const highestId = opened.reduce((mx, m) => Math.max(mx, Number(m.id) || 0), 0);
      // --since <id> filters to STRICTLY newer rows, client-side (belt-and-braces
      // over the server query) — acceptable at the catchup scale (≤200). Applied before
      // --limit, so --limit still means "the newest N of what's new".
      const fresh = catchupSince != null ? opened.filter((m) => (Number(m.id) || 0) > catchupSince) : opened;
      // Enforce --limit locally (server ignores it here) — the
      // newest N after the sort/since-filter.
      const printed = catchupLimit != null ? fresh.slice(0, catchupLimit) : fresh;
      // Voice notes are named AFTER the since/limit slice — narrating a 🎤 for a
      // row this run then filters out would describe something nobody printed.
      annotateVoiceAttachments(printed);
      if (v.digest) {
        // --digest — one condensed line per message. The condensed view for
        // "what happened, who handled what" before offering work; the raw JSON works
        // against that purpose on a long thread.
        for (const m of printed) {
          const kind = m.kind || 'message';
          const body = String(m.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
          // an in-flight lease held by ANOTHER runtime (self-filtered)
          // appends "being handled by X since T" — the sibling took it, don't redo.
          const inflight = beingHandledLine(m);
          const state = inflight ? `${digestHandledState(m)} · ${inflight}` : digestHandledState(m);
          console.log(`${m.id} · ${kind} · ${body} · ${state}`);
        }
      } else {
        console.log(JSON.stringify({ messages: printed }, null, 2));
        // Newer servers: a PROCESSED row carries
        // acked_by_label + handler_summary — narrate WHO already handled it and WHAT
        // they did, so the reader sees the other consumer's work instead of re-offering
        // it (the whole point of catchup). In --digest mode this rides inline instead.
        // Present-only: rows without the fields (never acked, or an older server) skip.
        for (const m of printed) {
          if (m.acked_by_label || m.handler_summary) {
            const who = m.acked_by_label || 'another consumer';
            const what = m.handler_summary ? `: ${String(m.handler_summary)}` : '';
            console.error(`pidge: message ${m.id} handled by ${who}${what}`);
          }
        }
      }
      // remember the highest id seen (per channel) so a later no-`--since` run
      // can suggest the cursor. Best-effort (writeState swallows a read-only fs). Date
      // is fine here — the CLI process, not a workflow script. Only ADVANCE the cursor:
      // a `--before` page (older rows) has a lower highest and must NOT regress it.
      const cursors = readState().catchupLastSeen || {};
      const storedId = (channelKey && cursors[channelKey] && cursors[channelKey].id) || 0;
      if (channelKey && highestId > storedId)
        writeState({ catchupLastSeen: { ...cursors, [channelKey]: { id: highestId, at: new Date().toISOString() } } });
      const replies = printed.filter((m) => m.kind === 'notification_reply').length;
      const clipped = catchupLimit != null && fresh.length > printed.length
        ? ` (newest ${printed.length} of ${fresh.length} — --limit; drop it or raise --before to see more)` : '';
      const sinceNote = catchupSince != null ? ` since id ${catchupSince}` : '';
      console.error(`pidge: catchup — ${printed.length} message(s)${sinceNote} in the thread${clipped}${replies ? ` · ${replies} answer(s) to earlier notifications` : ''}, read-only: NOT consumed, NOT acked. This is a peek; it never steals a message from another consumer.`);
      // The incremental-cursor nudge must ALWAYS surface on stderr — an
      // agent ALWAYS pipes (no TTY), and a repeat situating run must still learn the
      // --since cursor even when the thread hasn't moved. The old gate (only when a
      // prior cursor existed AND the thread moved past it) meant a fresh channel, or a
      // quiet one polled a few times, printed NO tip at all (the observed bug). Now:
      // any no-`--since` run that saw messages prints the cursor on stderr; stdout stays
      // clean (JSON or digest only). It points at the CURRENT highest id — the right
      // cursor for "only what arrives after".
      if (v.since === undefined && highestId > 0) {
        let newerNote = '';
        if (priorCursor && priorCursor.id && highestId > priorCursor.id) {
          const n = opened.filter((m) => (Number(m.id) || 0) > priorCursor.id).length;
          newerNote = ` (${n} new since your last read at id ${priorCursor.id})`;
        }
        console.error(`pidge: cursor — newest message is id ${highestId}${newerNote}. Next session: \`pidge catchup --digest --since ${highestId}\` shows only what arrives after.`);
      }
      // the whole thread went to stdout above — drain it before exiting.
      await exitFlushed(0);
      break;
    }
    case 'online':
      // `pidge online` = `pidge listen --all`, one word — so a pasted prompt can
      // just say "stay online: pidge online". Sugar ONLY: it forces --all (the
      // single ear) and falls through into listen — same loop, same flags, no
      // duplicated implementation.
      v.all = true;
      // fall through
    case 'listen': {
      // block until the human messages this channel (the app's composer),
      // print the messages as JSON, ACK them, exit 0. One-shot by design (loop
      // it, don't daemonize) — same contract as `wait`. Exit 3 on timeout, 4 if
      // the whole session never had a healthy round-trip.
      // At-least-once: the ack happens AFTER the print — a crash re-serves them;
      // dedupe by id if you've seen one before.
      // --all: the SINGLE EAR — the queue also serves notification
      // ANSWERS (kind notification_reply, with a self-contained ref), so a
      // fire-and-forget notify can't lose its reply. Without --all the original
      // composer-only contract stands (no double-consumption for ask/wait users).
      // --exec: ONE round handed to a handler, the bridge's contract without the
      // daemon. It OWNS stdout (the handler's own output is teed through it) and
      // it owns the ack decision, so the three flags that would fight it over
      // either are usage errors — loudly, never a silent precedence rule.
      const execHandler = v.exec || null;
      // strict, and EARLY: a typo here must die before a batch is served and
      // leased — inside the round it left a ~10-min blackout behind.
      if (execHandler) numStrict(v['handler-timeout'], '--handler-timeout', 1800);
      if (execHandler && v['ack-on-read'])
        die('pidge: listen --exec and --ack-on-read contradict each other: --exec acks only when the handler exits 0, --ack-on-read acks on read. Drop one.', 1);
      if (execHandler && v.follow)
        die('pidge: listen --exec runs ONE round (that is the point: the handler\'s exit code is the round\'s verdict). For a permanent loop use `pidge bridge --exec` — or drop --follow and relaunch this command.', 1);
      if (execHandler && v.ndjson)
        die('pidge: listen --exec and --ndjson contradict each other: under --exec the HANDLER owns stdout (its output is teed through). Drop one.', 1);
      // refuse to double-consume a channel another consumer owns (the lock
      // is pid-checked — a stale lock from a crashed consumer never blocks a
      // listen). Local-machine advisory by construction, which is exactly the
      // failure mode it exists for; `catchup` stays the read path.
      let bridgeHolder = bridgeLockHolder();
      if (bridgeHolder && bridgeHolder.kind === 'bridge') {
        // THE HANDOFF: a bridge (the on-call stand-in) yields to an interactive
        // listen — the human's real agent is back at the keyboard. Ask (SIGUSR2,
        // only to a lock that names itself a bridge — an older bridge would read
        // the signal as termination), then wait for the lock to free: a held
        // long-poll releases within ~30 s; a running handler finishes its batch
        // first (the lease would re-serve it otherwise). The bridge takes the
        // channel back when this listen exits.
        const takeoverMs = parseInt(process.env.PIDGE_LISTEN_TAKEOVER_MS || '', 10) || 90000;
        let asked = false;
        try { process.kill(bridgeHolder.pid, 'SIGUSR2'); asked = true; } catch { /* not ours to signal — fall through to the refusal */ }
        if (asked) {
          console.error(`pidge: listen — a bridge holds this channel (pid ${bridgeHolder.pid}${bridgeHolder.label ? `, "${bridgeHolder.label}"` : ''}) — asked it to yield; waiting up to ${Math.round(takeoverMs / 1000)}s (a batch it is mid-handling finishes first). It takes the channel back when this listen exits.`);
          const until = Date.now() + takeoverMs;
          while (bridgeLockHolder() && Date.now() < until) await sleep(500);
          bridgeHolder = bridgeLockHolder();
          if (bridgeHolder) console.error('pidge: listen — the bridge did not yield in time (a long handler run?) — refusing rather than double-consuming; retry in a minute, or read with `pidge catchup`');
          else console.error('pidge: listen — the bridge yielded: this session is the channel\'s consumer now');
        }
      }
      if (bridgeHolder)
        die(`pidge: listen REFUSED — this channel already has a LIVE consumer (pid ${bridgeHolder.pid}${bridgeHolder.label ? `, "${bridgeHolder.label}"` : ''}${bridgeHolder.started_at ? `, since ${bridgeHolder.started_at}` : ''}) — a \`pidge bridge\` or another \`pidge listen\`. One channel = one consumer; a second one double-consumes. Read with \`pidge catchup\` (read-only), or stop that process first. If you are CERTAIN no consumer is running (e.g. the pid belongs to an unrelated process), delete the lockfile yourself: rm "${bridgeLockPath()}"`, 2);
      // …and TAKE the lock for this whole run, so the next consumer meets the
      // same wall (the check above only reads it — the atomic 'wx' create below
      // is what makes "one channel = one consumer" a mechanism instead of a
      // convention). Released on EVERY exit path: the process 'exit' hook covers
      // the one-shot exit, the --follow window, exit 2/3/4 and the orphan
      // watchdog alike. A `--wait`/ask of your own is never refused by it.
      const listenLock = acquireBridgeLock('listen');
      let listenLockReleased = false;
      const releaseListenLock = () => {
        if (listenLockReleased) return;
        listenLockReleased = true;
        releaseBridgeLock(listenLock);
      };
      process.on('exit', releaseListenLock);
      // Ctrl-C / a supervisor's SIGTERM kills Node WITHOUT running the 'exit'
      // hook — so every interrupted listen left a corpse lock behind, and the
      // next one only started because the pid check caught it. Release it for
      // real, and exit on the shell's own convention (128 + signal) so a
      // supervisor can tell an interrupt from an empty round. Nothing in flight
      // is acked: the lease re-serves it.
      // A signal must take the HANDLER down with us: releasing the lock while a
      // child still runs invites the double-consume the lock exists to prevent
      // (relauncher starts a fresh listen; the lease lapses; the SAME batch runs
      // in two handlers). Mirror the bridge: SIGTERM the child, SIGKILL in 5 s,
      // and only then release + exit. No child ⇒ exit immediately as before.
      let execChild = null;
      const listenSignalExit = (sig, code) => {
        console.error(`pidge: listen — ${sig}: stopping. Nothing in flight is acked (the ~10-min lease re-serves it).`);
        if (execChild && execChild.exitCode === null && !execChild.killed) {
          console.error('pidge: listen — a handler is still running: SIGTERM to its whole process group (SIGKILL in 5s), then releasing the lock.');
          killHandlerGroup(execChild, 'SIGTERM');
          // NOT unref'd, deliberately: an unref'd escalation let the process
          // exit before the 5 s ever elapsed, so the SIGKILL that was supposed
          // to end a handler ignoring SIGTERM never fired at all. This timer's
          // whole job is to OUTLIVE the wait.
          const hard = setTimeout(() => killHandlerGroup(execChild, 'SIGKILL'), 5000);
          const bail = setTimeout(() => { releaseListenLock(); process.exit(code); }, 7000);
          execChild.once('exit', () => {
            clearTimeout(hard); clearTimeout(bail);
            releaseListenLock(); process.exit(code);
          });
          return;
        }
        releaseListenLock();
        process.exit(code);
      };
      process.on('SIGINT', () => listenSignalExit('SIGINT', 130));
      process.on('SIGTERM', () => listenSignalExit('SIGTERM', 143));
      installOrphanWatchdog(); // a killed-parent orphan exits instead of eating the queue
      // strict — same class as wait/ask/approve: a NaN deadline never ends
      const timeout = numStrict(v.timeout, '--timeout', 600);
      const listenInterval = numStrict(v.interval, '--interval', 5);
      const listenStartedAt = Date.now();
      // --follow --timeout 0: NO deadline — the session-length watch (a harness
      // that streams this process's stdout lines to the agent as events, e.g.
      // Claude Code's Monitor, owns its lifetime). Without --follow, 0 keeps its
      // old meaning (an immediate empty round).
      const followForever = v.follow && timeout === 0;
      // The forever watch is only honest where the HARNESS wakes the agent on
      // this process's stdout after the turn ends (Claude Code's Monitor sets
      // CLAUDECODE in the shell). Measured on Codex: the same command in its
      // "background terminal" kept the server green — a live long-poll — while
      // NOBODY read the queue: a deaf consumer, the one state worse than
      // offline. Elsewhere the honest shape is one FOREGROUND round per turn.
      if (followForever && !process.env.CLAUDECODE && process.env.PIDGE_EVENT_STREAM !== '1')
        die('pidge: online --follow --timeout 0 is the session-length watch for a harness that WAKES you on this process\'s stdout after your turn ends (Claude Code: Monitor({…, persistent:true})). This shell is not Claude Code, so a background run here would be a DEAF consumer — green for the server, silent for your human. Run ONE round in the FOREGROUND of your turn instead: `pidge online` (blocks until a message, up to --timeout, default 600 s), handle it, relaunch while you have nothing else — and between turns you are offline; say so. A harness that really streams stdout events to you can set PIDGE_EVENT_STREAM=1.', 1);
      let deadline = followForever ? Date.now() + 10 * 365 * 86400 * 1000 : Date.now() + timeout * 1000;
      const queueQs = (() => {
        // continuity=true asks the server for the thread it already holds
        // (gotcha #51 — read-only provenance). Old server ignores it ⇒ unchanged.
        const q = new URLSearchParams({ continuity: 'true' });
        if (v.all) q.set('all', 'true');
        return `?${q}`;
      })();
      // the exit-3 hint — a message you EXPECT may be under a visibility lease
      // from another read (a selftest, a crashed listener, a bridge), invisible to
      // this listen until it lapses. `pidge catchup` shows the whole queue read-only.
      const LEASE_HINT = 'if you expected a message, it may be under a visibility lease from another read (a selftest / crashed listener / bridge) — `pidge catchup` shows the whole queue read-only (delivered_at/lease), never consuming.';
      // the exit-3 companion: the RELAUNCH reflex. A one-shot listener that
      // isn't relaunched is an agent that quietly went offline — say so every
      // empty round. Suppressed under --follow (a supervisor window ending is
      // its own contract, not a lapse in the loop).
      const RELAUNCH_NUDGE = v.follow ? null : 'Nothing arrived this round. Relaunch the listener now — the loop (listen → handle → ack → relaunch) is what keeps you online. Unsure your loop is real? `pidge selftest` proves it (FAILS when nothing is listening).';
      // The FIRST batch that comes back QUICKLY was already sitting in
      // the queue when this listen started — with --all that includes answers to
      // EARLIER notifications, which read as "new" if we don't say otherwise. A
      // batch that arrives after a real hold (a long-poll that waited) is fresh.
      const BACKLOG_WINDOW_MS = 5000;
      let firstBatch = true;
      // --follow is SUPERVISOR-ONLY — warn LOUDLY at startup. A turn-based
      // agent that uses it traps its turn (the process keeps listening); the
      // default one-shot, looped from the supervisor, is what almost everyone wants.
      // The session-length watch (--timeout 0 under a harness that streams
      // stdout) IS the blessed shape — never scold it (measured: the warning
      // fired on every boot of the recommended invocation).
      if (v.follow && !followForever) {
        console.error('pidge: --follow keeps this process listening until --timeout (supervisor mode).');
        console.error('pidge: a TURN-BASED agent must NOT use --follow — it traps the turn. Use the');
        console.error('pidge: default one-shot (loop the command from your supervisor) instead.');
      }
      // --follow: print+ack a batch and KEEP listening until the
      // timeout — the supervisor loop without re-spawning a process per batch.
      let gotAny = false;
      const followEnd = async () => {
        if (v.follow && gotAny) {
          console.error(`pidge: --follow window ended after ${timeout}s — batches were delivered`);
          // batches were printed during this window: drain stdout before exiting
          // (the last one is still queued for a slow reader). Callers must await.
          await exitFlushed(0);
        }
        return false;
      };

      // read-receipt split: by DEFAULT a read message is DELIVERED (gray
      // ✓✓), NOT consumed — the agent ACKS after the work (`pidge ack`), and a
      // ~10-min server lease re-serves un-acked messages so a crash never loses
      // one. --ack-on-read restores the pre-0.9 immediate-consume.
      const ackOnRead = v['ack-on-read'];
      // Per-INSTALL notice (stamp file) + an in-process guard so a --follow run
      // doesn't repeat it across batches before the stamp write is observed.
      let ackNoticeShownThisProcess = false;
      // The `pidge typing` nudge, at most once per process (see printAndAck).
      let typingNudgeShown = false;
      // The continuity contexts of the CURRENT round, opened once by
      // openContinuity below: printed as their own stdout lines in the read
      // modes, handed to the handler as `batch.continuity` under --exec.
      let roundContinuity = null;
      // Gate hygiene, the SAME rule the bridge applies (siftGatedReplies): a
      // Face-ID gate answer is acked here and never surfaced as a row. The watch
      // is younger than the bridge and never got the rule ported — so a gated
      // money/deletion decision reached the agent as if it were a fresh command,
      // and a consumer had to hand-write its own guard against acting twice.
      // Applied to EVERY round (WS drain and poll alike) BEFORE the "did we get
      // anything?" check: a round of nothing-but-gate-answers is an EMPTY round —
      // it prints nothing, exits nothing, and keeps listening.
      const siftGated = (rows) => siftGatedReplies('listen', rows, {
        what: execHandler ? 'spawning a handler' : 'surfacing them as fresh rows',
        runToken: process.env.PIDGE_RUN_TOKEN || null,
      });
      // Print + (conditionally) ack — shared by the WS and polling paths.
      const printAndAck = async (msgsRaw) => {
        // E2E: open sealed rows BEFORE anything prints (stdout JSON and the
        // stderr narration below both read the decrypted values — a row we
        // can't open is blanked with a precise e2e_error, never base64).
        // async now — a sealed attachment is downloaded + unsealed to a
        // local path here (attachment.path in the printed JSON).
        const msgs = annotateVoiceAttachments(await Promise.all(msgsRaw.map((m) => e2eOpenMessageRow(m))));
        // --exec: the round is the HANDLER's, and so is stdout. runExecRound
        // never returns — it acks + exits 0, or prints handler_failed and exits 2.
        if (execHandler) return runExecRound(msgs);
        if (v.ndjson) {
          // One compact object per line, each stamped `type` mirroring `kind`
          // ("message" | "notification_reply"), the whole row preserved — so a
          // line-oriented consumer switches on ONE field and never on position.
          // The trailing batch_end closes the round: it says how many rows came
          // and the highest ACKABLE id (absent when nothing was ackable).
          for (const m of msgs) console.log(JSON.stringify({ type: String(m.kind || 'message'), ...m }));
          const ackable = msgs.map((m) => Number(m.id)).filter(Number.isInteger);
          console.log(JSON.stringify({
            type: 'batch_end', count: msgs.length,
            ...(ackable.length ? { max_ackable_id: Math.max(...ackable) } : {}),
          }));
        } else {
          console.log(JSON.stringify(msgs, null, 2));
        }
        // Heads-up on ORPHANED backlog served on the first quick read
        // (--all only). It's within-channel — NOT the cross-channel leak.
        if (v.all && firstBatch && (Date.now() - listenStartedAt) < BACKLOG_WINDOW_MS) {
          const replies = msgs.filter((m) => m.kind === 'notification_reply').length;
          const detail = replies ? ` (${replies} of them are answers to EARLIER notifications)` : '';
          console.error(`pidge: --all — ${msgs.length} message(s) were ALREADY queued when this listen started${detail}: OLD backlog (sent while you weren't listening), NOT fresh arrivals. This is your OWN channel's backlog, not a cross-channel leak.`);
        }
        firstBatch = false;
        // narrate answers so the agent knows WHICH notification spoke back.
        for (const m of msgs) {
          if (m.kind === 'notification_reply' && m.ref) {
            const said = m.text ? `: ${String(m.text).slice(0, 120)}` : '';
            console.error(`pidge: reply to your notification ${m.ref.correlation_id} ("${m.ref.title}") — ${m.action_id || m.ref.event_kind}${said}`);
            if (m.truncated) console.error('pidge: that reply hit the server cap (truncated:true) — tell your human the tail was lost');
          }
        }
        // The exact instant an INTERACTIVE agent should raise the three dots:
        // a human's message was just handed to it, and whatever it does next
        // happens while their screen shows nothing. (`--exec` never reaches
        // here — it returned above, and it fires the signal itself.) Gated on a
        // real composer message: an answer to a question you asked, or a
        // selftest nonce, is not a message you are about to reply to. Once per
        // process, so a --follow window nudges instead of nagging.
        if (!typingNudgeShown && msgs.some((m) => !m.kind || m.kind === 'message')) {
          typingNudgeShown = true;
          console.error('pidge: working on it for more than ~15 s before you answer? Run `pidge typing` first — the human sees the three dots instead of silence (it self-expires, and your reply clears it).');
        }
        const upTo = Math.max(...msgs.map((m) => m.id));
        if (ackOnRead) {
          try {
            // fetchT, not fetch: a wedged proxy stalling this ack would otherwise
            // pin the process forever (the WS drain path awaits printAndAck's exit
            // with no deadline) — messages are already printed, so a timeout here
            // just re-serves them next listen (at-least-once).
            const ack = await fetchT(`${BASE}/api/v1/messages/ack`, {
              method: 'POST', headers, body: JSON.stringify({ up_to: upTo }),
            });
            if (ack.status >= 200 && ack.status < 300) {
              // Read the BODY, exactly as the hand `ack` path does: a 2xx is
              // "the server heard me", not "the rows are done". up_to can ack
              // ZERO (a sibling mid-batch below the cursor, rows already
              // processed) and the old line still announced the whole batch as
              // consumed — the one number that decides whether they come back.
              const adata = await ack.json().catch(() => ({}));
              const acked = Number(adata.acked);
              const n = Number.isFinite(acked) ? acked : msgs.length;
              if (Number.isFinite(acked) && acked === 0)
                console.error(`pidge: --ack-on-read: the server acked 0 of ${msgs.length} message(s) — nothing was consumed and they WILL re-serve (already processed, or a sibling holds them). You have them printed above either way — dedupe by id.`);
              else
                console.error(`pidge: ${n} message(s) — acked on read (--ack-on-read); answer via notify, reuse thread_id when present`);
              if (Number(adata.skipped) > 0)
                console.error(`pidge: --ack-on-read: ${adata.skipped} message(s) below the cursor were SKIPPED (a sibling's in-flight work, or never-served rows) — they stay queued and re-serve.`);
            } else {
              console.error(`pidge: WARNING — ack failed (${ack.status}); these messages will be re-served next listen`);
            }
          } catch (e) {
            console.error(`pidge: WARNING — ack failed (network: ${e.message}); these messages will be re-served next listen`);
          }
        } else if (!ackNoticeShownThisProcess && !ackNoticeAlreadySeen()) {
          ackNoticeShownThisProcess = true;
          markAckNoticeSeen(); // once per install (stamp); a fresh per-turn process won't re-shout
          // The version-gated BREAKING flip — LOUD on stderr the first time.
          console.error(`pidge: NEW in 0.9.x — ${msgs.length} message(s) DELIVERED (gray ✓✓), NOT done. ACK AFTER you handle them: \`pidge ack --up-to ${upTo}\` (a ~10-min lease re-serves un-acked messages, so a crash between "I have it" and "I'm done" never loses one). Use --ack-on-read for the old immediate-consume.`);
        }
        gotAny = true;
        // The whole batch (a --ndjson round, or the pretty JSON array with its
        // opened attachments) is on stdout — drain the pipe BEFORE exiting, or a
        // consumer reading this process's output through a subprocess gets it cut
        // at the pipe buffer. `await`/`return`, never a bare call: the --follow
        // line below must not print on a round that is exiting (see exitFlushed).
        if (!v.follow) return exitFlushed(0);
        console.error('pidge: --follow — still listening');
      };

      // gotcha #51: continuity contexts are the thread Pidge ALREADY holds, handed
      // to a cold session as READ-ONLY provenance — NOT messages (nothing here is
      // ackable/consumable) and prior-run statements arrive labeled UNVERIFIED
      // (epistemic_status/note preserved). Each context prints as its OWN stdout
      // line stamped type:"continuity_context"; the human/agent consumer decides
      // what to do. MUST run before printAndAck (that exits the process on a
      // one-shot). Absent ⇒ nothing prints — output byte-identical to before.
      // Under --exec nothing is printed: the same contexts ride the batch the
      // handler reads on stdin (`continuity`), exactly as the bridge sends them.
      const printContinuity = async (data) => {
        const opened = await e2eOpenContinuityContexts(data && data.continuity_contexts);
        roundContinuity = opened || null;
        if (!opened || execHandler) return;
        for (const ctx of opened) console.log(JSON.stringify({ type: 'continuity_context', ...ctx }));
      };

      // --exec — ONE round, handled by the agent's own command, on the bridge's
      // exact contract: the batch on stdin ({messages, continuity?}), ONE
      // invocation, and THE HANDLER'S EXIT CODE decides the ack. Never returns.
      //   exit 0            → ack the batch's EXACT ids (never an up_to watermark)
      //                       carrying the handler's `pidge-summary:` line, if any
      //                       (no marker ⇒ acked without one — never invented) → exit 0
      //   anything else     → ack NOTHING (the ~10-min lease re-serves it) and emit
      //                       the failure ON STDOUT, where the agent wakes up:
      //                       {"type":"handler_failed","exit":N,"reason":…,"ids":[…]}
      //                       + a human line on stderr → exit 2
      //   exit 0 but the ACK failed → {"type":"ack_failed","ids":[…]} on stdout,
      //                       same channel, → exit 2. The work HAPPENED and the
      //                       server doesn't know it: the batch re-serves and the
      //                       handler runs again. Exiting 0 there (the old
      //                       behavior — the ack's return value was discarded)
      //                       reported a green round over a queue that still
      //                       holds the work.
      // A round that found nothing never gets here: no handler is spawned and the
      // empty-round exit 3 stands.
      const runExecRound = async (msgs) => {
        const batchIds = msgs.map((m) => Number(m.id)).filter(Number.isInteger);
        const batch = { messages: msgs, ...(roundContinuity ? { continuity: roundContinuity } : {}) };
        const handlerTimeoutS = numStrict(v['handler-timeout'], '--handler-timeout', 1800);
        console.error(`pidge: listen — batch of ${msgs.length} message(s) → handler (its exit code decides the ack): ${execHandler}`);
        const { outcome, summary, seconds, teeMidLine } = await runHandlerOnce({
          tag: 'listen',
          handlerCmd: execHandler,
          batch,
          batchIds,
          onSpawn: (child) => { execChild = child; },
          onSettle: () => { execChild = null; },
          handlerTimeoutS,
          narrateMs: parseInt(process.env.PIDGE_BRIDGE_NARRATE || '', 10) || 300000, // 5 min
          renewMs: parseInt(process.env.PIDGE_BRIDGE_RENEW || '', 10) || 60000,      // 60 s
        });
        // Every machine line below goes out through this: a handler that ended
        // its output mid-line would otherwise have our JSON glued to its tail.
        const machineLine = (obj) => {
          if (teeMidLine) process.stdout.write('\n');
          console.log(JSON.stringify(obj));
        };
        // A timed-out handler NEVER acks — even if it trapped SIGTERM and exited
        // 0: its work was cut short by definition.
        if (outcome.code === 0 && !outcome.timedOut) {
          if (batchIds.length === 0) {
            console.error('pidge: listen — WARNING: the batch had no numeric ids — nothing to ack (server bug?)');
          } else {
            const acked = await ackExactIds('listen', batchIds, summary, process.env.PIDGE_RUN_TOKEN || null);
            if (!acked) {
              // The handler SUCCEEDED and the ack didn't: the work is done but
              // the server still holds the batch, so it re-serves and the
              // handler sees it again. Say it on stdout — the wake-up channel —
              // and exit 2: a round that ends with the queue unchanged is not a
              // green one, whatever the handler thought.
              machineLine({ type: 'ack_failed', ids: batchIds });
              console.error(`pidge: listen — the handler exited 0 but the ACK did NOT land: the work happened and the server doesn't know it. The batch re-serves after the lease and your handler will see it AGAIN — make it idempotent, and ack by hand if it must not repeat: \`pidge ack --ids ${batchIds.join(',')} --summary "<what you did>"\`.`);
              await exitFlushed(2);
            }
            if (!summary)
              console.error('pidge: listen — the handler printed no `pidge-summary:` line, so the ack carries no note (never invented). Have it end with: echo "pidge-summary: <what you did>"');
          }
          // the handler's whole stdout was TEED through ours — drain it (a long
          // handler transcript is exactly the body a bare exit would cut).
          await exitFlushed(0);
        }
        const reason = outcome.error ? 'spawn_error'
          : outcome.timedOut ? 'timeout'
            : outcome.signal ? 'signal' : 'exit';
        const why = outcome.error ? `couldn't run (${outcome.error})`
          : outcome.timedOut ? `timed out (--handler-timeout ${handlerTimeoutS}s)`
            : outcome.signal ? `killed by ${outcome.signal}` : `exit ${outcome.code}`;
        // STDOUT, deliberately: a failure the agent can't see is a failure that
        // becomes a false green. Compact, one line, its own `type`.
        machineLine({
          type: 'handler_failed', exit: outcome.code ?? null, reason,
          ...(outcome.signal ? { signal: outcome.signal } : {}),
          ids: batchIds,
        });
        console.error(`pidge: listen — handler ${why} after ${seconds}s — NOTHING acked: the ~10-min lease re-serves these message(s) (ids ${batchIds.join(', ') || 'none'}). Fix the handler (or handle the batch yourself) and relaunch; at-least-once means it will come back.`);
        await exitFlushed(2); // the teed handler output + this verdict line are on stdout
      };

      // Realtime path: hold ConversationChannel — the human sees "ouvindo
      // agora" — and treat frames as wake-ups: the BACKLOG is always re-read over
      // a plain GET (at-least-once; also catches messages sent while offline).
      if (wantRealtime()) {
        let draining = false;
        const drain = async (finish) => {
          if (draining) return;
          draining = true;
          try {
            const res = await fetchT(`${BASE}/api/v1/messages${queueQs}`, { headers });
            await checkManifestNews(res);
            if (res.status === 200) {
              health.ok();
              const data = await res.json().catch(() => ({}));
              warnStalePriorClaim(data); // session-header warning, once
              warnConsumerConflict(data); // the consume GET flags a live sibling
              const msgs = await siftGated(data.messages || []);
              await printContinuity(data); // read-only provenance, before the exiting printAndAck
              if (msgs.length) {
                if (!v.follow) finish('got-messages');
                await printAndAck(msgs);
              }
            } else if (res.status === 401 || res.status === 403) {
              dieKeyRejected('listen', res.status); // the WS drain hits the same wall
            } else {
              health.fail(`backlog read ${res.status}`);
            }
          } catch (e) {
            health.fail(`backlog read (network: ${e.message})`);
          } finally {
            draining = false;
          }
        };
        let announced = false;
        const sessions = [cableSession({
          channel: 'ConversationChannel',
          params: wsIdentityParams(),
          deadline,
          onUp: (finish) => {
            if (!announced) { announced = true; console.error(`pidge: listening over the realtime socket${v.all ? ' — single ear: composer + notification answers' : ''} (the human sees "ouvindo agora")`); }
            drain(finish);
          },
          onFrame: (m, finish) => { if (m.type === 'message') drain(finish); },
        })];
        // --all: answers broadcast on InboxChannel, not Conversation — a
        // second subscription wakes the same HTTP drain (the queue is the ledger;
        // the loser session leaks until exit, harmless in a one-shot process).
        if (v.all) {
          sessions.push(cableSession({
            channel: 'InboxChannel',
            params: wsIdentityParams(),
            deadline,
            onUp: (finish) => drain(finish),
            onFrame: (m, finish) => { if (m.type === 'event' && m.responded) drain(finish); },
          }));
        }
        const outcome = await Promise.race(sessions);
        // Only a GENUINE deadline exits; an early/spurious 'deadline' or
        // 'ws-unavailable' degrades to polling below (never an early timeout lie).
        if (outcome === 'deadline' && Date.now() >= deadline - 1500) {
          await followEnd();
          await health.exitTimeout('no message from the human', LEASE_HINT, RELAUNCH_NUDGE);
        }
        if (outcome === 'got-messages') {
          await new Promise(() => {}); // printAndAck is in flight and exits the process
        }
        console.error(`pidge: realtime unavailable (${outcome}) — falling back to HTTP polling for the rest of this round (same contract, less instant); the socket is tried again on the next round`);
      }

      for (;;) {
        const waitS = health.degraded ? 0 : Math.max(0, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)));
        const askedAt = Date.now();
        try {
          const qs = new URLSearchParams();
          if (waitS > 0) qs.set('wait', String(waitS));
          if (v.all) qs.set('all', 'true');
          qs.set('continuity', 'true'); // gotcha #51 — ask for held thread; old server ignores it
          const res = await fetchT(`${BASE}/api/v1/messages${qs.size ? `?${qs}` : ''}`, { headers }, (waitS + 10) * 1000);
          await checkManifestNews(res);
          if (res.status === 200) {
            health.ok();
            const data = await res.json().catch(() => ({}));
            warnStalePriorClaim(data); // session-header warning, once
            warnConsumerConflict(data); // the consume GET flags a live sibling
            const msgs = await siftGated(data.messages || []);
            await printContinuity(data); // read-only provenance, before the exiting printAndAck
            if (msgs.length) await printAndAck(msgs);
          } else if (res.status === 401 || res.status === 403) {
            dieKeyRejected('listen', res.status); // a wall, not a timeout — never health.ok()
          } else if (res.status >= 500) {
            health.fail(`listen error ${res.status}`); // aggregated — no line per attempt
          } else {
            // Any other 4xx: answered, but not the round-trip this loop proves.
            // Never ok() — that latch is what made a broken read read "healthy".
            health.fail(`listen error ${res.status}`);
            console.error(`pidge: listen error ${res.status}`);
          }
        } catch (e) {
          health.fail(`network: ${e.message}`);
        }
        if (Date.now() >= deadline) {
          await followEnd();
          await health.exitTimeout('no message from the human', LEASE_HINT, RELAUNCH_NUDGE);
        }
        const pace = health.degraded ? DEGRADED_INTERVAL_S : listenInterval;
        if (Date.now() - askedAt < 2000) {
          await sleep(Math.min(pace, Math.max(1, Math.ceil((deadline - Date.now()) / 1000))) * 1000);
        }
      }
      break;
    }
    default:
      // Name the bad command and point at the married catalog + the two response
      // shortcuts (a friendlier landing than dumping the whole USAGE on a typo).
      die(`pidge: unknown subcommand '${command}'. Types: message · important · urgent · event · live (response: --actions/--wait, or the ask/approval shortcuts). pidge --help`, 1);
  }
})();
