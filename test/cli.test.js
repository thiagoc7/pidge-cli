'use strict';
// Acceptance tests for the resilience ladder + the realtime client.
// Includes the two criteria from the original field bug report:
//   1. ?wait= behind a proxy with a short response-timeout must not leave the
//      CLI deaf — it degrades to plain GETs and keeps the channel alive;
//   2. an hours-long `listen` must survive a server deploy/restart (the WS
//      reconnects; messages sent while offline are drained over HTTP).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn: rawSpawn } = require('node:child_process');
const { track } = require('./spawn-tracker');
// Own process group per child + group-kill when the file's tests end — a
// straggler (grand)child must never hold this process's event loop open.
const spawn = (cmd, args, opts = {}) => track(rawSpawn(cmd, args, { ...opts, detached: true }));
const { createMock } = require('./mock-server');

const CLI = path.join(__dirname, '..', 'bin', 'pidge.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runCli(args, port, env = {}, cwd = undefined) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd, // setup's skill fuse writes .claude/skills/pidge into cwd — point it at a tmp dir
    env: {
      ...process.env,
      PIDGE_URL: `http://127.0.0.1:${port}`,
      PIDGE_TOKEN: 'hld_test',
      PIDGE_DEGRADED_INTERVAL: '1', // keep the degraded pace test-fast
      // Isolate per spawn: state.json (manifest nag, e2e pins) must never
      // touch the REAL ~/.config/pidge — nor leak between tests.
      XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-test-')),
      // os.homedir() drives the HOME skill self-heal candidate — isolate it
      // too, so no test ever regenerates the developer's REAL ~/.claude/skills/pidge.
      // A test that exercises the home heal passes its own HOME via `env`.
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-home-')),
      ...env,
    },
  });
  const result = new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, result };
}

// Exercise the real subscription function with a fake socket and clock. No
// process startup or real 30-second waits are needed to inspect the wire beats.
function subscriptionHarness(channel) {
  const source = require('node:fs').readFileSync(CLI, 'utf8');
  const start = source.indexOf('function cableSubscribe(');
  const end = source.indexOf('\n// Run one WS subscription session', start);
  assert.ok(start >= 0 && end > start);
  let now = 0;
  let socket;
  const timers = new Map();
  const down = [];
  const frames = [];
  let up = 0;
  class Socket {
    constructor() { socket = this; this.readyState = 1; this.sent = []; }
    send(frame) { this.sent.push(JSON.parse(frame)); }
    close() { this.readyState = 3; }
    receive(frame) { this.onmessage({ data: JSON.stringify(frame) }); }
  }
  const context = require('node:vm').createContext({
    WebSocket: Socket, Date: { now: () => now },
    setInterval(fn, interval) {
      const timer = { fn, interval, next: now + interval, unref() {} };
      timers.set(timer, timer); return timer;
    },
    clearInterval(timer) { timers.delete(timer); },
  });
  const subscribe = require('node:vm').runInContext(source.slice(start, end) + '\ncableSubscribe', context);
  const subscription = subscribe({ channel, base: 'http://localhost', token: 'test',
    onUp: () => up++, onFrame: (frame) => frames.push(frame), onDown: (why) => down.push(why) });
  const tick = (ms) => {
    const target = now + ms;
    for (;;) {
      const timer = [...timers.values()].filter((t) => t.next <= target).sort((a, b) => a.next - b.next)[0];
      if (!timer) break;
      now = timer.next; timer.next += timer.interval; timer.fn();
    }
    now = target;
  };
  socket.onopen();
  const identifier = socket.sent[0].identifier;
  return { socket, subscription, tick, timers, down, frames, identifier, get up() { return up; } };
}

for (const channel of ['ConversationChannel', 'InboxChannel']) {
  test(`cable presence beats: ${channel} preserves transport liveness and frame delivery`, () => {
    const h = subscriptionHarness(channel);
    assert.equal(JSON.parse(h.identifier).channel, channel);
    // Pings before confirmation do not start application beats.
    for (let i = 0; i < 6; i++) { h.socket.receive({ type: 'ping' }); h.tick(5000); }
    assert.equal(h.socket.sent.length, 1);
    h.socket.receive({ type: 'confirm_subscription', identifier: h.identifier });
    h.socket.receive({ type: 'confirm_subscription', identifier: h.identifier });
    assert.equal(h.up, 2);
    for (let i = 0; i < 12; i++) { h.socket.receive({ type: 'ping' }); h.tick(5000); }
    const beats = h.socket.sent.filter((f) => f.command === 'message');
    assert.equal(beats.length, channel === 'ConversationChannel' ? 2 : 0,
      'only ConversationChannel renews presence, with no duplicate timer on reconfirm');
    for (const beat of beats) {
      assert.equal(beat.identifier, h.identifier);
      assert.deepEqual(JSON.parse(beat.data), { action: 'beat' });
    }
    h.socket.receive({ identifier: h.identifier, message: { type: 'message', id: 7 } });
    assert.equal(h.frames.length, 1);
    assert.equal(h.frames[0].id, 7);
    assert.equal(h.down.length, 0);
    h.tick(20000); // Neither subscription can survive a silent transport.
    assert.deepEqual(h.down, ['heartbeat lost (server gone?)']);
    assert.equal(h.socket.readyState, 3);
    assert.equal(h.timers.size, 0);
  });

  test(`cable close: ${channel} cancels all timers without reporting a failure`, () => {
    const h = subscriptionHarness(channel);
    h.socket.receive({ type: 'confirm_subscription', identifier: h.identifier });
    h.subscription.close();
    h.tick(60000);
    assert.equal(h.timers.size, 0);
    assert.equal(h.socket.sent.length, 1);
    assert.equal(h.down.length, 0);
  });
}

test('field report — wait= dying behind the edge (502): degrade to plain GETs, stay alive, deliver', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.waitMode = '502'; // every HELD poll dies; plain GETs are fine
  mock.state.messages = [{ id: 7, channel_id: 1, body: 'oi agente', created_at: 'x', consumed_at: null }];

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '30', '--interval', '1'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `expected delivery, got ${code}; stderr: ${stderr}`);
  assert.match(stdout, /oi agente/);
  assert.match(stderr, /degraded to plain GETs/);
});

test('field report — a proxy DESTROYING held sockets degrades the same way (wait command)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.waitMode = 'destroy';
  mock.state.notifications['cid-9'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'yes', label: 'Sim', text: null },
  };

  const { result } = runCli(['wait', 'cid-9', '--no-realtime', '--timeout', '30', '--interval', '1'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /"action_id": "yes"/);
  assert.match(stderr, /degraded to plain GETs/);
});

// The exit-4 contract is now CROSS-ROUND (the recommended loop is one round per
// process, so a single dead 50 s window is a blip, not a verdict): a dead round
// writes a streak file keyed by the token hash; exit 4 needs 3 dead rounds over
// 2+ min, and the verdict names the right culprit via a GET /up probe — the
// server answering means the CHANNEL/API path is broken; nothing answering
// means the HOST is offline (which only escalates after ~10 min).
function seedHealthLedger(dir, streak, firstAgoMs) {
  const h = crypto.createHash('sha256').update('hld_test').digest('hex').slice(0, 16);
  const file = path.join(dir, 'pidge', `health-${h}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ streak, first_at: Date.now() - firstAgoMs, last_at: Date.now() }));
  return file;
}

test('one dead round with the host offline is a BLIP (exit 3, host-blame), not an escalation', async () => {
  const mock = createMock();
  const port = await mock.start();
  await mock.stop(); // nothing listening — every request AND the /up probe fail

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '4', '--interval', '1'], port);
  const { code, stderr } = await result;

  assert.equal(code, 3, `stderr: ${stderr}`);
  assert.match(stderr, /HOST's network looks down/, 'the blame is local, not "the CHANNEL"');
  assert.match(stderr, /dead round 1 of 3/, 'the streak is narrated');
  const deafLines = stderr.split('\n').filter((l) => /deaf for/.test(l));
  assert.ok(deafLines.length <= 2, `expected aggregated stderr, got:\n${stderr}`);
});

test('a streak of dead rounds with the server answering /up escalates: exit 4 blames the CHANNEL', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messagesStatus = 500; // the API path is broken, the server itself is up
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-health-'));
  seedHealthLedger(dir, 2, 3 * 60000); // two prior dead rounds, first one 3 min ago

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '4', '--interval', '1'], port, { XDG_CONFIG_HOME: dir });
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 4, `stderr: ${stderr}`);
  assert.match(stderr, /3 consecutive rounds/, 'the verdict counts the whole streak');
  assert.match(stderr, /CHANNEL\/API path looks broken/, 'server up + API dead = channel blame');
  assert.match(stderr, /Surface this to your human/);
  const h = crypto.createHash('sha256').update('hld_test').digest('hex').slice(0, 16);
  assert.ok(!fs.existsSync(path.join(dir, 'pidge', `health-${h}.json`)), 'an escalation resets the streak — the next one must be earned fresh');
});

test('a LONG host-offline streak still escalates, blaming the HOST — through the session, not pidge', async () => {
  const mock = createMock();
  const port = await mock.start();
  await mock.stop();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-health-'));
  seedHealthLedger(dir, 5, 11 * 60000); // dead for 11 minutes already

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '3', '--interval', '1'], port, { XDG_CONFIG_HOME: dir });
  const { code, stderr } = await result;

  assert.equal(code, 4, `stderr: ${stderr}`);
  assert.match(stderr, /HOST is offline/, 'the culprit is named — never "the CHANNEL looks broken"');
  assert.match(stderr, /through your own session/);
});

test('a dead round whose authenticated probe answers 401 is a REJECTED KEY, not a blip', async () => {
  const mock = createMock();
  const port = await mock.start();
  // every poll dies as a server error (dead round), but the server itself is up
  // and whoami says the KEY is the problem — the verdict must say so (exit 2),
  // never "transport blip, relaunch" (the realtime path can reach the verdict
  // without ever seeing an HTTP 401: the WS handshake just closes).
  mock.state.messagesStatus = 500;
  mock.state.whoamiStatus = 401;

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '4', '--interval', '1'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.match(stderr, /REJECTED this channel key/);
});

test('one healthy round-trip clears the persisted streak', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-health-'));
  const file = seedHealthLedger(dir, 2, 3 * 60000);

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '2', '--interval', '1'], port, { XDG_CONFIG_HOME: dir });
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 3, 'healthy but silent = exit 3, as ever');
  assert.ok(!fs.existsSync(file), 'the streak file is gone after a healthy round');
  // 0.53.2: the relaunch nudge carries the proof step — an empty round is
  // exactly when an agent starts believing (and telling) it is online.
  assert.match(stderr, /pidge selftest/, 'the exit narration offers the proof, not just the instruction');
});

// A rotated/revoked key is a WALL, not a timeout. The 401 used to land in the
// `else { health.ok() }` branch — the server answered, so the round counted as
// healthy — and the session exited 3 "relaunch the listener", forever.
test('listen — a 401 is named as a rotated key: loud, local, exit 2 (never a timeout)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messagesStatus = 401;

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '20', '--interval', '1'], port,
    { PIDGE_BRIDGE_ALERT: '0' });
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 2, `a rejected key is exit 2, not 3/4; stderr: ${stderr}`);
  assert.match(stderr, /REJECTED this channel key \(401\)/);
  assert.match(stderr, /NOT a timeout/, 'it says what it is NOT — the confusion it exists to kill');
  assert.match(stderr, /LOCAL ALERT/, 'only a human can fix it, so it alerts locally');
  assert.match(stderr, /pidge setup --claim/, 'and names the fix');
  assert.ok(!/relaunch the listener/i.test(stderr), 'never "relaunch" — relaunching hits the same wall');
});

test('wait — a 401 mid-wait is the same wall, exit 2', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.pollStatus = 403; // revoked

  const { result } = runCli(['wait', 'cid-401', '--no-realtime', '--timeout', '20', '--interval', '1'], port,
    { PIDGE_BRIDGE_ALERT: '0' });
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.match(stderr, /REJECTED this channel key \(403\)/);
  assert.match(stderr, /NOT a timeout/);
});

// Other 4xx answered too — but not with the round-trip the loop exists to
// prove. They used to latch okEver and certify the channel as healthy.
test('a non-auth 4xx never certifies the channel as healthy (no exit-3 "all fine" over it)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messagesStatus = 422;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-health4xx-'));
  seedHealthLedger(dir, 2, 3 * 60000); // two dead rounds already

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '4', '--interval', '1'], port, { XDG_CONFIG_HOME: dir });
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 4, `a 4xx round is a DEAD round, not a healthy one; stderr: ${stderr}`);
  assert.match(stderr, /CHANNEL\/API path looks broken/);
});

// "Healthy" has a shelf life: okEver was a latch, so one good round-trip at the
// start of a long --follow window certified the channel hours later.
test('a round-trip that is too OLD no longer certifies the channel (recency, not history)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-health-stale-'));
  // One healthy read at the start (the queue answers 200, empty), then the API
  // dies for the rest of the window. With a 1 ms freshness window that first
  // round-trip is stale by the time the verdict runs, so the exit falls through
  // to the CROSS-ROUND verdict instead of the "healthy, just quiet" line.
  const { result } = runCli(['listen', '--no-realtime', '--timeout', '5', '--interval', '1'], port,
    { XDG_CONFIG_HOME: dir, PIDGE_HEALTHY_WINDOW_MS: '1' });
  setTimeout(() => { mock.state.messagesStatus = 500; }, 500);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 3, `one dead round is still a blip; stderr: ${stderr}`);
  assert.match(stderr, /dead round 1 of 3/, 'the stale session is judged by the cross-round ledger');
  assert.ok(!/= 'no answer yet', not a failure/.test(stderr),
    'a round-trip from ten minutes ago must not certify the channel as healthy NOW');
});

test('exit 3 — a healthy but silent session is still just "no answer yet"', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '2', '--interval', '1'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 3, `stderr: ${stderr}`);
  assert.match(stderr, /not a failure/);
});

test('soak — a realtime listen SURVIVES a server restart and still delivers', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('needs Node ≥22');
  const mock = createMock();
  const port = await mock.start();

  let subscribed = 0;
  mock.state.onSubscribe = () => { subscribed++; };

  const { result } = runCli(['listen', '--ack-on-read', '--realtime', '--timeout', '60'], port);

  // wait until the client is subscribed, then "deploy" (kill + restart)
  while (subscribed === 0) await sleep(50);
  await mock.stop();
  await sleep(2500); // the client is reconnecting with backoff meanwhile
  await mock.start(port);
  while (subscribed < 2) await sleep(50); // re-subscribed after the restart

  // the human types — the frame wakes the client; the backlog GET serves it
  mock.state.messages = [{ id: 12, channel_id: 1, body: 'sobreviveu ao deploy?', created_at: 'x', consumed_at: null }];
  mock.broadcast('ConversationChannel', { type: 'message', message: mock.state.messages[0] });

  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /sobreviveu ao deploy/);
  assert.match(stderr, /reconnecting/);
  assert.ok(mock.state.acks.length >= 1, 'must ack what it printed');
});

test('ask over the realtime socket resolves from the InboxChannel frame', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('needs Node ≥22');
  const mock = createMock();
  const port = await mock.start();

  mock.state.onSubscribe = (channel) => {
    if (channel !== 'InboxChannel') return;
    const cid = mock.state.notifies[0].correlation_id;
    // The answer EXISTS only when the frame fires — the WS wake-up, not the
    // connect-time HTTP check, must be what resolves this ask.
    setTimeout(() => {
      mock.state.notifications[cid] = {
        responded: true,
        chosen_action: { kind: 'acted', action_id: 'approve', label: 'Aprovar', text: null },
      };
      mock.broadcast('InboxChannel', {
        type: 'event', kind: 'acted', action_id: 'approve', responded: true, correlation_id: cid,
      });
    }, 500);
  };

  // ask now requires a way to answer (--actions/--custom-action/--template).
  const { result } = runCli(['ask', '--realtime', '--title', 'Aprovar?', '--actions', 'yes,no', '--timeout', '30'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /"action_id": "approve"/);
});

test('a wedged ack does NOT hang the process forever — it times out, exits (messages were printed)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.hangAck = true; // the ack POST never responds
  mock.state.messages = [{ id: 5, channel_id: 1, body: 'msg + ack travado', created_at: 'x', consumed_at: null }];

  // PIDGE_FETCH_TIMEOUT keeps the test fast; default in prod is 30 s.
  // --ack-on-read: the wedged-ack resilience lives on the ack path (0.9 default doesn't ack on read).
  const { result } = runCli(['listen', '--ack-on-read', '--no-realtime', '--timeout', '20'], port, { PIDGE_FETCH_TIMEOUT: '1500' });
  const started = Date.now();
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `must still exit 0 after printing; stderr: ${stderr}`);
  assert.match(stdout, /ack travado/, 'the messages are printed before the ack');
  assert.match(stderr, /ack failed/);
  assert.ok(Date.now() - started < 10000, 'must not hang to the 20s deadline waiting on a dead ack');
});

test('listen without a WebSocket-capable runtime quietly uses polling (no crash)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 3, channel_id: 1, body: 'polling puro', created_at: 'x', consumed_at: null }];

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '10'], port);
  const { code, stdout } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.match(stdout, /polling puro/);
});

// --- Onboarding: setup --claim / doctor / whoami -----------------------------

const fs = require('node:fs');
const os = require('node:os');

const crypto = require('node:crypto');

// The installed skill is a TREE: a small core (SKILL.md) plus references/*.md
// that the harness loads only when a trigger fires. A FACT must survive
// somewhere reachable, and that is what `all` is for; WHERE it lives is a
// separate claim, asserted against `core` or `refs[<name>]`. A test that only
// ever looked at SKILL.md would read a moved fact as a deleted one.
function installedSkill(dir) {
  const skillDir = path.join(dir, '.claude', 'skills', 'pidge');
  const core = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const refs = {};
  const refDir = path.join(skillDir, 'references');
  if (fs.existsSync(refDir)) {
    for (const f of fs.readdirSync(refDir).sort()) refs[f.replace(/\.md$/, '')] = fs.readFileSync(path.join(refDir, f), 'utf8');
  }
  let report = '';
  try { report = fs.readFileSync(path.join(dir, '.claude', 'skills', 'pidge-report', 'SKILL.md'), 'utf8'); } catch { /* a single-file target has no companion */ }
  return { core, refs, report, all: [core, ...Object.values(refs)].join('\n') };
}

// A throwaway "git project" directory (the .git DIR marks the toplevel) + the
// project-scoped env path the CLI derives for it (hash of the REAL toplevel
// path — the spawned process sees the symlink-resolved cwd on macOS /var→/private).
function makeProject() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-proj-')));
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}
function projectEnvPath(home, projDir) {
  const hash = crypto.createHash('sha256').update(projDir).digest('hex').slice(0, 16);
  return path.join(home, 'pidge', 'projects', hash, 'env');
}
// A non-git cwd: the shared-file (legacy/global) path. mkdtemp under os.tmpdir()
// has no .git ancestor.
const nonGitCwd = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-nogit-')));

test('setup --claim INSIDE a git project writes the PROJECT-scoped env (600) and runs doctor — secret never printed', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-setup-'));
  const proj = makeProject();

  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, proj,
  );
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const file = projectEnvPath(home, proj);
  const written = fs.readFileSync(file, 'utf8');
  assert.match(written, /PIDGE_TOKEN=hld_minted_by_claim/);
  assert.match(written, new RegExp(`PIDGE_URL=http://127.0.0.1:${port}`));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'env file must be chmod 600');
  assert.ok(!fs.existsSync(path.join(home, 'pidge', 'env')), 'the shared machine file must stay untouched');
  // the key must NEVER hit the terminal — only the file
  assert.ok(!stdout.includes('hld_minted_by_claim'), 'key leaked to stdout');
  assert.ok(!stderr.includes('hld_minted_by_claim'), 'key leaked to stderr');
  assert.match(stderr, /escopo DESTE projeto/, 'setup narrates the project scope');
  assert.match(stderr, /canal "mock"/);
  assert.match(stderr, /doctor: all good/);
  assert.match(stderr, /ROTATED the channel key/, 'setup says out loud what the claim exchange just did to any other install');
});

// A claim exchange REVOKES the previous key (the server mints a new one and
// drops the old holder's sockets and sessions). That used to happen in silence,
// so the surprise landed on the OTHER install — a bridge or a cron that worked
// a minute ago and 401s now with no idea why. One line, where we cause it.
test('setup --claim says the previous key is REVOKED — and names a prior owner when the generation shows one', async () => {
  const mock = createMock();
  const port = await mock.start();
  // this channel was already owned by a DIFFERENT install
  mock.state.claim = {
    claimed_by_label: 'outro-agente', claimed_by_fingerprint: 'fp-alheio',
    claimed_at: '2026-08-01T10:00:00Z', claim_generation: 3,
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-rotate-'));
  const proj = makeProject();

  const { code, stderr } = await runCli(
    ['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, proj,
  ).result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /previous key is now REVOKED/, 'the consequence is named, not implied');
  assert.match(stderr, /401/, 'and it says what the other install will actually see');
  assert.match(stderr, /A different install owned this channel before \(generation 4\)/,
    'the generation the ownership response already carried — no extra request');
});

// --- setup --from-computer: PIDGE_SECRET by DERIVATION (no secret travels) ---

const DERIVATION = JSON.parse(fs.readFileSync(path.join(__dirname, 'e2e_vectors.json'), 'utf8')).derivation;

// The paired-computer identity slot, as `pidge terminal connect` writes it.
function writeTerminalEnv(home, secret) {
  const dir = path.join(home, 'pidge', 'terminal');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'env'),
    `PIDGE_URL=https://api.pidge.sh\nPIDGE_TOKEN=hld_tunnel\nPIDGE_SECRET=${secret}\nPIDGE_CHANNEL_ID=396\n`,
    { mode: 0o600 });
}

test('setup --from-computer DERIVES the secret from the paired-computer key — fixture-exact, nothing travels', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-derive-'));
  const proj = makeProject();
  // The machine's computer key = the fixture's derivation IKM; the mock's
  // channel id is 1, so the expected secret is the fixture's ch1 vector —
  // the SAME bytes the app derives on the phone side.
  writeTerminalEnv(home, DERIVATION.computer_key_b64url);
  const ch1 = DERIVATION.vectors.find((v) => v.channel_id === 1);

  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--from-computer', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', PIDGE_SECRET: '', XDG_CONFIG_HOME: home }, proj,
  );
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const written = fs.readFileSync(projectEnvPath(home, proj), 'utf8');
  assert.match(written, new RegExp(`PIDGE_SECRET=${ch1.derived_key_b64url}`),
    'the derived channel key must be byte-identical to the shared fixture vector');
  assert.match(stderr, /PIDGE_SECRET DERIVED from this computer's key/);
  assert.match(stderr, new RegExp(`channel kf ${ch1.derived_kf}`), 'the narrated kf is the derived key\'s');
  assert.ok(!stdout.includes(ch1.derived_key_b64url) && !stderr.includes(ch1.derived_key_b64url),
    'the derived secret must never hit the terminal — only the file');
});

test('setup --from-computer on an UNPAIRED machine refuses BEFORE any network (the code survives)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-derive-'));

  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--from-computer', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', PIDGE_SECRET: '', XDG_CONFIG_HOME: home }, makeProject(),
  );
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 2);
  assert.match(stderr, /no paired-computer key/);
  assert.match(stderr, /pidge terminal connect/, 'the refusal names the pairing recipe');
  assert.equal(mock.state.claimCode, 'claim-ok', 'the single-use code must not be consumed');
  assert.ok(!mock.state.reqLog.some((r) => r.pathname === '/api/v1/claim'), 'no claim was attempted');
});

test('setup --from-computer with an ambient PIDGE_SECRET dies loud — the two secret sources never half-mix', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-derive-'));
  writeTerminalEnv(home, DERIVATION.computer_key_b64url);

  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--from-computer', '--url', 'http://127.0.0.1:9'],
    9, { PIDGE_TOKEN: '', PIDGE_URL: '', PIDGE_SECRET: DERIVATION.computer_key_b64url, XDG_CONFIG_HOME: home }, makeProject(),
  );
  const { code, stderr } = await result;
  assert.equal(code, 1);
  assert.match(stderr, /must not mix/);
});

test('setup OUTSIDE any project writes the legacy shared file (single-agent machine unchanged)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-setup-'));

  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, nonGitCwd(),
  );
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const written = fs.readFileSync(path.join(home, 'pidge', 'env'), 'utf8');
  assert.match(written, /PIDGE_TOKEN=hld_minted_by_claim/);
  assert.match(stderr, /arquivo COMPARTILHADO/, 'the shared-file write warns about multi-agent machines');
});

test('setup tolerates a DASH-LEADING claim code (legal urlsafe-base64 that argv parsers read as a flag)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.claimCode = '-dashLeadingCode123';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-dash-'));

  const { result } = runCli(
    ['setup', '--claim', '-dashLeadingCode123', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, nonGitCwd(),
  );
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `a machine-minted code must never die at the flag parser: ${stderr}`);
  assert.match(fs.readFileSync(path.join(home, 'pidge', 'env'), 'utf8'), /hld_minted_by_claim/);
});

test('setup with a used/expired code fails LOUD with the re-mint recipe', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.claimCode = null; // already claimed

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-setup-'));
  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home },
  );
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 2);
  assert.match(stderr, /EXPIRED|already used/);
  assert.match(stderr, /copiar prompt de setup/, 'must tell the agent how the human re-mints');
});

test('doctor narrates source + channel + devices and exits 0', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['doctor'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /canal "mock" · 1 device/);
  assert.ok(!stderr.includes('hld_test'), 'doctor must not display the key');
  assert.deepEqual(JSON.parse(stdout).ok, true);
});

// Doctor ALWAYS reports the prior-claim state: a CONFIRMATION on false, not
// silence. "I didn't see the warning" ≠ "there is no orphaned backlog".
test('doctor CONFIRMS "prior-claim backlog: none ✓" when the flag is false (not silent)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.staleFromPriorClaim = false; // the healthy, common case

  const { result } = runCli(['doctor'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /prior-claim backlog: none ✓/, 'doctor speaks the healthy case, not just the warning');
  assert.ok(!/PRIOR claim/.test(stderr), 'no false alarm when the backlog is clean');
});

// Doctor NUDGES (never touches) an unmarked home skill: a pre-marker
// pidge copy the self-heal (correctly) won't refresh would otherwise stay silent.
test('doctor WARNS when ~/.claude/skills/pidge/SKILL.md exists WITHOUT the pidge marker (never writes it)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-doctorhome-'));
  const homeSkill = path.join(home, '.claude', 'skills', 'pidge', 'SKILL.md');
  fs.mkdirSync(path.dirname(homeSkill), { recursive: true });
  const unmarked = '---\nname: pidge\ndescription: old copy, no marker.\n---\n\n# Old doctrine v26\n';
  fs.writeFileSync(homeSkill, unmarked);
  // cwd is a clean dir (NOT home) so this is purely the home-nudge path.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-doctorcwd-'));

  const { result } = runCli(['doctor'], port, { HOME: home }, cwd);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /has NO pidge marker/, 'doctor names the unmarked home skill');
  assert.match(stderr, /skill install/, 'and points at the fix');
  assert.equal(fs.readFileSync(homeSkill, 'utf8'), unmarked, 'doctor must NEVER touch the file — nudge only');
});

test('doctor does NOT warn when the home skill CARRIES the marker (that one self-heals)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-doctorhome2-'));
  const homeSkill = path.join(home, '.claude', 'skills', 'pidge', 'SKILL.md');
  fs.mkdirSync(path.dirname(homeSkill), { recursive: true });
  // A marked (current) home skill — nothing to nag about.
  fs.writeFileSync(homeSkill, `---\nname: pidge\ndescription: x.\n# pidge-skill rev=22 manifest=16\n---\n\n# Pidge\n\nok\n\n<!-- pidge-skill-end -->\n`);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-doctorcwd2-'));

  const { result } = runCli(['doctor'], port, { HOME: home }, cwd);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.ok(!/has NO pidge marker/.test(stderr), 'a marked home skill triggers no nudge');
});

test('doctor warns LOUD on 0 devices (sends reach nobody)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.devices = 0;

  const { result } = runCli(['doctor'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.match(stderr, /0 devices.*NOBODY/);
});

// "all good" printed over three ⚠️ lines is the doctor disagreeing with its own
// output — and `{ok:true}` made a script agree with the summary, not the run.
test('doctor — the verdict COUNTS the warnings it printed: never "all good" over a ⚠️', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.devices = 0;                 // warning: no_devices
  mock.state.staleFromPriorClaim = true;  // warning: stale_prior_claim

  const { result } = runCli(['doctor'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `warnings are not brokenness — still exit 0; stderr: ${stderr}`);
  assert.match(stderr, /healthy — 2 warning\(s\) above/);
  assert.ok(!/all good/.test(stderr), '"all good" is reserved for a run with nothing to warn about');
  const out = JSON.parse(stdout);
  assert.equal(out.ok, true, 'the channel is usable — ok stays true');
  assert.equal(out.warnings, 2, 'the machine line carries the count too');
  assert.deepEqual(out.warning_kinds.sort(), ['no_devices', 'stale_prior_claim']);
});

test('doctor — a clean run still says "all good" and reports zero warnings', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['doctor'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, stderr);
  assert.match(stderr, /all good/);
  const out = JSON.parse(stdout);
  assert.equal(out.warnings, 0);
  assert.deepEqual(out.warning_kinds, []);
});

test('doctor --quiet — the one-line status still says how many warnings it hid', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.devices = 0;

  const { result } = runCli(['doctor', '--quiet'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, stderr);
  assert.match(stderr, /✓ setup ok.*1 warning\(s\) above/s);
});

test('doctor probes the realtime path: reports ok when the socket confirms', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('needs Node ≥22');
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['doctor'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /realtime: ok/);
  assert.equal(JSON.parse(stdout).realtime, 'ok');
  assert.match(stderr, /pidge hello/, 'the hint now leads with the first-contact WOW');
});

test('doctor: realtime INDISPONÍVEL but the doctor STILL exits 0 (degrade is the contract)', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('needs Node ≥22');
  const mock = createMock();
  const port = await mock.start();
  mock.state.wsMode = '1006'; // a proxy/edge refusing the upgrade

  const { result } = runCli(['doctor'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, 'an unavailable WS must NOT fail the doctor — listen just polls');
  assert.match(stderr, /realtime: INDISPON/);
  assert.match(stderr, /--no-realtime/);
  assert.equal(JSON.parse(stdout).realtime, 'unavailable');
});

test('whoami prints the channel identity JSON', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['whoami'], port);
  const { code, stdout } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).channel.name, 'mock');
});

test('skill install writes .claude/skills/pidge/SKILL.md from the manifest', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-skill-'));

  const child = spawn(process.execPath, [CLI, 'skill', 'install'], {
    cwd: dir,
    // isolate HOME so `skill install` (and its self-heal path) never touches the real ~/.claude.
    env: { ...process.env, PIDGE_URL: `http://127.0.0.1:${port}`, PIDGE_TOKEN: 'hld_test', HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-home-')) },
  });
  const out = await new Promise((resolve) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  await mock.stop();

  assert.equal(out.code, 0, `stderr: ${out.stderr}`);
  const { core: skill, refs, all } = installedSkill(dir);
  assert.match(skill, /name: pidge/);
  // INVERTED assert: the dead content_template MENU is gone. The mock STILL serves
  // templates.decision_table (row text "template decision") — proof the generator now
  // IGNORES it — and the old "Pick the right send" menu heading is absent. (--template
  // now appears ONLY inside the skill's "it's gone, don't use it" warnings — that's the
  // point, so we assert the dead ROW + heading are absent, not the literal word.)
  assert.ok(!/template decision/.test(all), 'mock templates.decision_table row must NOT be pulled');
  assert.ok(!/Pick the right send/.test(all), 'the dead content_template menu heading is gone');
  assert.match(skill, /manifest v16/);
  // The core is a CORE: it carries the picker, the handshake and an INDEX, and
  // it points at reference files instead of inlining them.
  assert.match(skill, /## THE PICKER/, 'the shortest path to a correct send stays in the core');
  assert.match(skill, /## The version handshake/, 'the core says how it learns it is stale');
  assert.match(skill, /X-Pidge-Manifest-Version/, 'and names the header that says so');
  assert.match(skill, /## References — `references\/<name>\.md`/, 'the core carries the reference index');
  for (const name of ['identity', 'send', 'approvals', 'contract', 'answers', 'loop', 'multi-runtime', 'live', 'typing', 'runs']) {
    assert.ok(refs[name], `references/${name}.md was installed`);
    assert.match(skill, new RegExp(`\\*\\*${name}\\*\\* — `), `the index names ${name} with a trigger`);
    assert.ok(refs[name].trimEnd().endsWith('<!-- pidge-skill-end -->'), `references/${name}.md carries the trailer`);
  }
  // The generated appendix follows the fact into its file — the mock's `notes`
  // land in the contract reference, its `cli.output` in the answers reference.
  assert.match(refs.contract, /trust the echo/, 'the manifest notes are generated into the contract reference');
  assert.match(refs.answers, /exit 0 answered · 3 timed out/, "the manifest's own exit contract lands in the answers reference");
  // the pidge-report COMPANION lands as a sibling skill, marked + trailed like the main one.
  const report = fs.readFileSync(path.join(dir, '.claude', 'skills', 'pidge-report', 'SKILL.md'), 'utf8');
  assert.match(report, /name: pidge-report/);
  assert.match(report, /\n# pidge-skill rev=29 manifest=16\n/, 'companion carries the same marker');
  assert.ok(report.trimEnd().endsWith('<!-- pidge-skill-end -->'), 'companion carries the trailer');
  assert.match(skill, /pidge-report/, 'the main skill points at the companion');
  // The skill is the loudest announcement this CLI makes — every future session
  // on the machine reads it. This one was generated on a computer with no
  // Terminals daemon (isolated HOME/XDG above), so it teaches nothing about
  // mirroring a session that could not be mirrored here.
  assert.ok(!/Mirror THIS session/.test(all), 'no daemon here ⇒ no mirroring doctrine');
  assert.ok(!/pidge terminal enable/.test(all));
  assert.ok(!refs['agent-sessions'], 'and no reference file for a door this machine does not have');
  assert.match(skill, /## Full spec/, 'the core still points at the live contract');
});

test('skill install — on a computer WITH Terminals the skill carries the mirroring doctrine', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-skill-term-'));
  // Either half of "Terminals lives here" is enough — this seeds the daemon config.
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-skill-xdg-'));
  fs.mkdirSync(path.join(xdg, 'pidge', 'terminal'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'pidge', 'terminal', 'daemon.json'), JSON.stringify({ port: 8765, token: 'x' }));

  const out = await runCli(['skill', 'install'], port, { XDG_CONFIG_HOME: xdg }, dir).result;
  await mock.stop();

  assert.equal(out.code, 0, `stderr: ${out.stderr}`);
  const { core, refs } = installedSkill(dir);
  // The door lands as its own reference — named for the manifest section it
  // mirrors (`agent_sessions`) — and the core's index names it with its trigger.
  assert.ok(refs['agent-sessions'], 'the mirroring doctrine installs as a reference file');
  assert.match(refs['agent-sessions'], /Mirror THIS session to the human's phone/);
  assert.match(refs['agent-sessions'], /is SUCCESS/, 'including that the DENIAL is the success signal');
  assert.match(refs['agent-sessions'], /pidge terminal enable/, 'and the one command to run');
  assert.match(core, /\*\*agent-sessions\*\* — .*mirror/i, 'the core index carries its trigger');
});

// --- self-heal: the local skill self-heals (any pidge command refreshes a stale skill) ---
// The installed SKILL.md carries the marker `# pidge-skill rev=R manifest=N` as a YAML COMMENT
// INSIDE the frontmatter (0.15.3+). It must NOT precede the opening `---`: a first line that
// isn't `---` fails the YAML frontmatter parse, so Claude Code loads the skill with a garbage
// description (proven on a live headless run) — the 0.15.2 marker-first format was exactly that
// bug. On EVERY networked command, checkManifestNews → ensureSkillFresh reads the marker (from
// the new position, and tolerating the OLD line-1 `<!-- … -->` so a 0.15.2 install still heals),
// compares it against the CLI's SKILL_REVISION and the server's x-pidge-manifest-version header,
// and silently regenerates a stale skill so the agent's NEXT session is current. Only EXISTING
// skills refresh.

// Simulates a 0.15.2 install: the marker sits on line 1, ABOVE the `---` (the broken format).
function seedOldSkill(marker, body = 'OLD SKILL BODY') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-heal-'));
  const file = path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${marker}\n---\nname: pidge\n---\n\n# Pidge\n\n${body}\n`);
  return { dir, file };
}

// The corrected 0.15.3+ format: `---` on line 1, the marker a `#` comment inside the
// frontmatter. The heal also writes an end-of-file trailer (the cheap integrity check) — seed it
// too so a "fresh" seed reads as INTACT, not as a torn write.
function seedNewSkill(rev, manifest, body = 'OLD SKILL BODY') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-heal-'));
  const file = path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: pidge\ndescription: Send rich stuff.\n# pidge-skill rev=${rev} manifest=${manifest}\n---\n\n# Pidge\n\n${body}\n\n<!-- pidge-skill-end -->\n`);
  return { dir, file };
}

test('self-heal — a 0.15.2 marker-first install self-heals into the fixed in-frontmatter format', async () => {
  const mock = createMock();
  const port = await mock.start();
  // The real-world broken install: marker ABOVE the `---`, rev=1 (0.15.2's SKILL_REVISION).
  // manifest is current (16) but the spine bumped (5 > 1), so the heal fires and REPAIRS format.
  const { dir, file } = seedOldSkill('<!-- pidge-skill rev=1 manifest=16 -->', 'BROKEN 0.15.2 SKILL');

  const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const healed = fs.readFileSync(file, 'utf8');
  // THE regression guard: the frontmatter must open on line 1, or the YAML parse fails.
  assert.equal(healed.split('\n', 1)[0], '---', 'first line must be `---` (valid frontmatter)');
  assert.ok(!/<!-- pidge-skill rev=/.test(healed), 'the old HTML-comment marker is gone (the end trailer is not it)');
  assert.match(healed, /\n# pidge-skill rev=29 manifest=16\n/, 'marker now a YAML comment inside the frontmatter');
  assert.match(healed, /^---\nname: pidge\ndescription: Send rich/, 'real name + description survive the frontmatter');
  assert.ok(!/BROKEN 0\.15\.2 SKILL/.test(healed), 'the broken skill was replaced by a real regeneration');
  assert.match(stderr, /refreshed your local Pidge skill \(rev 29, manifest v16\)/, 'one stderr note');
});

test('self-heal — a SPINE bump (SKILL_REVISION > installed) self-heals the local skill', async () => {
  const mock = createMock();
  const port = await mock.start();
  // New-format skill, manifest current (16), spine stale (rev=0 < current 6) — reads the
  // marker from its new in-frontmatter position and heals on the spine trigger.
  const { dir, file } = seedNewSkill(0, 16, 'STALE SPINE');

  const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const healed = fs.readFileSync(file, 'utf8');
  assert.equal(healed.split('\n', 1)[0], '---', 'first line stays `---`');
  assert.match(healed, /\n# pidge-skill rev=29 manifest=16\n/, 'marker rewritten to the current rev, in the frontmatter');
  assert.ok(!/STALE SPINE/.test(healed), 'the stale spine was replaced by a real regeneration');
  assert.match(healed, /name: pidge/, 'a genuine skill was written');
  assert.match(stderr, /refreshed your local Pidge skill \(rev 29, manifest v16\)/, 'one stderr note');
  // the heal also (re)writes the pidge-report companion — this is exactly how an
  // existing install GAINS the companion on a spine bump, with zero human action.
  const reportFile = path.join(path.dirname(path.dirname(file)), 'pidge-report', 'SKILL.md');
  assert.match(fs.readFileSync(reportFile, 'utf8'), /name: pidge-report/, 'the companion sibling was written by the heal');
});

test('self-heal — a MANIFEST bump (server version > installed) self-heals the local skill', async () => {
  const mock = createMock();
  const port = await mock.start();
  // New-format skill, spine near-current but the baked manifest is stale (15 < the mock's 16).
  const { dir, file } = seedNewSkill(12, 15, 'STALE BY MANIFEST');

  const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const healed = fs.readFileSync(file, 'utf8');
  assert.match(healed, /\n# pidge-skill rev=29 manifest=16\n/, 'marker rewritten to the current manifest');
  assert.ok(!/STALE BY MANIFEST/.test(healed), 'the stale skill was regenerated');
  assert.match(stderr, /refreshed your local Pidge skill/, 'one stderr note');
});

test('self-heal — a NEWER spine is never downgraded, even when the server manifest moved', async () => {
  const mock = createMock();
  const port = await mock.start();
  // Observed live: a 0.46 install (spine 21) met a rev-22 skill whose baked manifest
  // was stale, and the manifest trigger "healed" it DOWN to rev 21. The spine a newer
  // CLI wrote outranks this binary's regeneration: leave the file alone; the newer
  // CLI heals its own manifest staleness.
  const { dir, file } = seedNewSkill(99, 10, 'DOCTRINE FROM A NEWER CLI');
  const before = fs.readFileSync(file, 'utf8');

  const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a newer-spine skill is left byte-for-byte');
  assert.ok(!/refreshed your local Pidge skill/.test(stderr), 'no heal note — nothing was healed');
});

test('self-heal — a FRESH skill (new-format marker current) is left byte-for-byte, no note', async () => {
  const mock = createMock();
  const port = await mock.start();
  // Proves the reader FINDS the marker in its new in-frontmatter position: if it couldn't,
  // it would read rev=0 and needlessly regenerate, failing the byte-for-byte assertion.
  const { dir, file } = seedNewSkill(29, 16, 'SENTINEL FRESH — keep me');
  const original = fs.readFileSync(file, 'utf8');

  const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'a current skill must NOT be regenerated');
  assert.ok(!/refreshed your local Pidge skill/.test(stderr), 'no refresh note when fresh');
});

test('self-heal — NO local skill present: a command runs normally, nothing is auto-created', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-heal-none-'));

  const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md')),
    'the self-heal must never create a skill that was not already there');
  assert.ok(!/refreshed your local Pidge skill/.test(stderr), 'no refresh note when there is no skill');
});

// --- the self-heal covers the HOME skill too, not just the cwd project skill ---
// A live agent once ran 3 WEEKS on ~/.claude/skills/pidge frozen at rev 6 because
// ensureSkillFresh only resolved the cwd project path. Old installs live in HOME.

function seedSkillAt(file, rev, body = 'STALE') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: pidge\ndescription: Send rich stuff.\n# pidge-skill rev=${rev} manifest=16\n---\n\n# Pidge\n\n${body}\n\n<!-- pidge-skill-end -->\n`);
}

test('home self-heal — a STALE home skill self-heals even when there is NO project skill', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-homeheal-'));
  const homeSkill = path.join(home, '.claude', 'skills', 'pidge', 'SKILL.md');
  seedSkillAt(homeSkill, 6, 'STALE HOME DOCTRINE'); // rev 6 = the frozen rev observed in the field
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-cleanproj-')); // NO project skill here

  const { result } = runCli(['whoami'], port, { HOME: home }, cwd);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const healed = fs.readFileSync(homeSkill, 'utf8');
  assert.match(healed, /\n# pidge-skill rev=29 manifest=16\n/, 'the home skill was regenerated to the current rev');
  assert.ok(!/STALE HOME DOCTRINE/.test(healed), 'the stale home doctrine was replaced by a real regeneration');
  assert.match(stderr, /refreshed your local Pidge skill/, 'the home heal narrated itself');
});

test('home self-heal — BOTH project and home skills stale: both heal in one pass; the note names ~/.claude', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-homeheal2-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-projheal2-'));
  const homeSkill = path.join(home, '.claude', 'skills', 'pidge', 'SKILL.md');
  const projSkill = path.join(cwd, '.claude', 'skills', 'pidge', 'SKILL.md');
  seedSkillAt(homeSkill, 6, 'STALE HOME');
  seedSkillAt(projSkill, 6, 'STALE PROJECT');

  const { result } = runCli(['whoami'], port, { HOME: home }, cwd);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(fs.readFileSync(homeSkill, 'utf8'), /rev=29 manifest=16/, 'home healed');
  assert.match(fs.readFileSync(projSkill, 'utf8'), /rev=29 manifest=16/, 'project healed');
  assert.match(stderr, /2 locations incl\. ~\/\.claude/, 'the note reports BOTH locations were refreshed');
});

test('home self-heal — a FRESH home skill is left byte-for-byte (no needless home regeneration)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-homefresh-'));
  const homeSkill = path.join(home, '.claude', 'skills', 'pidge', 'SKILL.md');
  seedSkillAt(homeSkill, 29, 'SENTINEL HOME — keep me'); // current rev
  const original = fs.readFileSync(homeSkill, 'utf8');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-cleanproj2-'));

  const { result } = runCli(['whoami'], port, { HOME: home }, cwd);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.equal(fs.readFileSync(homeSkill, 'utf8'), original, 'a current home skill must NOT be regenerated');
  assert.ok(!/refreshed your local Pidge skill/.test(stderr), 'no refresh note when the home skill is fresh');
});

// The HOME path requires a pidge marker: an unmarked home skill is
// AUTHORIAL (the human wrote it) and must be left alone. (The project path keeps its
// heal-a-marker-less-file semantics — covered by the "pidge-skill in body PROSE" test.)
test('home self-heal — an AUTHORIAL home skill (no pidge marker) is left untouched by the self-heal', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-authorial-'));
  const homeSkill = path.join(home, '.claude', 'skills', 'pidge', 'SKILL.md');
  fs.mkdirSync(path.dirname(homeSkill), { recursive: true });
  // A hand-written skill named "pidge" with NO pidge-skill marker anywhere.
  const authored = '---\nname: pidge\ndescription: my own hand-written skill.\n---\n\n# My Pidge notes\n\nhand-written, no marker.\n';
  fs.writeFileSync(homeSkill, authored);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-cleanproj3-'));

  const { result } = runCli(['whoami'], port, { HOME: home }, cwd);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.equal(fs.readFileSync(homeSkill, 'utf8'), authored, 'an unmarked home skill is authorial — never overwritten');
  assert.ok(!/refreshed your local Pidge skill/.test(stderr), 'no heal note for an authorial home skill');
});

// --- atomic self-heal — torn writes, concurrency, read-only, prose marker, .bak ---

test('atomic self-heal — a TORN write (marker intact, tail truncated) is detected and re-healed', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-heal-torn-'));
  const file = path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A partial write that died after the frontmatter: rev/manifest read as CURRENT, so
  // without the trailer check this file looked "fresh" forever and never healed.
  fs.writeFileSync(file, '---\nname: pidge\ndescription: Send rich stuff.\n# pidge-skill rev=22 manifest=16\n---\n\n# Pidge\n\nTRUNCATED MID-');

  const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const healed = fs.readFileSync(file, 'utf8');
  assert.ok(!/TRUNCATED MID-/.test(healed), 'the torn skill was regenerated');
  assert.match(healed.trimEnd(), /<!-- pidge-skill-end -->$/, 'the regenerated skill closes with the trailer');
  assert.match(stderr, /refreshed your local Pidge skill/, 'the heal narrated itself');
});

test('atomic self-heal — "pidge-skill" in body PROSE is not the marker: a marker-less skill still heals', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-heal-prose-'));
  const file = path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // No real marker in the frontmatter — but the body MENTIONS one with a huge rev.
  // The old first-line-containing scan read rev=99 and suppressed the heal forever.
  fs.writeFileSync(file, '---\nname: pidge\ndescription: Send rich stuff.\n---\n\nsee pidge-skill rev=99 manifest=99 for details\n\n<!-- pidge-skill-end -->\n');

  const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const healed = fs.readFileSync(file, 'utf8');
  assert.match(healed, /\n# pidge-skill rev=29 manifest=16\n/, 'a real marker was written by the heal');
  assert.ok(!/rev=99/.test(healed), 'the prose decoy is gone with the regeneration');
});

test('atomic self-heal — 4 concurrent heals never tear the file (atomic tmp+rename)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { dir, file } = seedNewSkill(0, 16, 'STALE FOR THE STAMPEDE');

  const outs = await Promise.all(
    Array.from({ length: 4 }, () => runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir).result),
  );
  await mock.stop();

  for (const o of outs) assert.equal(o.code, 0, `stderr: ${o.stderr}`);
  const healed = fs.readFileSync(file, 'utf8');
  assert.equal(healed.split('\n', 1)[0], '---', 'first line stays `---`');
  assert.equal((healed.match(/# pidge-skill rev=/g) || []).length, 1, 'exactly ONE marker — no interleaved halves');
  assert.match(healed, /\n# pidge-skill rev=29 manifest=16\n/, 'a whole, current skill won');
  assert.match(healed.trimEnd(), /<!-- pidge-skill-end -->$/, 'the trailer closes the file — no torn tail');
  const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'no tmp litter after concurrent heals');
});

test('atomic self-heal — a read-only skill dir degrades clean: the command succeeds, the file stands', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { dir, file } = seedNewSkill(0, 16, 'STALE BUT UNWRITABLE');
  const skillDir = path.dirname(file);
  const original = fs.readFileSync(file, 'utf8');
  fs.chmodSync(skillDir, 0o555);
  try {
    const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
    const { code, stderr } = await result;
    assert.equal(code, 0, `the user's command must survive the failed heal; stderr: ${stderr}`);
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'the stale file stands untouched — never half-written');
  } finally {
    fs.chmodSync(skillDir, 0o755);
    await mock.stop();
  }
});

test('atomic self-heal — healing over a CUSTOMIZED skill saves SKILL.md.bak + one stderr line', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { dir, file } = seedNewSkill(0, 16, 'MY CUSTOM NOTES — precious');

  const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const bak = path.join(path.dirname(file), 'SKILL.md.bak');
  assert.ok(fs.existsSync(bak), 'the previous content was backed up before the clobber');
  assert.match(fs.readFileSync(bak, 'utf8'), /MY CUSTOM NOTES — precious/, 'the .bak holds the clobbered content');
  assert.match(stderr, /SKILL\.md\.bak/, 'one stderr line points at the backup');
  assert.ok(!/MY CUSTOM NOTES/.test(fs.readFileSync(file, 'utf8')), 'the live skill is the regenerated one');
});

// --- listen --all — the single ear ---------------------------------------------

test('listen --all hears a notification answer and narrates which notification spoke back', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{
    id: 9, channel_id: 1, kind: 'notification_reply',
    body: 'sim, manda', text: 'sim, manda', action_id: 'reply',
    ref: { correlation_id: 'pricing-2', title: 'Aprovar preço?', thread_id: 'pricing', notification_status: 'completed', event_kind: 'replied' },
    created_at: 'x', consumed_at: null,
  }];

  const { result } = runCli(['listen', '--all', '--no-realtime', '--timeout', '10'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /notification_reply/);
  assert.match(stderr, /reply to your notification pricing-2 \("Aprovar preço\?"\)/);
});

test('listen WITHOUT --all keeps the composer-only contract (answers not served)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{
    id: 9, channel_id: 1, kind: 'notification_reply', body: 'sim',
    ref: { correlation_id: 'x', title: 'y' }, created_at: 'x', consumed_at: null,
  }];

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '6'], port);
  const { code } = await result;
  await mock.stop();

  assert.equal(code, 3, 'composer-only listen must time out — the answer is not its stream');
});

// --- ask obeys the template's suggested timeout ---------------------------------

test('ask without --timeout obeys the 201 suggested_ask_timeout and narrates it', async () => {
  const mock = createMock();
  const port = await mock.start();
  // answer immediately so the (1h) timeout never actually elapses
  mock.state.notifications['tpl-1'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'approve', label: 'Aprovar', text: null },
  };

  const { result } = runCli(
    ['ask', '--no-realtime', '--template', 'approval', '--title', 'Aprovar?', '--correlation-id', 'tpl-1'],
    port,
  );
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /timeout 60 min — suggested by template approval/);
  assert.equal(JSON.parse(stdout).action_id, 'approve');
});

test('an explicit --timeout always beats the template suggestion', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['tpl-2'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'approve', label: 'Aprovar', text: null },
  };

  const { result } = runCli(
    ['ask', '--no-realtime', '--template', 'approval', '--title', 'Aprovar?', '--correlation-id', 'tpl-2', '--timeout', '30'],
    port,
  );
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.doesNotMatch(stderr, /suggested by template/);
});

// --- hello = the first-contact WOW (template onboarding, send + wait) -----------

test('hello sends template=onboarding with default copy, narrates the WOW, returns the answer', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['wow-1'] = {
    responded: true,
    chosen_action: { kind: 'completed', action_id: 'done', label: 'Feito ✓', text: null },
  };

  const { result } = runCli(['hello', '--no-realtime', '--correlation-id', 'wow-1'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /WOW sent/);
  assert.equal(JSON.parse(stdout).action_id, 'done');
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.template, 'onboarding', 'hello must pin the onboarding template (the WOW trigger)');
  assert.ok(sent.title && sent.title.length > 0, 'hello supplies a default title');
});

test('hello --profile tracking is refused locally (the handshake needs an answer)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { result } = runCli(['hello', '--no-realtime', '--profile', 'tracking'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 1);
  assert.match(stderr, /tracking/);
});

// Hello no longer hangs the session: an unconfirmed handshake times out at
// --timeout (default 120s) with a NARRATED exit 3 (mirrors ask/wait), never eternal.
test('hello times out NARRATED with exit 3 when the human never confirms', async () => {
  const mock = createMock();
  const port = await mock.start();
  // No responded notification parked ⇒ the wait never resolves; --timeout ends it.
  const { result } = runCli(['hello', '--no-realtime', '--correlation-id', 'wow-timeout', '--timeout', '1', '--interval', '1'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 3, `a timed-out handshake is exit 3 (no answer yet), not a hang; stderr: ${stderr}`);
  assert.match(stderr, /no confirmation on wow-timeout/, 'the timeout is narrated, not silent');
  assert.match(stderr, /no answer yet/, 'and framed as waiting, not failure — the channel WAS healthy');
  assert.match(stderr, /pidge listen --all/, 'it points at where the confirmation will surface');
});

// `hello` had its OWN timeout line, which bypassed the health verdict: a debut
// on a channel that never completed one healthy round-trip reported "your human
// hasn't tapped yet" — the friendliest possible lie, on the first command an
// agent ever runs.
test('hello — a DEAF channel is blamed on the channel, not on the human (exit 4)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.pollStatus = 500; // the send lands; every poll after it fails
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-hello-health-'));
  seedHealthLedger(dir, 2, 3 * 60000); // two dead rounds already, 3 min back

  const { result } = runCli(['hello', '--no-realtime', '--correlation-id', 'wow-deaf', '--timeout', '3', '--interval', '1'],
    port, { XDG_CONFIG_HOME: dir });
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 4, `a deaf debut must escalate, not read as "not yet"; stderr: ${stderr}`);
  assert.match(stderr, /CHANNEL\/API path looks broken/);
  assert.ok(!/no answer yet/.test(stderr), 'never the waiting-on-your-human framing over a broken channel');
});

// --- tails: --follow + local custom-action id validation ------------------------

test('listen --follow prints+acks a batch and KEEPS listening, exit 0 at the window end', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 11, channel_id: 1, body: 'primeiro lote', created_at: 'x', consumed_at: null }];

  // --ack-on-read: a --follow supervisor that consumes inline (so the mock clears
  // between batches; without it the server lease would gate re-serve, unmodeled here).
  const { result } = runCli(['listen', '--follow', '--ack-on-read', '--no-realtime', '--timeout', '6', '--interval', '1'], port);
  await sleep(2500);
  // a second batch lands mid-window — a one-shot listen would have exited already
  mock.state.messages = [{ id: 12, channel_id: 1, body: 'segundo lote', created_at: 'x', consumed_at: null }];
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /primeiro lote/);
  assert.match(stdout, /segundo lote/, 'the follow window must deliver BOTH batches');
  assert.match(stderr, /--follow — still listening/);
  assert.match(stderr, /--follow window ended/);
  // The LOUD supervisor-only warning at startup (a turn-based agent traps its turn).
  assert.match(stderr, /supervisor mode/);
  assert.match(stderr, /must NOT use --follow/);
});

test('an invalid --custom-action id fails fast locally with the spelled-out rule', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(
    ['notify', '--title', 'x', '--custom-action', 'Não-Válido:Rótulo'],
    port,
  );
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 1);
  assert.match(stderr, /lowercase letters, digits and underscore only/);
  assert.equal(mock.state.notifies.length, 0, 'must not reach the server');
});

// --- shared-config guard (a cron agent once silently hijacked another channel's stored key) ---

test('setup REFUSES to overwrite a config owned by another live channel — and does not burn the claim code', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-guard-'));
  fs.mkdirSync(path.join(home, 'pidge'), { recursive: true });
  fs.writeFileSync(path.join(home, 'pidge', 'env'),
    `PIDGE_URL=http://127.0.0.1:${port}\nPIDGE_TOKEN=hld_existing_live\n`);

  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, nonGitCwd(),
  );
  const { code, stderr } = await result;

  assert.equal(code, 2);
  assert.match(stderr, /já guarda a chave de "mock"/);
  assert.match(stderr, /--force/);
  assert.match(stderr, /PIDGE_AGENT=/, 'the refusal leads with an agent-correct exit');
  assert.ok(!stderr.includes('--print'), 'the refusal must NOT offer --print to an agent (key would land in its context)');
  assert.equal(mock.state.claimCode, 'claim-ok', 'the single-use code must SURVIVE the refusal');
  const kept = fs.readFileSync(path.join(home, 'pidge', 'env'), 'utf8');
  assert.match(kept, /hld_existing_live/, 'the existing config must be untouched');
  await mock.stop();
});

test('setup --force overwrites; a REVOKED stored key needs no --force', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-guard-'));
  fs.mkdirSync(path.join(home, 'pidge'), { recursive: true });
  fs.writeFileSync(path.join(home, 'pidge', 'env'),
    `PIDGE_URL=http://127.0.0.1:${port}\nPIDGE_TOKEN=hld_revoked\n`);

  // dead key in the file ⇒ proceeds without --force
  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, nonGitCwd(),
  );
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const written = fs.readFileSync(path.join(home, 'pidge', 'env'), 'utf8');
  assert.match(written, /hld_minted_by_claim/);
});

// --- project-scoped identity (0.28): the multi-agent machine default -------------

test('THE INCIDENT, fixed: an occupied shared file does NOT block a project setup — no guard, no --force, isolated env', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-multi-'));
  // another agent (a cron, a sibling) owns the machine-shared file
  fs.mkdirSync(path.join(home, 'pidge'), { recursive: true });
  fs.writeFileSync(path.join(home, 'pidge', 'env'),
    `PIDGE_URL=http://127.0.0.1:${port}\nPIDGE_TOKEN=hld_existing_live\n`);
  const proj = makeProject();

  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, proj,
  );
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `the pasted prompt must just work on a multi-agent machine; stderr: ${stderr}`);
  assert.match(fs.readFileSync(projectEnvPath(home, proj), 'utf8'), /hld_minted_by_claim/);
  const shared = fs.readFileSync(path.join(home, 'pidge', 'env'), 'utf8');
  assert.match(shared, /hld_existing_live/, "the sibling's shared config must be untouched");
});

test('two projects on one machine get two isolated envs; a subdir resolves its project env by walk-up', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-two-'));
  const projA = makeProject();
  const projB = makeProject();

  let out = await runCli(['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, projA).result;
  assert.equal(out.code, 0, `project A setup: ${out.stderr}`);
  mock.state.claimCode = 'claim-b';
  out = await runCli(['setup', '--claim', 'claim-b', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, projB).result;
  assert.equal(out.code, 0, `project B setup must not collide with A: ${out.stderr}`);
  assert.ok(fs.existsSync(projectEnvPath(home, projA)), 'A has its own env');
  assert.ok(fs.existsSync(projectEnvPath(home, projB)), 'B has its own env');

  // a command run from a SUBDIR of A walks up to the toplevel and finds A's key
  const sub = path.join(projA, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  out = await runCli(['whoami'], port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, sub).result;
  await mock.stop();
  assert.equal(out.code, 0, `whoami from a subdir must resolve the project env: ${out.stderr}`);
  assert.match(out.stderr, /canal "mock"/);
});

test('legacy compat: inside a git project with NO project env, reads fall back to the shared file', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-legacy-'));
  fs.mkdirSync(path.join(home, 'pidge'), { recursive: true });
  fs.writeFileSync(path.join(home, 'pidge', 'env'),
    `PIDGE_URL=http://127.0.0.1:${port}\nPIDGE_TOKEN=hld_test\n`);

  const { result } = runCli(['whoami'], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, makeProject());
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `an existing shared-file install must keep working inside a repo: ${stderr}`);
  assert.match(stderr, /canal "mock"/);
});

test('setup --global inside a project targets the shared machine file (daemon/cron opt-in)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-global-'));
  const proj = makeProject();

  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--global', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, proj,
  );
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(fs.readFileSync(path.join(home, 'pidge', 'env'), 'utf8'), /hld_minted_by_claim/);
  assert.ok(!fs.existsSync(projectEnvPath(home, proj)), '--global must not write the project env');
});

test('setup --global conflicts with PIDGE_AGENT (exit 1, before any network)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-conflict-'));
  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--global', '--url', 'http://127.0.0.1:1'],
    1, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'alpha' },
  );
  const { code, stderr } = await result;
  assert.equal(code, 1);
  assert.match(stderr, /--global conflicts with PIDGE_AGENT/);
});

test('an ENV-TOKEN install never adopts a foreign project env (config bleed / pin bypass regression)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-envtok-'));
  const proj = makeProject();
  // a FOREIGN identity's project env pointing at a dead server
  const foreign = projectEnvPath(home, proj);
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.writeFileSync(foreign, 'PIDGE_URL=http://127.0.0.1:1\nPIDGE_TOKEN=hld_foreign\n');
  // the shared file carries this install's URL (no token — the token rides the env)
  fs.mkdirSync(path.join(home, 'pidge'), { recursive: true });
  fs.writeFileSync(path.join(home, 'pidge', 'env'), `PIDGE_URL=http://127.0.0.1:${port}\n`);

  // PIDGE_TOKEN in the env = fully-specified identity; cwd inside the foreign
  // project must NOT flip its config (URL, state.json, fingerprint) to the
  // project scope — pre-0.28.0-fix this resolved the dead URL and failed.
  const { result } = runCli(['whoami'], port,
    { PIDGE_TOKEN: 'hld_test', PIDGE_URL: '', XDG_CONFIG_HOME: home }, proj);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `env-token install must keep its own scope inside a foreign repo: ${stderr}`);
  assert.match(stderr, /canal "mock"/);
});

test("setup never bleeds a DIFFERENT scope's PIDGE_SECRET into the new project env", async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-secret-'));
  // the shared scope holds ANOTHER channel's E2E secret
  fs.mkdirSync(path.join(home, 'pidge'), { recursive: true });
  fs.writeFileSync(path.join(home, 'pidge', 'env'),
    `PIDGE_URL=http://127.0.0.1:${port}\nPIDGE_SECRET=SHARED_CHANNEL_SECRET_b64\n`);
  const proj = makeProject();

  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', PIDGE_SECRET: '', XDG_CONFIG_HOME: home }, proj,
  );
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const written = fs.readFileSync(projectEnvPath(home, proj), 'utf8');
  assert.ok(!written.includes('SHARED_CHANNEL_SECRET_b64'),
    "another scope's secret must never be bound to a new channel identity");
});

test("the clobber guard validates the target key against the TARGET file's own server (cross-server bypass regression)", async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-xsrv-'));
  const proj = makeProject();
  // the project env (the LOAD-time scope) points at a DEAD server…
  const projEnv = projectEnvPath(home, proj);
  fs.mkdirSync(path.dirname(projEnv), { recursive: true });
  fs.writeFileSync(projEnv, 'PIDGE_URL=http://127.0.0.1:1\nPIDGE_TOKEN=hld_project\n');
  // …while the shared file (the --global TARGET) holds a key LIVE on the mock
  fs.mkdirSync(path.join(home, 'pidge'), { recursive: true });
  fs.writeFileSync(path.join(home, 'pidge', 'env'),
    `PIDGE_URL=http://127.0.0.1:${port}\nPIDGE_TOKEN=hld_shared_live\n`);

  // no --url on purpose: the guard must reach the TARGET's server (the mock),
  // confirm the key is alive, and refuse — not misroute to the dead project URL.
  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--global'],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, proj,
  );
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 2, `the live shared key must block the --global clobber: ${stderr}`);
  assert.match(stderr, /já guarda a chave de "mock"/,
    "the guard must have CONFIRMED the owner with the target's server, not guessed from an unreachable one");
  assert.match(fs.readFileSync(path.join(home, 'pidge', 'env'), 'utf8'), /hld_shared_live/);
});

test('doctor on a project-scoped install narrates "(this project)" and never scolds it as the SHARED file', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-docproj-'));
  const proj = makeProject();
  const projEnv = projectEnvPath(home, proj);
  fs.mkdirSync(path.dirname(projEnv), { recursive: true });
  fs.writeFileSync(projEnv, `PIDGE_URL=http://127.0.0.1:${port}\nPIDGE_TOKEN=hld_test\n`);

  const { result } = runCli(['doctor'], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, proj);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /\(this project\)/, 'the token source names the project scope');
  assert.ok(!stderr.includes('reading the SHARED file'),
    'a project-scoped identity is the FIX for the shared-file footgun — doctor must not re-warn it');
});

test('re-setup of the SAME project with a live key refuses with the project-flavored message; --force repoints', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-repoint-'));
  const proj = makeProject();

  let out = await runCli(['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, proj).result;
  assert.equal(out.code, 0, out.stderr);

  // the stored (rotated) key still authenticates as "mock" ⇒ the guard fires
  mock.state.claimCode = 'claim-two';
  out = await runCli(['setup', '--claim', 'claim-two', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, proj).result;
  assert.equal(out.code, 2, `a live project env must not be silently repointed: ${out.stderr}`);
  assert.match(out.stderr, /Este PROJETO já fala/);

  out = await runCli(['setup', '--claim', 'claim-two', '--force', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, proj).result;
  await mock.stop();
  assert.equal(out.code, 0, `--force must repoint the project: ${out.stderr}`);
});

// --- per-agent isolation: PIDGE_AGENT + setup --print ---------------------------

test('PIDGE_AGENT namespaces the config file so two agents never share an identity', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-agent-'));

  // agent "alpha" claims
  let r = runCli(['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'alpha' });
  let out = await r.result;
  assert.equal(out.code, 0, `alpha setup: ${out.stderr}`);
  const alphaEnv = path.join(home, 'pidge', 'agents', 'alpha', 'env');
  assert.ok(fs.existsSync(alphaEnv), 'alpha gets its own file');

  // a SECOND agent "mkt" claims — must NOT trip the guard (different file), no --force
  mock.state.claimCode = 'claim-mkt';
  r = runCli(['setup', '--claim', 'claim-mkt', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'mkt' });
  out = await r.result;
  await mock.stop();
  assert.equal(out.code, 0, `mkt setup must not collide: ${out.stderr}`);
  assert.ok(fs.existsSync(path.join(home, 'pidge', 'agents', 'mkt', 'env')), 'mkt gets a separate file');
  assert.ok(fs.existsSync(alphaEnv), "alpha's file is untouched");
});

test('setup --print emits export lines and writes NO file (per-agent, human-run)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-print-'));

  const { result } = runCli(['setup', '--claim', 'claim-ok', '--print', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home });
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /export PIDGE_TOKEN=hld_minted_by_claim/);
  assert.match(stdout, /export PIDGE_URL=/);
  assert.ok(!fs.existsSync(path.join(home, 'pidge', 'env')), '--print must not write the file');
  assert.match(stderr, /NÃO rode --print de dentro de um agente/);
  // 0.8.1: the post-setup doctor must NOT claim a config file it never wrote.
  assert.match(stderr, /not stored on disk/);
  assert.doesNotMatch(stderr, /token found \(.*pidge.*env\)/);
});

// --- setup → skill → hello fuse (graceful-degrade) ------------------------------

test('setup fuses the skill install + a `pidge hello` hint, exit 0', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-fuse-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-fuse-cwd-'));

  const { result } = runCli(['setup', '--claim', 'claim-ok', '--print', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, cwd);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /skill written/, 'the skill install ran as part of setup');
  assert.match(stderr, /pidge hello/, 'setup hints the first-contact handshake');
  // the skill TREE was actually written into cwd, generated from the (mock) manifest
  const { core, all } = installedSkill(cwd);
  assert.match(core, /## THE PICKER/);
  assert.match(all, /Approval has two paths/);
});

test('setup fuse — a manifest failure DEGRADES (one-line skip + hello hint), setup STILL exits 0, no USAGE dump', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.manifestStatus = 500; // the skill install can't read the manifest
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-fuse-fail-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-fuse-fail-cwd-'));

  const { result } = runCli(['setup', '--claim', 'claim-ok', '--print', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, cwd);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `setup must survive a skill-install failure; stderr: ${stderr}`);
  assert.match(stderr, /skill install skipped/, 'the failure is ONE stderr line');
  assert.match(stderr, /pidge hello/, 'the hello hint still prints');
  assert.ok(!fs.existsSync(path.join(cwd, '.claude', 'skills', 'pidge', 'SKILL.md')), 'no SKILL.md when the manifest read fails');
  // graceful-degrade invariant: never fall through to the global USAGE dump.
  assert.doesNotMatch(stderr, /send an iPhone notification to a human and block until they answer/);
});

// --- 0.9.0: Fix 2 (ack-after-work) + Fix 3 (degrade) + claim/contract ----------

test('--version prints the CLI version and exits 0 (was "Unknown option")', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { result } = runCli(['--version'], port);
  const { code, stdout } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('listen (0.9 default) DELIVERS without consuming + shows the ack-after-work notice', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 8, channel_id: 1, body: 'trabalho pendente', created_at: 'x' }];

  // Isolate the config dir so the once-per-install ack-notice stamp (Fix 2)
  // doesn't leak across runs — a fresh install must SEE the notice.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-ack-'));
  const { result } = runCli(['listen', '--no-realtime', '--timeout', '10'], port, { XDG_CONFIG_HOME: home });
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /trabalho pendente/);
  assert.equal(mock.state.acks.length, 0, 'the 0.9 default must NOT ack on read');
  assert.match(stderr, /DELIVERED \(gray/);
  assert.match(stderr, /pidge ack --up-to 8/);
});

test('the ack-after-work notice shows ONCE PER INSTALL — a second listen is silent (stamp)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-ack2-'));

  mock.state.messages = [{ id: 9, channel_id: 1, body: 'um', created_at: 'x' }];
  let out = await runCli(['listen', '--no-realtime', '--timeout', '10'], port, { XDG_CONFIG_HOME: home }).result;
  assert.match(out.stderr, /DELIVERED \(gray/, 'first run shows the notice');

  // a SECOND fresh process, same install (same XDG_CONFIG_HOME) → notice suppressed
  mock.state.messages = [{ id: 10, channel_id: 1, body: 'dois', created_at: 'x' }];
  out = await runCli(['listen', '--no-realtime', '--timeout', '10'], port, { XDG_CONFIG_HOME: home }).result;
  await mock.stop();
  assert.match(out.stdout, /dois/, 'second run still delivers');
  assert.doesNotMatch(out.stderr, /DELIVERED \(gray/, 'the notice is once-per-install, not every run');
});

test('ack --up-to processes (green); ack --renew heartbeats the lease', async () => {
  const mock = createMock();
  const port = await mock.start();

  let r = runCli(['ack', '--up-to', '8'], port);
  let out = await r.result;
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /processed 1 message/);

  r = runCli(['ack', '--up-to', '8', '--renew'], port);
  out = await r.result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /lease renewed on 1 message/);
});

// 0.53.3 (the round-3 zero-agent retest): the ack's "what next" line carries the server-MEASURED
// presence and the selftest proof — the round-3 agent read the old advice line,
// said "Relaunching now", ran nothing, and told its human a listener was live.
test('ack — the closing line prints the MEASURED presence and offers the selftest proof', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.listeningState = 'offline';

  const out = await runCli(['ack', '--up-to', '8', '--summary', 'done'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /Server-measured presence right now: OFFLINE\./, 'the truth, not advice');
  assert.match(out.stderr, /`pidge selftest` PROVES it/, 'the proof step rides the last line the agent reads');
  assert.match(out.stderr, /Never claim online from memory/, 'and the honesty rule is spelled out');
});

test('ack — an older server without listening_state degrades to the plain line (present-only probe)', async () => {
  const mock = createMock();
  const port = await mock.start();

  const out = await runCli(['ack', '--up-to', '8', '--summary', 'done'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /pidge: ✓ acked\. Relaunch your listener/, 'no phantom fragment on an old server');
  assert.ok(!/Server-measured/.test(out.stderr), 'the probe stays silent when the server does not answer it');
  assert.match(out.stderr, /`pidge selftest` PROVES it/, 'the proof offer does not depend on the probe');
});

// The OTHER round-3 path: hello ended by TIMEOUT (the human tapped late), and
// the old narration never mentioned the proof — the selftest word had zero
// occurrences in the whole transcript. The timeout is exactly when the agent
// decides what "online" means next, so the proof rides that narration too.
test('hello — the timeout narration launches the loop AND offers the selftest proof', async () => {
  const mock = createMock();
  const port = await mock.start();

  const out = await runCli(['hello', '--timeout', '1', '--interval', '1'], port).result;
  await mock.stop();
  assert.equal(out.code, 3, `timeout is "no answer yet", not a failure: ${out.stderr}`);
  assert.match(out.stderr, /handshake is DURABLE/, 'the durable framing stays');
  assert.match(out.stderr, /`pidge selftest` PROVES you are reachable/, 'the proof offer rides the timeout path');
});

// The green ✓✓ is EARNED. Two ways it used to be given away: an ack the server
// processed ZERO rows for, and an ack carrying no note at all (which the server
// files as "drained" — a tick that stands for nothing the human can read).
test('ack — 0 acked never gets the green line: it says nothing turned green', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.ackAcked = 0;
  mock.state.ackSkipped = 2;

  const out = await runCli(['ack', '--up-to', '8'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /0 acked/);
  assert.ok(!/green ✓✓/.test(out.stderr), 'nothing was processed — nothing turned green');
  assert.match(out.stderr, /skipped 2 message/, 'and the skipped rows are surfaced, not swallowed');
  assert.ok(!/pidge: ✓ acked\./.test(out.stderr), 'the closing line must not claim an ack either');
});

test('ack — a note-LESS ack says the server files it as drained, instead of promising green ✓✓', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['ack', '--up-to', '8'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /processed 1 message\(s\) with NO note/);
  assert.match(out.stderr, /DRAINED/);
  assert.ok(!/green ✓✓/.test(out.stderr), 'a mute ack does not get the green promise');
});

test('ack --summary — the ack that CAN say what happened keeps the green ✓✓', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['ack', '--up-to', '8', '--summary', 'reiniciei o worker'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /green ✓✓/);
  assert.match(out.stderr, /with a summary/);
});

// 0.26.0 stay-online nudges — presence is a LOOP (listen → handle → ack →
// RELAUNCH); the CLI says so at the moments an agent decides what to do next.
// stderr ONLY (stdout stays parseable JSON), and SUPPRESSED where the advice
// would be wrong (a --renew mid-task; a channel with a live consumer).
test('stay-online nudge: `ack` success says relaunch; `--renew` (mid-task heartbeat) stays silent', async () => {
  const mock = createMock();
  const port = await mock.start();

  let out = await runCli(['ack', '--up-to', '8'], port).result;
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /Relaunch your listener/);

  out = await runCli(['ack', '--up-to', '8', '--renew'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.doesNotMatch(out.stderr, /Relaunch your listener/, 'a renew means the task is STILL RUNNING — no relaunch advice');
});

test('stay-online nudge: doctor NEXT-nudges when NO consumer is live; SILENT when one is', async () => {
  const mock = createMock();
  const port = await mock.start();

  let out = await runCli(['doctor'], port).result;
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /NEXT — stay online/);

  mock.state.consumers = [{ fingerprint: 'fp_x', label: 'team-bridge', listening: true, live: true }];
  out = await runCli(['doctor'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.doesNotMatch(out.stderr, /NEXT — stay online/, 'a live consumer means someone IS online — nudging `listen` would bait a double-consume');
});

// `--summary` is a global BOOLEAN (inbox counts+latency). The ack command
// needs it as a STRING (attribution) — before the fix it parsed as boolean-true
// and dropped the text to an ignored positional (a SILENT no-op). Now the ack
// case re-parses its own argv so the value survives, and a bare --summary throws.
test('ack --ids --summary carries the summary into the ack body (never a silent no-op)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['ack', '--ids', '41,42', '--summary', 'reiniciei o worker'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(mock.state.ackBodies[0].ids, [41, 42], 'the ids still parse alongside the string summary');
  assert.equal(mock.state.ackBodies[0].summary, 'reiniciei o worker', 'the summary reaches the server');
  assert.match(out.stderr, /with a summary/);
});

test('ack --up-to --summary works too, and the summary is capped at 1000 chars', async () => {
  const mock = createMock();
  const port = await mock.start();
  const big = 'x'.repeat(1500);
  const out = await runCli(['ack', '--up-to', '9', '--summary', big], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.equal(mock.state.ackBodies[0].up_to, 9);
  assert.equal(mock.state.ackBodies[0].summary.length, 1000, 'the CLI caps the summary before it leaves the machine');
});

test('ack --summary with NO value is a usage error (exit 1), never a silent no-op', async () => {
  const mock = createMock();
  const port = await mock.start();
  // --summary immediately followed by another recognized flag → parseArgs sees
  // "argument missing" for the string option → usage error, no ack fired.
  const out = await runCli(['ack', '--ids', '5', '--summary'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, `a valueless --summary must fail loud; stderr: ${out.stderr}`);
  assert.match(out.stderr, /summary/i);
  assert.equal(mock.state.ackBodies.length, 0, 'nothing was acked on the usage error');
});

test('ack --summary "" (empty string) is a usage error too — no blank attribution', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['ack', '--ids', '5', '--summary', '   '], port).result;
  await mock.stop();
  assert.equal(out.code, 1, `a blank --summary must fail loud; stderr: ${out.stderr}`);
  assert.match(out.stderr, /needs a value/);
  assert.equal(mock.state.ackBodies.length, 0, 'nothing was acked');
});

test('`inbox --summary` still works (the boolean flag was not broken by the ack fix)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.inboxSummary = { total: 7, scope: 'channel', pending: 2, avg_response_seconds: 300 };
  const out = await runCli(['inbox', '--summary'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /"total":\s*7/, 'it hit the summary endpoint, not the list');
  assert.match(out.stderr, /7 sent \(channel\) — 2 pending/);
});

test('contract set declares operating_contract; contract show reads it back', async () => {
  const mock = createMock();
  const port = await mock.start();

  let r = runCli(['contract', 'set', 'listen_mode=turn_based'], port);
  let out = await r.result;
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /declared listen_mode="turn_based"/);
  assert.equal(mock.state.operatingContract.listen_mode.value, 'turn_based');

  r = runCli(['contract', 'show'], port);
  out = await r.result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /listen_mode/);
});

test('contract set NEVER prints the channel key to stdout (0.9.2 key-leak fix)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['contract', 'set', 'listen_mode=turn_based'], port).result;
  assert.equal(out.code, 0, out.stderr);
  // the PATCH response echoes the key; stdout must carry ONLY the operating_contract
  assert.doesNotMatch(out.stdout, /hld_/, 'the agent key must never land in stdout');
  assert.doesNotMatch(out.stderr, /hld_/, 'nor in stderr');
  const parsed = JSON.parse(out.stdout);
  assert.ok(parsed.operating_contract, 'stdout is clean JSON with operating_contract');
  await mock.stop();
});

test('contract set rejects an unknown key / bad value LOCALLY (exit 1, no round-trip)', async () => {
  const mock = createMock();
  const port = await mock.start();

  let out = await runCli(['contract', 'set', 'bogus_key=1'], port).result;
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /unknown operating_contract key/);

  // a wrong-typed enum value is also caught locally
  out = await runCli(['contract', 'set', 'listen_mode=sideways'], port).result;
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /must be one of: turn_based, persistent, external_daemon, always_on/);
  assert.equal(Object.keys(mock.state.operatingContract).length, 0, 'a bad key never reaches the server');

  // external_daemon is now ACCEPTED (reaches the server, exit 0)
  out = await runCli(['contract', 'set', 'listen_mode=external_daemon'], port).result;
  assert.equal(out.code, 0, out.stderr);

  await mock.stop();
});

test('setup DECLARES operating_contract — default turn_based, --listen-mode overrides', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-setup-oc-'));

  // default (non-interactive) → turn_based
  let out = await runCli(['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'oc' }).result;
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /declared listen_mode=turn_based/);
  assert.equal(mock.state.operatingContract.listen_mode.value, 'turn_based');
  assert.equal(mock.state.operatingContract.keep_connection_alive.value, false);

  // --listen-mode always_on → the supervisor declaration
  mock.state.claimCode = 'claim-2';
  mock.state.operatingContract = {};
  out = await runCli(['setup', '--claim', 'claim-2', '--force', '--listen-mode', 'always_on', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'oc2' }).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /declared listen_mode=always_on/);
  assert.equal(mock.state.operatingContract.listen_mode.value, 'always_on');
  assert.equal(mock.state.operatingContract.keep_connection_alive.value, true);
});

test('whoami reports HONEST reach AND SHOUTS on a claim swap (not just doctor)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-whoami-'));

  // agent "a" claims (gen 1), a DIFFERENT agent "b" claims (gen 2)
  await runCli(['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'a' }).result;
  mock.state.claimCode = 'claim-b';
  await runCli(['setup', '--claim', 'claim-b', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'b' }).result;

  mock.state.deviceReach = { total: 3, pushable: 2, deliverable: 1, apns_environment: 'production', by_environment: { production: 1, sandbox: 1 } };
  const out = await runCli(['whoami'], port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'a' }).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /will actually receive a push/, 'whoami reports deliverable reach');
  assert.match(out.stderr, /UNREACHABLE/);
  assert.match(out.stderr, /ANOTHER AGENT CLAIMED THIS CHANNEL/, 'whoami SHOUTS on a claim swap');
});

test('doctor EXITS 2 when devices exist but 0 are deliverable (a send reaches nobody)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.devices = 2;
  mock.state.deviceReach = { total: 2, pushable: 2, deliverable: 0, apns_environment: 'production', by_environment: { sandbox: 2 } };

  const out = await runCli(['doctor'], port).result;
  await mock.stop();
  assert.equal(out.code, 2, out.stderr);
  assert.match(out.stderr, /reaches nobody|BROKEN/);
});

test('ack rejects mixing --up-to and --ids (usage error, exit 1)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['ack', '--up-to', '8', '--ids', '1,2'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /not both/);
});

test('a server newer than KNOWN_MANIFEST_VERSION nudges ONCE on stderr (the CLI knows a fixed floor)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.manifestVersion = 199; // server advertises news the CLI doesn't know
  // isolate the per-install state cache so the 24h throttle can't leak
  // across suite runs (a re-run would otherwise suppress the nag and false-fail).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-nag-'));
  const out = await runCli(['doctor'], port, { XDG_CONFIG_HOME: home }).result;
  await mock.stop();
  assert.match(out.stderr, /manifest v199/, 'the version nudge fires when the server is ahead');
  // the nudge reframes as "new capabilities you can use NOW via --param" — a
  // thin-pipe CLI rarely needs a release on a server bump — NOT "your CLI is stale,
  // UPDATE it" as the headline action.
  assert.match(out.stderr, /thin pipe/, 'reframed as new capabilities, not a stale-CLI scold');
  assert.match(out.stderr, /--param/, 'tells the agent how to use the new field today');
  assert.doesNotMatch(out.stderr, /UPDATE the CLI/, 'updating is no longer the headline action');
  // the manifest is PUBLIC — the curl reads without a key; the Bearer is
  // shown only as the OPTIONAL way to also see the channel's own config.
  assert.match(out.stderr, /Authorization: Bearer \$PIDGE_TOKEN/);
});

test('doctor reports HONEST device reach and warns when pushable > deliverable', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.deviceReach = { total: 3, pushable: 2, deliverable: 1, apns_environment: 'production', by_environment: { production: 1, sandbox: 1 } };

  const { result } = runCli(['doctor'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.match(stderr, /will actually receive a push/);
  assert.match(stderr, /UNREACHABLE/);
});

test('claim ownership: doctor SHOUTS when another agent took the channel (generation bumped)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-claim-'));

  // agent "a" sets up + claims (generation 1, fingerprint Fa)
  let r = runCli(['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'a' });
  let out = await r.result;
  assert.equal(out.code, 0, `a setup: ${out.stderr}`);
  assert.match(out.stderr, /ownership claimed as "a" \(generation 1\)/);

  // a DIFFERENT agent "b" claims the SAME channel (different fingerprint) → generation 2
  mock.state.claimCode = 'claim-b';
  r = runCli(['setup', '--claim', 'claim-b', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'b' });
  out = await r.result;
  assert.equal(out.code, 0, `b setup: ${out.stderr}`);
  assert.match(out.stderr, /generation 2/);

  // agent "a" runs doctor → must SHOUT (stored gen 1 < server gen 2, different fingerprint)
  r = runCli(['doctor'], port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'a' });
  out = await r.result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /ANOTHER AGENT CLAIMED THIS CHANNEL/);
});

test('Fix 3 — repeated WS close 1006 DEGRADES to polling and still delivers (never deaf)', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('needs Node ≥22');
  const mock = createMock();
  const port = await mock.start();
  mock.state.wsMode = '1006'; // every WS connection drops abruptly, repeatedly
  mock.state.messages = [{ id: 14, channel_id: 1, body: 'sobrevive ao 1006', created_at: 'x' }];

  const { result } = runCli(['listen', '--realtime', '--timeout', '30'], port, { PIDGE_WS_BACKOFF_MS: '100' });
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /sobrevive ao 1006/);
  assert.match(stderr, /realtime unavailable|reconnecting/);
});

test('Fix 3 — repeated 1006 with NO message: REAL wall-clock on timeout (never the 28800s lie), runs to the deadline', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('needs Node ≥22');
  const mock = createMock();
  const port = await mock.start();
  mock.state.wsMode = '1006';

  const { result } = runCli(['listen', '--realtime', '--timeout', '4'], port, { PIDGE_WS_BACKOFF_MS: '100' });
  const started = Date.now();
  const { code, stderr } = await result;
  const elapsedMs = Date.now() - started;
  await mock.stop();

  assert.equal(code, 3, `stderr: ${stderr}`);
  const m = stderr.match(/after (\d+)s/);
  assert.ok(m, `expected a REAL-elapsed timeout line, got: ${stderr}`);
  assert.ok(Number(m[1]) < 30, `elapsed must be the REAL wall-clock, got ${m[1]}s`);
  assert.ok(!stderr.includes('28800'), 'must NEVER print the configured-deadline lie');
  assert.ok(elapsedMs >= 2500, `must run to the ~4s deadline, not bail when WS gave up (~0.6s); ran ${elapsedMs}ms`);
});

test('doctor warns when reading the SHARED legacy file (no PIDGE_AGENT, no env var)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-shared-'));
  fs.mkdirSync(path.join(home, 'pidge'), { recursive: true });
  fs.writeFileSync(path.join(home, 'pidge', 'env'),
    `PIDGE_URL=http://127.0.0.1:${port}\nPIDGE_TOKEN=hld_shared\n`);

  const { result } = runCli(['doctor'], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home });
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.match(stderr, /SHARED file/);
  assert.match(stderr, /PIDGE_AGENT/);
});

// Reachability self-test. The verdict is the SERVER's, and the CLI never
// consumes its own nonce: it fires, watches GET /selftest/:id read-only, and
// PASSES only when something ELSE acked it. The old loop leased the queue and
// acked the nonce itself, then reported "your listener received the nonce" on
// channels where nothing was listening at all.
test('selftest — PASS only when ANOTHER consumer acks the nonce inside the window', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.selftestAckedAfterMs = 300; // a real listener out there picks it up
  const { result } = runCli(['selftest', '--window', '10', '--no-realtime'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();
  assert.equal(code, 0, `expected PASS exit 0, got ${code}; stderr: ${stderr}`);
  assert.match(stderr, /SELF-TEST PASSED/);
  assert.match(stderr, /OTHER than this command/, 'the PASS says WHO proved it');
  assert.match(stdout, /"status":\s*"passed"/);
  assert.equal(mock.state.acks.length, 0, 'the CLI itself never acks — the ack in this test is the other consumer\'s, server-side');
});

test('selftest — with NOTHING listening it FAILS and says the wire is all it proved', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.consumers = []; // the server reports zero live consumers
  const { result } = runCli(['selftest', '--window', '5', '--no-realtime'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();
  assert.equal(code, 2, `expected FAIL exit 2, got ${code}; stderr: ${stderr}`);
  assert.match(stderr, /SELF-TEST FAILED/);
  assert.match(stderr, /nothing is listening/, 'it names the real cause');
  assert.match(stderr, /proved the WIRE/, 'and says exactly what the run DID prove');
  assert.ok(!/ORPHANED/.test(stderr), 'no orphan/detached-listener story when there is no listener at all');
  assert.match(stdout, /"consumers_live":\s*0/);
});

// `live` outlives `listening` by ~10 minutes (the consumer row stays live for
// that long after the last consume). So for ten minutes after a loop dies the
// server still lists it, and the selftest used to blame "1 consumer live and
// none acked (deaf)" when the truth was that nothing was listening at all —
// the misdiagnosis that sends you debugging a handler you no longer have.
test('selftest — a consumer that is live-but-NOT-listening is nothing listening, not a deaf loop', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.consumers = [{ label: 'bridge-bot', live: true, listening: false }];
  const { result } = runCli(['selftest', '--window', '5', '--no-realtime'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();
  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.match(stderr, /nothing is listening/, 'the stale live row is not a listener');
  assert.ok(!/ARE live/.test(stderr), 'and it must NOT be blamed as a deaf consumer');
  assert.match(stdout, /"consumers_live":\s*0/);
});

// An OLD server sends no `listening` field at all. There we keep today's
// answer: a `live` row still counts. Reporting an empty channel we cannot
// actually see would be a worse lie than the one above.
test('selftest — an old server (no `listening` field) still counts a live consumer', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.consumers = [{ label: 'bridge-bot', live: true }];
  const { result } = runCli(['selftest', '--window', '5', '--no-realtime'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();
  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.match(stderr, /1 consumer\(s\) ARE live/);
  assert.match(stdout, /"consumers_live":\s*1/);
});

test('selftest — a LIVE but deaf consumer is blamed differently from an empty channel', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.consumers = [{ label: 'bridge-bot', live: true, listening: true }]; // holding the queue NOW, and never acks
  const { result } = runCli(['selftest', '--window', '5', '--no-realtime'], port);
  const { code, stderr } = await result;
  await mock.stop();
  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.match(stderr, /1 consumer\(s\) ARE live/, 'a live consumer that never acks is a DIFFERENT diagnosis');
  assert.match(stderr, /READS without acking|deaf/, 'and it names the shape of the bug');
});

// The selftest is now READ-ONLY on the queue: it must never serve, lease or
// consume a real message. The old one read `all=true&lease=60` and acked.
test('selftest never touches the queue: no consume read, no ack, nothing leased', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.leaseMs = 600000; // the server's ~10-min visibility lease
  mock.state.messages = [
    { id: 42, kind: 'message', body: 'resposta real do humano', created_at: 'x' },
    { id: 200, kind: 'message', body: 'chegou durante a janela', created_at: 'x' }, // id > the nonce (seq starts at 100)
  ];
  mock.state.selftestAckedAfterMs = 300;

  const { result } = runCli(['selftest', '--window', '10', '--no-realtime'], port);
  const { code, stderr } = await result;
  assert.equal(code, 0, `the selftest itself must still PASS; stderr: ${stderr}`);

  for (const id of [42, 200]) {
    const row = mock.state.messages.find((m) => m.id === id);
    assert.ok(row, `message ${id} is still in the queue`);
    assert.equal(row._leasedUntil, undefined,
      `message ${id} was never served or leased — the selftest reads the VERDICT, not the queue`);
  }
  assert.deepEqual(mock.state.messageReads, [], 'it never reads GET /messages at all');
  assert.equal(mock.state.acks.length, 0, 'and it never POSTs an ack of its own');
  await mock.stop();
});

test('selftest — a non-numeric --window falls back to the default, never a false FAIL', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.selftestAckedAfterMs = 300;
  const { result } = runCli(['selftest', '--window', '30s', '--no-realtime'], port); // typo'd window
  const { code, stderr } = await result;
  await mock.stop();
  assert.equal(code, 0, `a typo'd window must not masquerade as a dead listener; stderr: ${stderr}`);
  assert.match(stderr, /SELF-TEST PASSED/);
});

// A verdict we could not READ says nothing about the listener. It used to fall
// through into FAILED and blame an "ORPHANED/detached listener" for a 500.
test('selftest — an unreadable verdict is INCONCLUSIVE, never blamed on the listener', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.selftestStatus = 500; // the verdict endpoint is broken
  const { result } = runCli(['selftest', '--window', '5', '--no-realtime'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();
  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.match(stderr, /INCONCLUSIVE/);
  assert.match(stderr, /couldn't be READ/);
  assert.ok(!/SELF-TEST FAILED/.test(stderr), 'a broken read is not a failed listener');
  assert.match(stdout, /"reason":\s*"verdict_unreadable"/);
});

test('listen exit 3 points at `pidge catchup` (a message may be under another read\'s lease)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { result } = runCli(['listen', '--no-realtime', '--timeout', '2', '--interval', '1'], port);
  const { code, stderr } = await result;
  await mock.stop();
  assert.equal(code, 3, `stderr: ${stderr}`);
  assert.match(stderr, /pidge catchup/, 'the exit-3 hint names the read-only diagnostic');
  assert.match(stderr, /lease/i, 'and explains WHY a message might be invisible');
});

// --- 0.12.0 — CLI bugs batch ---------------------------------------------------

// `pidge <sub> --help` must show the SUBCOMMAND's own help, not the global
// USAGE dump (help exits before any network — no mock server needed).
test('subcommand help — `pidge ask --help` shows the subcommand help (own flags), not the global dump', async () => {
  const out = await runCli(['ask', '--help'], 1).result;
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /^pidge ask —/, 'leads with the focused ask header');
  assert.match(out.stdout, /--actions LIST\|JSON/, "lists ask's own --actions flag");
  assert.match(out.stdout, /--timeout SECONDS/, 'and --timeout');
  assert.doesNotMatch(out.stdout, /pidge setup --claim CODE/, 'must NOT be the global command list');
});

test('subcommand help — other subcommands get their own focused help too (notify / wait / listen / inbox / ack)', async () => {
  const cases = [
    ['notify', /^pidge notify —/, /--body-markdown MD/],
    ['wait', /^pidge wait —/, /pidge wait <correlation_id>/],
    ['listen', /^pidge listen —/, /--follow/],
    ['inbox', /^pidge inbox —/, /--summary/],
    ['ack', /^pidge ack —/, /--up-to ID/],
    ['online', /^pidge online —/, /listen --all/],
  ];
  for (const [cmd, header, flag] of cases) {
    const out = await runCli([cmd, '--help'], 1).result;
    assert.equal(out.code, 0, `${cmd} --help: ${out.stderr}`);
    assert.match(out.stdout, header, `${cmd} leads with its focused header`);
    assert.match(out.stdout, flag, `${cmd} lists its own flag`);
    assert.doesNotMatch(out.stdout, /pidge setup --claim CODE/, `${cmd} is not the global dump`);
  }
});

test('subcommand help — `pidge --help` (no command) keeps the global overview; `pidge help ask` is focused', async () => {
  let out = await runCli(['--help'], 1).result;
  assert.equal(out.code, 0);
  assert.match(out.stdout, /pidge setup --claim CODE/, 'global --help lists all commands');

  out = await runCli(['help', 'ask'], 1).result;
  assert.equal(out.code, 0);
  assert.match(out.stdout, /^pidge ask —/, '`pidge help <cmd>` is the focused form');
});

// --- the help only ANNOUNCES Terminals to a computer that installed it ------
//
// The commands never move: `pidge terminal …` typed on purpose still runs
// everywhere, and its own help still answers. What is gated is the VOLUNTEERING
// — a person who never installed the feature must not read about panes, mirrors
// or Agent Sessions in the overview of a notification CLI. runCli already gives
// every spawn a fresh XDG_CONFIG_HOME/HOME, so "no daemon" is the default here;
// a slot is seeded by hand for the other half.

// The vendored tree the service runs — one half of "Terminals lives here" (the
// daemon config is the other; either one is enough).
function seedDaemonSlot() {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-slot-'));
  const dir = path.join(xdg, 'pidge', 'terminal', 'cli', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pidge.js'), '#!/usr/bin/env node\n');
  return xdg;
}

// The FEATURE, not the word: "in YOUR terminal", the `:terminal` custom-action
// flag and the app's E2E "TERMINAL step" are shells and wire fields that survive
// on every machine — only these say Terminals exists.
const TERMINAL_MENTIONS = [/pidge terminal/, /Agent Sessions/i, /TERMINALS: share/, /tmux/i, /mirror(ing|ed|s)?\b/i];

test('help — a computer with NO Terminals daemon is never told the feature exists', async () => {
  const out = await runCli(['--help'], 1).result;
  assert.equal(out.code, 0);
  for (const re of TERMINAL_MENTIONS) {
    assert.doesNotMatch(out.stdout, re, `the overview volunteers nothing about Terminals (${re})`);
  }
  // …and nothing ELSE was lost with it: the overview is the same document.
  assert.match(out.stdout, /pidge setup --claim CODE/);
  assert.match(out.stdout, /pidge update {2,}/, 'update is still listed — only its Terminals aside is gone');
  assert.match(out.stdout, /pidge bridge --exec/);
  assert.match(out.stdout, /Full spec \(the contract/);
});

test('help — with the daemon slot present the overview is the FULL one, Terminals block and all', async () => {
  const out = await runCli(['--help'], 1, { XDG_CONFIG_HOME: seedDaemonSlot() }).result;
  assert.equal(out.code, 0);
  assert.match(out.stdout, /pidge terminal <sub> {2,}TERMINALS: share a tmux PANE/);
  assert.match(out.stdout, /Run exactly this one bash command and nothing/, 'the enable recipe rides the block');
  assert.match(out.stdout, /`terminal connect` nudges you here/, 'and the update line points back at it');
});

test('help — PIDGE_TERMINAL_HELP=1 forces the full overview on a machine with no daemon', async () => {
  const out = await runCli(['--help'], 1, { PIDGE_TERMINAL_HELP: '1' }).result;
  assert.equal(out.code, 0);
  assert.match(out.stdout, /pidge terminal <sub> {2,}TERMINALS: share a tmux PANE/);
  assert.match(out.stdout, /`terminal connect` nudges you here/);
});

test('help — the focused helps follow the same rule (update, setup), and `terminal --help` always answers', async () => {
  let out = await runCli(['update', '--help'], 1).result;
  assert.equal(out.code, 0);
  assert.doesNotMatch(out.stdout, /terminal connect/, 'update stops naming a caller this computer does not have');
  assert.match(out.stdout, /installs `pidge-cli@latest` globally/, 'the rest of its story is untouched');

  out = await runCli(['setup', '--help'], 1).result;
  assert.equal(out.code, 0);
  assert.doesNotMatch(out.stdout, /--from-computer/, 'a derivation that needs a paired computer stays unadvertised');
  assert.match(out.stdout, /--claim CODE/);

  const xdg = seedDaemonSlot();
  out = await runCli(['update', '--help'], 1, { XDG_CONFIG_HOME: xdg }).result;
  assert.match(out.stdout, /`pidge terminal connect` runs the same check/);
  out = await runCli(['setup', '--help'], 1, { XDG_CONFIG_HOME: xdg }).result;
  assert.match(out.stdout, /--from-computer/);

  // Typing the command IS knowing about it — its help never hides.
  out = await runCli(['terminal', '--help'], 1).result;
  assert.equal(out.code, 0);
  assert.match(out.stdout, /^pidge terminal —/);
  assert.match(out.stdout, /pidge terminal connect --code CODE/);
});

// The manifest-version nag is throttled to once / 24h (per-install cache).
test('version nag — fires ONCE then is throttled: 5 runs in a row = 1 nag', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.manifestVersion = 199;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-nag5-'));

  let nags = 0;
  for (let i = 0; i < 5; i++) {
    const out = await runCli(['doctor'], port, { XDG_CONFIG_HOME: home }).result;
    if (/manifest v199/.test(out.stderr)) nags++;
  }
  await mock.stop();
  assert.equal(nags, 1, 'the nag must be throttled to once per 24h, not once per call');
});

test('version nag — --quiet-nag and PIDGE_QUIET_NAG=1 silence the nag entirely', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.manifestVersion = 199;

  // --quiet-nag flag (fresh home so the throttle isn't what's hiding it)
  let home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-quiet-'));
  let out = await runCli(['doctor', '--quiet-nag'], port, { XDG_CONFIG_HOME: home }).result;
  assert.doesNotMatch(out.stderr, /manifest v199/, '--quiet-nag silences the nag');

  // PIDGE_QUIET_NAG=1 env, again a fresh home
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-quiet2-'));
  out = await runCli(['doctor'], port, { XDG_CONFIG_HOME: home, PIDGE_QUIET_NAG: '1' }).result;
  assert.doesNotMatch(out.stderr, /manifest v199/, 'PIDGE_QUIET_NAG=1 silences the nag');
  await mock.stop();
});

// --actions accepts a JSON array of custom {id,label} actions.
test('--actions accepts a JSON array of custom {id,label} actions', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(
    ['notify', '--title', 'Deploy?', '--actions',
      '[{"id":"approve","label":"Aprovar agora"},{"id":"defer","label":"Deixa pra amanhã"}]'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const sent = mock.state.notifies.at(-1);
  assert.deepEqual(sent.custom_actions, [
    { id: 'approve', label: 'Aprovar agora' },
    { id: 'defer', label: 'Deixa pra amanhã' },
  ]);
  assert.equal(sent.actions, undefined, 'the JSON form does not also set the short actions list');
});

test('--actions — the short comma form still works (compat retro)', async () => {
  const mock = createMock();
  const port = await mock.start();
  // (yes,no,reply would now be REFUSED by the decision+reply guard — use a decision-only combo.)
  const out = await runCli(['notify', '--title', 'x', '--actions', 'yes,no,later'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const sent = mock.state.notifies.at(-1);
  assert.deepEqual(sent.actions, ['yes', 'no', 'later']);
  assert.equal(sent.custom_actions, undefined);
});

test('JSON --actions composes with --custom-action (both appended)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(
    ['notify', '--title', 'x', '--actions', '[{"id":"approve","label":"Aprovar"}]',
      '--custom-action', 'defer:Depois'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const sent = mock.state.notifies.at(-1);
  assert.deepEqual(sent.custom_actions.map((c) => c.id), ['approve', 'defer']);
});

test('malformed JSON in --actions fails fast LOCALLY (exit 1, no send)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['notify', '--title', 'x', '--actions', '[{"id":"approve"'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /looks like JSON but didn't parse/);
  assert.equal(mock.state.notifies.length, 0, 'must not reach the server');
});

test('a JSON --actions item missing id/label is rejected locally with the spelled-out rule', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['notify', '--title', 'x', '--actions', '[{"label":"no id"}]'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /is invalid|label is required/);
  assert.equal(mock.state.notifies.length, 0);
});

// The generated skill carries the always-on recipe for turn-based agents.
test('skill install includes the always-on recipe for turn-based agents', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-skill244-'));

  const child = spawn(process.execPath, [CLI, 'skill', 'install'], {
    cwd: dir,
    // isolate HOME so `skill install` (and its self-heal path) never touches the real ~/.claude.
    env: { ...process.env, PIDGE_URL: `http://127.0.0.1:${port}`, PIDGE_TOKEN: 'hld_test', HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-home-')) },
  });
  const out = await new Promise((resolve) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  await mock.stop();

  assert.equal(out.code, 0, out.stderr);
  const skill = installedSkill(dir).all; // a fact may live in the core or in a reference
  assert.match(skill, /always-on/i, 'the recipe section is present');
  assert.match(skill, /pidge listen --follow/, 'the interactive window is still taught');
  assert.match(skill, /pidge listen --all --exec/, 'the loop leads with the handler form');
  assert.match(skill, /--exec '<handler>' --timeout 50/, 'the supervisor poll runs one --exec round per tick');
  // the exec contract, in the words an agent needs: the exit code IS the ack,
  // and a dead handler surfaces on stdout instead of a silent green.
  assert.match(skill, /exit code decide/i, 'the handler exit code owns the ack');
  assert.match(skill, /handler_failed/, 'a failed handler surfaces on stdout, not in silence');
  assert.match(skill, /pidge-summary:/, 'the marker line is the only source of the note');
  // the stdout contract (so nobody writes a line-by-line parser for the array)
  assert.match(skill, /never parse it line by line/i, 'the pretty-array contract is spelled out');
  assert.match(skill, /--ndjson/, 'the line-oriented alternative is named');
  assert.match(skill, /ackable ⇔ the object has an `id`/i, 'the one rule for what can be acked');
  // an ack that claims work nobody did is the dishonest signal this rev exists to kill
  assert.match(skill, /MUTE ack/, 'a note-less loop ack is named for what it is');
  assert.match(skill, /drained/, 'and named as the server sees it');
});

// A wait is a SECOND consumer of your own channel — the skill must say so, and
// say what to do instead (send-and-go, collect through the loop).
test('skill teaches the wait-under-a-live-listener asymmetry + the step-by-step section', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-skill-asym-'));

  const child = spawn(process.execPath, [CLI, 'skill', 'install'], {
    cwd: dir,
    env: { ...process.env, PIDGE_URL: `http://127.0.0.1:${port}`, PIDGE_TOKEN: 'hld_test', HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-home-')) },
  });
  const out = await new Promise((resolve) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  await mock.stop();

  assert.equal(out.code, 0, out.stderr);
  const skill = installedSkill(dir).all; // a fact may live in the core or in a reference
  assert.match(skill, /includes your OWN second process/i, 'the asymmetry is stated as a rule, not an aside');
  assert.match(skill, /send-and-go/, 'and the way out is named');
  assert.match(skill, /consumer lock/, 'the mechanism (the lock) is taught, not just the etiquette');
  // the step-by-step doctrine (one send = one actionable step; ask for a print)
  assert.match(skill, /## Guiding a human step by step/, 'the new section is present');
  assert.match(skill, /One send = one actionable step/i);
  assert.match(skill, /screenshot|print/i, 'asking for a print is part of it');
});

// The skill must TEACH `pidge bridge` + `ack --summary`, carry the
// multi-agent PIDGE_AGENT block, and ship the 3 prose fixes. Live agents on rev 8
// found: bridge = 0 hits, `ack --summary` only as an effect, examples without
// PIDGE_AGENT speak the wrong channel on a multi-agent host.
test('skill teaches bridge, ack --summary, the PIDGE_AGENT block + the prose fixes', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-skill6867-'));

  const child = spawn(process.execPath, [CLI, 'skill', 'install'], {
    cwd: dir,
    // isolate HOME so `skill install` (and its self-heal path) never touches the real ~/.claude.
    env: { ...process.env, PIDGE_URL: `http://127.0.0.1:${port}`, PIDGE_TOKEN: 'hld_test', HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-home-')) },
  });
  const out = await new Promise((resolve) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  await mock.stop();

  assert.equal(out.code, 0, out.stderr);
  const skill = installedSkill(dir).all; // a fact may live in the core or in a reference
  // the bridge section (was 0 hits on rev 8)
  assert.match(skill, /pidge bridge/, 'the supervisor section names `pidge bridge`');
  assert.match(skill, /bridge --exec/, 'bridge --exec is taught');
  assert.match(skill, /bridge install/, 'bridge install is taught');
  assert.match(skill, /Claude resumes within a day/);
  assert.match(skill, /Codex\/Gemini start fresh with catchup/);
  assert.doesNotMatch(skill, /a resumed model session that remembers earlier batches/);
  // ack --summary as a COMMAND, not just an effect
  assert.match(skill, /ack --up-to <id> --summary/, 'ack --summary shown as a command');
  // the multi-agent block, early and explicit
  assert.match(skill, /PIDGE_AGENT=<your-id>/, 'the PIDGE_AGENT multi-agent block is present');
  assert.match(skill, /agents\/<your-id>\/env/, 'the per-agent config path is named');
  // durable-queue framing replaces the fatalist line
  assert.ok(!/or you lose it/.test(skill), 'the fatalist "or you lose it" line is gone');
  assert.match(skill, /what you lose is TIME, not the message/, 'the queue-is-durable framing is in');
  // human's language, not English-only. This is WRITING doctrine, so it lives in
  // the pidge-report companion — the skill an agent reads while composing.
  assert.ok(!/English only/.test(skill), 'the "English only" line is gone');
  assert.match(installedSkill(dir).report, /mirror the language they use/, 'the human\'s-language guidance is in');
  // the turn-based example spans more than one harness
  assert.match(skill, /Claude Code, Codex, Gemini CLI/, 'the turn-based example is no longer a single harness');
});

// The session-start ritual in the skill now recommends the O(new) digest read.
test('skill recommends `pidge catchup --digest --since <last>` as the session-start read', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-skill70-'));

  const child = spawn(process.execPath, [CLI, 'skill', 'install'], {
    cwd: dir,
    // isolate HOME so `skill install` (and its self-heal path) never touches the real ~/.claude.
    env: { ...process.env, PIDGE_URL: `http://127.0.0.1:${port}`, PIDGE_TOKEN: 'hld_test', HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-home-')) },
  });
  const out = await new Promise((resolve) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  await mock.stop();

  assert.equal(out.code, 0, out.stderr);
  const skill = installedSkill(dir).all; // a fact may live in the core or in a reference
  assert.match(skill, /pidge catchup --digest --since <last>/, 'the session-start ritual uses the incremental digest read');
  assert.match(skill, /pidge catchup --digest --since 480/, 'a concrete --since example is shown');
});

// --- 0.13.0 — template system: type subcommands + skill ------------------------

// 1) one spec per typed send — each stamps the right template_kind on /notify.

test('typed sends — pidge message stamps template_kind:message and fire-and-forgets', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['message', '--title', 'Build done', '--body', '2m12s'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.template_kind, 'message');
  assert.equal(sent.title, 'Build done');
});

test('typed sends — pidge important (⭐ default) stamps template_kind:important', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['important', '--title', 'Review PR', '--body-markdown', '# Summary'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.equal(mock.state.notifies.at(-1).template_kind, 'important');
});

test('typed sends — pidge ask is the shortcut for important + --wait (template_kind:important)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['ask-1'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'yes', label: 'Sim', text: null },
  };
  const out = await runCli(
    ['ask', '--no-realtime', '--title', 'Approve deploy?', '--actions', 'yes,no', '--correlation-id', 'ask-1'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).action_id, 'yes');
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.template_kind, 'important', 'ask now sends the canonical `important` (no `ask` type in the married catalog)');
  assert.deepEqual(sent.actions, ['yes', 'no']);
});

test('typed sends — pidge event stamps template_kind:event with event_at + lead_minutes', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(
    ['event', '--title', 'Sprint review', '--event-at', '2026-06-26T14:00-03:00', '--lead-minutes', '15'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.template_kind, 'event');
  assert.equal(sent.event_at, '2026-06-26T14:00-03:00');
  assert.equal(sent.lead_minutes, 15);
});

test('typed sends — pidge urgent stamps template_kind:urgent; --escalate adds escalate:true', async () => {
  const mock = createMock();
  const port = await mock.start();

  // plain urgent: escalate is NOT set
  let out = await runCli(['urgent', '--title', '503 spike'], port).result;
  assert.equal(out.code, 0, out.stderr);
  let sent = mock.state.notifies.at(-1);
  assert.equal(sent.template_kind, 'urgent');
  assert.equal(sent.escalate, undefined, 'no --escalate ⇒ no escalate flag');

  // urgent --escalate: escalate:true rides the payload
  out = await runCli(['urgent', '--title', 'API down', '--escalate'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  sent = mock.state.notifies.at(-1);
  assert.equal(sent.template_kind, 'urgent');
  assert.equal(sent.escalate, true);
});

test('typed sends — pidge live no longer stamps a /notify send; it starts a REAL card', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['live', '--title', 'Deploy v3.2 — building...'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.equal(mock.state.notifies.length, 0, 'the silent /notify degrade is dead');
  assert.equal(mock.state.liveWrites.at(-1).body.title, 'Deploy v3.2 — building...');
});

// --- the RESPONSE axis (--wait) composes on ANY type ----------------------------

test('typed sends — --wait on a normal type blocks until the answer and prints chosen_action', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['imp-wait'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'yes', label: 'Sim', text: null },
  };
  const out = await runCli(
    ['important', '--wait', '--no-realtime', '--title', 'Can I proceed?', '--actions', 'yes,no', '--correlation-id', 'imp-wait'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).action_id, 'yes', '--wait prints chosen_action JSON to stdout');
  assert.equal(mock.state.notifies.at(-1).template_kind, 'important');
});

test('typed sends — WITHOUT --wait a typed send is fire-and-forget (prints the raw 201, exits 0)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['important', '--title', 'fyi-ish', '--actions', 'yes,no'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  // stdout is the raw 201 (has a correlation_id / status), NOT a chosen_action
  const parsed = JSON.parse(out.stdout);
  assert.ok(parsed.status || parsed.correlation_id, 'fire-and-forget prints the 201');
  assert.equal(parsed.action_id, undefined, 'no chosen_action without --wait');
});

test('typed sends — `live --wait` is refused locally (status-only, never answers)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['live', '--wait', '--title', 'Deploy'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /can't --wait|status-only/);
  assert.equal(mock.state.notifies.length, 0, 'must not reach the server');
});

// --- the approval RECIPE (important + Approve/Reject + Face ID + --wait) --------

test('typed sends — pidge approval injects Approve(Face ID)/Reject, waits, prints chosen_action', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['appr-1'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'grant', label: 'Approve', text: null },
  };
  const out = await runCli(
    ['approval', '--no-realtime', '--title', 'Deploy to production?', '--correlation-id', 'appr-1'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).action_id, 'grant');
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.template_kind, 'important', 'approval is the important type under the hood');
  // the default pair: Approve gated by Face ID (custom id avoids the built-in collision), Reject destructive
  assert.deepEqual(sent.custom_actions, [
    { id: 'grant', label: 'Approve', biometric: true, terminal: true },
    { id: 'deny', label: 'Reject', style: 'destructive', terminal: true },
  ]);
  assert.equal(sent.actions, undefined, 'approval uses custom_actions, not built-in actions');
});

test('typed sends — pidge approval lets the user OVERRIDE the default pair', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['appr-2'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'yes', label: 'Sim', text: null },
  };
  const out = await runCli(
    ['approval', '--no-realtime', '--title', 'Go?', '--actions', 'yes,no', '--correlation-id', 'appr-2'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.template_kind, 'important');
  assert.deepEqual(sent.actions, ['yes', 'no'], "the user's --actions wins");
  assert.equal(sent.custom_actions, undefined, 'no default pair injected when the user supplies actions');
});

// --- compat aliases (old names → new canonical type) ----------------------------

test('typed sends — fyi→message, report→important, alert→urgent (mapped + a rename note)', async () => {
  const mock = createMock();
  const port = await mock.start();

  let out = await runCli(['fyi', '--title', 'x'], port).result;
  assert.equal(out.code, 0, out.stderr);
  assert.equal(mock.state.notifies.at(-1).template_kind, 'message');
  assert.match(out.stderr, /renamed → use `pidge message`/);

  out = await runCli(['report', '--title', 'x'], port).result;
  assert.equal(out.code, 0, out.stderr);
  assert.equal(mock.state.notifies.at(-1).template_kind, 'important');
  assert.match(out.stderr, /renamed → use `pidge important`/);

  out = await runCli(['alert', '--title', 'x', '--escalate'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.template_kind, 'urgent');
  assert.equal(sent.escalate, true, 'alert→urgent still honors --escalate');
  assert.match(out.stderr, /renamed → use `pidge urgent`/);
});

test('typed sends — the `ask` alias still requires a way to answer (--actions)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['ask', '--no-realtime', '--title', 'Approve?'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /--actions required for ask/);
  assert.equal(mock.state.notifies.length, 0, 'must not reach the server');
});

// 2) friendly local errors — fail fast, nothing reaches the server.
// (the `ask`-needs-actions guard is covered above in the alias section.)

test('pidge event WITHOUT --event-at errors locally with the ISO8601 recipe', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['event', '--title', 'Standup'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /--event-at required for event/);
  assert.match(out.stderr, /ISO8601/);
  assert.equal(mock.state.notifies.length, 0);
});

test('pidge event with a non-ISO8601 --event-at errors locally (no send)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['event', '--title', 'Standup', '--event-at', 'amanhã às 14h'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /not a valid ISO8601/);
  assert.equal(mock.state.notifies.length, 0);
});

test('an unknown subcommand points at the type catalog (exit 1, no send)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['frobnicate', '--title', 'x'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /unknown subcommand 'frobnicate'/);
  assert.match(out.stderr, /message · important · urgent · event · live/);
  assert.equal(mock.state.notifies.length, 0);
});

// 3) `pidge notify` is deprecated — warns locally but STILL sends (soft-rollout:
//    no template_kind, the server falls back to fyi). `pidge send` is the same alias.

test('pidge notify warns DEPRECATED but still sends WITHOUT a template_kind', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['notify', '--title', 'legado'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /deprecated/);
  assert.match(out.stderr, /message · important · urgent · event · live/, 'points at the married catalog');
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.title, 'legado');
  assert.equal(sent.template_kind, undefined, 'typeless send, server picks the channel default');
});

test('pidge send is a deprecated alias of notify (warns + sends)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['send', '--title', 'via send'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /`pidge send` is deprecated/);
  assert.equal(mock.state.notifies.at(-1).template_kind, undefined);
});

// 4) the generated skill carries the type catalog table.

test('skill install includes the "Choose the right type" catalog table', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-skill246-'));

  const child = spawn(process.execPath, [CLI, 'skill', 'install'], {
    cwd: dir,
    // isolate HOME so `skill install` (and its self-heal path) never touches the real ~/.claude.
    env: { ...process.env, PIDGE_URL: `http://127.0.0.1:${port}`, PIDGE_TOKEN: 'hld_test', HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-home-')) },
  });
  const out = await new Promise((resolve) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  await mock.stop();

  assert.equal(out.code, 0, out.stderr);
  const skill = installedSkill(dir).all; // a fact may live in the core or in a reference
  // The "Two axes" heading is GONE — the spine now leads with the
  // two-approval-paths distinction.
  assert.match(skill, /Approval has two paths/, 'the two-approval-paths section is present');
  assert.match(skill, /composes on ANY type/i, 'the response axis is explained');
  // the married catalog of 5
  for (const t of ['message', 'important', 'urgent', 'event', 'live']) {
    assert.match(skill, new RegExp(`pidge ${t}`), `skill mentions pidge ${t}`);
  }
  // the two response shortcuts + send-and-go vs wait
  assert.match(skill, /pidge approval/, 'the approval recipe');
  assert.match(skill, /send-and-go vs wait/i, 'teaches send-and-go vs wait');
  // POSITIVE asserts — the hand-authored spine landed in full:
  assert.match(skill, /THE PICKER/, 'the situation→command picker table');
  assert.match(skill, /pidge important --actions yes,no --wait/, 'the blocking-decision picker row');
  assert.match(skill, /ack_requires_biometric/, 'Path B names the profile knob');
  assert.match(skill, /--gated/, 'the Face-ID flag is documented');
  // skill polish — catalog-first · write-for-the-lock-screen · good reports:
  assert.match(skill, /Write for the lock screen/, 'the lock-screen guidance section is present');
  assert.match(skill, /catalog action FIRST/, 'the Buttons bullet is catalog-first');
  // every gold example now sets a plain --body alongside the rich --body-markdown:
  assert.match(skill, /--body "Signups 1,204/, 'a gold example sets a plain --body');
  assert.ok(
    /--body "Signups 1,204[\s\S]*?--body-markdown \$'\| Metric/.test(skill),
    'the metrics gold example carries BOTH --body and --body-markdown',
  );
  // and the GENERATED appendix still renders (the mock profiles.decision_table row) —
  // proves the generated half survives the hand-authored rewrite.
  assert.match(skill, /no answer needed → profile omitted/, 'the profiles appendix renders');
});

// --- CLI redesign ---------------------------------------------------------------

// EDIT 1 — the input chain: --body-markdown-file reads markdown from a file (or
// stdin via "-"), killing the long-markdown shell-quoting footgun.
test('--body-markdown-file reads the markdown body from a file', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-bmf-'));
  const f = path.join(dir, 'body.md');
  const md = '# Deploy report\n\n- one\n- two\n\n`code` and "quotes" that would wreck a shell flag';
  fs.writeFileSync(f, md);

  const out = await runCli(['important', '--title', 't', '--body-markdown-file', f], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.equal(mock.state.notifies.at(-1).body_markdown, md, 'the POST body_markdown equals the file content');
});

test('--body-markdown-file - reads the markdown body from stdin', async () => {
  const mock = createMock();
  const port = await mock.start();
  const md = '# From stdin\n\npiped markdown — no shell quoting needed';

  const { child, result } = runCli(['important', '--title', 't', '--body-markdown-file', '-'], port);
  child.stdin.write(md);
  child.stdin.end();
  const out = await result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.equal(mock.state.notifies.at(-1).body_markdown, md, 'the POST body_markdown equals the piped stdin');
});

// EDIT 2 — --gated synthesizes exactly one Face-ID confirm custom action.
test('--gated synthesizes one Face-ID confirm custom action', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['important', '--title', 't', '--gated'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const ca = mock.state.notifies.at(-1).custom_actions;
  assert.equal(ca.length, 1, 'exactly one gated action');
  assert.equal(ca[0].id, 'confirm_action');
  assert.equal(ca[0].biometric, true);
  assert.equal(ca[0].confirm, true);
  assert.equal(ca[0].terminal, true);
});

test('--gated does NOT double-gate when the agent already sent a biometric action', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(
    ['important', '--title', 't', '--gated', '--custom-action', 'wire:Wire $10k:biometric'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const ca = mock.state.notifies.at(-1).custom_actions;
  assert.equal(ca.length, 1, 'the agent\'s own biometric action stands — no confirm_action added on top');
  assert.equal(ca[0].id, 'wire');
});

// EDIT 4 — --template is off the help menu (still parses as silent input).
test('--help strips --template from discovery but lists --gated + --body-markdown-file', async () => {
  const out = await runCli(['--help'], 1).result;
  assert.equal(out.code, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /--template ID/, '--template is off the help menu');
  assert.match(out.stdout, /--gated/, '--gated is documented');
  assert.match(out.stdout, /--body-markdown-file/, '--body-markdown-file is documented');
});

test('--template still PARSES as silent input (back-compat) even though it is undocumented', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['notify', '--title', 't', '--template', 'reminder'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.equal(mock.state.notifies.at(-1).template, 'reminder', 'the template field still rides the wire');
});

// EDIT 3 — `hello` default copy is English (USA-first).
test('hello default copy is English (no Portuguese)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['hello-en'] = {
    responded: true,
    chosen_action: { kind: 'completed', action_id: 'done', label: 'Done ✓', text: null },
  };
  const out = await runCli(['hello', '--no-realtime', '--correlation-id', 'hello-en'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.title, 'Your agent is ready 🐦');
  assert.match(sent.body, /Tap Done . to confirm/);
  assert.doesNotMatch(sent.title, /Seu agente/);
  assert.doesNotMatch(sent.body, /Toque em Feito/);
});

// EDIT 6 — a --wait send with decision buttons defaults to 60 min,
// not 600 s, when the 201 carries no suggested_ask_timeout (requires_action key).
test('decision timeout — a --wait send WITH decision buttons defaults the timeout to 60 min', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['b2-buttons'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'yes', label: 'Sim', text: null },
  };
  const out = await runCli(
    ['important', '--no-realtime', '--title', 'Approve?', '--actions', 'yes,no', '--wait', '--correlation-id', 'b2-buttons'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /defaulting --wait to 60 min for a decision/, 'the decision-timeout default fired');
});

test('decision timeout — a no-buttons --wait send still defaults to 600 s (NOT a decision)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['b2-quiet'] = {
    responded: true,
    chosen_action: { kind: 'completed', action_id: 'done', label: 'Feito ✓', text: null },
  };
  const out = await runCli(
    ['important', '--no-realtime', '--title', 'FYI', '--wait', '--correlation-id', 'b2-quiet'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.doesNotMatch(out.stderr, /60 min for a decision/, 'no buttons ⇒ no decision default');
  assert.doesNotMatch(out.stderr, /suggested by template/, 'and no template suggestion either ⇒ the 600 s else-branch');
});

test('decision timeout — `pidge approval` (injected Face-ID pair) reads requires_action and gets 60 min', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['b2-approval'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'grant', label: 'Approve', text: null },
  };
  const out = await runCli(
    ['approval', '--no-realtime', '--title', 'Deploy to prod?', '--correlation-id', 'b2-approval'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  // approval injects APPROVAL_ACTIONS (custom_actions) → the server keys
  // requires_action:true on them even though hasAnswerAffordance() is local-false.
  assert.equal(mock.state.notifies.at(-1).custom_actions.length, 2, 'the Approve/Reject pair was injected');
  assert.match(out.stderr, /defaulting --wait to 60 min for a decision/);
});

// --- `pidge approve` — the hook-shaped, deny-default gate -----------------------

test('approve: human taps allow → exit 0, chosen_action JSON on stdout, gated pair in the payload', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['appr-allow'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'allow', label: 'Allow', text: null },
  };
  const out = await runCli(
    ['approve', 'Run `rm -rf build/`?', '--no-realtime', '--correlation-id', 'appr-allow'],
    port,
  ).result;
  await mock.stop();

  assert.equal(out.code, 0, `expected exit 0 on allow; stderr: ${out.stderr}`);
  assert.equal(JSON.parse(out.stdout).action_id, 'allow', 'chosen_action JSON on stdout');
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.title, 'Run `rm -rf build/`?', 'the positional question is the title');
  assert.equal(sent.template_kind, 'important', 'approve rides the important type');
  assert.deepEqual(sent.custom_actions, [
    { id: 'allow', label: 'Allow', confirm: true, biometric: true, terminal: true },
    { id: 'deny', label: 'Deny', style: 'destructive', terminal: true },
  ], 'the gated allow(Face-ID)/deny pair is on the wire');
  assert.equal(sent.actions, undefined, 'approve uses custom_actions, not built-in actions');
  // Closed circuit: approve blocks on its own cid (deny-default), so the answer
  // must not ALSO mirror onto the queue and wake a bridge handler as a "command".
  assert.equal(sent.mirror_reply, false, 'approve opts out of the queue mirror (mirror_reply:false)');
});

test('approve: human taps deny → exit 1 (deny explicit, never a false allow)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['appr-deny'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'deny', label: 'Deny', text: null },
  };
  const out = await runCli(
    ['approve', 'Wire $10k?', '--no-realtime', '--correlation-id', 'appr-deny'],
    port,
  ).result;
  await mock.stop();

  assert.equal(out.code, 1, `expected exit 1 on deny; stderr: ${out.stderr}`);
  assert.equal(JSON.parse(out.stdout).action_id, 'deny', 'chosen_action still printed');
  assert.match(out.stderr, /DENIED/);
});

test('approve: no answer before timeout → exit 1 (deny-default, fail closed)', async () => {
  const mock = createMock();
  const port = await mock.start();
  // never responds → the wait runs to the (short) deadline
  const out = await runCli(
    ['approve', 'Deploy to prod?', '--no-realtime', '--timeout', '2', '--interval', '1', '--correlation-id', 'appr-to'],
    port,
  ).result;
  await mock.stop();

  assert.equal(out.code, 1, `expected exit 1 on timeout; stderr: ${out.stderr}`);
  assert.match(out.stderr, /DENIED|deny-default/);
  assert.equal(JSON.parse(out.stdout).decision, 'deny', 'a machine-readable deny on stdout');
});

test('approve: a send that never lands → non-zero (fail closed on error)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifyStatus = 500; // the notify POST fails
  const out = await runCli(
    ['approve', 'Anything?', '--no-realtime', '--timeout', '2', '--correlation-id', 'appr-err'],
    port,
  ).result;
  await mock.stop();

  assert.notEqual(out.code, 0, `a failed send must NOT be exit 0; stderr: ${out.stderr}`);
  assert.equal(out.code, 1, 'approve maps an HTTP send failure to exit 1 (deny-default)');
});

test('approve over the realtime socket resolves allow → exit 0 (onAnswer threads through WS)', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('needs Node ≥22');
  const mock = createMock();
  const port = await mock.start();
  mock.state.onSubscribe = (channel) => {
    if (channel !== 'InboxChannel') return;
    const cid = mock.state.notifies[0].correlation_id;
    setTimeout(() => {
      mock.state.notifications[cid] = {
        responded: true,
        chosen_action: { kind: 'acted', action_id: 'allow', label: 'Allow', text: null },
      };
      mock.broadcast('InboxChannel', {
        type: 'event', kind: 'acted', action_id: 'allow', responded: true, correlation_id: cid,
      });
    }, 400);
  };
  const { result } = runCli(['approve', 'Ship it?', '--realtime', '--timeout', '30'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();
  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /"action_id": "allow"/);
});

test('approve: --allow-label / --deny-label rename the buttons', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['appr-lbl'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'allow', label: 'Ship it', text: null },
  };
  const out = await runCli(
    ['approve', 'Ship?', '--no-realtime', '--allow-label', 'Ship it', '--deny-label', 'Hold', '--correlation-id', 'appr-lbl'],
    port,
  ).result;
  await mock.stop();

  assert.equal(out.code, 0, out.stderr);
  const ca = mock.state.notifies.at(-1).custom_actions;
  assert.equal(ca[0].label, 'Ship it');
  assert.equal(ca[1].label, 'Hold');
});

// --- NaN in --timeout/--interval must fail CLOSED, never hang forever ----
// parseInt('abc') → NaN made doWait's deadline NaN (never reached): wait/ask/
// approve/hello/listen polled FOREVER and approve's deny-default timeout branch
// was unreachable. A typo must die IMMEDIATELY (exit 1), before anything is sent.

test('wait --timeout abc dies immediately (exit 1), never entering the poll loop', async () => {
  // No server at all (port 1): the strict parse must die BEFORE any network happens.
  const { code, stderr } = await runCli(['wait', 'cid-nan', '--no-realtime', '--timeout', 'abc'], 1).result;
  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.match(stderr, /--timeout "abc" is not a number/);
});

test('wait --interval abc dies the same way', async () => {
  const { code, stderr } = await runCli(['wait', 'cid-nan', '--no-realtime', '--interval', 'abc'], 1).result;
  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.match(stderr, /--interval "abc" is not a number/);
});

test('approve --timeout abc fails CLOSED (exit 1) BEFORE sending the approval', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { code, stderr } = await runCli(['approve', 'Deploy?', '--no-realtime', '--timeout', 'abc'], port).result;
  await mock.stop();
  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.match(stderr, /is not a number/);
  assert.equal(mock.state.notifies.length, 0, 'nothing was sent — no ghost approval on the phone');
});

test('ask --timeout abc refuses before the send too', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { code, stderr } = await runCli(
    ['ask', '--title', 'x', '--actions', 'yes,no', '--no-realtime', '--timeout', 'abc'], port,
  ).result;
  await mock.stop();
  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.equal(mock.state.notifies.length, 0, 'nothing was sent');
});

test('hello --interval abc refuses before the send', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { code, stderr } = await runCli(['hello', '--no-realtime', '--interval', 'abc'], port).result;
  await mock.stop();
  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.equal(mock.state.notifies.length, 0, 'nothing was sent');
});

test('listen --timeout abc refuses (same eternal-deadline class)', async () => {
  const { code, stderr } = await runCli(['listen', '--no-realtime', '--timeout', 'abc'], 1).result;
  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.match(stderr, /is not a number/);
});

test('approve on a MALFORMED poll body: deny-default holds, exit 1 on timeout', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.pollGarbage = true;
  const { code, stdout, stderr } = await runCli(
    ['approve', 'Ship?', '--no-realtime', '--timeout', '2', '--interval', '1', '--correlation-id', 'appr-garbage'], port,
  ).result;
  await mock.stop();
  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.match(stdout, /"decision":"deny"/, 'the machine-readable deny lands on stdout');
});

test('approve when the server is unreachable: exit 2 (the send never left the ground)', async () => {
  const mock = createMock();
  const port = await mock.start();
  await mock.stop(); // nothing listening — the send throws a raw network error
  const { code, stderr } = await runCli(['approve', 'Anything?', '--no-realtime', '--timeout', '2'], port).result;
  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.match(stderr, /send failed \(network\)/);
});

test('SIGINT mid-wait: approve exits 1 (deny-default), never 0', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { child, result } = runCli(
    ['approve', 'Danger?', '--no-realtime', '--timeout', '30', '--interval', '1', '--correlation-id', 'appr-sigint'], port,
  );
  while (mock.state.notifies.length === 0) await sleep(25); // the approval is in flight
  await sleep(300); // and the wait loop is holding
  child.kill('SIGINT');
  const { code, stderr } = await result;
  await mock.stop();
  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.match(stderr, /interrupted before an answer — DENIED/);
});

// --- docs drift guards ----------------------------------------------------

test('the README never re-teaches the refused decision+reply combo and documents approve', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.ok(!/--actions yes,no,reply/.test(readme), 'README must not showcase a send the CLI refuses since 0.16.0');
  assert.match(readme, /pidge approve/, 'the approve gate is documented');
  assert.match(readme, /only as trustworthy as/, 'the env trust caveat is spelled out');
});

test('approve --help tells the true exit-code story (HTTP fail → 1, raw network → 2) + the env caveat', async () => {
  const out = await runCli(['approve', '--help'], 1).result;
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /an HTTP failure on the send → exit 1/);
  assert.match(out.stdout, /ONLY a raw network error \(the send never reached the server at all\) → exit 2/);
  assert.match(out.stdout, /TRUST CAVEAT/);
  assert.ok(!/A send that never left the ground → exit 2/.test(out.stdout), 'the old over-promise is gone');
});

// --- refuse a decision button + reply in one send ------------------

test('--actions yes,no,reply is REFUSED locally (exit 1, no send)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['important', '--title', 'x', '--actions', 'yes,no,reply'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /can't combine a decision button/);
  assert.equal(mock.state.notifies.length, 0, 'must not reach the server');
});

test('--actions reply ALONE is fine (sends)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['important', '--title', 'x', '--actions', 'reply'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(mock.state.notifies.at(-1).actions, ['reply']);
});

test('done,reply is ALLOWED (done is not a decision; DONE_REPLY is a real category)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['important', '--title', 'x', '--actions', 'done,reply'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(mock.state.notifies.at(-1).actions, ['done', 'reply']);
});

// --- no stray, description-less `template` line in subcommand help --

test('`pidge important --help` no longer prints a bare `template` line', async () => {
  const out = await runCli(['important', '--help'], 1).result;
  assert.equal(out.code, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /^\s*template\s*$/m, 'no bare description-less template line');
  assert.match(out.stdout, /--subtitle TEXT/, 'the real flags still render');
});

// --- --quiet collapses setup to a single status line ---------------

test('setup --quiet collapses onboarding to ONE status line (verbose lines suppressed)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-quiet-'));
  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`, '--quiet'],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, home,
  );
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /✓ setup ok — canal "mock"/, 'the single status line');
  assert.doesNotMatch(stderr, /doctor: token found/, 'verbose doctor lines are suppressed');
  assert.doesNotMatch(stderr, /doctor: all good/, 'the verbose all-good line is replaced');
  // the file is still written + the key still never printed
  const written = fs.readFileSync(path.join(home, 'pidge', 'env'), 'utf8');
  assert.match(written, /PIDGE_TOKEN=hld_minted_by_claim/);
  assert.ok(!stderr.includes('hld_minted_by_claim') && !stdout.includes('hld_minted_by_claim'), 'key never leaks');
});

// --- listen --all warns on orphaned backlog -------------------------

test('listen --all WARNS that a quick first batch is old backlog, not new arrivals', async () => {
  const mock = createMock();
  const port = await mock.start();
  // pre-existing queue: a composer message + an old notification answer
  mock.state.messages = [
    { id: 20, channel_id: 1, body: 'oi', created_at: 'x', consumed_at: null },
    { id: 21, channel_id: 1, kind: 'notification_reply', body: 'sim', text: 'sim', action_id: 'reply', ref: { correlation_id: 'old-1', title: 'Q antigo', event_kind: 'replied' } },
  ];
  const out = await runCli(['listen', '--all', '--ack-on-read', '--no-realtime', '--timeout', '10', '--interval', '1'], port).result;
  await mock.stop();

  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /ALREADY queued when this listen started/, 'the orphan-backlog heads-up');
  assert.match(out.stderr, /1 of them are answers to EARLIER notifications/, 'counts the resurfaced notification answers');
  assert.match(out.stderr, /not a cross-channel leak/, 'clarifies it is within-channel — not a cross-channel leak');
});

test('listen WITHOUT --all does not print the backlog heads-up', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 30, channel_id: 1, body: 'oi', created_at: 'x', consumed_at: null }];
  const out = await runCli(['listen', '--ack-on-read', '--no-realtime', '--timeout', '10', '--interval', '1'], port).result;
  await mock.stop();

  assert.equal(out.code, 0, out.stderr);
  assert.doesNotMatch(out.stderr, /ALREADY queued when this listen started/, 'no --all ⇒ no backlog heads-up');
});

// --ack-on-read ignored the ack's response BODY: a 2xx that acked ZERO rows
// still announced the whole batch as consumed. The hand `ack` path has always
// read that number; this one now does too.
test('listen --ack-on-read reads the ack BODY: 0 acked is said out loud, not announced as consumed', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 40, channel_id: 1, body: 'oi', created_at: 'x' }];
  mock.state.ackAcked = 0;
  mock.state.ackSkipped = 3;

  const out = await runCli(['listen', '--ack-on-read', '--no-realtime', '--timeout', '10', '--interval', '1'], port).result;
  await mock.stop();

  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /acked 0 of 1 message/, 'the server\'s own count, not our optimism');
  assert.match(out.stderr, /WILL re-serve/, 'and what that means for the reader');
  assert.match(out.stderr, /3 message\(s\) below the cursor were SKIPPED/, 'skipped is surfaced like the hand path');
  assert.ok(!/1 message\(s\) — acked on read/.test(out.stderr), 'never the "consumed" line over an empty ack');
});


// --- strict message ids on ack (a lazy parseInt acked the WRONG watermark) ---

test('ack --up-to with a correlation_id dies loud BEFORE any HTTP — no wrong watermark', async () => {
  const mock = createMock();
  await mock.start();
  try {
    const { result } = runCli(['ack', '--up-to', '9f2e7c31-ab40-4f11-9e01-77d21c55aa02'], mock.port);
    const { code, stderr } = await result;
    assert.equal(code, 1, 'must exit 1 (fail-closed), not silently ack ids 1..9');
    assert.match(stderr, /numeric message id/i, 'the error must teach the id namespace');
    assert.match(stderr, /correlation_id/i);
    assert.equal(mock.state.acks.length, 0, 'NO ack request may reach the server');
  } finally { await mock.stop(); }
});

test('ack --ids with one bad entry dies loud (no silent drop of the bad id)', async () => {
  const mock = createMock();
  await mock.start();
  try {
    const { result } = runCli(['ack', '--ids', '12,abc,14'], mock.port);
    const { code } = await result;
    assert.equal(code, 1);
    assert.equal(mock.state.acks.length, 0, 'the old .filter() silently acked [12,14]; now nothing goes');
  } finally { await mock.stop(); }
});

test('positive control: a real numeric --up-to still acks normally', async () => {
  const mock = createMock();
  await mock.start();
  try {
    const { result } = runCli(['ack', '--up-to', '103'], mock.port);
    const { code } = await result;
    assert.equal(code, 0);
    assert.equal(mock.state.acks.length, 1);
    assert.equal(mock.state.ackBodies[0].up_to, 103);
  } finally { await mock.stop(); }
});

// --- doctor with a SESSION token must fail loud, not "canal undefined" ---

test('doctor with a ses_ token says SESSION token + exits 2 (server v57 either-track whoami)', async () => {
  const mock = createMock();
  await mock.start();
  try {
    const { result } = runCli(['doctor'], mock.port, { PIDGE_TOKEN: 'ses_abc123' });
    const { code, stderr } = await result;
    assert.equal(code, 2, 'a session token is a misconfig — doctor must not bless it');
    assert.match(stderr, /SESSION token/i);
    assert.doesNotMatch(stderr, /canal "undefined"/, 'the undefined-channel print is the bug');
  } finally { await mock.stop(); }
});

// --- `pidge live` drives the REAL Live Activity endpoints --------------------

test('live: --title starts a card via POST /live_activities — /notify is NEVER hit', async () => {
  const mock = createMock();
  const port = await mock.start();
  try {
    const { result } = runCli(
      ['live', 'backfill-1', '--title', 'Backfill', '--status', 'Stage 1/4', '--step', '1/4'], port);
    const { code, stdout, stderr } = await result;
    assert.equal(code, 0, `stderr: ${stderr}`);
    assert.equal(mock.state.notifies.length, 0, 'the old silent degrade hit /notify — it must be dead');
    assert.equal(mock.state.liveWrites.length, 1);
    const w = mock.state.liveWrites[0];
    assert.equal(w.method, 'POST');
    assert.equal(w.body.correlation_id, 'backfill-1');
    assert.equal(w.body.title, 'Backfill');
    assert.equal(w.body.status, 'Stage 1/4');
    // --step is sugar: progress + fraction label, NO steps field on the wire.
    assert.equal(w.body.progress, 0.25);
    assert.equal(w.body.progress_label, '1/4');
    assert.equal(w.body.step, undefined);
    const echoed = JSON.parse(stdout);
    assert.equal(echoed.operation, 'started');
    assert.match(stderr, /correlation_id=backfill-1/);
  } finally { await mock.stop(); }
});

test('live: CID without --title updates in place via PATCH', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.liveCards['backfill-1'] = true;
  try {
    const { result } = runCli(['live', 'backfill-1', '--status', 'Stage 3/4', '--step', '3/4'], port);
    const { code, stdout } = await result;
    assert.equal(code, 0);
    const w = mock.state.liveWrites[0];
    assert.equal(w.method, 'PATCH');
    assert.match(w.path, /backfill-1$/);
    assert.equal(w.body.progress, 0.75);
    assert.equal(w.body.correlation_id, undefined, 'PATCH keys on the URL, not the body');
    assert.equal(JSON.parse(stdout).operation, 'updated');
  } finally { await mock.stop(); }
});

test('live: PATCH on an unknown CID exits 2 with the --title hint', async () => {
  const mock = createMock();
  const port = await mock.start();
  try {
    const { result } = runCli(['live', 'ghost-1', '--status', 'x'], port);
    const { code, stderr } = await result;
    assert.equal(code, 2);
    assert.match(stderr, /add --title to START it/);
  } finally { await mock.stop(); }
});

test('live: --end posts the outcome + linger to the end endpoint', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.liveCards['backfill-1'] = true;
  try {
    const { result } = runCli(['live', 'backfill-1', '--end', '--outcome', 'Backfill ok ✓', '--linger', '60'], port);
    const { code, stdout } = await result;
    assert.equal(code, 0);
    const w = mock.state.liveWrites[0];
    assert.equal(w.method, 'POST');
    assert.match(w.path, /backfill-1\/end$/);
    assert.equal(w.body.outcome, 'Backfill ok ✓');
    assert.equal(w.body.linger_seconds, 60);
    assert.equal(JSON.parse(stdout).operation, 'ended');
  } finally { await mock.stop(); }
});

test('live: an over-budget --dedicated degrade is narrated on stderr, never silent', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.liveDegrade = true;
  try {
    const { result } = runCli(['live', 'ded-3', '--title', 'D3', '--dedicated'], port);
    const { code, stdout, stderr } = await result;
    assert.equal(code, 0);
    assert.equal(mock.state.liveWrites[0].body.presentation, 'dedicated');
    assert.equal(JSON.parse(stdout).degraded, true);
    assert.match(stderr, /DEGRADED/);
  } finally { await mock.stop(); }
});

test('live: --wait refused (exit 1), --step+--progress refused (exit 1)', async () => {
  const mock = createMock();
  const port = await mock.start();
  try {
    let r = await runCli(['live', 'x', '--title', 'T', '--wait'], port).result;
    assert.equal(r.code, 1);
    assert.match(r.stderr, /can't --wait/);
    r = await runCli(['live', 'x', '--title', 'T', '--step', '1/2', '--progress', '0.5'], port).result;
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--step OR --progress/);
    assert.equal(mock.state.liveWrites.length, 0, 'a refused command must not reach the wire');
  } finally { await mock.stop(); }
});

test('live: --paused sends is_running:false; a plain update omits is_running (omit-to-preserve)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.liveCards['t1'] = true;
  try {
    let r = await runCli(['live', 't1', '--paused'], port).result;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(mock.state.liveWrites[0].body.is_running, false);
    r = await runCli(['live', 't1', '--status', 'go'], port).result;
    assert.equal(r.code, 0);
    assert.equal(mock.state.liveWrites[1].body.is_running, undefined);
  } finally { await mock.stop(); }
});

// ---------------------------------------------------------------------------
// `pidge catchup`: the READ-ONLY situational read. GET ?history=true&all=true,
// print the thread newest-first, NEVER consume (no ack, no lease). Exit 0/2 only.
// ---------------------------------------------------------------------------
test('catchup: prints the thread newest-first, sends history=true&all=true, NEVER acks (exit 0)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 10, channel_id: 1, kind: 'message', body: 'primeira', created_at: 'a' },
    { id: 25, channel_id: 1, kind: 'notification_reply', body: 'sim', text: 'sim',
      action_id: 'yes', ref: { correlation_id: 'c-1', title: 'Deploy?' }, created_at: 'b' },
    { id: 14, channel_id: 1, kind: 'message', body: 'segunda', created_at: 'c' },
  ];
  const { result } = runCli(['catchup'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  // read-only contract: it must NEVER have acked/consumed.
  assert.equal(mock.state.acks.length, 0, 'catchup must NEVER ack — it is read-only');
  // the query it sent: history=true AND all=true (answers included).
  assert.equal(mock.state.messageReads.length, 1);
  assert.match(mock.state.messageReads[0], /history=true/);
  assert.match(mock.state.messageReads[0], /all=true/);
  // stdout is JSON {messages:[…]} newest first (id desc: 25, 14, 10).
  const out = JSON.parse(stdout);
  assert.deepEqual(out.messages.map((m) => m.id), [25, 14, 10]);
  // the reply row survived with its ref (notification answers are in the thread).
  assert.equal(out.messages[0].kind, 'notification_reply');
  assert.match(stderr, /read-only/);
});

test('catchup: an empty channel still exits 0 with {"messages":[]}', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [];
  const { result } = runCli(['catchup'], port);
  const { code, stdout } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { messages: [] });
});

test('catchup: --limit is enforced CLIENT-SIDE (server ignores it on ?history) — the newest N', async () => {
  const mock = createMock();
  const port = await mock.start();
  // The mock (like the real ?history=true path) returns ALL rows regardless of limit.
  mock.state.messages = [
    { id: 1, channel_id: 1, kind: 'message', body: 'um' },
    { id: 2, channel_id: 1, kind: 'message', body: 'dois' },
    { id: 3, channel_id: 1, kind: 'message', body: 'três' },
    { id: 4, channel_id: 1, kind: 'message', body: 'quatro' },
  ];
  const { result } = runCli(['catchup', '--limit', '2', '--before', '480'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  // REAL behavior: exactly the newest 2 are printed, even though the server sent 4.
  const out = JSON.parse(stdout);
  assert.deepEqual(out.messages.map((m) => m.id), [4, 3], 'the newest N, sliced locally');
  // it still forwards both params (harmless; --before IS honored server-side).
  assert.match(mock.state.messageReads[0], /limit=2/);
  assert.match(mock.state.messageReads[0], /before=480/);
  // and it tells the human the view was clipped.
  assert.match(stderr, /newest 2 of 4/);
});

test('catchup: a non-numeric --limit is a usage error (exit 1)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { result } = runCli(['catchup', '--limit', 'lots'], port);
  const { code, stderr } = await result;
  await mock.stop();
  assert.equal(code, 1);
  assert.match(stderr, /--limit must be a positive integer/);
});

test('catchup: a processed row narrates "handled by <who>: <what>" on stderr', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 40, channel_id: 1, kind: 'message', body: 'faz o deploy',
      acked_by_label: 'bridge-24x7', handler_summary: 'shipped the weekly report, main deployed' },
    { id: 41, channel_id: 1, kind: 'message', body: 'ainda não tratada' }, // no attribution → no line
  ];
  const { result } = runCli(['catchup'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  // the attribution rides in the printed JSON (present-only passthrough)...
  assert.equal(JSON.parse(stdout).messages.find((m) => m.id === 40).acked_by_label, 'bridge-24x7');
  // ...and is narrated so the reader sees the other consumer's work, not just the message.
  assert.match(stderr, /message 40 handled by bridge-24x7: shipped the weekly report, main deployed/);
  // the un-acked row produces NO handled-by line.
  assert.ok(!/message 41 handled by/.test(stderr), 'a row without attribution stays silent');
});

test('catchup: a server error exits 2 (not 3/4 — there is no wait)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.manifestVersion = 16;
  // point at a dead port so the read is a hard network failure → exit 2.
  await mock.stop();
  const { result } = runCli(['catchup'], port);
  const { code, stderr } = await result;

  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.match(stderr, /catchup failed/);
});

// catchup gains an incremental cursor (--since) + a condensed view (--digest).
// Situate in O(new), not O(whole thread).
test('catchup --since <id> shows only NEWER rows (client-side) and forwards the query', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 10, channel_id: 1, kind: 'message', body: 'velha' },
    { id: 20, channel_id: 1, kind: 'message', body: 'no limiar' },
    { id: 30, channel_id: 1, kind: 'message', body: 'nova' },
    { id: 40, channel_id: 1, kind: 'message', body: 'mais nova' },
  ];
  const { result } = runCli(['catchup', '--since', '20'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const out = JSON.parse(stdout);
  assert.deepEqual(out.messages.map((m) => m.id), [40, 30], 'STRICTLY greater than 20, newest first');
  assert.match(mock.state.messageReads[0], /since=20/, 'the cursor is forwarded to the server too');
  assert.match(stderr, /2 message\(s\) since id 20/, 'the summary names the cursor');
});

test('catchup --since is STRICT numeric (a correlation-id-shaped value is exit 1, not a wrong watermark)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { result } = runCli(['catchup', '--since', 'c-9f2e'], port);
  const { code, stderr } = await result;
  await mock.stop();
  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.match(stderr, /--since/, 'the usage error names the flag');
});

test('catchup --digest prints ONE line per message — id · kind · body · handled/PENDING', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 40, channel_id: 1, kind: 'message', body: 'faz o deploy',
      acked_by_label: 'bridge-24x7', handler_summary: 'shipped the weekly report' },
    { id: 41, channel_id: 1, kind: 'message', body: 'ainda não tratada' },
  ];
  const { result } = runCli(['catchup', '--digest'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  // stdout is the digest (NOT JSON): one line per message, newest first.
  assert.ok(!/^\s*\{/.test(stdout), 'digest mode does not print raw JSON');
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 2, 'exactly one line per message');
  // newest first (id desc): 41 (PENDING) then 40 (attributed).
  assert.match(lines[0], /^41 · message · ainda não tratada · PENDING$/);
  assert.match(lines[1], /^40 · message · faz o deploy · handled by bridge-24x7: shipped the weekly report$/);
  // the per-row "handled by" stderr narration is inline in the digest, not doubled on stderr.
  assert.ok(!/pidge: message 40 handled by/.test(stderr), 'digest carries attribution inline, not on stderr');
});

// The digest has THREE states. The bug: a row with `processed_at` but no note
// printed PENDING (derived from summary/label alone), telling a successor to REDO
// finished work — the middle case below.
test('catchup --digest — THREE states: handled-with-note / ✓ acked (no note) / PENDING', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    // (a) processed WITH a note → handled by X: <note>
    { id: 10, channel_id: 1, kind: 'message', body: 'com nota', processed_at: '2026-07-06T23:00:00Z',
      acked_by_label: 'bridge-24x7', handler_summary: 'shipped the weekly report' },
    // (b) THE BUG: processed (processed_at) but NO note/label → ✓ acked (no note), NOT PENDING
    { id: 417, channel_id: 1, kind: 'notification_reply', body: 'Sim', processed_at: '2026-07-06T23:26:33Z' },
    // (c) genuinely un-processed → PENDING
    { id: 500, channel_id: 1, kind: 'message', body: 'de verdade nova' },
  ];
  const { result } = runCli(['catchup', '--digest'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const byId = Object.fromEntries(stdout.trim().split('\n').map((l) => [l.split(' · ')[0], l]));
  assert.match(byId['10'], /· handled by bridge-24x7: shipped the weekly report$/, '(a) note present ⇒ handled by X');
  assert.match(byId['417'], /· ✓ acked \(no note\)$/, '(b) processed_at + no note ⇒ ✓ acked, NEVER PENDING');
  assert.ok(!/PENDING/.test(byId['417']), 'the anti-redo lie is dead: a processed row is not PENDING');
  assert.match(byId['500'], /· PENDING$/, '(c) truly un-processed ⇒ PENDING');
});

// The FOURTH shade of done: a MUTE ack (server ≥ v112 files it as `drained`) —
// processed, no note, nothing sent afterwards. It rendered identically to a
// quiet-but-real ack, so a successor read "someone handled this" where the
// truth is "someone made it disappear".
test('catchup --digest — a DRAINED row reads as a mute ack, not a plain silent one', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 60, channel_id: 1, kind: 'message', body: 'silenciada', processed_at: '2026-07-06T23:00:00Z', handled_state: 'drained' },
    { id: 61, channel_id: 1, kind: 'message', body: 'com label', processed_at: '2026-07-06T23:00:00Z', acked_by_label: 'bridge-bot', handled_state: 'drained' },
    // handled_state ABSENT (an older server) keeps today's text, exactly
    { id: 62, channel_id: 1, kind: 'message', body: 'server antigo', processed_at: '2026-07-06T23:00:00Z' },
    // a note beats everything: a row with a summary is never "mute"
    { id: 63, channel_id: 1, kind: 'message', body: 'com nota', processed_at: '2026-07-06T23:00:00Z', handled_state: 'drained', handler_summary: 'reiniciei o worker' },
  ];
  const { result } = runCli(['catchup', '--digest'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const byId = Object.fromEntries(stdout.trim().split('\n').map((l) => [l.split(' · ')[0], l]));
  assert.match(byId['60'], /· ✓ acked \(mute — no note, nothing sent after\)$/);
  assert.match(byId['61'], /· ✓ acked by bridge-bot \(mute — no note, nothing sent after\)$/);
  assert.match(byId['62'], /· ✓ acked \(no note\)$/, 'an older server (no field) renders exactly as before');
  assert.match(byId['63'], /· handled by another consumer: reiniciei o worker$/, 'a note is never a mute ack');
});

test('catchup --digest — a processed row with a LABEL but no note reads "✓ acked by X (no note)"', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 22, channel_id: 1, kind: 'message', body: 'x', processed_at: '2026-07-06T23:00:00Z', acked_by_label: 'bridge-bot' },
  ];
  const { result } = runCli(['catchup', '--digest'], port);
  const { code, stdout } = await result;
  await mock.stop();
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^22 · message · x · ✓ acked by bridge-bot \(no note\)$/);
});

test('catchup --digest --since compose (condensed view of only what is new)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 10, channel_id: 1, kind: 'message', body: 'velha' },
    { id: 30, channel_id: 1, kind: 'message', body: 'nova' },
  ];
  const { result } = runCli(['catchup', '--digest', '--since', '10'], port);
  const { code, stdout } = await result;
  await mock.stop();

  assert.equal(code, 0);
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'only the row newer than id 10');
  assert.match(lines[0], /^30 · message · nova · PENDING$/);
});

// the cursor hint fires on EVERY no-`--since` run that saw messages —
// first run included, and even when nothing new arrived — always on stderr (stdout
// stays clean). The old gate (prior cursor AND thread-moved) printed nothing on a
// fresh or quiet channel, the observed bug.
test('catchup ALWAYS prints the cursor on stderr (no --since) — first run and when nothing is new', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 55, channel_id: 1, kind: 'message', body: 'oi' }];
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-cursor-'));

  // First run (no prior cursor) STILL prints the cursor — an agent always pipes.
  const first = await runCli(['catchup'], port, { XDG_CONFIG_HOME: xdg }).result;
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stderr, /cursor — newest message is id 55.*--since 55/, `first: ${first.stderr}`);
  assert.ok(!/new since your last read/.test(first.stderr), 'first run has no prior cursor to diff against');

  // A newer message arrives; the second run points at the NEW highest and notes the delta.
  mock.state.messages.push({ id: 60, channel_id: 1, kind: 'message', body: 'novidade' });
  const second = await runCli(['catchup'], port, { XDG_CONFIG_HOME: xdg }).result;
  await mock.stop();
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stderr, /cursor — newest message is id 60 \(1 new since your last read at id 55\).*--since 60/, `second: ${second.stderr}`);
});

test('a repeat catchup with NOTHING new STILL prints the cursor (the observed bug: silent repeats)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 70, channel_id: 1, kind: 'message', body: 'oi' }];
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-cursor2-'));

  await runCli(['catchup'], port, { XDG_CONFIG_HOME: xdg }).result; // records 70
  // Nothing new arrives; a second situating run must STILL surface the cursor.
  const again = await runCli(['catchup'], port, { XDG_CONFIG_HOME: xdg }).result;
  await mock.stop();
  assert.match(again.stderr, /cursor — newest message is id 70.*--since 70/, `again: ${again.stderr}`);
  assert.ok(!/new since your last read/.test(again.stderr), 'nothing new ⇒ no delta note, just the cursor');
});

test('--since suppresses the cursor hint (the caller already provided one; stdout+stderr stay focused)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 80, channel_id: 1, kind: 'message', body: 'oi' }];
  const out = await runCli(['catchup', '--since', '10'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.ok(!/cursor — newest message/.test(out.stderr), 'a --since run does not also nag about the cursor');
});

// The cursor is keyed per CHANNEL (hash(token)), like the server pin:
// two channels from ONE config dir must not cross-contaminate the suggested --since.
test('the catchup cursor is per-CHANNEL — channel A never suggests its cursor to channel B', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 90, channel_id: 1, kind: 'message', body: 'oi' }];
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-chan-'));

  // Channel A records a cursor at id 90.
  const a = await runCli(['catchup'], port, { XDG_CONFIG_HOME: xdg, PIDGE_TOKEN: 'hld_channelA' }).result;
  assert.equal(a.code, 0, a.stderr);

  // Channel B (SAME config dir, DIFFERENT token) sees a newer thread but must NOT be
  // told to use channel A's cursor — its own slot is empty.
  mock.state.messages.push({ id: 95, channel_id: 1, kind: 'message', body: 'novidade' });
  const b = await runCli(['catchup'], port, { XDG_CONFIG_HOME: xdg, PIDGE_TOKEN: 'hld_channelB' }).result;
  await mock.stop();
  assert.equal(b.code, 0, b.stderr);
  // B prints its OWN cursor (id 95) but must NOT diff against A's stored 90.
  assert.match(b.stderr, /cursor — newest message is id 95/, 'channel B gets its own cursor');
  assert.ok(!/new since your last read/.test(b.stderr), "channel B has no prior cursor of its own — A's must not leak in");
});

// A --before page (older rows, lower highest id) must NEVER regress
// the stored cursor; the cursor only ever ADVANCES to the newest id seen.
test('a later read with a LOWER highest id does NOT regress the stored cursor', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-noregress-'));
  const statePath = path.join(xdg, 'pidge', 'state.json');
  const storedId = () => Object.values(JSON.parse(fs.readFileSync(statePath, 'utf8')).catchupLastSeen)[0].id;

  mock.state.messages = [{ id: 100, channel_id: 1, kind: 'message', body: 'nova' }];
  await runCli(['catchup'], port, { XDG_CONFIG_HOME: xdg }).result;
  assert.equal(storedId(), 100, 'the first read records the newest id');

  // A subsequent read that only sees an OLDER row (a --before page) must not lower it.
  mock.state.messages = [{ id: 40, channel_id: 1, kind: 'message', body: 'velha' }];
  await runCli(['catchup', '--before', '100'], port, { XDG_CONFIG_HOME: xdg }).result;
  await mock.stop();
  assert.equal(storedId(), 100, 'the cursor stays at the newest id ever seen, never regressed by a back-page');
});

// ---------------------------------------------------------------------------
// `pidge skill install --target claude|agents|gemini`: same content, the
// destination changes (a Claude skill vs the AGENTS.md/GEMINI.md root conventions).
// ---------------------------------------------------------------------------
function runSkillInstall(args, port, cwd) {
  const child = spawn(process.execPath, [CLI, 'skill', 'install', ...args], {
    cwd,
    // isolate HOME so `skill install` (and its self-heal path) never touches the real ~/.claude.
    env: { ...process.env, PIDGE_URL: `http://127.0.0.1:${port}`, PIDGE_TOKEN: 'hld_test', HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-home-')) },
  });
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('skill install --target agents|gemini writes root files = the claude spine + inlined report doctrine', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-target-'));

  const claude = await runSkillInstall(['--target', 'claude'], port, dir);
  const agents = await runSkillInstall(['--target', 'agents'], port, dir);
  const gemini = await runSkillInstall(['--target', 'gemini'], port, dir);
  await mock.stop();

  for (const r of [claude, agents, gemini]) assert.equal(r.code, 0, r.stderr);
  const claudeMd = fs.readFileSync(path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md'), 'utf8');
  const agentsMd = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  const geminiMd = fs.readFileSync(path.join(dir, 'GEMINI.md'), 'utf8');
  assert.equal(agentsMd, geminiMd, 'both single-file targets carry identical content');
  // The single-file targets have no second file to install the pidge-report
  // companion into, so they carry the SAME doctrine inlined above the trailer;
  // the claude target keeps a lean spine and installs the companion as a sibling.
  const spine = claudeMd.replace(/<!-- pidge-skill-end -->\n$/, '');
  assert.ok(agentsMd.startsWith(spine), 'AGENTS.md begins with the exact claude spine');
  assert.match(agentsMd, /# Pidge Report — write for the feed, not the archive/);
  assert.match(agentsMd, /Five shapes, five budgets/);
  assert.ok(!/Five shapes, five budgets/.test(claudeMd), 'the claude skill points at the companion instead of inlining it');
  // A root-file target has nowhere to put a reference TREE either, so the
  // references are inlined the same way. Choosing a target must never cost a fact:
  // every reference the claude target wrote is reachable inside AGENTS.md.
  assert.ok(!fs.existsSync(path.join(dir, 'references')), 'a root-file target grows no reference dir');
  const refs = installedSkill(dir).refs;
  assert.ok(Object.keys(refs).length >= 8, 'the claude install did produce references to compare against');
  for (const [name, body] of Object.entries(refs)) {
    const heading = body.split('\n')[0].replace(/^# /, '');
    assert.ok(agentsMd.includes(heading), `references/${name}.md rode into AGENTS.md`);
  }
  // the spine sections rode along into every target.
  assert.match(agentsMd, /a fresh interactive session/);
  assert.match(agentsMd, /Only then speak/);
  assert.match(agentsMd, /pidge catchup/);
  // the JSON echo names the resolved target + destination.
  assert.equal(JSON.parse(agents.stdout).target, 'agents');
  assert.match(JSON.parse(agents.stdout).file, /AGENTS\.md$/);
});

test('skill install defaults to the claude target; an unknown --target exits 1', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-target-'));

  const def = await runSkillInstall([], port, dir);
  assert.equal(def.code, 0, def.stderr);
  assert.equal(JSON.parse(def.stdout).target, 'claude');
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md')));

  const bad = await runSkillInstall(['--target', 'copilot'], port, dir);
  await mock.stop();
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown --target/);
});

test('skill install --target agents backs up a differing existing AGENTS.md to .bak', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-target-'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'PRE-EXISTING PROJECT INSTRUCTIONS\n');

  const r = await runSkillInstall(['--target', 'agents'], port, dir);
  await mock.stop();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /saved to .*AGENTS\.md\.bak/);
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md.bak'), 'utf8'), 'PRE-EXISTING PROJECT INSTRUCTIONS\n');
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /name: pidge/);
});

test('skill install: a re-install NEVER clobbers an existing .bak — the user original survives', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-target-'));
  const ORIGINAL = 'THE USER\'S OWN AGENTS.md — irreplaceable\n';
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), ORIGINAL);

  // First install parks the original at AGENTS.md.bak and writes the generated skill.
  const first = await runSkillInstall(['--target', 'agents'], port, dir);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md.bak'), 'utf8'), ORIGINAL);

  // Simulate a diverging state (a hand-edit, or a rev/manifest bump between installs):
  // the file on disk now differs from what the next install will generate, so the
  // backup branch fires again — and MUST NOT overwrite the original .bak.
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'A LATER EDIT that differs from the generated skill\n');
  const second = await runSkillInstall(['--target', 'agents'], port, dir);
  await mock.stop();
  assert.equal(second.code, 0, second.stderr);

  // The ORIGINAL .bak is untouched — the user's irreplaceable file is still safe.
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md.bak'), 'utf8'), ORIGINAL, 'original .bak must survive a re-install');
  // The diverging edit was preserved under a timestamped sibling, and the stderr said so.
  const tsBaks = fs.readdirSync(dir).filter((f) => /^AGENTS\.md\.bak\.\d+$/.test(f));
  assert.equal(tsBaks.length, 1, `expected one timestamped backup, got ${tsBaks.join(', ')}`);
  assert.equal(fs.readFileSync(path.join(dir, tsBaks[0]), 'utf8'), 'A LATER EDIT that differs from the generated skill\n');
  assert.match(second.stderr, /saved to .*AGENTS\.md\.bak\.\d+/);
});

test('skill install: OUR OWN prior output rolls through ONE .bak.prev — a manifest bump never litters the repo', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-target-'));
  const dest = path.join(dir, 'AGENTS.md');
  const ORIGINAL = 'THE USER\'S OWN AGENTS.md — irreplaceable\n';
  fs.writeFileSync(dest, ORIGINAL);

  // First install parks the user's original at .bak — it carries NO pidge marker,
  // so it is theirs and must survive everything that follows.
  const first = await runSkillInstall(['--target', 'agents'], port, dir);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(fs.readFileSync(`${dest}.bak`, 'utf8'), ORIGINAL);

  // Now five successive refreshes. Each time the file on disk is OUR generated
  // skill (frontmatter marker intact) that has drifted from what the next install
  // writes — exactly the shape of a manifest bump, five releases in a row.
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(dest, `${fs.readFileSync(dest, 'utf8')}\n<!-- drift ${i} -->\n`);
    const r = await runSkillInstall(['--target', 'agents'], port, dir);
    assert.equal(r.code, 0, r.stderr);
  }
  await mock.stop();

  // Their irreplaceable file is exactly where the first install put it.
  assert.equal(fs.readFileSync(`${dest}.bak`, 'utf8'), ORIGINAL, 'the user original must survive every refresh');
  // Ours never minted a timestamped sibling — five bumps, zero litter.
  const tsBaks = fs.readdirSync(dir).filter((f) => /^AGENTS\.md\.bak\.\d+$/.test(f));
  assert.deepEqual(tsBaks, [], `a generated skill must never mint a timestamped backup, got ${tsBaks.join(', ')}`);
  // And the ONE rolling copy holds the LAST version, not the first — a hand-edit
  // made just before the bump is still recoverable.
  assert.match(fs.readFileSync(`${dest}.bak.prev`, 'utf8'), /drift 4/, '.bak.prev must hold the most recent version');
  // Two backups, forever: theirs and our previous.
  const allBaks = fs.readdirSync(dir).filter((f) => f.startsWith('AGENTS.md.bak'));
  assert.equal(allBaks.length, 2, `backups must stay bounded at 2, got ${allBaks.join(', ')}`);
});

// ===========================================================================
// Multi-runtime v2 — identity headers, consumers/provenance
// surfacing, being_handled_by self-filter, conflict warning, --note.
// Every new surface is PRESENT-ONLY: a mock WITHOUT the fields (an old server)
// must degrade cleanly. A stable config dir (fixed XDG_CONFIG_HOME + HOME)
// gives a STABLE fingerprint across two runCli calls — needed to assert "(you)".
// ===========================================================================

function stableIdentityEnv() {
  return {
    XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-c1-xdg-')),
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-c1-home-')),
  };
}

test('multi-runtime — every HTTP verb carries X-Pidge-Fingerprint + URI-encoded label', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [];
  const label = 'inÿest bridge'; // non-ASCII + space ⇒ MUST be URI-encoded in the header
  const env = { PIDGE_LABEL: label };
  await runCli(['whoami'], port, env).result;
  await runCli(['important', '--title', 'hi'], port, env).result;
  await runCli(['ack', '--up-to', '1'], port, env).result;
  await runCli(['inbox'], port, env).result;
  await runCli(['catchup'], port, env).result;
  await mock.stop();

  const enc = encodeURIComponent(label);
  const verbs = [
    ['GET', '/api/v1/whoami'],
    ['POST', '/api/v1/notify'],
    ['POST', '/api/v1/messages/ack'],
    ['GET', '/api/v1/notifications'], // inbox list
    ['GET', '/api/v1/messages'],      // catchup history read
  ];
  for (const [method, pathname] of verbs) {
    const reqs = mock.state.reqLog.filter((r) => r.pathname === pathname && r.method === method);
    assert.ok(reqs.length, `no ${method} ${pathname} recorded`);
    for (const r of reqs) {
      assert.match(r.fingerprint || '', /^fp_[0-9a-f]+$/, `fingerprint header on ${pathname}`);
      assert.equal(r.label, enc, `URI-encoded label header on ${pathname}`);
    }
  }
});

test('multi-runtime — the WS subscribe carries fingerprint/label params (Conversation + Inbox), un-encoded', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('needs Node ≥22');
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [];
  const label = 'team-bridge';
  // No message queued + a short timeout: the socket subscribes, waits, times out
  // (exit 3) — both channels are subscribed before the deadline.
  const { result } = runCli(['listen', '--all', '--realtime', '--timeout', '3'], port, { PIDGE_LABEL: label });
  await result;
  await mock.stop();

  const convo = mock.state.subscribeIdentifiers.find((i) => i.channel === 'ConversationChannel');
  assert.ok(convo, 'ConversationChannel subscribed');
  assert.match(convo.fingerprint || '', /^fp_[0-9a-f]+$/, 'fingerprint on the WS params');
  assert.equal(convo.label, label, 'RAW (un-encoded) label on the WS params — it is a JSON string, not a header');
  const inbox = mock.state.subscribeIdentifiers.find((i) => i.channel === 'InboxChannel');
  assert.ok(inbox && /^fp_/.test(inbox.fingerprint || '') && inbox.label === label, 'InboxChannel identifies too');
});

test('multi-runtime — the doctor realtime probe subscribes ANONYMOUSLY (no phantom consumer)', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('needs Node ≥22');
  const mock = createMock();
  const port = await mock.start();
  const { result } = runCli(['doctor'], port, { PIDGE_LABEL: 'diag' });
  await result;
  await mock.stop();
  const probe = mock.state.subscribeIdentifiers.find((i) => i.channel === 'ConversationChannel');
  assert.ok(probe, 'the probe subscribed to ConversationChannel');
  assert.equal(probe.fingerprint, undefined, 'the probe carries NO fingerprint — a diagnosis must not mint a consumer');
  assert.equal(probe.label, undefined, 'the probe carries NO label');
});

test('multi-runtime — whoami lists live consumers with "(you)" + a consumer_conflict warning', async () => {
  const mock = createMock();
  const port = await mock.start();
  const env = stableIdentityEnv();
  // Step 1: learn OUR fingerprint (stable because the config dir is fixed).
  await runCli(['whoami'], port, env).result;
  const ourFp = mock.state.reqLog.find((r) => r.pathname === '/api/v1/whoami').fingerprint;
  assert.match(ourFp || '', /^fp_/);
  // Step 2: the server now reports two live consumers incl. us.
  mock.state.consumers = [
    { fingerprint: ourFp, label: 'me-here', listening: true, live: true },
    { fingerprint: 'fp_sibling', label: 'other-runtime', listening: false, live: true },
  ];
  mock.state.consumerConflict = true;
  const { result } = runCli(['whoami'], port, env);
  const { code, stderr } = await result;
  await mock.stop();
  assert.equal(code, 0, stderr);
  assert.match(stderr, /consumers — 2 live/);
  assert.match(stderr, /me-here \(you\)/, 'our own row is marked (you) by fingerprint compare');
  assert.match(stderr, /other-runtime/);
  assert.match(stderr, /consumer_conflict/, 'the conflict is flagged');
});

test('multi-runtime — whoami provenance block nudges on blind acks (v67)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.provenance = {
    since: '2026-07-01T00:00:00Z', processed: 41,
    processed_without_summary: 7, processed_unattributed: 2,
  };
  const { result } = runCli(['whoami'], port);
  const { code, stderr } = await result;
  await mock.stop();
  assert.equal(code, 0, stderr);
  assert.match(stderr, /provenance/);
  assert.match(stderr, /41 processed/);
  assert.match(stderr, /7 acked WITHOUT a note/);
});

test('multi-runtime — a pre-v66/v67 server (no consumers/provenance) degrades silently', async () => {
  const mock = createMock();
  const port = await mock.start();
  // consumers/provenance stay null (default) ⇒ the whoami omits both blocks.
  const { result } = runCli(['whoami'], port);
  const { code, stderr } = await result;
  await mock.stop();
  assert.equal(code, 0, stderr);
  assert.ok(!/consumers —/.test(stderr), 'no consumers line against an old server');
  assert.ok(!/provenance/.test(stderr), 'no provenance line against an old server');
  assert.ok(!/consumer_conflict/.test(stderr), 'no conflict line against an old server');
});

test('multi-runtime — catchup --digest renders being_handled_by for a SIBLING, self-filtered', async () => {
  const mock = createMock();
  const port = await mock.start();
  const env = stableIdentityEnv();
  await runCli(['whoami'], port, env).result; // learn our fp
  const ourFp = mock.state.reqLog.find((r) => r.pathname === '/api/v1/whoami').fingerprint;
  mock.state.messages = [
    { id: 10, kind: 'message', body: 'held by ME', channel_id: 1, created_at: 'x',
      being_handled_by: { fingerprint: ourFp, label: 'me', since: '2026-07-07T12:00:00Z' } },
    { id: 11, kind: 'message', body: 'held by a sibling', channel_id: 1, created_at: 'x',
      being_handled_by: { fingerprint: 'fp_bridge', label: 'team-bridge', since: '2026-07-07T12:22:04Z' } },
  ];
  const { result } = runCli(['catchup', '--digest'], port, env);
  const { code, stdout } = await result;
  await mock.stop();
  assert.equal(code, 0);
  const lines = stdout.trim().split('\n');
  const l11 = lines.find((l) => l.startsWith('11 '));
  const l10 = lines.find((l) => l.startsWith('10 '));
  assert.match(l11, /being handled by team-bridge since 2026-07-07T12:22:04Z/, 'a sibling in-flight shows');
  assert.ok(!/being handled by/.test(l10), 'OUR OWN in-flight lease is self-filtered (no self-noise)');
});

test('multi-runtime — listen warns ONCE on consumer_conflict from the consume GET (v66)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.consumeConflict = true;
  mock.state.messages = [{ id: 5, channel_id: 1, body: 'hi', created_at: 'x', consumed_at: null }];
  const { result } = runCli(['listen', '--no-realtime', '--timeout', '20', '--interval', '1'], port);
  const { code, stderr } = await result;
  await mock.stop();
  assert.equal(code, 0, stderr);
  const hits = (stderr.match(/another consumer is live on this channel \(consumer_conflict\)/g) || []).length;
  assert.equal(hits, 1, 'the conflict warning fires exactly once per run');
});

test('multi-runtime — notify --note rides as sent_note', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { result } = runCli(['important', '--title', 'x', '--note', 'armed by the nightly job'], port);
  const { code } = await result;
  await mock.stop();
  assert.equal(code, 0);
  assert.equal(mock.state.notifies[0].sent_note, 'armed by the nightly job');
});

test('multi-runtime — ack narrates "annotated N" when the server backfilled a prior consumer (v67)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.ackAnnotated = 3;
  const { result } = runCli(['ack', '--up-to', '9'], port);
  const { code, stderr } = await result;
  await mock.stop();
  assert.equal(code, 0, stderr);
  assert.match(stderr, /annotated 3 previously-acked message\(s\)/);
});

test('multi-runtime — ack against a pre-v67 server (annotated 0) says nothing extra', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.ackAnnotated = 0; // the default — models an old server / nothing to annotate
  const { result } = runCli(['ack', '--up-to', '9'], port);
  const { code, stderr } = await result;
  await mock.stop();
  assert.equal(code, 0, stderr);
  assert.ok(!/annotated/.test(stderr), 'no annotation narration when there is nothing to annotate');
});

test('multi-runtime — whoami nudges on unattributed_listening (an old-CLI listener)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.consumers = [
    { fingerprint: 'fp_bridge', label: 'team-bridge', listening: false, live: true },
  ];
  mock.state.unattributedListening = true; // channels.listening_until live, no attributed row covers it
  const { result } = runCli(['whoami'], port);
  const { code, stderr } = await result;
  await mock.stop();
  assert.equal(code, 0, stderr);
  assert.match(stderr, /UNIDENTIFIED consumer is listening/, 'the upgrade nudge fires');
  assert.match(stderr, /pre-0\.25/, 'names the cause (an old CLI)');
});

test('multi-runtime — a >80-code-unit label with an astral char at the slice boundary must NOT crash the CLI', async () => {
  const mock = createMock();
  const port = await mock.start();
  // 79 ASCII + an emoji: .slice(0, 80) cuts the surrogate pair in half — the raw
  // lone surrogate made encodeURIComponent throw URIError AT MODULE LOAD (the
  // shared `headers` const), killing EVERY verb before argv parsing.
  const label = 'a'.repeat(79) + '😀';
  const { result } = runCli(['whoami'], port, { PIDGE_LABEL: label });
  const { code, stderr } = await result;
  await mock.stop();
  assert.equal(code, 0, `the CLI must boot and run: stderr:\n${stderr}`);
  const req = mock.state.reqLog.find((r) => r.pathname === '/api/v1/whoami');
  assert.ok(req.label, 'the label header still rides');
  // The header must be decodable (well-formed percent-encoding of well-formed
  // UTF-16) — decodeURIComponent throws on garbage.
  const decoded = decodeURIComponent(req.label);
  assert.ok(decoded.startsWith('a'.repeat(79)), 'the intact prefix survives');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(decoded),
    'no lone surrogate in the decoded label (well-formed)');
});

// ===========================================================================
// Fingerprint salt (claim-retry hardening) + honest cursor `skipped`
// ===========================================================================

test('fingerprint salt — a FRESH install mints fp-salt once and the fingerprint is stable across calls', async () => {
  const mock = createMock();
  const port = await mock.start();
  const env = stableIdentityEnv(); // one XDG shared across both calls
  await runCli(['whoami'], port, env).result;
  await runCli(['whoami'], port, env).result;
  await mock.stop();

  const saltFile = path.join(env.XDG_CONFIG_HOME, 'pidge', 'fp-salt');
  assert.ok(fs.existsSync(saltFile), 'a brand-new identity dir mints fp-salt');
  assert.match(fs.readFileSync(saltFile, 'utf8').trim(), /^[0-9a-f]{32}$/);
  const fps = mock.state.reqLog.filter((r) => r.pathname === '/api/v1/whoami').map((r) => r.fingerprint);
  assert.equal(fps.length, 2);
  assert.equal(fps[0], fps[1], 'the salted fingerprint is STABLE across invocations');
  assert.match(fps[0], /^fp_[0-9a-f]+$/);
});

test('fingerprint salt — an EXISTING install (env on disk, no salt) keeps its legacy fingerprint and mints NOTHING', async () => {
  const mock = createMock();
  const port = await mock.start();
  const env = stableIdentityEnv();
  // simulate a pre-salt install: the env file already exists in the identity dir
  const dir = path.join(env.XDG_CONFIG_HOME, 'pidge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'env'), `PIDGE_URL=http://127.0.0.1:${port}\nPIDGE_TOKEN=hld_test\n`);
  await runCli(['whoami'], port, env).result;
  const first = mock.state.reqLog.filter((r) => r.pathname === '/api/v1/whoami').map((r) => r.fingerprint);
  await runCli(['whoami'], port, env).result;
  await mock.stop();

  assert.ok(!fs.existsSync(path.join(dir, 'fp-salt')),
    'an existing install is NEVER re-identified — no salt file appears');
  const fps = mock.state.reqLog.filter((r) => r.pathname === '/api/v1/whoami').map((r) => r.fingerprint);
  assert.equal(fps[0], fps[1], 'legacy fingerprint stays byte-stable');
  assert.equal(first[0], fps[0]);
});

test('ack — a v88 `skipped` count is narrated honestly (present-only; old servers stay silent)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.ackSkipped = 2;
  const r = await runCli(['ack', '--up-to', '9'], port).result;
  await mock.stop();
  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);
  assert.match(r.stderr, /skipped 2 message\(s\) below the cursor/, 'the refusal is surfaced, not silent');
  assert.match(r.stderr, /stay queued and re-serve/, 'and explained as safe');
});

// --- composer-wake on wait (0.32) -------------------------------------------
// A blocking wait watches ONE notification while the human may TYPE in the
// channel composer — one conversation to them, two planes on the wire. The
// wait now sends wake_on_message=true, and a deliverable composer row returns
// as a TYPED result (kind:"human_message") drained through the one consume
// path (lease semantics intact, ack-after-work).

test('wait wakes on a composer message and returns it typed (kind human_message), un-acked', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 41, channel_id: 1, body: 'na verdade, faz outra coisa antes', created_at: 'x', consumed_at: null }];

  const { result } = runCli(['wait', 'cid-1', '--no-realtime', '--timeout', '10', '--interval', '1'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr:\n${stderr}`);
  assert.match(stdout, /"kind": "human_message"/);
  assert.match(stdout, /na verdade, faz outra coisa antes/);
  assert.match(stdout, /"pending_notification": "cid-1"/, 'says which notification is still unanswered');
  assert.match(stderr, /ACK AFTER you handle them/, 'read-receipt contract: delivered, not done');
  assert.equal(mock.state.acks.length, 0, 'the wake never acks — the agent acks after the work');
  const drainReads = mock.state.messageReads.filter((u) => !/history=true/.test(u));
  assert.equal(drainReads.length, 1, 'exactly one drain through the consume path');
  assert.match(drainReads[0], /continuity=true/, 'the drain asks for the thread context packet');
});

test('an answered wait with queued composer messages prints chosen_action and POINTS at the queue (no drain)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['cid-2'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'yes', label: 'Sim', text: null },
  };
  mock.state.messages = [{ id: 42, channel_id: 1, body: 'e mais uma coisa', created_at: 'x', consumed_at: null }];

  const { result } = runCli(['wait', 'cid-2', '--no-realtime', '--timeout', '10', '--interval', '1'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr:\n${stderr}`);
  assert.match(stdout, /"action_id": "yes"/, 'the answer is the primary result — shape untouched');
  assert.match(stderr, /ALSO holds composer message/, 'the backlog is named before exiting');
  assert.equal(mock.state.messageReads.length, 0, 'not drained here — a drain would lease the rows the suggested listen should read');
});

test('a running bridge suppresses the composer wake — the wait never double-consumes the queue', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 43, channel_id: 1, body: 'do bridge, não sua', created_at: 'x', consumed_at: null }];

  // A live bridge lock for THIS token (hash mirrors the CLI's per-channel key),
  // held by our own pid — alive by construction.
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-lock-'));
  const h = crypto.createHash('sha256').update('hld_test').digest('hex').slice(0, 16);
  fs.mkdirSync(path.join(xdg, 'pidge'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'pidge', `bridge-${h}.lock`),
    JSON.stringify({ pid: process.pid, started_at: 'x', label: 'test-bridge' }) + '\n');

  const { result } = runCli(['wait', 'cid-3', '--no-realtime', '--timeout', '2', '--interval', '1'], port,
    { XDG_CONFIG_HOME: xdg });
  const { code } = await result;
  await mock.stop();

  assert.equal(code, 3, 'no wake — the wait rides to its timeout');
  assert.equal(mock.state.messageReads.length, 0, 'the queue was never touched');
});

test('doctor counts un-acked composer messages and says nobody is consuming', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 44, channel_id: 1, body: 'quero parar isso tudo', created_at: 'x', consumed_at: null }];

  const { result } = runCli(['doctor', '--no-realtime'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr:\n${stderr}`);
  assert.match(stderr, /1 composer message\(s\) un-acked/);
  assert.match(stderr, /Nobody is consuming this queue/);
  const historyReads = mock.state.messageReads.filter((u) => /history=true/.test(u));
  assert.equal(historyReads.length, 1, 'the probe is the read-only history read');
  assert.equal(mock.state.acks.length, 0, 'the probe never consumes or acks');
});

test('doctor confirms a clean composer queue explicitly', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['doctor', '--no-realtime'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr:\n${stderr}`);
  assert.match(stderr, /composer queue: no un-acked messages ✓/);
});

// --- honest signals: the two doctor probes + the wait-under-a-live-consumer line ---
//
// A green light nobody earned is the failure mode. `doctor` learned to name the
// two shapes it can see from the READ-ONLY history: a consumer that takes
// deliveries and never acks (deaf), and an ack with nothing behind it (mute).
// Both are advisory, both degrade to silence on a server that omits the fields.

const AGO = (ms) => new Date(Date.now() - ms).toISOString();

test('doctor: a LIVE consumer + deliveries whose lease lapsed un-acked = a DEAF consumer, said out loud', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.consumers = [{ fingerprint: 'fp_loop', label: 'blind-loop', listening: true, live: true }];
  mock.state.messages = [
    // served, lease already expired, still unprocessed — it was read and dropped
    { id: 61, kind: 'message', body: 'primeira', created_at: 'x',
      delivered_at: AGO(600000), delivery_expires_at: AGO(60000) },
    { id: 62, kind: 'message', body: 'segunda', created_at: 'x',
      delivered_at: AGO(600000), delivery_expires_at: AGO(30000) },
    // fresh delivery, lease still open — NOT evidence of anything
    { id: 63, kind: 'message', body: 'em voo', created_at: 'x',
      delivered_at: AGO(5000), delivery_expires_at: new Date(Date.now() + 600000).toISOString() },
  ];

  const { code, stderr } = await runCli(['doctor', '--no-realtime'], port).result;
  await mock.stop();

  assert.equal(code, 0, `the probe is advisory — never exit 2; stderr:\n${stderr}`);
  assert.match(stderr, /2 message\(s\) were DELIVERED to a consumer/, 'only the lapsed ones count');
  assert.match(stderr, /without handling it/, 'it names the shape (read, not handled)');
  assert.equal(mock.state.acks.length, 0, 'the probe never consumes or acks');
});

test('doctor: the same backlog with NOBODY live stays the "nobody is consuming" story, not a deaf-consumer warning', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 64, kind: 'message', body: 'sozinha', created_at: 'x',
    delivered_at: AGO(600000), delivery_expires_at: AGO(60000) }];

  const { code, stderr } = await runCli(['doctor', '--no-realtime'], port).result;
  await mock.stop();

  assert.equal(code, 0, `stderr:\n${stderr}`);
  assert.match(stderr, /Nobody is consuming this queue/);
  assert.ok(!/DELIVERED to a consumer/.test(stderr), 'with no consumer there is nothing deaf to report');
});

test('doctor: handled_state "drained" in the last 24h is called a MUTE ack; other states are not', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 71, kind: 'message', body: 'a', created_at: 'x', processed_at: AGO(3600000), handled_state: 'drained' },
    { id: 72, kind: 'message', body: 'b', created_at: 'x', processed_at: AGO(7200000), handled_state: 'drained' },
    { id: 73, kind: 'message', body: 'c', created_at: 'x', processed_at: AGO(3600000), handled_state: 'responded' },
    { id: 74, kind: 'message', body: 'd', created_at: 'x', processed_at: AGO(3600000), handled_state: 'acked_with_note' },
    { id: 75, kind: 'message', body: 'e', created_at: 'x', processed_at: AGO(48 * 3600000), handled_state: 'drained' },
  ];

  const { code, stdout, stderr } = await runCli(['doctor', '--no-realtime'], port).result;
  await mock.stop();

  assert.equal(code, 0, `stderr:\n${stderr}`);
  assert.match(stderr, /2 message\(s\) acked in the last 24h with NO note/, 'only the recent drained rows count');
  assert.match(stderr, /MUTE ack/);
  assert.match(stderr, /composer queue: no un-acked messages ✓/, 'processed rows are not pending — the other line still tells the truth');
  // A finding a script can't see is trivia. The probe NAMES its own kind, so a
  // rewrite of the prose above can never quietly demote it to "other".
  const line = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(line.warnings, 1, 'the mute-ack finding counts as a warning (one finding, however many messages)');
  assert.deepEqual(line.warning_kinds, ['mute_ack'], 'and it is named on the machine line');
  assert.match(stderr, /healthy — 1 warning\(s\) above \(mute_ack\)/, 'the verdict agrees with the lines above it');
});

test('doctor: an OLD server (no handled_state field) says nothing about mute acks — silence, not a complaint', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 76, kind: 'message', body: 'a', created_at: 'x', processed_at: AGO(3600000) }];

  const { code, stderr } = await runCli(['doctor', '--no-realtime'], port).result;
  await mock.stop();

  assert.equal(code, 0, `stderr:\n${stderr}`);
  assert.ok(!/MUTE ack/.test(stderr), 'a field the server does not send is not a finding');
  assert.ok(!/handled_state/.test(stderr), 'and never a complaint ABOUT the missing field');
});

test('a wait under a LIVE consumer narrates the asymmetry (and still never drains the queue)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 81, channel_id: 1, body: 'do listener, não sua', created_at: 'x', consumed_at: null }];

  // A live consumer lock for THIS token, held by our own pid — alive by construction.
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-livelock-'));
  const h = crypto.createHash('sha256').update('hld_test').digest('hex').slice(0, 16);
  fs.mkdirSync(path.join(xdg, 'pidge'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'pidge', `bridge-${h}.lock`),
    JSON.stringify({ pid: process.pid, started_at: 'x', label: 'my-listener' }) + '\n');

  const { code, stderr } = await runCli(['wait', 'cid-live', '--no-realtime', '--timeout', '2', '--interval', '1'], port,
    { XDG_CONFIG_HOME: xdg }).result;
  await mock.stop();

  assert.equal(code, 3, 'no wake — the wait rides to its timeout');
  assert.match(stderr, /LIVE consumer/, 'the asymmetry is narrated, not silent');
  assert.match(stderr, /"my-listener"/, 'and it names who holds the channel');
  assert.match(stderr, /hears ONLY the answer/, 'it says what this wait can and cannot hear');
  assert.equal(stderr.split('\n').filter((l) => /LIVE consumer/.test(l)).length, 1, 'once per process, not once per poll');
  assert.equal(mock.state.messageReads.length, 0, 'the queue was never touched');
});

// ---------------------------------------------------------------------------
// 0.53.1 — the no-token exit recovers, it doesn't just restart (a fresh-agent
// live test, 2026-08-29): with the identity ON DISK under agents/<id>/env and
// only PIDGE_AGENT missing from the environment, the old message pointed at
// `setup --claim <code>` — a single-use code the agent had already burned.

test('no token + per-agent envs on disk: the exit names PIDGE_AGENT=<id> BEFORE suggesting re-onboarding', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-notoken-'));
  for (const id of ['oldie', 'newbie']) {
    fs.mkdirSync(path.join(home, 'pidge', 'agents', id), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, 'pidge', 'agents', id, 'env'), 'PIDGE_TOKEN=hld_parked\n', { mode: 0o600 });
  }
  // a project-scoped env exists too, and this run is OUTSIDE any git project —
  // both recovery paths must be named before the claim-code last resort
  fs.mkdirSync(path.join(home, 'pidge', 'projects', 'abcd1234'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, 'pidge', 'projects', 'abcd1234', 'env'), 'PIDGE_TOKEN=hld_proj\n', { mode: 0o600 });

  const { code, stderr } = await runCli(['whoami'], 9, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, nonGitCwd()).result;

  assert.equal(code, 1);
  assert.match(stderr, /PIDGE_AGENT=newbie/, 'every id with an env file is listed');
  assert.match(stderr, /PIDGE_AGENT=oldie/);
  assert.match(stderr, /EVERY pidge command needs it/, 'the stickiness rides the recovery hint');
  assert.match(stderr, /1 project-scoped config/, 'the project path is offered too');
  assert.ok(stderr.indexOf('PIDGE_AGENT=') < stderr.indexOf('setup --claim'),
    're-onboarding is the LAST resort, never the first suggestion');
});

test('no token + nothing on disk: the exit still leads with PIDGE_TOKEN/setup (no phantom hints)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-notoken-bare-'));
  const { code, stderr } = await runCli(['whoami'], 9, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, nonGitCwd()).result;
  assert.equal(code, 1);
  assert.match(stderr, /set PIDGE_TOKEN/);
  assert.match(stderr, /setup --claim/);
  assert.ok(!/PIDGE_AGENT=/.test(stderr), 'no ids to name — no hint invented');
});

test('setup heals a config dir that PRE-EXISTS group-writable to 0700 (the mkdir mode cannot)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-perm-'));
  // the trap: the dir chain exists ALREADY, looser than the CLI would mint it
  // (observed live: born 0775 under a shared-group umask, outside the CLI)
  const agentDir = path.join(home, 'pidge', 'agents', 'perm-heal');
  fs.mkdirSync(agentDir, { recursive: true });
  for (const d of [path.join(home, 'pidge'), path.join(home, 'pidge', 'agents'), agentDir]) fs.chmodSync(d, 0o775);

  const { code, stderr } = await runCli(
    ['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'perm-heal' }, nonGitCwd(),
  ).result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  for (const d of [path.join(home, 'pidge'), path.join(home, 'pidge', 'agents'), agentDir]) {
    assert.equal(fs.statSync(d).mode & 0o777, 0o700, `${d} must be healed to 0700`);
  }
  assert.equal(fs.statSync(path.join(agentDir, 'env')).mode & 0o777, 0o600);
  assert.match(stderr, /escopo do agente "perm-heal"/, 'the scope note names the agent');
  assert.match(stderr, /PIDGE_AGENT=perm-heal no ambiente/, 'and says the var is needed on every later command');
});

// ── 0.54: the write probe, the follow gate, presence + the SessionStart hook ──

test('setup refuses BEFORE spending the claim code when the config dir is not writable (a Codex-sandbox shape)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-setup-ro-'));
  fs.chmodSync(home, 0o500); // read-only: mkdir/write under it fails for a non-root user
  const proj = makeProject();
  const { result } = runCli(['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`], port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, proj);
  const { code, stderr } = await result;
  await mock.stop();
  fs.chmodSync(home, 0o700);
  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.match(stderr, /NOT writable/);
  assert.match(stderr, /claim code was NOT consumed/);
  assert.match(stderr, /XDG_CONFIG_HOME="\$PWD\/\.pidge"/, 'the fix is named: config inside the workspace');
  assert.equal(mock.state.claimCode, 'claim-ok', 'the single-use code is still valid — nothing was exchanged');
});

test('online --follow --timeout 0 (the forever watch) refuses outside Claude Code — a background run there would be a DEAF consumer', async () => {
  const mock = createMock();
  const port = await mock.start();
  const denied = await runCli(['online', '--follow', '--timeout', '0', '--no-realtime'], port, { CLAUDECODE: '' }).result;
  assert.equal(denied.code, 1, `stderr: ${denied.stderr}`);
  assert.match(denied.stderr, /DEAF consumer/);
  assert.match(denied.stderr, /FOREGROUND/);
  assert.match(denied.stderr, /PIDGE_EVENT_STREAM=1/);
  // an explicit event-stream declaration lets any harness run it; Claude Code sets CLAUDECODE itself
  for (const env of [{ CLAUDECODE: '', PIDGE_EVENT_STREAM: '1' }, { CLAUDECODE: '1' }]) {
    const r = runCli(['online', '--follow', '--timeout', '0', '--no-realtime', '--interval', '1'], port, env);
    await new Promise((res) => setTimeout(res, 2500));
    assert.equal(r.child.exitCode, null, `the forever watch must still be running under ${JSON.stringify(env)}`);
    r.child.kill('SIGTERM');
    await r.result;
  }
  await mock.stop();
});

test('presence — ONE line for a SessionStart hook: OFFLINE tells the agent to start the watch; a live consumer tells it to read, never listen', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.consumers = [];
  mock.state.listeningState = 'offline';
  const off = await runCli(['presence'], port).result;
  assert.equal(off.code, 0, off.stderr);
  assert.equal(off.stdout.trim().split('\n').length, 1, 'exactly one line — it lands in the agent\'s context at every session start');
  assert.match(off.stdout, /OFFLINE/);
  assert.match(off.stdout, /Monitor\(\{command:'pidge online --follow --ndjson --timeout 0'/);
  mock.state.consumers = [{ fingerprint: 'fp', label: 'my-watch', listening: true, live: true }];
  mock.state.listeningState = 'listening';
  const on = await runCli(['presence'], port).result;
  // a consumer row that lingers after the session died: the MEASURED presence wins
  mock.state.listeningState = 'offline';
  const stale = await runCli(['presence'], port).result;
  await mock.stop();
  assert.match(stale.stdout, /OFFLINE — nobody is listening/, 'a lingering consumer row never contradicts a measured offline');
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /listening — my-watch holds the queue/);
  assert.match(on.stdout, /never start a second listener/);
});

test('hook install writes a tagged SessionStart entry into the PROJECT .claude/settings.json, keeps other hooks, is idempotent, and uninstall removes only ours', async () => {
  const mock = createMock();
  const port = await mock.start();
  const proj = makeProject();
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo theirs' }] }] } }));
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-hook-xdg-')); // one identity for both runs — the command embeds it
  const a = await runCli(['hook', 'install'], port, { XDG_CONFIG_HOME: xdg }, proj).result;
  assert.equal(a.code, 0, a.stderr);
  const s1 = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s1.permissions, { allow: ['Bash(ls:*)'] }, 'unrelated settings survive');
  assert.equal(s1.hooks.SessionStart.length, 2, 'theirs + ours');
  assert.equal(s1.hooks.SessionStart[0].hooks[0].command, 'echo theirs');
  assert.match(s1.hooks.SessionStart[1].hooks[0].command, /pidge\.js' presence$/, 'ours runs THIS CLI\'s presence');
  assert.equal(JSON.parse(a.stdout).changed, true);
  const b = await runCli(['hook', 'install'], port, { XDG_CONFIG_HOME: xdg }, proj).result;
  assert.equal(JSON.parse(b.stdout).changed, false, 'idempotent');
  assert.equal(JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart.length, 2, 'no duplicate');
  const c = await runCli(['hook', 'uninstall'], port, { XDG_CONFIG_HOME: xdg }, proj).result;
  await mock.stop();
  assert.equal(JSON.parse(c.stdout).removed, true);
  const s3 = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s3.hooks.SessionStart.length, 1, 'only ours is gone');
  assert.equal(s3.hooks.SessionStart[0].hooks[0].command, 'echo theirs');
});

test('setup under Claude Code installs the SessionStart hook; --no-hook skips it; outside Claude Code nothing is written', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-setup-hook-'));
  const proj = makeProject();
  const r = await runCli(['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`], port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, CLAUDECODE: '1' }, proj).result;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /SessionStart hook installed/);
  const s = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8'));
  assert.match(s.hooks.SessionStart[0].hooks[0].command, /presence$/);

  mock.state.claimCode = 'claim-ok';
  const proj2 = makeProject();
  const r2 = await runCli(['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`, '--no-hook'], port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-setup-hook2-')), CLAUDECODE: '1' }, proj2).result;
  assert.equal(r2.code, 0, r2.stderr);
  assert.ok(!fs.existsSync(path.join(proj2, '.claude', 'settings.json')), '--no-hook writes nothing');

  mock.state.claimCode = 'claim-ok';
  const proj3 = makeProject();
  const r3 = await runCli(['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`], port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-setup-hook3-')), CLAUDECODE: '' }, proj3).result;
  await mock.stop();
  assert.equal(r3.code, 0, r3.stderr);
  assert.ok(!fs.existsSync(path.join(proj3, '.claude', 'settings.json')), 'not Claude Code: no hook');
});

// ── 0.54.3: the consumer kind, the clamp, the durable hook ───────────────────

test('consumer kind — listen sends `listen`, the forever watch sends `watch`, sends and reads send none', async () => {
  const mock = createMock();
  const port = await mock.start();
  await runCli(['listen', '--no-realtime', '--timeout', '1'], port).result;
  const w = runCli(['online', '--follow', '--timeout', '0', '--no-realtime', '--interval', '1'], port, { CLAUDECODE: '1' });
  await new Promise((r) => setTimeout(r, 2000));
  w.child.kill('SIGTERM'); await w.result;
  await runCli(['whoami'], port).result;
  await runCli(['message', '--title', 'x', '--body', 'y'], port).result;
  await mock.stop();
  const kinds = (p) => mock.state.reqLog.filter((r) => r.pathname === p).map((r) => r.kind);
  assert.ok(kinds('/api/v1/messages').includes('listen'), `a listen round says listen: ${JSON.stringify(mock.state.reqLog.map((r) => [r.pathname, r.kind]))}`);
  assert.ok(kinds('/api/v1/messages').includes('watch'), 'the forever watch says watch');
  assert.ok(kinds('/api/v1/whoami').every((k) => k === null), 'whoami is a read — no kind');
  assert.ok(kinds('/api/v1/notify').every((k) => k === null), 'a send is not a consumer — no kind');
});

test('--follow --timeout 0 never trips TimeoutOverflowWarning (the far-future deadline is clamped)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const w = runCli(['online', '--follow', '--timeout', '0', '--interval', '1'], port, { CLAUDECODE: '1' });
  await new Promise((r) => setTimeout(r, 3000));
  w.child.kill('SIGTERM');
  const r = await w.result;
  await mock.stop();
  assert.doesNotMatch(r.stderr, /TimeoutOverflowWarning/, `stderr:\n${r.stderr}`);
});

test('hook install from a real install path writes `pidge presence` when a pidge is on PATH, else the CLI path', async () => {
  const mock = createMock();
  const port = await mock.start();
  const proj = makeProject();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-fake-global-'));
  fs.writeFileSync(path.join(bin, 'pidge'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const a = await runCli(['hook', 'install'], port, { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin` }, proj).result;
  assert.equal(a.code, 0, a.stderr);
  assert.match(JSON.parse(a.stdout).command, /(^| )pidge presence$/, 'a global pidge is the durable choice');
  const b = await runCli(['hook', 'install'], port, { PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin` }, proj).result;
  await mock.stop();
  assert.match(JSON.parse(b.stdout).command, /pidge\.js' presence$/, 'no global pidge: this CLI\'s path');
});

test('0.54.5: a watch exits when the HARNESS that launched it dies, even though its shell parent survives (no deaf consumer)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-orphan-'));
  // harness (node) → sh (survives) → the watch. Kill the harness; the shell keeps living.
  const harness = spawn(process.execPath, ['-e', `
    const { spawn } = require('child_process');
    const sh = spawn('sh', ['-c', ${JSON.stringify(`${process.execPath} ${CLI} online --follow --ndjson --timeout 0 --no-realtime --interval 1 2>"${xdg}/watch.err"; sleep 30`)}], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, PIDGE_URL: `http://127.0.0.1:${port}`, PIDGE_TOKEN: 'hld_test', XDG_CONFIG_HOME: xdg, HOME: xdg, CLAUDECODE: '1' }, stdio: 'ignore' });
  const lock = path.join(xdg, 'pidge', `bridge-${crypto.createHash('sha256').update('hld_test').digest('hex').slice(0, 16)}.lock`);
  const until = Date.now() + 15000;
  while (!fs.existsSync(lock) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  assert.ok(fs.existsSync(lock), 'the watch is up (lock held)');
  harness.kill('SIGKILL'); // the harness dies; sh keeps the watch as its child
  const until2 = Date.now() + 25000;
  while (fs.existsSync(lock) && Date.now() < until2) await new Promise((r) => setTimeout(r, 300));
  await mock.stop();
  const err = (() => { try { return fs.readFileSync(path.join(xdg, 'watch.err'), 'utf8'); } catch { return '(no stderr)'; } })();
  assert.ok(!fs.existsSync(lock), `the watch released the channel after its harness died; watch stderr:\n${err}`);
  assert.match(fs.readFileSync(path.join(xdg, 'watch.err'), 'utf8'), /the harness that launched me \(node, pid \d+\) is gone/);
});

test('0.54.5: the session-length watch is not scolded as "TURN-BASED must NOT use --follow"', async () => {
  const mock = createMock();
  const port = await mock.start();
  const w = runCli(['online', '--follow', '--timeout', '0', '--no-realtime', '--interval', '1'], port, { CLAUDECODE: '1' });
  await new Promise((r) => setTimeout(r, 2000));
  w.child.kill('SIGTERM');
  const r = await w.result;
  await mock.stop();
  assert.doesNotMatch(r.stderr, /must NOT use --follow/, `stderr:\n${r.stderr}`);
});

// ── 0.54.8: a printed body must survive the pipe ────────────────────────────
// The field bug: `pidge inbox --limit 200` read by an agent through a
// subprocess arrived cut at ~64 KB ("Unterminated string" when it parsed it),
// while the SAME command redirected to a FILE was whole (466 KB) — and the
// half-read inbox produced a false "receipt not found" inside a money gate.
// Cause: stdout on a PIPE is async, so `console.log(big)` + `process.exit(0)`
// on the next tick drops whatever the pipe buffer hadn't taken. The consumer
// here is DELIBERATELY slow (it attaches its reader a second late, exactly the
// shape of a subprocess that collects output after the child is gone) — the
// unfixed CLI loses the tail there, and a pipe is the CANONICAL way an agent
// reads this CLI.
test('0.54.8: a big `inbox` body reaches a SLOW pipe consumer WHOLE (no 64 KB cut)', async () => {
  const mock = createMock();
  const port = await mock.start();
  // ~460 KB — the size the field report measured.
  mock.state.inboxNotifications = Array.from({ length: 400 }, (_, i) => ({
    id: i + 1, correlation_id: `cid-${i}`, title: `t${i}`.padEnd(120, '·'),
    body: 'conteúdo do relatório '.repeat(40), status: 'delivered', responded: false,
  }));

  const child = spawn(process.execPath, [CLI, 'inbox', '--limit', '200'], {
    env: {
      ...process.env,
      PIDGE_URL: `http://127.0.0.1:${port}`,
      PIDGE_TOKEN: 'hld_test',
      XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-flush-')),
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-flush-home-')),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  // stdout is left UNREAD on purpose: no 'data' handler ⇒ the stream never
  // flows and the OS pipe fills at 64 KB while the CLI prints.
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  await sleep(1200); // the CLI has printed (and, unfixed, exited) by now
  child.stdout.on('data', (c) => { stdout += c; });
  const code = await closed;
  await mock.stop();

  assert.equal(code, 0, `stderr:\n${stderr}`);
  assert.ok(stdout.length > 65536,
    `the body was truncated at the pipe buffer: ${stdout.length} bytes (65536 = the classic cut); stderr:\n${stderr}`);
  const data = JSON.parse(stdout); // the assertion that matters: it still PARSES
  assert.equal(data.notifications.length, 400, 'every row arrived, not just the first pipe-full');
});

// The same cut, on the path an agent lives in: a `listen`/`online` round prints
// the whole batch and exits. A watch whose batch is truncated hands its agent
// half a message — worse than none, because it parses.
test('0.54.8: a big `listen` batch reaches a SLOW pipe consumer WHOLE', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = Array.from({ length: 60 }, (_, i) => ({
    id: i + 1, kind: 'message', created_at: 'x',
    body: `mensagem ${i}: ` + 'texto longo do humano '.repeat(300),
  }));

  const child = spawn(process.execPath, [CLI, 'listen', '--all', '--no-realtime', '--timeout', '10', '--interval', '1'], {
    env: {
      ...process.env,
      PIDGE_URL: `http://127.0.0.1:${port}`,
      PIDGE_TOKEN: 'hld_test',
      XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-flush2-')),
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-flush2-home-')),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  await sleep(1500);
  child.stdout.on('data', (c) => { stdout += c; });
  const code = await closed;
  await mock.stop();

  assert.equal(code, 0, `stderr:\n${stderr}`);
  assert.ok(stdout.length > 65536, `truncated batch: ${stdout.length} bytes; stderr:\n${stderr}`);
  const rows = JSON.parse(stdout);
  assert.equal(rows.length, 60, 'the whole batch parses — every row is there');
});
