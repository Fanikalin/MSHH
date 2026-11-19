import React from 'react';
import { useOutlet } from 'react-router-dom';
import { PageRoot } from '../../app/components/page';
import { WelcomePage } from '../../app/pages/client/WelcomePage';
import { MshhChatsNav } from './MshhChatsNav';

/**
 * «Чаты» home: unified chat list in the nav column; without an open chat the
 * content column reuses Cinny's welcome placeholder.
 */
export function MshhHome() {
  const outlet = useOutlet();

  return <PageRoot nav={<MshhChatsNav />}>{outlet ?? <WelcomePage />}</PageRoot>;
}
