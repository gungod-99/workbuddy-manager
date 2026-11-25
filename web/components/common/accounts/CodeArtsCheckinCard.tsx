'use client';

import {useEffect, useRef, useState} from 'react';
import {CalendarCheck2, ChevronDown, Clock3, Loader2, RefreshCw} from 'lucide-react';
import {codeartsApi, errText} from '@/lib/api';
import {useAuth} from '@/lib/auth-context';
import {useAsyncAll} from '@/lib/use-async-data';
import {useHeartbeat} from '@/lib/use-heartbeat';
import {useT} from '@/lib/i18n/provider';
import {notify} from '@/lib/toast';
import {fmtDateTime, fmtNumber} from '@/lib/format';
import type {CodeArtsCheckinResult} from '@/lib/types';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Switch} from '@/components/ui/switch';

export function CodeArtsCheckinCard({onComplete}: {onComplete: () => Promise<boolean>}) {
  const t = useT();
  const {isAdmin} = useAuth();
  const {values, errors, reload, isInitialLoading} = useAsyncAll({schedule: () => codeartsApi.autoCheckin()});
  useHeartbeat(reload, 15000);
  const schedule = values.schedule;
  const [busy, setBusy] = useState<'saving' | 'claiming' | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [times, setTimes] = useState(['09:00', '21:00']);
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState<CodeArtsCheckinResult | null>(null);
  const [error, setError] = useState('');
  const lock = useRef(false);
  useEffect(() => {if (schedule?.times.length === 2 && !dirty) setTimes(schedule.times);}, [schedule, dirty]);

  const save = async (body: {enabled?: boolean; times?: string[]; jitter_minutes?: number}) => {
    if (lock.current) return;
    lock.current = true; setBusy('saving'); setError('');
    try {await codeartsApi.saveAutoCheckin(body); setDirty(false); notify.ok(t('ca.scheduleSaved')); await reload();}
    catch (e) {setError(errText(e));}
    finally {lock.current = false; setBusy(null);}
  };
  const claim = async () => {
    if (lock.current) return;
    lock.current = true; setBusy('claiming'); setError('');
    try {
      const value = await codeartsApi.checkin(); setResult(value);
      if (value.summary.failed) notify.err(t('ca.checkinPartialFailed'));
      else notify.ok(t('ca.checkinCompleted'), t('ca.claimSummary', {n: fmtNumber(value.summary.claimed ?? 0), credit: fmtNumber(value.summary.total_credit ?? 0)}));
      await onComplete(); await reload();
    } catch (e) {setError(errText(e));}
    finally {lock.current = false; setBusy(null);}
  };
  const badTimes = times.some((v) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v)) || times[0] === times[1];

  return <section className="rounded-[20px] border border-border/60 bg-muted/20 p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"><CalendarCheck2 className="size-5" /></div>
        <div><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold">{t('ca.autoCheckinTitle')}</h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{isInitialLoading ? t('common.loading') : schedule ? t(schedule.enabled ? 'ca.autoEnabled' : 'ca.autoDisabled') : '—'}</span></div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('ca.autoCheckinHint')}</p>
          {schedule && <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground"><Clock3 className="size-3" />
            {schedule.times.join(' / ')} · {t('ca.beijingTime')}
            {schedule.running ? <span className="text-emerald-700 dark:text-emerald-400">· {t('ca.checkinRunning')}</span>
              : schedule.enabled && schedule.next_run_at ? <span>· {t('ca.nextCheckin', {time: fmtDateTime(schedule.next_run_at)})}</span> : null}
          </p>}
          {schedule?.last_result && <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{t('ca.lastAutoResult')}: {schedule.last_result}{schedule.last_at ? ` · ${fmtDateTime(schedule.last_at)}` : ''}</p>}
        </div>
      </div>
      {isAdmin && <div className="flex items-center gap-3">
        <Label htmlFor="ca-auto-checkin" className="sr-only">{t('ca.autoCheckinTitle')}</Label>
        <Switch id="ca-auto-checkin" checked={schedule?.enabled ?? false} disabled={busy !== null || !schedule} onCheckedChange={(enabled) => void save({enabled})} />
        <Button variant="outline" size="sm" className="rounded-full" disabled={busy !== null || schedule?.running} onClick={() => void claim()}>
          {busy === 'claiming' ? <Loader2 className="animate-spin" /> : <CalendarCheck2 />}{t('ca.checkinNow')}
        </Button>
      </div>}
    </div>
    {!!errors.schedule && <div className="mt-3 flex items-center gap-3 text-xs text-destructive">{t('ca.scheduleLoadFailed')}<Button variant="ghost" size="sm" onClick={() => void reload()}><RefreshCw />{t('state.retry')}</Button></div>}
    {isAdmin && schedule && <>
      <button type="button" className="mt-4 flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {t('ca.scheduleSettings')}<ChevronDown className={`size-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && <form onSubmit={(e) => {e.preventDefault(); if (!badTimes) void save({times});}}
        className="mt-3 flex flex-wrap items-end gap-3 rounded-xl border border-border/60 bg-background/70 p-3">
        {times.map((value, i) => <div key={i} className="space-y-1.5"><Label htmlFor={`ca-checkin-time-${i}`} className="text-[11px]">{t(i === 0 ? 'ca.firstTime' : 'ca.secondTime')}</Label>
          <Input id={`ca-checkin-time-${i}`} type="time" value={value} className="h-8 w-32" disabled={busy !== null} onChange={(e) => {setDirty(true); setTimes(times.map((v, j) => j === i ? e.target.value : v));}} /></div>)}
        <Button type="submit" size="sm" disabled={busy !== null || !dirty || badTimes} className="rounded-full">{busy === 'saving' && <Loader2 className="animate-spin" />}{t('common.save')}</Button>
        <p className="w-full text-[11px] text-muted-foreground">{t('ca.schedulePersistence')}{badTimes && <span className="ml-2 text-destructive">{t('ca.scheduleInvalid')}</span>}</p>
      </form>}
    </>}
    {error && <p role="alert" className="mt-3 rounded-xl bg-destructive/5 p-3 text-xs leading-5 text-destructive">{error}</p>}
    {result && <details open className="mt-4 border-t border-border/50 pt-3">
      <summary className="cursor-pointer text-xs font-medium">{t('ca.claimSummary', {n: fmtNumber(result.summary.claimed ?? 0), credit: fmtNumber(result.summary.total_credit ?? 0)})}</summary>
      <div className="mt-3 space-y-2">{result.results.map((row, i) => <div key={`${row.account_id}-${i}`} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs">
        <span className="font-medium">{row.nickname || row.account_id}</span>
        <span className={row.kind === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>{row.kind === 'claimed' ? t('ca.claimedAmount', {n: fmtNumber(row.credit ?? 0)})
          : t(row.kind === 'already-claimed' ? 'ca.alreadyClaimed' : row.kind === 'inactive' ? 'ca.inactive' : 'ca.checkinFailed')}</span>
        {row.message && <p className={`w-full text-[11px] leading-5 ${row.kind === 'failed' || row.action_required ? 'text-destructive' : 'text-muted-foreground'}`}>{row.message}</p>}
      </div>)}</div>
    </details>}
  </section>;
}
