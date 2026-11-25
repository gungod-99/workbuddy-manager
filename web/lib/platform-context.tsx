'use client';

import {createContext, useCallback, useContext, useEffect, useMemo, useState} from 'react';
import type {Platform} from './types';
import {useRealm} from './realm-context';

export type UsageRealm = 'cn' | 'global' | 'ca';

const Context = createContext<{platform: Platform; setPlatform: (value: Platform) => void} | null>(null);

export function PlatformProvider({children}: {children: React.ReactNode}) {
  const [platform, update] = useState<Platform>('wb');
  useEffect(() => {
    try {
      if (localStorage.getItem('wb.platform') === 'ca') update('ca');
    } catch { /* Use WB when browser storage is unavailable. */ }
  }, []);
  const setPlatform = useCallback((value: Platform) => {
    update(value);
    try { localStorage.setItem('wb.platform', value); } catch { /* Session selection still works. */ }
  }, []);
  const value = useMemo(() => ({platform, setPlatform}), [platform, setPlatform]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function usePlatform() {
  const value = useContext(Context);
  if (!value) throw new Error('usePlatform requires PlatformProvider');
  return value;
}

export function useUsageScope(): {realm: UsageRealm; label: string; platform: Platform} {
  const {platform} = usePlatform();
  const {realm, label} = useRealm();
  return {platform, realm: platform === 'ca' ? 'ca' : realm,
    label: platform === 'ca' ? 'CA · CodeArts' : label};
}
