import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer, get, request} from 'node:http';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {hubRevision, patchLibrary} from './patch.mjs';
import {proxyFailureDetail, proxyRequestLifecycle} from './proxy-lifecycle.mjs';
import {startSseKeepalive} from './sse-keepalive.mjs';

class Response extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableNeedDrain = false;
  writes = [];
  flushes = 0;
  flushHeaders() { this.flushes++; }
  write(value) { this.writes.push(value); return true; }
}

test('SSE comment keeps a quiet model connection alive without changing its final frames', async () => {
  let finishedModel = false;
  const server = createServer((_req, res) => {
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    startSseKeepalive(res, 25);
    setTimeout(() => {
      finishedModel = true;
      res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
    }, 350);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise((resolve, reject) => {
      const req = get('http://127.0.0.1:' + server.address().port, (res) => {
        assert.equal(finishedModel, false, 'headers must reach the client before model generation');
        let body = '';
        res.setTimeout(150, () => res.destroy(new Error('SSE idle timeout')));
        res.on('data', (data) => { body += data; });
        res.on('error', reject);
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
    });
    assert.ok(result.split(': keep-alive\n\n').length > 3);
    assert.equal(result.replaceAll(': keep-alive\n\n', ''),
      'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SSE timers stop at finish/close, deduplicate and respect response backpressure', async () => {
  for (const ending of ['finish', 'close']) {
    const res = new Response();
    const stop = startSseKeepalive(res, 10);
    assert.equal(startSseKeepalive(res, 10), stop);
    assert.equal(res.flushes, 1);
    assert.equal(res.writes[0], ': keep-alive\n\n');
    res.writableNeedDrain = true;
    await delay(35);
    assert.equal(res.writes.length, 1);
    res.writableNeedDrain = false;
    await delay(30);
    assert.ok(res.writes.length > 1);
    res.emit(ending);
    const count = res.writes.length;
    await delay(30);
    assert.equal(res.writes.length, count);
    assert.equal(res.listenerCount('finish'), 0);
    assert.equal(res.listenerCount('close'), 0);
  }
  const closed = new Response();
  closed.destroyed = true;
  startSseKeepalive(closed, 10);
  assert.equal(closed.writes.length, 0);
});

test('proxy cancels on a client disconnect even before upstream headers arrive', async () => {
  for (const event of ['close', 'aborted']) {
    const req = new EventEmitter(), res = new Response();
    const lifecycle = proxyRequestLifecycle(req, res, 10_000);
    (event === 'close' ? res : req).emit(event);
    assert.equal(lifecycle.signal.aborted, true);
    assert.equal(lifecycle.clientDisconnected(), true);
    assert.equal(lifecycle.signal.reason.name, 'AbortError');
    assert.equal(req.listenerCount('aborted'), 0);
    assert.equal(res.listenerCount('close'), 0);
    assert.equal(res.listenerCount('finish'), 0);
  }
});

test('proxy disconnect aborts a real pending upstream HTTP request', async () => {
  let accepted, closed, settled, deadline;
  const upstreamAccepted = new Promise((resolve) => { accepted = resolve; });
  const upstreamClosed = new Promise((resolve, reject) => {
    closed = resolve;
    deadline = setTimeout(() => reject(new Error('pending upstream was not cancelled')), 2000);
  });
  const proxySettled = new Promise((resolve) => { settled = resolve; });
  const upstream = createServer((_req, res) => {
    res.once('close', closed);
    accepted();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = createServer(async (req, res) => {
    const lifecycle = proxyRequestLifecycle(req, res, 10_000);
    try {
      await fetch('http://127.0.0.1:' + upstream.address().port, {signal: lifecycle.signal});
      settled(false);
    } catch {
      settled(lifecycle.signal.aborted && lifecycle.clientDisconnected());
    } finally {
      lifecycle.cleanup();
    }
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const client = get('http://127.0.0.1:' + proxy.address().port);
    client.on('error', () => {});
    await upstreamAccepted;
    client.destroy();
    await upstreamClosed;
    assert.equal(await proxySettled, true);
  } finally {
    clearTimeout(deadline);
    upstream.closeAllConnections();
    proxy.closeAllConnections();
    await Promise.all([new Promise((resolve) => upstream.close(resolve)), new Promise((resolve) => proxy.close(resolve))]);
  }
});

test('proxy deadline remains distinct from disconnect and finish removes cancellation listeners', async () => {
  const req = new EventEmitter(), res = new Response();
  const lifecycle = proxyRequestLifecycle(req, res, 15);
  await delay(35);
  assert.equal(lifecycle.signal.aborted, true);
  assert.equal(lifecycle.signal.reason.name, 'TimeoutError');
  assert.equal(lifecycle.clientDisconnected(), false);
  lifecycle.cleanup();
  const req2 = new EventEmitter(), res2 = new Response();
  const complete = proxyRequestLifecycle(req2, res2, 15);
  res2.writableEnded = true;
  res2.emit('finish');
  await delay(35);
  assert.equal(complete.signal.aborted, false);
  assert.equal(req2.listenerCount('aborted'), 0);
  assert.equal(res2.listenerCount('close'), 0);
  assert.equal(proxyFailureDetail(new TypeError('URL with secret', {cause: {code: 'UND_ERR_HEADERS_TIMEOUT'}})),
    'TypeError/UND_ERR_HEADERS_TIMEOUT');
});

function fixture(parent) {
  const app = join(parent, 'app'), library = join(app, 'node_modules/dsh-providers-hub/lib');
  const gateway = join(library, 'openai-gateway/server.js');
  const pool = join(library, 'account-pool.js');
  const proxy = join(app, 'dist-server/modules/gateway/gateway.controller.js');
  mkdirSync(join(library, 'openai-gateway'), {recursive: true});
  mkdirSync(join(app, 'dist-server/modules/gateway'), {recursive: true});
  writeFileSync(join(app, 'package.json'), JSON.stringify({dependencies: {'dsh-providers-hub': 'source#' + hubRevision}}));
  writeFileSync(gateway, `const writeSseHead = (response) => {
        response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
        });
    };
createServer(requestHandler);
`);
  writeFileSync(pool, 'class Pool { candidateAccounts(provider, modelId, excludeAccountIds) { return this.readAccounts().filter(() => true); } }\n');
  writeFileSync(proxy, `export async function proxy(request, response) {
        let upstream;
        try {
            upstream = await fetch('http://localhost/', {
                signal: AbortSignal.timeout(upstreamTimeoutMs ?? 600_000),
            });
        } catch (error) {
            logger?.warn?.(\x60[proxy] 网关不可达（\x24{target.host}:\x24{target.port}）：\x24{String(error)}\x60);
        }
}
`);
  return {app, library, gateway, pool, proxy};
}

test('pinned patch is idempotent, upgrades scope-only installs and checks every target before writing', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wb-ca-stream-patch-'));
  try {
    const f = fixture(parent);
    const cleanGateway = readFileSync(f.gateway, 'utf8');
    const cleanPool = readFileSync(f.pool, 'utf8');
    const cleanProxy = readFileSync(f.proxy, 'utf8');
    assert.equal(patchLibrary(f.app).patched, 3);
    assert.equal(patchLibrary(f.app).patched, 0);
    assert.match(readFileSync(f.gateway, 'utf8'), /wbStartSseKeepalive\(response\)/);
    assert.match(readFileSync(f.proxy, 'utf8'), /wbLifecycle\.clientDisconnected\(\)/);
    assert.equal(readFileSync(f.gateway + '.wb-original', 'utf8'), cleanGateway);
    writeFileSync(f.gateway, "import {scopeHandler as wbScopeHandler} from '../wb-account-scope.mjs';\n" +
      cleanGateway.replace('createServer(requestHandler)', 'createServer(wbScopeHandler(requestHandler))'));
    writeFileSync(f.pool, "import {scopeAllows as wbScopeAllows} from './wb-account-scope.mjs';\n" +
      cleanPool.replace('return this.readAccounts()', 'return this.readAccounts()\n            .filter(wbScopeAllows)'));
    writeFileSync(f.proxy, cleanProxy);
    assert.equal(patchLibrary(f.app).patched, 2);
    assert.equal(patchLibrary(f.app).patched, 0);
    const before = readFileSync(f.gateway, 'utf8');
    writeFileSync(f.proxy, 'unsupported controller contract');
    writeFileSync(f.pool, cleanPool);
    assert.throws(() => patchLibrary(f.app), /contract changed/);
    assert.equal(readFileSync(f.gateway, 'utf8'), before);
    assert.equal(readFileSync(f.pool, 'utf8'), cleanPool);
  } finally {
    assert.equal(dirname(resolve(parent)), resolve(tmpdir()));
    assert.ok(basename(parent).startsWith('wb-ca-stream-patch-'));
    rmSync(parent, {recursive: true, force: true});
  }
});

test('patched official Chat/Responses gateway sends keepalives before a delayed model and preserves terminal errors',
  {skip: !process.env.WB_CA_TEST_APP}, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'wb-ca-stream-official-'));
    const app = join(parent, 'app');
    let gateway;
    try {
      cpSync(process.env.WB_CA_TEST_APP, app, {recursive: true, verbatimSymlinks: true});
      patchLibrary(app);
      // Compress only the disposable fixture's timer; the actual pinned gateway
      // still executes its normal parser, stream conversion and request lifetime.
      const helper = join(app, 'node_modules/dsh-providers-hub/lib/wb-sse-keepalive.mjs');
      writeFileSync(helper, readFileSync(helper, 'utf8').replace('intervalMs = 15_000', 'intervalMs = 25'));
      const {createOpenAiGateway} = await import(pathToFileURL(join(app, 'node_modules/dsh-providers-hub/lib/openai-gateway/server.js')));
      const reservation = createServer();
      await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
      const port = reservation.address().port;
      await new Promise((resolve) => reservation.close(resolve));
      const token = 'wb-ca-stream-fixture-key-000000000000';
      let generated = false, failureMode = false;
      gateway = createOpenAiGateway({
        home: join(parent, 'home'),
        env: {DSH_OPENAI_GATEWAY_PORT: String(port), DSH_OPENAI_GATEWAY_HOST: '127.0.0.1', DSH_OPENAI_GATEWAY_API_KEY: token},
        logger: {info() {}, warn() {}, error() {}},
        llm: {
          async resolveModelInfo(_provider, model) { return {id: model, name: model, inputModalities: ['text'], contextWindow: 8192}; },
          async *stream() {
            await delay(700);
            generated = true;
            if (failureMode) {
              yield {type: 'finish', reason: {kind: 'error', failure: {code: 'upstream_unavailable', message: 'fixture upstream failure', status: 502}}};
            } else {
              yield {type: 'text-delta', index: 0, text: 'OK'};
              yield {type: 'finish', reason: {kind: 'stop'}};
            }
          },
        },
      });
      await gateway.start();
      const call = (path) => new Promise((resolve, reject) => {
        const body = JSON.stringify(path === '/v1/responses'
          ? {model: 'codearts/stream-fixture', input: 'reply OK', stream: true}
          : {model: 'codearts/stream-fixture', messages: [{role: 'user', content: 'reply OK'}], stream: true});
        const req = request({host: '127.0.0.1', port, path, method: 'POST',
          headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}}, (res) => {
          try {
            assert.equal(res.statusCode, 200);
            assert.equal(generated, false, 'gateway must send headers before model generation');
          } catch (error) { res.resume(); reject(error); return; }
          let text = '';
          res.setTimeout(250, () => res.destroy(new Error('official gateway SSE idle timeout')));
          res.on('data', (chunk) => { text += chunk; });
          res.on('error', reject);
          res.on('end', () => resolve(text));
        });
        req.on('error', reject);
        req.end(body);
      });
      const [chat, responses] = await Promise.all([call('/v1/chat/completions'), call('/v1/responses')]);
      for (const body of [chat, responses]) assert.ok(body.split(': keep-alive\n\n').length > 2);
      assert.ok(chat.includes('"content":"OK"'));
      assert.equal(chat.split('data: [DONE]').length - 1, 1);
      assert.equal(responses.split('event: response.completed').length - 1, 1);
      assert.equal(responses.includes('event: response.failed'), false);
      generated = false;
      failureMode = true;
      const [chatError, responsesError] = await Promise.all([call('/v1/chat/completions'), call('/v1/responses')]);
      assert.ok(chatError.includes('fixture upstream failure'));
      assert.equal(chatError.split('data: [DONE]').length - 1, 1);
      assert.ok(responsesError.includes('fixture upstream failure'));
      assert.equal(responsesError.split('event: response.failed').length - 1, 1);
      assert.equal(responsesError.includes('event: response.completed'), false);
    } finally {
      if (gateway) await gateway.close({drainActiveMs: 0});
      assert.equal(dirname(resolve(parent)), resolve(tmpdir()));
      assert.ok(basename(parent).startsWith('wb-ca-stream-official-'));
      rmSync(parent, {recursive: true, force: true});
    }
  });
