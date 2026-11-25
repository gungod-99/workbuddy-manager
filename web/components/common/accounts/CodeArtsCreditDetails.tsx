'use client';

import {Coins} from 'lucide-react';
import type {CodeArtsCreditAccount} from '@/lib/types';
import {fmtDateTime, fmtNumber} from '@/lib/format';
import {useT} from '@/lib/i18n/provider';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/ui/badge';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/animate-ui/radix/dialog';

export function CodeArtsCreditDetails({account, onClose}: {account: CodeArtsCreditAccount | null; onClose: () => void}) {
  const t = useT();
  const balance = account?.balance;
  const amount = (value: number | null) => value == null ? '—' : fmtNumber(value);
  return <Dialog open={!!account} onOpenChange={(open) => {if (!open) onClose();}}>
    <DialogContent className="max-w-xl">
      <DialogHeader><DialogTitle>{t('ca.creditDetails')}</DialogTitle><DialogDescription>{account?.nickname}</DialogDescription></DialogHeader>
      <DialogBody className="max-h-[calc(100dvh-12rem)]"><div className="space-y-4 px-6 pb-5">
        {account?.error && <p role="alert" className="rounded-xl bg-destructive/5 p-3 text-xs leading-6 text-destructive">{account.error}</p>}
        <div className="flex items-center justify-between rounded-2xl bg-muted/50 p-4"><span className="flex items-center gap-2 text-sm text-muted-foreground"><Coins className="size-4" />{t('ca.balance')}</span>
          <span className="text-2xl font-semibold tabular-nums">{amount(balance?.total ?? null)}</span></div>
        {balance?.packages.map((pack, index) => <div key={`${pack.name}-${index}`} className="rounded-2xl border p-4">
          <div className="flex items-center justify-between gap-3"><div className="text-sm font-medium">{pack.name}</div>
            <Badge variant="secondary" className="rounded-full text-[10px]">{t(pack.active ? 'ca.packageActive' : 'ca.packageExpired')}</Badge></div>
          <div className="mt-3 grid grid-cols-3 gap-3 text-xs"><div><p className="text-muted-foreground">{t('ca.packageRemaining')}</p><p className="mt-1.5 font-semibold tabular-nums">{amount(pack.remaining)}</p></div>
            <div><p className="text-muted-foreground">{t('ca.packageUsed')}</p><p className="mt-1.5 tabular-nums">{amount(pack.used)}</p></div>
            <div><p className="text-muted-foreground">{t('ca.packageTotal')}</p><p className="mt-1.5 tabular-nums">{amount(pack.total)}</p></div></div>
          <p className="mt-3 text-[11px] leading-5 text-muted-foreground">{t('ca.packageExpiry')}: {pack.expires_at ? fmtDateTime(pack.expires_at) : t('ca.expiryNotProvided')}</p>
          {pack.expiring_remaining != null && pack.expiring_remaining > 0 && <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">{t('ca.expiringCredits', {n: fmtNumber(pack.expiring_remaining)})}</p>}
          {pack.expiry_note && <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{pack.expiry_note}</p>}
        </div>)}
      </div></DialogBody>
      <DialogFooter><Button variant="outline" className="rounded-full" onClick={onClose}>{t('common.close')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
