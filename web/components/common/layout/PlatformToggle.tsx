'use client';

import {usePlatform} from '@/lib/platform-context';
import {useT} from '@/lib/i18n/provider';
import {cn} from '@/lib/utils';
import type {Platform} from '@/lib/types';
import {RealmToggle} from './RealmToggle';

export function PlatformToggle() {
  const {platform, setPlatform} = usePlatform();
  const t = useT();
  return <>
    <div role="tablist" aria-label={t('platform.select')}
      className="inline-flex gap-0.5 rounded-full border border-border/60 bg-muted/60 p-0.5">
      {(['wb', 'ca'] as Platform[]).map((value) => <button key={value} type="button"
        role="tab" aria-selected={platform === value} onClick={() => setPlatform(value)}
        className={cn('rounded-full px-3 py-1 text-[11px] font-medium transition-colors',
          platform === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
        {t(`platform.${value}`)}
      </button>)}
    </div>
    {platform === 'wb' && <RealmToggle />}
  </>;
}
