'use client';

import {useMemo, useState, type ReactNode} from 'react';
import Link from 'next/link';
import {Activity, ArrowUpRight, Boxes, CheckCircle2, Clock3, Coins, KeyRound, RefreshCw, Server, ShieldCheck, Users, Zap} from 'lucide-react';
import {Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import {codeartsApi, keyApi, modelApi, statsApi} from '@/lib/api';
import {codeartsAccountAvailable, codeartsAccountTier, codeartsAccountUsage, codeartsCreditOverview, codeartsPackagePercent} from '@/lib/codearts-dashboard';
import {dailySeries, hourlySeries} from '@/lib/usage-chart';
import {useAsyncAll} from '@/lib/use-async-data';
import {useHeartbeat} from '@/lib/use-heartbeat';
import {useNow} from '@/lib/use-now';
import {useT} from '@/lib/i18n/provider';
import {fmtCompact, fmtDateTime, fmtLatency, fmtNumber, fmtRemain} from '@/lib/format';
import {cn} from '@/lib/utils';
import type {CodeArtsRequestQuality, UsageBreakdown} from '@/lib/types';
import {PageHeader} from '@/components/common/layout/PageHeader';
import {StatCard} from '@/components/common/layout/StatCard';
import {RealtimeStatsStrip} from '@/components/common/layout/RealtimeStatsStrip';
import {LoadError} from '@/components/common/states/LoadError';
import {SkeletonBar} from '@/components/common/states/SkeletonBar';
import {CreditCountdown} from '@/components/common/accounts/CreditCountdown';
import {CodeArtsCheckinCard} from '@/components/common/accounts/CodeArtsCheckinCard';
import {CodeArtsCreditDetails} from '@/components/common/accounts/CodeArtsCreditDetails';
import {Button} from '@/components/ui/button';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select';
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from '@/components/ui/table';

const amount = (value: number | null | undefined) => value == null ? '—' : fmtNumber(value);
const compact = (value: number | null | undefined) => value == null ? '—' : fmtCompact(value);
const latency = (value: number | null | undefined) => value == null ? '—' : fmtLatency(Math.round(value));

export function CodeArtsDashboard() {
  const t = useT();
  const [days, setDays] = useState('14');
  const [metric, setMetric] = useState('requests');
  const [detailId, setDetailId] = useState<string | null>(null);
  const now = Math.floor(useNow(30000) / 1000);
  const base = useAsyncAll({
    accounts: () => codeartsApi.list(),
    credits: () => codeartsApi.credits(),
    models: () => modelApi.catalog('cn', false, 'ca'),
    keys: () => keyApi.list('ca'),
    summary: () => statsApi.summary('ca'),
  });
  const period = useAsyncAll({
    dashboard: () => codeartsApi.dashboard(Number(days)),
    trend: () => Number(days) === 1
      ? statsApi.hourly(undefined, 'ca').then((rows) => hourlySeries(rows))
      : statsApi.daily(Number(days), 'ca').then((rows) => rows),
    models: () => statsApi.byModel(Number(days), 'ca'),
    keys: () => statsApi.byKey(Number(days), 'ca'),
  }, [days]);
  const reload = async () => (await Promise.all([base.reload(), period.reload()])).every(Boolean);
  useHeartbeat(reload, 30000);
  const accounts = base.values.accounts?.accounts;
  const models = base.values.models?.source === 'none' ? undefined : base.values.models?.models;
  const summary = base.values.summary;
  const dashboard = period.values.dashboard;
  const available = accounts?.filter((account) => codeartsAccountAvailable(account, now)).length;
  const urgent = accounts?.filter((account) => account.enabled && account.expires_at != null &&
    account.expires_at > now && account.expires_at <= now + 6 * 3600).length;
  const credit = useMemo(() => codeartsCreditOverview(accounts, base.values.credits, now), [accounts, base.values.credits, now]);
  const creditById = new Map(base.values.credits?.accounts.map((row) => [row.account_id, row]));
  const accountUsage = useMemo(() => codeartsAccountUsage(dashboard?.ledger.history), [dashboard?.ledger.history]);
  const accountNames = new Map(accounts?.map((account) => [account.id, account.nickname || account.id]));
  const chartData = useMemo(() => {
    const rows = period.values.trend;
    if (!rows || !dashboard) return undefined;
    return Number(days) === 1 ? rows as ReturnType<typeof hourlySeries>
      : dailySeries(rows as Parameters<typeof dailySeries>[0], Number(days), dashboard.range.to);
  }, [period.values.trend, dashboard, days]);
  const activeKeys = base.values.keys?.filter((key) => key.enabled).length;
  const selectedCredit = detailId ? creditById.get(detailId) ?? null : null;
  const periodLabel = t('ca.overview.period', {days});
  const refreshing = base.isRefreshing || period.isRefreshing;
  const partial = Object.keys(base.errors).length > 0 || Object.keys(period.errors).length > 0 ||
    !!dashboard && Object.keys(dashboard.errors).length > 0 || base.values.models?.source === 'none';

  return <div className="space-y-4" aria-busy={refreshing}>
    <PageHeader title={t('ca.dashboardTitle')} description={t('ca.overview.description')}
      actions={<div className="flex items-center gap-2">
        <Button asChild size="sm" variant="outline"><Link href="/accounts"><Users />{t('nav.accounts')}</Link></Button>
        <Button size="sm" variant="outline" disabled={refreshing} onClick={() => void reload()}>
          <RefreshCw className={refreshing ? 'animate-spin' : ''} />{t('common.refresh')}
        </Button>
      </div>} />
    {base.isInitialFailed && period.isInitialFailed ? <LoadError message={t('ca.loadFailed')} onRetry={reload} />
      : base.isInitialLoading && period.isInitialLoading ? <DashboardSkeleton /> : <>
        {partial && <LoadError message={t('ca.partialLoadFailed')} onRetry={reload} />}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
          <StatCard label={t('dashboard.totalAccounts')} value={amount(accounts?.length)} icon={Users}
            hint={t('ca.overview.poolHint')} />
          <StatCard label={t('ca.overview.availableAccounts')} value={amount(available)} icon={ShieldCheck} tone="success"
            hint={accounts && available != null ? t('ca.overview.unavailableHint', {n: accounts.length - available}) : undefined} />
          <StatCard label={t('ca.overview.expiringAuth')} value={amount(urgent)} icon={Clock3} tone={urgent ? 'warning' : 'neutral'}
            hint={t('ca.overview.expiringAuthHint')} />
          <StatCard label={t('ca.overview.usableCredits')} icon={Coins} tone="accent"
            value={<div className="space-y-1.5"><span>{amount(credit.usable)}</span>
              {credit.expiries.length > 0 && <div className="flex"><CreditCountdown expiries={credit.expiries} /></div>}</div>}
            hint={credit.unknownAccounts ? t('ca.balancePartial', {n: credit.unknownAccounts})
              : t('ca.overview.unusableHint', {n: amount(credit.unusable)})} />
          <StatCard label={t('dashboard.todayTokens')} value={compact(dashboard ? dashboard.today.prompt_tokens + dashboard.today.completion_tokens : undefined)}
            icon={Zap} tone="info" hint={dashboard ? t('ca.overview.todayRequests', {n: amount(dashboard.today.requests)}) : undefined} />
        </div>

        <RealtimeStatsStrip days={1} platform="ca" />

        <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="min-w-0 rounded-[20px] bg-muted p-4 sm:p-5 lg:col-span-2">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div><h2 className="flex items-center gap-2 text-sm font-medium"><Activity className="size-4" />{t('ca.overview.trendTitle')}</h2>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{dashboard ? `${dashboard.range.from} — ${dashboard.range.to}` : periodLabel} · {t('ca.beijingTime')}</p></div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-full bg-background/70 p-1" role="group" aria-label={t('ca.overview.trendMetric')}>
                  {['requests', 'tokens'].map((value) => <button key={value} type="button" onClick={() => setMetric(value)} aria-pressed={metric === value}
                    className={cn('rounded-full px-3 py-1 text-[11px] transition-colors', metric === value ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
                    {t(value === 'tokens' ? 'ca.overview.tokens' : 'metric.requests')}</button>)}
                </div>
                <Select value={days} onValueChange={setDays}><SelectTrigger className="h-8 w-28 rounded-full bg-background/70 text-xs" aria-label={t('ca.overview.timeRange')}><SelectValue /></SelectTrigger>
                  <SelectContent>{['1', '7', '14', '30'].map((value) => <SelectItem key={value} value={value}>
                    {value === '1' ? t('ca.overview.today') : t('ca.overview.period', {days: value})}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="h-[230px] w-full">
              {chartData ? <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{top: 12, right: 8, bottom: 0, left: 0}}>
                  <defs><linearGradient id="ca-trend-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.3} /><stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                  </linearGradient></defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={10} stroke="var(--muted-foreground)" minTickGap={24} />
                  <YAxis tickLine={false} axisLine={false} fontSize={10} width={42} stroke="var(--muted-foreground)" allowDecimals={false} tickFormatter={fmtCompact} />
                  <Tooltip labelFormatter={(_, payload) => payload?.[0]?.payload?.full ?? ''}
                    contentStyle={{background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 12, fontSize: 12}} />
                  <Area type="monotone" dataKey={metric === 'tokens' ? 'tokens' : 'success'} name={t(metric === 'tokens' ? 'ca.overview.tokens' : 'ca.overview.successfulRequests')}
                    stroke="var(--chart-1)" fill="url(#ca-trend-fill)" strokeWidth={2} />
                  {metric === 'requests' && <Area type="monotone" dataKey="failed" name={t('dashboard.failedRequests')}
                    stroke="var(--destructive)" fill="none" strokeWidth={1.5} strokeDasharray="4 3" />}
                </AreaChart>
              </ResponsiveContainer> : <PanelMessage loading={period.isInitialLoading} failed={!!period.errors.trend || !!period.errors.dashboard} />}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border/50 pt-4 sm:grid-cols-4">
              <MiniStat label={t('ca.overview.completedRequests')} value={amount(dashboard?.quality.requests)} />
              <MiniStat label={t('ca.overview.successRate')} value={dashboard?.quality.success_rate == null ? '—' : `${dashboard.quality.success_rate}%`} tone="success" />
              <MiniStat label={t('ca.overview.avgFirstToken')} value={latency(dashboard?.quality.avg_first_token_ms)} />
              <MiniStat label={t('ca.overview.outputSpeed')} value={dashboard?.quality.tokens_per_sec == null ? '—' : `${dashboard.quality.tokens_per_sec} tok/s`} />
            </div>
            <p className="mt-3 text-[10px] leading-5 text-muted-foreground">{t('ca.overview.trendScope')}</p>
          </div>

          <div className="rounded-[20px] bg-muted p-4 sm:p-5">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-medium"><Server className="size-4" />{t('dashboard.upstreamPanel')}</h2>
            <div className="space-y-3 text-xs">
              <StatusRow label={t('dashboard.connStatus')}><span className={dashboard?.status.connected ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>
                {dashboard ? t(dashboard.status.connected ? 'ca.overview.connected' : 'ca.overview.unreachable') : '—'}</span></StatusRow>
              <StatusRow label={t('ca.overview.channelStatus')}><span>{dashboard?.status.closed == null ? '—' : t(dashboard.status.closed ? 'ca.overview.channelClosed' : 'ca.overview.channelOpen')}</span></StatusRow>
              <StatusRow label={t('ca.overview.enabledInProvider')}><span>{amount(dashboard?.status.accounts_enabled)} / {amount(dashboard?.status.accounts_total)}</span></StatusRow>
              <StatusRow label={t('ca.modelsCount')}><span>{amount(models?.length)}</span></StatusRow>
              <StatusRow label={t('ca.overview.disabledModels')}><span>{amount(dashboard?.status.models_disabled)}</span></StatusRow>
              <StatusRow label={t('ca.overview.enabledKeys')}><span>{amount(activeKeys)} / {amount(base.values.keys?.length)}</span></StatusRow>
              <StatusRow label={t('ca.overview.lastRequest')}><span className="text-right text-[11px]">{fmtDateTime(dashboard?.recent_requests[0]?.ts)}</span></StatusRow>
            </div>
            {dashboard?.status.error && <p role="alert" className="mt-3 rounded-xl bg-destructive/5 p-3 text-xs leading-5 text-destructive">{dashboard.status.error}</p>}
            <div className="mt-5 rounded-2xl bg-background/60 p-3">
              <p className="text-[11px] text-muted-foreground">{t('ca.totalTokens')}</p><p className="mt-1 text-xl font-semibold tabular-nums">{compact(summary?.total_tokens)}</p>
              <p className="mt-1 text-[10px] leading-5 text-muted-foreground">{t('ca.overview.accumulatedScope')}</p>
            </div>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {[['/models', 'nav.models'], ['/keys', 'nav.keys'], ['/stats', 'nav.stats']].map(([href, label]) => <Button asChild key={href} variant="ghost" size="sm" className="h-7 rounded-full bg-background/50 text-[11px]"><Link href={href}>{t(label)}<ArrowUpRight className="size-3" /></Link></Button>)}
            </div>
          </div>
        </section>

        <section className="rounded-[20px] bg-muted p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-medium"><Coins className="size-4" />{t('ca.overview.creditsTitle')}</h2>
            <p className="text-[10px] text-muted-foreground">{base.values.credits ? t('ca.overview.creditCoverage', {known: credit.knownAccounts, total: accounts?.length ?? base.values.credits.accounts.length}) : '—'}</p></div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MiniStat label={t('ca.overview.knownBalance')} value={amount(credit.total)} tone="accent" />
            <MiniStat label={t('ca.overview.unusableCredits')} value={amount(credit.unusable)} tone={credit.unusable ? 'warning' : 'neutral'} />
            <MiniStat label={t('ca.overview.expiringCredits')} value={amount(credit.expiring)} tone={credit.expiring ? 'warning' : 'neutral'} />
            <MiniStat label={t('ca.overview.expiredCredits')} value={amount(credit.expired)} />
          </div>
          {credit.unknownAccounts > 0 && <p className="mt-3 text-[11px] text-amber-700 dark:text-amber-400">{t('ca.balancePartial', {n: credit.unknownAccounts})}</p>}
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl bg-background/60 p-3"><p className="text-xs font-medium">{t('ca.overview.nearestExpiry')}</p>
              <div className="mt-2">{credit.expiries.length > 0 ? <CreditCountdown expiries={credit.expiries} />
                : <span className="text-[11px] text-muted-foreground">{base.values.credits ? t('ca.overview.noDatedExpiry') : '—'}</span>}</div>
              {credit.undatedPackages > 0 && <p className="mt-2 text-[10px] leading-5 text-muted-foreground">{t('ca.overview.undatedPackages', {n: credit.undatedPackages})}</p>}
            </div>
            <div className="rounded-2xl bg-background/60 p-3"><p className="text-xs font-medium">{t('ca.overview.reportedExpense')}</p>
              <p className="mt-2 text-lg font-semibold tabular-nums">{amount(dashboard?.quality.reported_credit)}<span className="ml-2 text-[10px] font-normal text-muted-foreground">{periodLabel}</span></p>
              <p className="mt-1 text-[10px] leading-5 text-muted-foreground">{dashboard ? t('ca.overview.expenseCoverage', {known: dashboard.quality.credit_samples, total: dashboard.quality.requests}) : '—'}</p>
            </div>
          </div>
          <p className="mt-3 text-[10px] leading-5 text-muted-foreground">{t('ca.overview.creditsScope')}</p>
        </section>

        <CodeArtsCheckinCard onComplete={reload} />

        <section className="rounded-[20px] bg-muted p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-medium"><Users className="size-4" />{t('ca.overview.healthTitle')}</h2>
            <Button asChild variant="ghost" size="sm" className="h-7 rounded-full text-[11px]"><Link href="/accounts">{t('ca.overview.allAccounts')}<ArrowUpRight className="size-3" /></Link></Button></div>
          {accounts && accounts.length > 0 ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{accounts.slice(0, 9).map((account) => {
            const tier = codeartsAccountTier(account, now);
            const row = creditById.get(account.id);
            const expiry = account.expires_at;
            const packs = row?.balance?.packages.filter((pack) => pack.active && pack.unit === 'credit') ?? [];
            const hasPackageTotals = packs.length > 0 && packs.every((pack) => pack.total != null && pack.used != null);
            const used = hasPackageTotals ? packs.reduce((n, pack) => n + pack.used!, 0) : null;
            const total = hasPackageTotals ? packs.reduce((n, pack) => n + pack.total!, 0) : null;
            const percent = codeartsPackagePercent(used, total);
            const limited = Object.entries(account.model_rate_limits).filter(([, at]) => at != null && at > now);
            return <div key={account.id} className="min-w-0 rounded-2xl bg-background/60 p-3.5">
              <div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate text-sm font-medium" title={account.nickname}>{account.nickname || account.id}</span>
                <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px]', tier === 'ready' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                  : tier === 'limited' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400' : 'bg-muted text-muted-foreground')}>{t(`ca.overview.account_${tier}`)}</span></div>
              <div className="mt-3 flex items-baseline justify-between gap-2"><span className="text-[11px] text-muted-foreground">{t('ca.balance')}</span>
                <button type="button" disabled={!row} onClick={() => setDetailId(account.id)} aria-label={t('ca.creditDetailsFor', {name: account.nickname})}
                  className={cn('flex items-center gap-1 text-lg font-semibold tabular-nums hover:underline', row?.balance == null ? 'text-muted-foreground' : row.balance.total < 200 ? 'text-amber-700 dark:text-amber-400' : 'text-foreground')}>
                  {amount(row?.balance?.total)}<ArrowUpRight className="size-3" /></button></div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border" title={percent == null ? t('ca.overview.packageUsageUnknown') : t('ca.overview.packageUsage', {n: percent.toFixed(1)})}>
                {percent != null && <div className="h-full rounded-full bg-violet-500/70" style={{width: `${100 - percent}%`}} />}</div>
              <div className="mt-2 flex justify-between gap-2 text-[10px] text-muted-foreground"><span>{t('ca.credentialExpiry')}</span>
                <span className={expiry != null && expiry <= now ? 'text-destructive' : ''} title={fmtDateTime(expiry)}>{expiry == null ? '—' : expiry - now >= 5 * 365 * 86400 ? fmtDateTime(expiry) : fmtRemain(expiry - now)}</span></div>
              <div className="mt-2 flex items-start justify-between gap-2 text-[10px]"><span className="text-muted-foreground">{t('ca.todayCheckin')}</span>
                <span className={row?.checkin?.kind === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>{row?.checkin
                  ? row.checkin.kind === 'claimed' ? t('ca.claimedAmount', {n: amount(row.checkin.credit)})
                    : t(row.checkin.kind === 'already-claimed' ? 'ca.alreadyClaimed' : row.checkin.kind === 'failed' ? 'ca.checkinFailed' : 'ca.inactive')
                  : t('ca.overview.noManualClaim')}</span></div>
              <div className="mt-2 flex justify-between gap-2 text-[10px] text-muted-foreground"><span>{t('ca.overview.lastUsed')}</span><span>{fmtDateTime(account.last_used_at)}</span></div>
              {row?.error && <button type="button" className="mt-2 text-left text-[10px] text-destructive hover:underline" onClick={() => setDetailId(account.id)}>{t('ca.overview.balanceFailureDetails')}</button>}
              {limited.length > 0 && <p className="mt-2 text-[10px] leading-5 text-amber-700 dark:text-amber-400" title={limited.map(([model, at]) => `${model} · ${fmtDateTime(at)}`).join('\n')}>{t('ca.overview.limitedModels', {n: limited.length})}</p>}
              {account.refreshable && <p className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground"><RefreshCw className="size-2.5" />{t('ca.overview.refreshable')}</p>}
            </div>;
          })}</div> : <PanelMessage loading={base.isInitialLoading} failed={!!base.errors.accounts} empty="ca.emptyHint" />}
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <UsageRanking title={t('ca.overview.modelUsage')} icon="models" rows={period.values.models} loading={period.isInitialLoading} failed={!!period.errors.models} periodLabel={periodLabel} href="/models" />
          <UsageRanking title={t('ca.overview.keyUsage')} icon="keys" rows={period.values.keys} loading={period.isInitialLoading} failed={!!period.errors.keys} periodLabel={periodLabel} href="/keys" />
        </section>

        <section className="rounded-[20px] bg-muted p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-medium"><Boxes className="size-4" />{t('ca.overview.accountUsage')}</h2><span className="text-[11px] text-muted-foreground">{periodLabel}</span></div>
          {accountUsage && accountUsage.length > 0 ? <div className="rounded-2xl bg-background/60 p-1 sm:p-2"><Table>
            <TableHeader><TableRow><TableHead className="text-left text-[11px]">{t('nav.accounts')}</TableHead><TableHead className="text-[11px]">{t('metric.requests')}</TableHead>
              <TableHead className="text-[11px]">{t('ca.overview.inputTokens')}</TableHead><TableHead className="text-[11px]">{t('ca.overview.outputTokens')}</TableHead>
              <TableHead className="text-[11px]">{t('ca.overview.tokens')}</TableHead><TableHead className="text-[11px]">{t('ca.overview.usageReported')}</TableHead><TableHead className="text-[11px]">{t('dashboard.failedRequests')}</TableHead></TableRow></TableHeader>
            <TableBody>{accountUsage.slice(0, 12).map((row) => <TableRow key={row.account_id ?? 'unknown'} className="text-xs tabular-nums">
              <TableCell className="max-w-44 truncate text-left font-medium" title={row.account_id ?? undefined}>{row.account_id ? accountNames.get(row.account_id) || row.account_id : t('ca.overview.unknownAccount')}</TableCell>
              <TableCell>{amount(row.totals.requests)}</TableCell><TableCell>{compact(row.totals.input_tokens == null || row.totals.cache_read_tokens == null ? null : row.totals.input_tokens + row.totals.cache_read_tokens)}</TableCell>
              <TableCell>{compact(row.totals.output_tokens)}</TableCell><TableCell className="font-semibold">{compact(row.totals.total_tokens)}</TableCell><TableCell>{amount(row.totals.reported_requests)}</TableCell>
              <TableCell className={row.totals.errors ? 'text-destructive' : ''}>{amount(row.totals.errors)}</TableCell>
            </TableRow>)}</TableBody>
          </Table></div> : <PanelMessage loading={period.isInitialLoading} failed={!!period.errors.dashboard || !!dashboard?.errors.ledger} />}
          <p className="mt-3 text-[10px] leading-5 text-muted-foreground">{t('ca.overview.ledgerScope')}</p>
        </section>

        <section className="rounded-[20px] bg-muted p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-medium"><CheckCircle2 className="size-4" />{t('ca.overview.qualityTitle')}</h2>
            <span className="text-[11px] text-muted-foreground">{periodLabel}</span></div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            <MiniStat label={t('ca.overview.successfulRequests')} value={amount(dashboard?.quality.succeeded)} tone="success" />
            <MiniStat label="4xx" value={amount(dashboard?.quality.failures_4xx)} tone={dashboard?.quality.failures_4xx ? 'warning' : 'neutral'} />
            <MiniStat label="5xx" value={amount(dashboard?.quality.failures_5xx)} tone={dashboard?.quality.failures_5xx ? 'danger' : 'neutral'} />
            <MiniStat label={t('ca.overview.rateLimited')} value={amount(dashboard?.quality.rate_limited)} tone={dashboard?.quality.rate_limited ? 'warning' : 'neutral'} />
            <MiniStat label={t('ca.overview.avgDuration')} value={latency(dashboard?.quality.avg_latency_ms)} />
          </div>
          <QualityNote quality={dashboard?.quality} />
          <div className="mb-3 mt-5 flex items-center justify-between border-t border-border/50 pt-4"><h3 className="text-xs font-medium">{t('ca.overview.recentRequests')}</h3>
            <Button asChild variant="ghost" size="sm" className="h-7 rounded-full text-[11px]"><Link href="/logs">{t('ca.overview.allLogs')}<ArrowUpRight className="size-3" /></Link></Button></div>
          {dashboard && dashboard.recent_requests.length > 0 ? <div className="rounded-2xl bg-background/60 p-1 sm:p-2"><Table>
            <TableHeader><TableRow><TableHead className="text-left text-[11px]">{t('ca.overview.time')}</TableHead><TableHead className="text-left text-[11px]">{t('nav.models')}</TableHead>
              <TableHead className="text-left text-[11px]">{t('nav.keys')}</TableHead><TableHead className="text-[11px]">{t('ca.overview.status')}</TableHead>
              <TableHead className="text-[11px]">{t('ca.overview.tokens')}</TableHead><TableHead className="text-[11px]">{t('ca.overview.avgFirstToken')}</TableHead><TableHead className="text-[11px]">{t('ca.overview.duration')}</TableHead><TableHead className="text-[11px]">{t('metric.credits')}</TableHead></TableRow></TableHeader>
            <TableBody>{dashboard.recent_requests.map((row) => <TableRow key={row.id} className="text-[11px] tabular-nums">
              <TableCell className="text-left text-muted-foreground">{fmtDateTime(row.ts)}</TableCell>
              <TableCell className="max-w-64 text-left"><p className="truncate font-medium" title={row.mapped_model || row.model || undefined}>{row.mapped_model || row.model || '—'}</p>
                {row.error && <details className="mt-1 max-w-64 text-destructive"><summary className="cursor-pointer">{t('ca.overview.errorDetails')}</summary><p className="mt-1 whitespace-normal break-words leading-5">{row.error}</p></details>}</TableCell>
              <TableCell className="max-w-32 truncate text-left">{row.key_name || '—'}</TableCell>
              <TableCell><span className={cn('rounded-full px-2 py-0.5', row.status >= 200 && row.status < 300 ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-red-500/10 text-destructive')}>{row.status}</span></TableCell>
              <TableCell title={`${t('ca.overview.inputTokens')}: ${amount(row.prompt_tokens)} / ${t('ca.overview.outputTokens')}: ${amount(row.completion_tokens)}`}>{compact(row.prompt_tokens + row.completion_tokens)}</TableCell>
              <TableCell>{row.first_token_ms && row.first_token_ms > 0 ? latency(row.first_token_ms) : '—'}</TableCell><TableCell>{latency(row.latency_ms)}</TableCell><TableCell>{amount(row.credit)}</TableCell>
            </TableRow>)}</TableBody>
          </Table></div> : <PanelMessage loading={period.isInitialLoading} failed={!!period.errors.dashboard} />}
        </section>
      </>}
    <CodeArtsCreditDetails account={selectedCredit} onClose={() => setDetailId(null)} />
  </div>;
}

function StatusRow({label, children}: {label: string; children: ReactNode}) {
  return <div className="flex items-start justify-between gap-3"><span className="text-muted-foreground">{label}</span><span className="font-medium tabular-nums">{children}</span></div>;
}

function MiniStat({label, value, tone = 'neutral'}: {label: string; value: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent'}) {
  return <div className="min-w-0 rounded-2xl bg-background/60 px-3 py-2.5"><p className="truncate text-[10px] text-muted-foreground" title={label}>{label}</p>
    <p className={cn('mt-1.5 text-lg font-semibold tracking-tight tabular-nums', tone === 'success' && 'text-emerald-600 dark:text-emerald-400',
      tone === 'warning' && 'text-amber-700 dark:text-amber-400', tone === 'danger' && 'text-destructive', tone === 'accent' && 'text-violet-600 dark:text-violet-400')}>{value}</p></div>;
}

function PanelMessage({loading, failed, empty = 'dashboard.noCallData'}: {loading?: boolean; failed?: boolean; empty?: string}) {
  const t = useT();
  return <div className="grid min-h-24 place-items-center p-4 text-center text-xs leading-6 text-muted-foreground">{t(loading ? 'common.loading' : failed ? 'ca.loadFailed' : empty)}</div>;
}

function UsageRanking({title, icon, rows, loading, failed, periodLabel, href}: {
  title: string; icon: 'models' | 'keys'; rows: UsageBreakdown[] | undefined; loading: boolean; failed: boolean; periodLabel: string; href: string;
}) {
  const t = useT();
  const ranked = rows ? [...rows].sort((a, b) => (b.prompt_tokens + b.completion_tokens) - (a.prompt_tokens + a.completion_tokens)) : [];
  const allTokens = ranked.reduce((sum, row) => sum + row.prompt_tokens + row.completion_tokens, 0);
  const Icon = icon === 'models' ? Boxes : KeyRound;
  return <div className="min-w-0 rounded-[20px] bg-muted p-4 sm:p-5">
    <div className="mb-4 flex items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-sm font-medium"><Icon className="size-4" />{title}</h2>
      <span className="text-[10px] text-muted-foreground">{periodLabel}</span></div>
    {ranked.length > 0 ? <div className="space-y-2">{ranked.slice(0, 5).map((row, i) => {
      const tokens = row.prompt_tokens + row.completion_tokens;
      const share = allTokens ? tokens * 100 / allTokens : 0;
      return <div key={`${row.name}-${i}`} className="rounded-2xl bg-background/60 p-3">
        <div className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2"><span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[10px] text-muted-foreground">{i + 1}</span>
          <span className="min-w-0 truncate text-xs font-medium" title={row.name}>{row.name}</span></div><span className="shrink-0 text-xs font-semibold tabular-nums">{fmtCompact(tokens)} <span className="font-normal text-muted-foreground">tokens</span></span></div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full bg-blue-500/65" style={{width: `${share}%`}} /></div>
        <div className="mt-2 flex justify-between text-[10px] text-muted-foreground"><span>{t('ca.overview.rankingRequests', {n: fmtNumber(row.requests)})}</span>
          <span>{share.toFixed(1)}%{icon === 'models' && row.tokens_per_sec != null ? ` · ${row.tokens_per_sec} tok/s` : ''}</span></div>
      </div>;
    })}</div> : <PanelMessage loading={loading} failed={failed} />}
    <div className="mt-3 flex items-center justify-between gap-2"><p className="text-[10px] leading-5 text-muted-foreground">{t('ca.overview.rankingScope')}</p><Link className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground" href={href}><ArrowUpRight className="size-3.5" aria-label={title} /></Link></div>
  </div>;
}

function QualityNote({quality}: {quality: CodeArtsRequestQuality | undefined}) {
  const t = useT();
  return <p className="mt-3 text-[10px] leading-5 text-muted-foreground">{t('ca.overview.qualityScope')}
    {quality && ` ${t('ca.overview.latencyCoverage', {latency: quality.latency_samples, first: quality.first_token_samples, speed: quality.throughput_samples})}`}
    {!!quality?.other && ` ${t('ca.overview.otherStatuses', {n: quality.other})}`}</p>;
}

function DashboardSkeleton() {
  return <div className="space-y-4"><div className="grid grid-cols-2 gap-3 xl:grid-cols-5">{Array.from({length: 5}, (_, i) => <div key={i} className="h-28 rounded-[20px] bg-muted p-4"><SkeletonBar /><SkeletonBar /></div>)}</div>
    <div className="grid gap-4 lg:grid-cols-3"><div className="h-80 rounded-[20px] bg-muted p-5 lg:col-span-2"><SkeletonBar /></div><div className="h-80 rounded-[20px] bg-muted p-5"><SkeletonBar /></div></div></div>;
}
