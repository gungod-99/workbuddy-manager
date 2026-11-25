import assert from 'node:assert/strict';
import {test} from 'node:test';
import {codeartsAccountTier, codeartsCreditOverview, codeartsAccountUsage, codeartsPackagePercent} from './codearts-dashboard.ts';

const now = 1795579200;
const account = (id, patch = {}) => ({id, enabled: true, is_expired: false, expires_at: now + 3600,
  credential_status: 'available', model_rate_limits: {}, ...patch});
const pack = (patch = {}) => ({active: true, unit: 'credit', remaining: 100, expires_at: now + 86400, ...patch});
const balance = (total, packages = []) => ({total, expired_total: null, expiring_total: null, packages});
const credits = (...rows) => ({accounts: rows.map(([account_id, value]) => ({account_id, balance: value}))});

test('available and disabled credits stay separate; missing and stale accounts do not distort coverage', () => {
  const accounts = [account('a'), account('b', {enabled: false}), account('c'), account('d')];
  const result = codeartsCreditOverview(accounts, credits(['a', balance(100)], ['b', balance(600)],
    ['c', null], ['removed', balance(99999)]), now);
  assert.equal(result.total, 700); assert.equal(result.usable, 100); assert.equal(result.unusable, 600);
  assert.equal(result.knownAccounts, 2); assert.equal(result.unknownAccounts, 2);
  assert.equal(result.lowBalanceAccounts, 1); assert.equal(result.expired, null);
});

test('unknown balance is not zero but real zero and an empty pool remain zero', () => {
  assert.equal(codeartsCreditOverview([account('a')], credits(['a', null]), now).total, null);
  assert.equal(codeartsCreditOverview([account('a')], credits(['a', balance(0)]), now).usable, 0);
  assert.equal(codeartsCreditOverview([], credits(), now).total, 0);
  assert.equal(codeartsCreditOverview(undefined, credits(), now).usable, null);
});

test('expiry countdown excludes token units, unknown dates, expired packages and unusable accounts', () => {
  const result = codeartsCreditOverview([account('a'), account('b', {is_expired: true})], credits(
    ['a', balance(800, [pack(), pack({unit: 'token', remaining: 99999}), pack({expires_at: null}),
      pack({active: false}), pack({expires_at: now - 1}), pack({remaining: 0}), pack({remaining: null})])],
    ['b', balance(200, [pack()])]), now);
  assert.deepEqual(result.expiries, [{at: now + 86400, amount: 100}]);
  assert.equal(result.undatedPackages, 1);
});

test('rate limit on a model is distinguished from an unusable account and timestamps override stale flags', () => {
  assert.equal(codeartsAccountTier(account('a', {model_rate_limits: {'codearts/model': now + 60}}), now), 'limited');
  assert.equal(codeartsAccountTier(account('a', {expires_at: now - 1}), now), 'expired');
  assert.equal(codeartsAccountTier(account('a', {enabled: false, is_expired: true}), now), 'disabled');
  assert.equal(codeartsAccountTier(account('a', {credential_status: 'pending'}), now), 'pending');
  assert.equal(codeartsAccountTier(account('a', {expires_at: null}), now), 'ready');
});

test('official account usage sums daily totals without adding cached or reasoning tokens twice', () => {
  const totals = {requests: 1, reported_requests: 1, input_tokens: 10, output_tokens: 8, cache_read_tokens: 3,
    cache_write_tokens: 3, reasoning_tokens: 5, total_tokens: 21, errors: 0};
  const result = codeartsAccountUsage([{accounts: [{account_id: 'a', totals}, {account_id: null, totals}]},
    {accounts: [{account_id: 'a', totals}]}]);
  assert.equal(result[0].totals.total_tokens, 42);
  assert.equal(result[0].totals.reasoning_tokens, 10);
  assert.equal(result[1].account_id, null);
  assert.equal(codeartsAccountUsage(null), null);
  assert.deepEqual(codeartsAccountUsage([]), []);
});

test('missing ledger counters and package totals do not turn into invented measured zeros', () => {
  const totals = {requests: 2, total_tokens: 3};
  assert.equal(codeartsAccountUsage([{accounts: [{account_id: 'a', totals}]},
    {accounts: [{account_id: 'a', totals: {...totals, total_tokens: null}}]}])[0].totals.total_tokens, null);
  assert.equal(codeartsPackagePercent(null, 100), null);
  assert.equal(codeartsPackagePercent(100, null), null);
  assert.equal(codeartsPackagePercent(0, 100), 0);
  assert.equal(codeartsPackagePercent(130, 100), 100);
});
