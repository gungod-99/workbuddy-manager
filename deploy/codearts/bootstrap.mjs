import {randomBytes} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';

const home = process.env.CODEARTS2API_HOME || '/data';
mkdirSync(join(home, 'openai-gateway'), {recursive: true, mode: 0o700});
function secret(path) {
  if (!existsSync(path)) writeFileSync(path, randomBytes(40).toString('base64url') + '\n', {mode: 0o600, flag: 'wx'});
  const value = readFileSync(path, 'utf8').trim();
  if (value.length < 24 || /\s/.test(value)) throw new Error('Invalid existing CA credential file');
  chmodSync(path, 0o600);
  return value;
}
const admin = secret(join(home, 'admin-key'));
const gateway = secret(join(home, 'openai-gateway/api-key'));
const output = process.env.WB_CA_CONNECTION_OUTPUT || '/connection/connection.json';
mkdirSync(dirname(output), {recursive: true, mode: 0o700});
const connection = {base_url: process.env.WB_CA_MANAGER_BASE || 'http://codearts2api:8092', admin_key: admin, gateway_key: gateway};
writeFileSync(output + '.tmp', JSON.stringify(connection) + '\n', {mode: 0o600});
renameSync(output + '.tmp', output);
process.env.CODEARTS2API_ADMIN_AUTH = '1';
process.env.CODEARTS2API_ADMIN_KEY = admin;
process.env.DSH_OPENAI_GATEWAY_API_KEY = gateway;
process.env.DSH_JET_HUB_AUTO_OPEN_BROWSER = '0';
await import(pathToFileURL(join(process.env.WB_CA_APP || '/app', 'dist-server/index.js')).href);
