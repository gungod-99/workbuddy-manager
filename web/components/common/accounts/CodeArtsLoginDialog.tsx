'use client';

import {useEffect, useRef, useState} from 'react';
import {ArrowRight, Check, CheckCircle2, Clock3, ExternalLink, Info, Link2, Loader2, RefreshCw, ShieldCheck} from 'lucide-react';
import {codeartsApi, errText} from '@/lib/api';
import {callbackIssue, CodeArtsLoginFlow, type LoginState} from '@/lib/codearts-login';
import {useT} from '@/lib/i18n/provider';
import {notify} from '@/lib/toast';
import {cn} from '@/lib/utils';
import {Button} from '@/components/ui/button';
import {Label} from '@/components/ui/label';
import {Textarea} from '@/components/ui/textarea';
import {CopyButton} from '@/components/ui/copy-button';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/animate-ui/radix/dialog';

export function CodeArtsLoginDialog({open, onOpenChange, onSuccess}: {
  open: boolean; onOpenChange: (value: boolean) => void; onSuccess: () => Promise<boolean>;
}) {
  const t = useT();
  const [state, setState] = useState<LoginState>({phase: 'idle', login: null, error: ''});
  const [callback, setCallback] = useState('');
  const [validation, setValidation] = useState('');
  const [now, setNow] = useState(Date.now());
  const latest = useRef({onSuccess, t});
  latest.current = {onSuccess, t};
  const flow = useRef<CodeArtsLoginFlow | null>(null);
  if (!flow.current) {
    flow.current = new CodeArtsLoginFlow({api: codeartsApi, changed: setState, errorText: errText,
      messages: {expired: t('ca.loginExpired'), rejected: t('ca.callbackFailed'), failed: t('ca.loginFailed')},
      success: () => {
        setCallback('');
        notify.ok(latest.current.t('ca.loginSuccess'));
        void latest.current.onSuccess();
      }});
  }
  useEffect(() => {
    if (!open) return;
    setCallback(''); setValidation(''); setNow(Date.now());
    flow.current!.open();
    return () => flow.current!.close();
  }, [open]);
  useEffect(() => {
    if (!open || !state.login || state.phase === 'success' || state.phase === 'failed') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, state.login, state.phase]);

  const start = () => {setCallback(''); setValidation(''); void flow.current!.start();};
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const issue = callbackIssue(callback);
    if (issue) {setValidation(t(issue === 'missing' ? 'ca.callbackMissing' : 'ca.callbackInvalid')); return;}
    setValidation('');
    void flow.current!.submit(callback);
  };
  const remaining = Math.max(0, Math.ceil(((state.login?.expires_at ?? 0) * 1000 - now) / 1000));
  const time = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  const working = ['starting', 'submitting', 'exchanging'].includes(state.phase);
  const hasLink = !!state.login && ['waiting', 'submitting', 'exchanging'].includes(state.phase);
  const step = state.phase === 'success' || ['submitting', 'exchanging'].includes(state.phase) || !!callback.trim()
    ? 3 : hasLink ? 2 : 1;
  const error = validation || state.error;
  const changeOpen = (value: boolean) => {
    if (!value) flow.current!.close();
    onOpenChange(value);
  };

  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogContent className="w-[calc(100vw-2rem)] min-w-0 max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto]">
      <DialogHeader className="min-w-0 border-b border-border/50 px-4 py-5 pr-12 sm:px-6">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground"><ShieldCheck className="size-4" />Huawei CodeArts</div>
        <DialogTitle className="text-xl">{t('ca.add')}</DialogTitle>
        <DialogDescription className="max-w-lg leading-5">{t('ca.loginDescription')}</DialogDescription>
      </DialogHeader>
      {/* Native scrolling avoids ScrollArea's display:table min-content width.
          Fixed field sizing keeps long OAuth URLs from sizing the dialog. */}
      <div className="min-h-0 min-w-0 w-full max-w-full overflow-x-hidden overflow-y-auto">
        <div className="min-w-0 w-full space-y-5 px-4 py-5 sm:px-6">
          <ol aria-label={t('ca.loginSteps')} className="grid min-w-0 grid-cols-3 gap-2">
            {[t('ca.flowGenerate'), t('ca.flowAuthorize'), t('ca.flowSubmit')].map((label, index) => <li key={label}
              aria-current={step === index + 1 ? 'step' : undefined}
              className={cn('flex min-w-0 items-center gap-1.5 rounded-xl border px-2 py-3 text-[11px] sm:gap-2 sm:px-3 sm:text-xs',
                step === index + 1 ? 'border-primary/30 bg-primary/5 text-foreground' : 'border-border/60 text-muted-foreground')}>
              <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                step >= index + 1 ? 'bg-primary text-primary-foreground' : 'bg-muted')}>
                {state.phase === 'success' || step > index + 1 ? <Check className="size-3.5" /> : index + 1}
              </span><span className="min-w-0 break-words">{label}</span>
            </li>)}
          </ol>
          {state.phase === 'success' ? <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 px-5 py-8 text-center" role="status">
            <CheckCircle2 className="mx-auto mb-4 size-10 text-emerald-600 dark:text-emerald-400" />
            <p className="text-base font-semibold">{t('ca.loginSuccess')}</p>
            <p className="mx-auto mt-2 max-w-sm text-xs leading-6 text-muted-foreground">{t('ca.loginSuccessHint')}</p>
            <Button variant="outline" className="mt-5 rounded-full" onClick={start}><PlusIcon />{t('ca.addAnother')}</Button>
          </div> : <>
            <div className="flex min-w-0 gap-3 rounded-xl bg-muted/60 px-4 py-3 text-xs leading-5 text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0" /><p className="min-w-0 break-words">{t('ca.incognitoHint')}</p>
            </div>
            {['idle', 'starting'].includes(state.phase) && <div className="rounded-2xl border border-dashed px-5 py-7 text-center">
              <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-2xl bg-muted"><Link2 className="size-5" /></div>
              <p className="text-sm font-medium">{t('ca.readyTitle')}</p>
              <p className="mx-auto mt-2 max-w-sm text-xs leading-6 text-muted-foreground">{t('ca.readyHint')}</p>
              <Button className="mt-5 rounded-full px-5" disabled={working} onClick={start}>
                {working ? <Loader2 className="animate-spin" /> : <ArrowRight />}{t(working ? 'ca.generating' : 'ca.start')}
              </Button>
            </div>}
            {hasLink && state.login && <>
              <section className="min-w-0 w-full rounded-2xl border border-border/70 p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{t('ca.authorizeTitle')}</p>
                  {state.phase === 'waiting' && <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] tabular-nums',
                    remaining < 60 ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400' : 'bg-muted text-muted-foreground')}>
                    <Clock3 className="size-3" />{t('ca.linkExpires', {time})}
                  </span>}
                </div>
                <p className="text-xs leading-5 text-muted-foreground">{t('ca.stepLogin')}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button asChild variant="default" size="sm" className="rounded-full"><a href={state.login.login_url} target="_blank" rel="noopener noreferrer"><ExternalLink />{t('ca.openLogin')}</a></Button>
                  <CopyButton value={state.login.login_url} label={t('ca.copyLogin')} showLabel size="sm" variant="outline" className="rounded-full" />
                </div>
                <details className="mt-3 min-w-0 max-w-full text-[11px] text-muted-foreground"><summary className="w-fit max-w-full cursor-pointer py-1">{t('ca.showLoginLink')}</summary>
                  <textarea readOnly aria-label={t('ca.copyLogin')} value={state.login.login_url} rows={3} wrap="soft" spellCheck={false}
                    style={{fieldSizing: 'fixed'}}
                    className="mt-2 h-24 min-w-0 w-full max-w-full resize-none overflow-x-hidden overflow-y-auto rounded-lg border bg-muted/50 p-2 font-mono text-[11px] leading-5 [overflow-wrap:anywhere]" onFocus={(e) => e.currentTarget.select()} />
                </details>
              </section>
              <form onSubmit={submit} className="min-w-0 w-full max-w-full space-y-3 rounded-2xl border border-border/70 p-4">
                <Label htmlFor="ca-callback" className="text-sm font-semibold">{t('ca.callbackTitle')}</Label>
                <p id="ca-callback-hint" className="text-xs leading-6 text-muted-foreground">{t('ca.stepCallback')}</p>
                <Textarea id="ca-callback" rows={3} wrap="soft" maxLength={8192} value={callback} disabled={state.phase !== 'waiting'}
                  aria-describedby="ca-callback-hint" aria-invalid={!!validation} autoComplete="off" spellCheck={false}
                  style={{fieldSizing: 'fixed'}}
                  onChange={(e) => {setCallback(e.target.value); setValidation('');}} placeholder={t('ca.callbackPlaceholder')}
                  className="h-28 min-w-0 w-full max-w-full resize-none overflow-x-hidden overflow-y-auto bg-muted/40 font-mono text-xs leading-6 [overflow-wrap:anywhere]" />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground" role="status">
                    <Loader2 className="size-3 shrink-0 animate-spin" /><span className="min-w-0 break-words">{t(state.phase === 'exchanging' || state.phase === 'submitting' ? 'ca.callbackAccepted' : 'ca.waiting')}</span>
                  </span>
                  <Button type="submit" disabled={state.phase !== 'waiting' || !callback.trim()} size="sm" className="rounded-full">
                    {state.phase === 'submitting' ? <Loader2 className="animate-spin" /> : <ArrowRight />}{t('ca.submitCallback')}
                  </Button>
                </div>
              </form>
            </>}
            {error && <div role="alert" className="min-w-0 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs leading-6 text-destructive [overflow-wrap:anywhere]">{error}</div>}
            {state.phase === 'failed' && <Button variant="outline" className="rounded-full" onClick={start}><RefreshCw />{t('ca.retry')}</Button>}
          </>}
        </div>
      </div>
      <DialogFooter className="min-w-0 flex-wrap items-center justify-between border-t border-border/50 px-4 sm:px-6">
        <p className="min-w-0 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{t('ca.loginPrivacy')}</p>
        <Button variant={state.phase === 'success' ? 'default' : 'outline'} className="shrink-0 rounded-full" onClick={() => changeOpen(false)}>{t('common.close')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function PlusIcon() {return <ArrowRight className="size-4" />;}
