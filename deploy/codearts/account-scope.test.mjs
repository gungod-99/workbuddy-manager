import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {scopeAllows, scopeHandler, verifyScope, withScope} from './account-scope.mjs';
import {hubRevision, patchLibrary} from './patch.mjs';

const admin = 'test-admin-only', gateway = 'test-gateway-only';
function sign(accounts, path = '/v1/chat/completions', at = Math.floor(Date.now() / 1000)) {
  const payload = Buffer.from(JSON.stringify({v: 1, at, path, accounts})).toString('base64url');
  return payload + '.' + createHmac('sha256', admin).update('wb-ca-scope-v1.' + payload).digest('base64url');
}
const entry = (name) => ({id: 'codearts-' + name, provider: 'codearts', enabled: true, credentialRef: 'test_' + name});

test('signed scope rejects tampering, expiry, wrong paths and malformed accounts', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.deepEqual([...verifyScope(sign(['codearts-a']), '/v1/chat/completions', admin)], ['codearts-a']);
  for (const token of [sign(['codearts-a'], '/wrong'), sign(['codearts-a'], undefined, now - 91),
    sign(['codearts-a'], undefined, now + 91), sign(['buddy-a']), sign(['codearts-' + 'a'.repeat(97)]),
    sign(Array(201).fill('codearts-a')), sign(['codearts-a']) + 'x', 'invalid']) {
    assert.throws(() => verifyScope(token, '/v1/chat/completions', admin, now));
  }
  assert.deepEqual([...verifyScope(sign([]), '/v1/chat/completions', admin)], []);
});

test('concurrent asynchronous scopes remain isolated and empty scope never means unrestricted', async () => {
  const rows = [entry('a'), entry('b')];
  assert.equal(rows.filter(scopeAllows).length, 2);
  const results = await Promise.all(Array.from({length: 60}, (_, i) => withScope([rows[i % 2].id], async () => {
    await setTimeout(i % 5);
    return rows.filter(scopeAllows).map((a) => a.id);
  })));
  results.forEach((result, i) => assert.deepEqual(result, [rows[i % 2].id]));
  assert.deepEqual(withScope([], () => rows.filter(scopeAllows)), []);
  assert.equal(rows.filter(scopeAllows).length, 2);
});

test('HTTP contract requires gateway authorization and a valid signature before filtering', async () => {
  const previous = [process.env.CODEARTS2API_ADMIN_KEY, process.env.DSH_OPENAI_GATEWAY_API_KEY];
  process.env.CODEARTS2API_ADMIN_KEY = admin;
  process.env.DSH_OPENAI_GATEWAY_API_KEY = gateway;
  const server = createServer(scopeHandler(async (_req, res) => {
    await setTimeout(2);
    res.end(JSON.stringify([entry('a'), entry('b')].filter(scopeAllows).map((a) => a.id)));
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = (accounts, path) => ({Authorization: 'Bearer ' + gateway, 'X-WB-CA-Scope': sign(accounts, path)});
  try {
    const path = '/v1/wb-account-scope';
    const capability = await fetch(base + path, {headers: headers(['codearts-a'], path)});
    assert.equal(capability.status, 200);
    assert.equal(capability.headers.get('x-wb-ca-scope'), 'v1');
    assert.deepEqual(await capability.json(), {version: 1});
    assert.equal((await fetch(base + path)).status, 403);
    assert.equal((await fetch(base + path, {headers: {'X-WB-CA-Scope': sign([], path)}})).status, 403);
    const responses = await Promise.all(['a', 'b'].map((name) => fetch(base + '/v1/chat/completions', {
      headers: headers(['codearts-' + name])}).then((r) => r.json())));
    assert.deepEqual(responses, [['codearts-a'], ['codearts-b']]);
    assert.deepEqual(await (await fetch(base + '/v1/chat/completions', {headers: headers([])})).json(), []);
    assert.equal((await fetch(base + '/wrong', {headers: headers(['codearts-a'])})).status, 403);
    assert.deepEqual(await (await fetch(base + '/v1/chat/completions')).json(), ['codearts-a', 'codearts-b']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [index, key] of ['CODEARTS2API_ADMIN_KEY', 'DSH_OPENAI_GATEWAY_API_KEY'].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
  }
});

// Use a disposable copy of the pinned, compiled official application. This test
// exercises its actual selection and retry methods without loading real state.
test('official AccountPool first selection, retries, rotation and broken credentials cannot cross a group',
  {skip: !process.env.WB_CA_TEST_APP}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'wb-ca-scope-'));
    const app = join(parent, 'app');
    try {
      cpSync(process.env.WB_CA_TEST_APP, app, {recursive: true, verbatimSymlinks: true});
      assert.equal(patchLibrary(app).patched, 2);
      assert.equal(patchLibrary(app).patched, 0);
      const poolPath = join(app, 'node_modules/dsh-providers-hub/lib/account-pool.js');
      const gatewayPath = join(app, 'node_modules/dsh-providers-hub/lib/openai-gateway/server.js');
      const patched = readFileSync(gatewayPath, 'utf8');
      // An unsupported pool contract must fail before modifying the gateway.
      writeFileSync(poolPath, 'unsupported contract');
      assert.throws(() => patchLibrary(app));
      assert.equal(readFileSync(gatewayPath, 'utf8'), patched);
      writeFileSync(poolPath, readFileSync(poolPath + '.wb-original'));
      patchLibrary(app);
      const {AccountPool} = await import(pathToFileURL(poolPath));
      const {withScope: officialScope} = await import(pathToFileURL(join(app, 'node_modules/dsh-providers-hub/lib/wb-account-scope.mjs')));
      const pool = Object.create(AccountPool.prototype);
      const rows = [entry('outside'), entry('a'), entry('b')];
      pool.readAccounts = () => rows;
      pool.ctx = {credentials: {resolve: async () => ({value: '{}'})}};
      await officialScope(['codearts-a', 'codearts-b'], async () => {
        assert.equal((await pool.getAvailableAccount('codearts', '')).entry.id, 'codearts-a');
        assert.equal((await pool.getAvailableAccount('codearts', '', new Set(['codearts-a']))).entry.id, 'codearts-b');
        assert.equal(await pool.getAvailableAccount('codearts', '', new Set(['codearts-a', 'codearts-b'])), null);
        assert.equal((await pool.getAvailableAccount('codearts', '', undefined, 'codearts-outside')).entry.id, 'codearts-a');
        pool.ctx.credentials.resolve = async () => {throw new Error('invalid credential');};
        assert.equal(await pool.getAvailableAccount('codearts', ''), null);
      });
      pool.ctx.credentials.resolve = async () => ({value: '{}'});
      assert.equal(await officialScope([], () => pool.getAvailableAccount('codearts', '')), null);
      assert.equal((await pool.getAvailableAccount('codearts', '')).entry.id, 'codearts-outside');
      assert.equal(JSON.parse(readFileSync(join(app, 'package.json'))).dependencies['dsh-providers-hub'].endsWith('#' + hubRevision), true);
    } finally {
      rmSync(parent, {recursive: true, force: true});
    }
  });
