import {copyFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const hubRevision = 'a1bd1124d6a16ef50aa8a3b2ad99e39330beb215';

function write(path, content) {
  const temp = path + '.wb-new';
  writeFileSync(temp, content, {mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o644});
  renameSync(temp, path);
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
    {path: join(library, 'openai-gateway/server.js'),
      before: 'createServer(requestHandler)', after: 'createServer(wbScopeHandler(requestHandler))',
      statement: "import {scopeHandler as wbScopeHandler} from '../wb-account-scope.mjs';\n"},
    {path: join(library, 'account-pool.js'),
      pattern: /(candidateAccounts\(provider, modelId, excludeAccountIds\)\s*\{\s*return this\.readAccounts\(\))/g,
      statement: "import {scopeAllows as wbScopeAllows} from './wb-account-scope.mjs';\n"},
  ];
  const staged = targets.map((target) => {
    const original = readFileSync(target.path, 'utf8');
    if (original.startsWith(target.statement)) {
      const marker = target.after || '.filter(wbScopeAllows)';
      if (original.split(marker).length !== 2) throw new Error('Existing CA scope patch is inconsistent');
      return {...target, original, result: original};
    }
    let result;
    if (target.before) {
      if (original.split(target.before).length !== 2) throw new Error('CA gateway contract changed');
      result = original.replace(target.before, target.after);
    } else {
      if ([...original.matchAll(target.pattern)].length !== 1) throw new Error('CA account candidate contract changed');
      result = original.replace(target.pattern, '$1\n            .filter(wbScopeAllows)');
    }
    return {...target, original, result: target.statement + result};
  });
  const helper = join(dirname(fileURLToPath(import.meta.url)), 'account-scope.mjs');
  for (const target of staged) {
    if (target.result !== target.original && !existsSync(target.path + '.wb-original')) copyFileSync(target.path, target.path + '.wb-original');
  }
  write(join(library, 'wb-account-scope.mjs'), readFileSync(helper));
  for (const target of staged) if (target.result !== target.original) write(target.path, target.result);
  return {version: 1, patched: staged.filter((target) => target.result !== target.original).length, library};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = patchLibrary(process.argv[2] || '/app');
  console.log(JSON.stringify(result));
}
