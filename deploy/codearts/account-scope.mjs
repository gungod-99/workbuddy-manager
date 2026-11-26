import {AsyncLocalStorage} from 'node:async_hooks';
import {createHmac, timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const scopes = new AsyncLocalStorage();
const capabilityPath = '/v1/wb-account-scope';

function equal(a, b) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readSecret(name, env) {
  const value = process.env[env]?.trim();
  if (value) return value;
  const home = process.env.CODEARTS2API_HOME || join(homedir(), '.codearts2api');
  return readFileSync(join(home, name), 'utf8').trim();
}

export function verifyScope(token, path, adminKey, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || token.length > 15000) throw new Error('invalid scope');
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error('invalid scope');
  const [encoded, signature] = parts;
  const wanted = createHmac('sha256', adminKey).update('wb-ca-scope-v1.' + encoded).digest('base64url');
  if (!equal(signature, wanted)) throw new Error('invalid scope');
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (value.v !== 1 || !Number.isInteger(value.at) || Math.abs(now - value.at) > 90 || value.path !== path
      || !Array.isArray(value.accounts) || value.accounts.length > 200
      || !value.accounts.every((id) => typeof id === 'string' && /^codearts-[a-zA-Z0-9_-]{1,96}$/.test(id))) {
    throw new Error('invalid scope');
  }
  return new Set(value.accounts);
}

export function scopeAllows(entry) {
  const scope = scopes.getStore();
  return scope === undefined || (entry.provider === 'codearts' && scope.has(entry.id));
}

export function withScope(accounts, callback) {
  return scopes.run(new Set(accounts), callback);
}

export function scopeHandler(handler) {
  return (request, response) => {
    const path = new URL(request.url || '/', 'http://localhost').pathname;
    const token = request.headers['x-wb-ca-scope'];
    if (token === undefined && path !== capabilityPath) return handler(request, response);
    try {
      const gatewayKey = readSecret('openai-gateway/api-key', 'DSH_OPENAI_GATEWAY_API_KEY');
      if (!gatewayKey || !equal(request.headers.authorization || '', 'Bearer ' + gatewayKey)) throw new Error('invalid authorization');
      const scope = verifyScope(token, path, readSecret('admin-key', 'CODEARTS2API_ADMIN_KEY'));
      response.setHeader('X-WB-CA-Scope', 'v1');
      if (path === capabilityPath) {
        response.writeHead(200, {'Content-Type': 'application/json'});
        response.end(JSON.stringify({version: 1}));
        return;
      }
      return scopes.run(scope, () => handler(request, response));
    } catch {
      response.writeHead(403, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({error: {message: 'CA account scope is invalid or expired', code: 'invalid_account_scope', type: 'permission_error'}}));
    }
  };
}
