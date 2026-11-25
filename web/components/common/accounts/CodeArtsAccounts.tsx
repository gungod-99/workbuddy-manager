'use client';

import {useRef, useState} from 'react';
import {CheckCircle2, Coins, Loader2, Pause, Play, Plus, RefreshCw, Search, Trash2, Users} from 'lucide-react';
import {codeartsApi, errText} from '@/lib/api';
import {useAuth} from '@/lib/auth-context';
import {useT} from '@/lib/i18n/provider';
import {useAsyncAll} from '@/lib/use-async-data';
import {useHeartbeat} from '@/lib/use-heartbeat';
import {notify} from '@/lib/toast';
import {fmtDateTime, fmtNumber} from '@/lib/format';
import type {CodeArtsAccount, CodeArtsCreditAccount} from '@/lib/types';
import {PageHeader} from '@/components/common/layout/PageHeader';
import {PageSectionTabs} from '@/components/common/layout/PageSectionTabs';
import {EmptyState} from '@/components/common/layout/EmptyState';
import {ConfirmDialog} from '@/components/common/layout/ConfirmDialog';
import {LoadError} from '@/components/common/states/LoadError';
import {SkeletonBar} from '@/components/common/states/SkeletonBar';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/ui/badge';
import {Input} from '@/components/ui/input';
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from '@/components/ui/table';
import {CodeArtsLoginDialog} from './CodeArtsLoginDialog';
import {CodeArtsCheckinCard} from './CodeArtsCheckinCard';
import {CodeArtsCreditDetails} from './CodeArtsCreditDetails';

const EMPTY: CodeArtsAccount[] = [];

export function CodeArtsAccounts() {
  const t = useT();
  const {isAdmin} = useAuth();
  const {values, errors, isInitialLoading, isInitialFailed, isRefreshing, reload} = useAsyncAll({
    accounts: () => codeartsApi.list(), credits: () => codeartsApi.credits(),
  });
  useHeartbeat(reload, 30000);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshingCredits, setRefreshingCredits] = useState(false);
  const [details, setDetails] = useState<CodeArtsCreditAccount | null>(null);
  const operationLock = useRef(false);
  const accounts = values.accounts?.accounts ?? EMPTY;
  const credits = values.credits;
  const balances = new Map(credits?.accounts.map((a) => [a.account_id, a]) ?? []);
  const filtered = accounts.filter((a) => `${a.nickname} ${a.id}`.toLowerCase().includes(query.toLowerCase()));
  const active = accounts.filter((a) => a.enabled && !a.is_expired && a.credential_status === 'available').length;

  const operate = async (id: string, action: () => Promise<unknown>) => {
    if (operationLock.current) return;
    operationLock.current = true; setBusy(id);
    try {await action(); notify.ok(t('ca.saved')); await reload();}
    catch (e) {notify.err(errText(e));}
    finally {operationLock.current = false; setBusy(null);}
  };
  const refreshCredits = async () => {
    if (refreshingCredits) return;
    setRefreshingCredits(true);
    try {await codeartsApi.credits(true); await reload();}
    catch (e) {notify.err(errText(e));}
    finally {setRefreshingCredits(false);}
  };

  return <div className="space-y-5">
    <PageHeader title={t('ca.accountsTitle')} description={t('ca.accountsDescription')}
      actions={<><Button variant="outline" size="sm" className="rounded-full" disabled={isRefreshing} onClick={() => void reload()}>
        <RefreshCw className={isRefreshing ? 'animate-spin' : ''} />{t('common.refresh')}
      </Button>{isAdmin && <Button size="sm" className="rounded-full" onClick={() => setOpen(true)}><Plus />{t('ca.add')}</Button>}</>} />
    <PageSectionTabs />
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      <div className="rounded-2xl border border-border/60 bg-muted/30 p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Users className="size-4" />{t('ca.accountCount')}</div>
        <div className="mt-2 flex items-baseline gap-2"><span className="text-2xl font-semibold tabular-nums">{values.accounts ? fmtNumber(accounts.length) : '—'}</span>
          <span className="text-xs text-muted-foreground">{t('ca.activeCount', {n: active})}</span></div>
      </div>
      <div className="rounded-2xl border border-border/60 bg-muted/30 p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Coins className="size-4" />{t('ca.totalCredits')}</div>
        <div className="mt-2 text-2xl font-semibold tabular-nums">{credits?.total == null ? '—' : fmtNumber(credits.total)}</div>
        {credits && credits.unknown_accounts > 0 && <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">{t('ca.balancePartial', {n: credits.unknown_accounts})}</div>}
      </div>
      <div className="col-span-2 flex items-center gap-3 rounded-2xl border border-border/60 bg-muted/30 p-4 lg:col-span-1">
        <CheckCircle2 className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <p className="text-xs leading-6 text-muted-foreground">{t('ca.accountNote')}</p>
      </div>
    </div>
    <CodeArtsCheckinCard onComplete={reload} />
    {isInitialFailed || errors.accounts ? <LoadError message={t('ca.loadFailed')} onRetry={reload} />
      : isInitialLoading ? <SkeletonBar /> : <>
        {errors.credits && <LoadError message={t('ca.balanceLoadFailed')} onRetry={refreshCredits} />}
        <section className="overflow-hidden rounded-[20px] border border-border/60 bg-background">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
            <div className="relative w-full sm:max-w-xs"><Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('ca.search')} aria-label={t('ca.search')} className="h-9 rounded-full bg-muted/40 pl-9" />
            </div>
            <Button variant="ghost" size="sm" className="rounded-full" disabled={refreshingCredits} onClick={() => void refreshCredits()}>
              <RefreshCw className={refreshingCredits ? 'animate-spin' : ''} />{t('ca.refreshCredits')}
            </Button>
          </div>
          <Table><TableHeader className="bg-muted/40"><TableRow className="hover:bg-transparent">
            <TableHead className="h-11 pl-5 text-left">{t('metric.name')}</TableHead>
            <TableHead className="text-left">{t('ca.balance')}</TableHead>
            <TableHead className="text-left">{t('ca.todayCheckin')}</TableHead>
            <TableHead className="text-left">{t('accounts.colStatus')}</TableHead>
            <TableHead className="text-left">{t('ca.credentialExpiry')}</TableHead>
            {isAdmin && <TableHead className="pr-5 text-right">{t('accounts.colActions')}</TableHead>}
          </TableRow></TableHeader><TableBody>
            {filtered.map((a) => {
              const credit = balances.get(a.id);
              const checkin = credit?.checkin;
              return <TableRow key={a.id}>
                <TableCell className="py-4 pl-5 text-left">
                  <div className="max-w-[220px] truncate font-medium" title={a.nickname}>{a.nickname}</div>
                  <div className="mt-1 font-mono text-[10px] text-muted-foreground">{a.id}</div>
                </TableCell>
                <TableCell className="text-left">
                  {credit?.balance ? <button type="button" className="group text-left" onClick={() => setDetails(credit)} aria-label={t('ca.creditDetailsFor', {name: a.nickname})}>
                    <div className="text-base font-semibold tabular-nums group-hover:underline">{fmtNumber(credit.balance.total)}</div>
                    <div className="mt-1 text-[10px] text-muted-foreground">{t('ca.viewPackages')}</div>
                  </button> : credit?.error ? <button type="button" onClick={() => setDetails(credit)} className="text-xs text-destructive underline decoration-dotted underline-offset-4">{t('ca.balanceError')}</button>
                    : <span className="text-xs text-muted-foreground">{t('ca.unknown')}</span>}
                  {credit?.balance?.expiring_total != null && credit.balance.expiring_total > 0 && <div className="mt-1 text-[10px] text-amber-700 dark:text-amber-400">{t('ca.expiringCredits', {n: fmtNumber(credit.balance.expiring_total)})}</div>}
                </TableCell>
                <TableCell className="text-left">
                  {checkin ? <><Badge variant={checkin.kind === 'failed' ? 'destructive' : 'secondary'} className="rounded-full text-[10px]">
                    {t(checkin.kind === 'claimed' ? 'ca.claimed' : checkin.kind === 'already-claimed' ? 'ca.alreadyClaimed' : checkin.kind === 'inactive' ? 'ca.inactive' : 'ca.checkinFailed')}
                  </Badge>{checkin.kind === 'claimed' && checkin.credit != null && <div className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">+{fmtNumber(checkin.credit)}</div>}
                    {checkin.message && <div className="mt-1 max-w-[180px] truncate text-[10px] text-muted-foreground" title={checkin.message}>{checkin.message}</div>}</>
                    : <span className="text-xs text-muted-foreground">{t('ca.noCheckinRecord')}</span>}
                </TableCell>
                <TableCell className="text-left"><Badge variant={a.is_expired ? 'destructive' : 'secondary'} className="rounded-full text-[10px]">
                  {!a.enabled ? t('keys.badgeDisabled') : a.credential_status === 'pending' ? t('ca.pending') : a.is_expired ? t('keys.badgeExpired')
                    : a.credential_status === 'available' ? t('ca.enabled') : t('ca.credentialUnknown')}
                </Badge>{a.refreshable && <div className="mt-1.5 text-[10px] text-muted-foreground">{t('ca.autoRefresh')}</div>}</TableCell>
                <TableCell className="text-left text-[11px] text-muted-foreground">{a.expires_at ? fmtDateTime(a.expires_at) : t('ca.unknown')}</TableCell>
                {isAdmin && <TableCell className="pr-4"><div className="flex justify-end gap-1">
                  <Button size="icon" variant="ghost" disabled={busy !== null} title={a.enabled ? t('ca.disable') : t('ca.enable')}
                    aria-label={a.enabled ? t('ca.disable') : t('ca.enable')} className="size-8 rounded-full"
                    onClick={() => void operate(a.id, () => codeartsApi.update(a.id, {enabled: !a.enabled}))}>{a.enabled ? <Pause /> : <Play />}</Button>
                  <Button size="icon" variant="ghost" disabled={busy !== null || !a.refreshable} title={t('ca.refresh')} aria-label={t('ca.refresh')} className="size-8 rounded-full"
                    onClick={() => void operate(a.id, () => codeartsApi.refresh(a.id))}>{busy === a.id ? <Loader2 className="animate-spin" /> : <RefreshCw />}</Button>
                  <ConfirmDialog title={t('ca.deleteTitle')} description={t('ca.deleteDescription', {name: a.nickname})} destructive
                    trigger={<Button size="icon" variant="ghost" disabled={busy !== null} aria-label={t('common.delete')} className="size-8 rounded-full text-muted-foreground hover:text-destructive"><Trash2 /></Button>}
                    onConfirm={async () => {await codeartsApi.remove(a.id); await reload();}} />
                </div></TableCell>}
              </TableRow>;
            })}
          </TableBody></Table>
          {!filtered.length && <EmptyState icon={Users} title={query ? t('ca.noMatches') : t('ca.empty')} description={query ? t('ca.searchHint') : t('ca.emptyHint')} />}
        </section>
      </>}
    <CodeArtsLoginDialog open={open} onOpenChange={setOpen} onSuccess={reload} />
    <CodeArtsCreditDetails account={details} onClose={() => setDetails(null)} />
  </div>;
}
