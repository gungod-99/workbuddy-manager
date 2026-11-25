/** Pure presentation helpers. Missing upstream fields always remain unknown. */
import type {CodeArtsAccount, CodeArtsCredits, CodeArtsDashboardData, CodeArtsLedgerTotals, CreditExpiry} from './types';

export type CodeArtsAccountTier = 'ready' | 'limited' | 'expired' | 'disabled' | 'pending' | 'unknown';

export function codeartsAccountTier(account: CodeArtsAccount, now: number): CodeArtsAccountTier {
  if (!account.enabled) return 'disabled';
  if (account.is_expired || (account.expires_at != null && account.expires_at <= now)) return 'expired';
  if (account.credential_status !== 'available') return account.credential_status === 'pending' ? 'pending' : 'unknown';
  return Object.values(account.model_rate_limits).some((at) => at != null && at > now) ? 'limited' : 'ready';
}

export function codeartsAccountAvailable(account: CodeArtsAccount, now: number): boolean {
  const tier = codeartsAccountTier(account, now);
  return tier === 'ready' || tier === 'limited';
}

const known = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

export interface CodeArtsCreditOverview {
  total: number | null;
  usable: number | null;
  unusable: number | null;
  expired: number | null;
  expiring: number | null;
  knownAccounts: number;
  unknownAccounts: number;
  lowBalanceAccounts: number;
  undatedPackages: number;
  expiries: CreditExpiry[];
}

export function codeartsCreditOverview(
  accounts: readonly CodeArtsAccount[] | undefined,
  credits: CodeArtsCredits | undefined,
  now: number,
): CodeArtsCreditOverview {
  const result: CodeArtsCreditOverview = {total: null, usable: null, unusable: null, expired: null,
    expiring: null, knownAccounts: 0, unknownAccounts: 0, lowBalanceAccounts: 0, undatedPackages: 0, expiries: []};
  if (!accounts || !credits) return result;
  const balances = new Map(credits.accounts.map((row) => [row.account_id, row.balance]));
  const usable: number[] = [], unusable: number[] = [], expired: number[] = [], expiring: number[] = [];
  let usableCount = 0, unusableCount = 0;
  for (const account of accounts) {
    const balance = balances.get(account.id);
    const available = codeartsAccountAvailable(account, now);
    if (available) usableCount += 1; else unusableCount += 1;
    if (!balance || !known(balance.total)) {result.unknownAccounts += 1; continue;}
    result.knownAccounts += 1;
    (available ? usable : unusable).push(balance.total);
    if (known(balance.expired_total)) expired.push(balance.expired_total);
    if (known(balance.expiring_total)) expiring.push(balance.expiring_total);
    if (!available) continue;
    if (balance.total < 200) result.lowBalanceAccounts += 1;
    for (const pack of balance.packages) {
      if (!pack.active || pack.unit !== 'credit' || !known(pack.remaining) || pack.remaining <= 0) continue;
      if (!known(pack.expires_at)) {result.undatedPackages += 1; continue;}
      if (pack.expires_at > now) result.expiries.push({at: pack.expires_at, amount: pack.remaining});
    }
  }
  const sum = (values: number[], count: number) => values.length ? values.reduce((a, b) => a + b, 0) : count === 0 ? 0 : null;
  result.total = sum([...usable, ...unusable], accounts.length);
  result.usable = sum(usable, usableCount);
  result.unusable = sum(unusable, unusableCount);
  result.expired = sum(expired, accounts.length);
  result.expiring = sum(expiring, accounts.length);
  result.expiries.sort((a, b) => a.at - b.at);
  return result;
}

/** Add official CA gateway daily rows; never derive totals from the 500-row memory log. */
export function codeartsAccountUsage(history: CodeArtsDashboardData['ledger']['history'] | undefined) {
  if (history == null) return null;
  const accounts = new Map<string, CodeArtsLedgerTotals>();
  const add = (before: CodeArtsLedgerTotals | undefined, row: CodeArtsLedgerTotals): CodeArtsLedgerTotals => {
    if (!before) return {...row};
    const result = {...before};
    for (const field of Object.keys(row) as (keyof CodeArtsLedgerTotals)[]) {
      result[field] = known(before[field]) && known(row[field]) ? before[field] + row[field] : null;
    }
    return result;
  };
  for (const day of history) {
    for (const row of day.accounts) {
      const id = row.account_id || '';
      accounts.set(id, add(accounts.get(id), row.totals));
    }
  }
  return [...accounts].map(([account_id, totals]) => ({account_id: account_id || null, totals}))
    .sort((a, b) => (b.totals.total_tokens ?? -1) - (a.totals.total_tokens ?? -1));
}

export function codeartsPackagePercent(used: number | null, total: number | null): number | null {
  return known(used) && known(total) && total > 0 ? Math.max(0, Math.min(100, used * 100 / total)) : null;
}
