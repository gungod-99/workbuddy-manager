import assert from 'node:assert/strict';
import {test} from 'node:test';
import {callbackIssue, CodeArtsLoginFlow} from './codearts-login.ts';

const deferred = () => {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};};
const login = (id) => ({account_id: id, login_url: 'https://codearts.huaweicloud.com/authorize', expires_at: Date.now() / 1000 + 180});

test('a long pasted callback remains valid and is forwarded completely', async () => {
  const url = 'http://localhost:19000/oauth/callback?code=' + 'x'.repeat(3800) + '&state=' + 'y'.repeat(2000);
  let received;
  const {flow} = setup({callback: async (id, value) => {received = value; return {accepted: true};}});
  assert.equal(callbackIssue(url), null);
  await flow.start(); await flow.submit(url);
  assert.equal(received, url);
  assert.equal(flow.state.phase, 'exchanging');
  flow.close();
});
function setup(overrides = {}) {
  const cancelled = [], states = [];
  let successes = 0;
  const api = {start: async () => login('first'), poll: async () => ({done: false}),
    callback: async () => ({accepted: true}), cancel: async (id) => {cancelled.push(id);}, ...overrides};
  const flow = new CodeArtsLoginFlow({api, changed: (value) => states.push(value), success: () => {successes += 1;},
    errorText: (error) => error.message, messages: {expired: 'expired', rejected: 'rejected', failed: 'failed'}});
  flow.open();
  return {flow, states, cancelled, successes: () => successes};
}

test('a late start response cannot overwrite a newly opened dialog', async () => {
  const old = deferred(); let starts = 0;
  const {flow, cancelled} = setup({start: () => ++starts === 1 ? old.promise : Promise.resolve(login('new'))});
  const first = flow.start(); flow.close(); flow.open(); await flow.start();
  old.resolve(login('old')); await first;
  assert.equal(flow.state.login.account_id, 'new');
  assert.ok(cancelled.includes('old'));
  flow.close();
});

test('late callback errors after close and retry cannot pollute the new authorization', async () => {
  const old = deferred();
  const {flow} = setup({callback: () => old.promise});
  await flow.start(); const submit = flow.submit('callback');
  flow.close(); flow.open(); await flow.start();
  old.reject(new Error('old error')); await submit;
  assert.equal(flow.state.phase, 'waiting'); assert.equal(flow.state.error, '');
  flow.close();
});

test('double clicks produce one start and one callback request', async () => {
  const start = deferred(), callback = deferred(); let starts = 0, submissions = 0;
  const {flow} = setup({start: () => {starts += 1; return start.promise;}, callback: () => {submissions += 1; return callback.promise;}});
  const a = flow.start(), b = flow.start();
  assert.equal(starts, 1); start.resolve(login('first')); await Promise.all([a, b]);
  const c = flow.submit('callback'), d = flow.submit('callback');
  assert.equal(submissions, 1); callback.resolve({accepted: true}); await Promise.all([c, d]);
  assert.equal(flow.state.phase, 'exchanging');
  flow.close();
});

test('poll success wins over a later callback error and runs completion once', async () => {
  const old = deferred();
  const {flow, successes} = setup({callback: () => old.promise, poll: async () => ({done: true, success: true})});
  await flow.start(); const submit = flow.submit('callback'); await flow.pollOnce();
  old.reject(new Error('too late')); await submit; await flow.pollOnce();
  assert.equal(flow.state.phase, 'success'); assert.equal(flow.state.error, ''); assert.equal(successes(), 1);
  flow.close();
});

test('expiry uses the original server deadline and never extends on a poll', async () => {
  const {flow} = setup({start: async () => ({...login('expired'), expires_at: Date.now() / 1000 - 1})});
  await flow.start(); await flow.pollOnce();
  assert.equal(flow.state.phase, 'failed'); assert.equal(flow.state.error, 'expired');
  flow.close();
});

test('an old in-flight poll does not block the new generation', async () => {
  const old = deferred(); let calls = 0;
  const {flow, successes} = setup({poll: () => ++calls === 1 ? old.promise : Promise.resolve({done: true, success: true})});
  await flow.start(); const firstPoll = flow.pollOnce();
  flow.close(); flow.open(); await flow.start(); await flow.pollOnce();
  old.resolve({done: true, success: false, error: 'old failure'}); await firstPoll;
  assert.equal(flow.state.phase, 'success'); assert.equal(successes(), 1);
  flow.close();
});

test('a callback in flight at link expiry can still finish successfully', async (t) => {
  t.mock.timers.enable({apis: ['Date'], now: 1000000});
  const callback = deferred(); let finished = false;
  const {flow, successes} = setup({callback: () => callback.promise,
    start: async () => ({...login('near-expiry'), expires_at: 1001}),
    poll: async () => ({done: finished, success: finished})});
  try {
    await flow.start();
    const submission = flow.submit('callback');
    t.mock.timers.setTime(1002000);
    await flow.pollOnce();
    assert.equal(flow.state.phase, 'submitting');
    callback.resolve({accepted: true}); await submission;
    finished = true; await flow.pollOnce();
    assert.equal(flow.state.phase, 'success'); assert.equal(successes(), 1);
  } finally {flow.close();}
});

test('a rejected callback restores the original link deadline', async (t) => {
  t.mock.timers.enable({apis: ['Date'], now: 1000000});
  const callback = deferred();
  const {flow} = setup({callback: () => callback.promise,
    start: async () => ({...login('near-expiry'), expires_at: 1001})});
  try {
    await flow.start(); const submission = flow.submit('callback');
    t.mock.timers.setTime(1002000);
    callback.resolve({accepted: false}); await submission;
    assert.equal(flow.state.phase, 'waiting');
    await flow.pollOnce();
    assert.equal(flow.state.phase, 'failed'); assert.equal(flow.state.error, 'expired');
  } finally {flow.close();}
});

test('close invalidates responses immediately and cancels once across cleanup', async () => {
  const result = deferred();
  const {flow, cancelled, successes} = setup({poll: () => result.promise});
  await flow.start(); const polling = flow.pollOnce();
  flow.close(); flow.close();
  result.resolve({done: true, success: true}); await polling;
  assert.equal(successes(), 0);
  assert.deepEqual(cancelled, ['first']);
});

test('callback feedback accepts complete loopback URLs and rejects incomplete or external ones', () => {
  assert.equal(callbackIssue('http://127.0.0.1:19000/callback?code=a&state=b'), null);
  assert.equal(callbackIssue('http://[::1]:19000/callback?code=a&state=b'), null);
  assert.equal(callbackIssue('http://localhost:19000/oauth/callback?code=a'), null);
  assert.equal(callbackIssue('http://127.0.0.1:19000/oauth/callback?secret=a&redirect=true'), null);
  assert.equal(callbackIssue('http://localhost:19000/oauth/callback?state=b'), 'missing');
  assert.equal(callbackIssue('http://localhost:19000/oauth/callback?code=%20&secret='), 'missing');
  assert.equal(callbackIssue('https://huaweicloud.com/?code=a&state=b'), 'invalid');
  assert.equal(callbackIssue('http://user:pw@localhost:19000/?code=a&state=b'), 'invalid');
  assert.equal(callbackIssue('not a URL'), 'invalid');
});
