'use client';

import {usePlatform} from '@/lib/platform-context';
import {useT} from '@/lib/i18n/provider';
import {Button} from '@/components/ui/button';
import {PageHeader} from './PageHeader';

export function WbOnlyNotice({title}: {title: string}) {
  const t = useT();
  const {setPlatform} = usePlatform();
  return <div className="space-y-4">
    <PageHeader title={title} description={t('ca.wbFeature')} />
    <Button variant="outline" onClick={() => setPlatform('wb')}>{t('platform.wb')}</Button>
  </div>;
}
