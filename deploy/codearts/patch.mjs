import {copyFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const hubRevision = 'a1bd1124d6a16ef50aa8a3b2ad99e39330beb215';

function write(path, content) {
  const temp = path + '.wb-new';
  writeFileSync(temp, content, {mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o644});
  renameSync(temp, path);
}

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) {
    if (source.split(after).length !== 2) throw new Error('Existing CA ' + label + ' patch is inconsistent');
    return source;
  }
  if (source.split(before).length !== 2) throw new Error('CA ' + label + ' contract changed');
  return source.replace(before, after);
}

function importOnce(source, statement) {
  if (source.includes(statement)) {
    if (source.split(statement).length !== 2) throw new Error('Duplicate CA patch import');
    return source;
  }
  return statement + source;
}

export function patchLibrary(app) {
  app = realpathSync(app);
  const metadata = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  if (!metadata.dependencies?.['dsh-providers-hub']?.endsWith('#' + hubRevision)) {
    throw new Error('Unsupported codearts2api dependency; expected the pinned v0.1.12 release');
  }
  const library = realpathSync(join(app, 'node_modules/dsh-providers-hub/lib'));
  const rel = relative(app, library);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('CodeArts dependency escaped its application directory');
  const targets = [
    {path: join(library, 'openai-gateway/server.js'), transform(original) {
      let result = replaceOnce(original, 'createServer(requestHandler)', 'createServer(wbScopeHandler(requestHandler))', 'gateway scope');
      result = importOnce(result, "import {scopeHandler as wbScopeHandler} from '../wb-account-scope.mjs';\n");
      const marker = '        wbStartSseKeepalive(response);';
      if (result.includes(marker)) {
        if (result.split(marker).length !== 2) throw new Error('Existing CA SSE patch is inconsistent');
      } else {
        const pattern = /(const writeSseHead = \(response\) => \{\s*response\.writeHead\(200, \{[\s\S]*?\}\);)(\s*\};)/g;
        if ([...result.matchAll(pattern)].length !== 1) throw new Error('CA SSE header contract changed');
        result = result.replace(pattern, '$1\n' + marker + '$2');
      }
      return importOnce(result, "import {startSseKeepalive as wbStartSseKeepalive} from '../wb-sse-keepalive.mjs';\n");
    }},
    {path: join(library, 'account-pool.js'), transform(original) {
      let result = original;
      if (result.includes('.filter(wbScopeAllows)')) {
        if (result.split('.filter(wbScopeAllows)').length !== 2) throw new Error('Existing CA account scope patch is inconsistent');
      } else {
        const pattern = /(candidateAccounts\(provider, modelId, excludeAccountIds\)\s*\{\s*return this\.readAccounts\(\))/g;
        if ([...result.matchAll(pattern)].length !== 1) throw new Error('CA account candidate contract changed');
        result = result.replace(pattern, '$1\n            .filter(wbScopeAllows)');
      }
      return importOnce(result, "import {scopeAllows as wbScopeAllows} from './wb-account-scope.mjs';\n");
    }},
    {path: join(app, 'dist-server/modules/gateway/gateway.controller.js'), transform(original) {
      let result = replaceOnce(original, '        let upstream;\n        try {',
        '        const wbLifecycle = wbProxyRequestLifecycle(request, response, upstreamTimeoutMs ?? 600_000);\n        let upstream;\n        try {', 'proxy lifecycle');
      result = replaceOnce(result, 'signal: AbortSignal.timeout(upstreamTimeoutMs ?? 600_000),', 'signal: wbLifecycle.signal,', 'proxy signal');
      result = replaceOnce(result,
        '            logger?.warn?.(`[proxy] 网关不可达（${target.host}:${target.port}）：${String(error)}`);',
        '            if (wbLifecycle.clientDisconnected()) {\n                wbLifecycle.cleanup();\n                return;\n            }\n            wbLifecycle.cleanup();\n            logger?.warn?.(`[proxy] 网关请求失败（${target.host}:${target.port}）：${wbProxyFailureDetail(error)} after ${Date.now() - startedAt}ms`);',
        'proxy error detail');
      return importOnce(result, "import {proxyRequestLifecycle as wbProxyRequestLifecycle, proxyFailureDetail as wbProxyFailureDetail} from './wb-proxy-lifecycle.mjs';\n");
    }},
  ];
  const staged = targets.map((target) => {
    const actual = realpathSync(target.path);
    const targetRel = relative(app, actual);
    if (targetRel.startsWith('..') || isAbsolute(targetRel)) throw new Error('CA patch target escaped its application directory');
    target.path = actual;
    const original = readFileSync(target.path, 'utf8');
    return {...target, original, result: target.transform(original)};
  });
  const here = dirname(fileURLToPath(import.meta.url));
  const helpers = [
    [join(library, 'wb-account-scope.mjs'), readFileSync(join(here, 'account-scope.mjs'))],
    [join(library, 'wb-sse-keepalive.mjs'), readFileSync(join(here, 'sse-keepalive.mjs'))],
    [join(dirname(staged[2].path), 'wb-proxy-lifecycle.mjs'), readFileSync(join(here, 'proxy-lifecycle.mjs'))],
  ];
  for (const target of staged) {
    if (target.result !== target.original && !existsSync(target.path + '.wb-original')) copyFileSync(target.path, target.path + '.wb-original');
  }
  for (const [path, content] of helpers) write(path, content);
  for (const target of staged) if (target.result !== target.original) write(target.path, target.result);
  return {version: 2, patched: staged.filter((target) => target.result !== target.original).length, library};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = patchLibrary(process.argv[2] || '/app');
  console.log(JSON.stringify(result));
}
