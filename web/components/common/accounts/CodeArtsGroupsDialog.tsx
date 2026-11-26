'use client';

import {useRef, useState} from 'react';
import {FolderPlus, Loader2, Pencil, Trash2} from 'lucide-react';
import {codeartsApi, errText} from '@/lib/api';
import type {CodeArtsGroup} from '@/lib/types';
import {notify} from '@/lib/toast';
import {useT} from '@/lib/i18n/provider';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {ConfirmDialog} from '@/components/common/layout/ConfirmDialog';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/animate-ui/radix/dialog';

export function CodeArtsGroupsDialog({open, onOpenChange, groups, onSaved}: {
  open: boolean; onOpenChange: (open: boolean) => void; groups: CodeArtsGroup[]; onSaved: () => Promise<boolean>;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const save = async () => {
    if (lock.current || !name.trim()) return;
    lock.current = true; setBusy(true);
    try {
      if (editing == null) await codeartsApi.createGroup(name.trim());
      else await codeartsApi.renameGroup(editing, name.trim());
      setEditing(null); setName(''); await onSaved(); notify.ok(t('ca.saved'));
    } catch (error) {notify.err(errText(error));}
    finally {lock.current = false; setBusy(false);}
  };
  return <Dialog open={open} onOpenChange={(value) => {
    if (!busy) {onOpenChange(value); setEditing(null); setName('');}
  }}>
    <DialogContent className="max-w-xl">
      <DialogHeader><DialogTitle>{t('ca.groups.manage')}</DialogTitle>
        <DialogDescription>{t('ca.groups.description')}</DialogDescription></DialogHeader>
      <DialogBody><div className="space-y-4 p-5">
        <form className="flex min-w-0 gap-2" onSubmit={(event) => {event.preventDefault(); void save();}}>
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={64}
            aria-label={t('ca.groups.name')} placeholder={t('ca.groups.name')} disabled={busy} className="min-w-0" />
          <Button type="submit" disabled={busy || !name.trim()} className="shrink-0 rounded-full">
            {busy ? <Loader2 className="animate-spin" /> : <FolderPlus />}{t(editing == null ? 'ca.groups.create' : 'common.save')}
          </Button>
          {editing != null && <Button type="button" variant="ghost" disabled={busy} onClick={() => {setEditing(null); setName('');}}>{t('common.cancel')}</Button>}
        </form>
        <div className="space-y-2">
          {groups.map((group) => <div key={group.id} className="flex min-w-0 items-center gap-3 rounded-xl border p-3">
            <div className="min-w-0 flex-1"><div className="truncate font-medium" title={group.name}>{group.name}</div>
              <p className="mt-1 text-xs text-muted-foreground">{t('ca.groups.counts', {accounts: group.account_count, keys: group.key_count})}</p></div>
            <Button size="icon" variant="ghost" className="size-8 shrink-0 rounded-full" disabled={busy} aria-label={t('ca.groups.rename')}
              onClick={() => {setEditing(group.id); setName(group.name);}}><Pencil /></Button>
            <ConfirmDialog title={t('ca.groups.deleteTitle')} description={t('ca.groups.deleteHint', {name: group.name})} destructive
              trigger={<Button size="icon" variant="ghost" disabled={busy || group.account_count > 0 || group.key_count > 0}
                title={t('ca.groups.deleteGuard')} aria-label={t('common.delete')} className="size-8 shrink-0 rounded-full"><Trash2 /></Button>}
              onConfirm={async () => {await codeartsApi.deleteGroup(group.id); await onSaved();}} />
          </div>)}
          {!groups.length && <p className="py-5 text-center text-sm text-muted-foreground">{t('ca.groups.empty')}</p>}
        </div>
      </div></DialogBody>
      <DialogFooter><Button variant="outline" disabled={busy} className="rounded-full" onClick={() => onOpenChange(false)}>{t('common.close')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
