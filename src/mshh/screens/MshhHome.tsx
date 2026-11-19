import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useOutlet } from 'react-router-dom';
import { Box, toRem } from 'folds';
import { PageRoot } from '../../app/components/page';
import { ScreenSize, useScreenSizeContext } from '../../app/hooks/useScreenSize';
import { ContainerColor } from '../../app/styles/ContainerColor.css';
import { getMshhPath } from '../../app/pages/pathUtils';
import { MshhChatsNav } from './MshhChatsNav';
import { MshhEmpty } from '../components/EmptyState';
import { Splitter } from '../components/Splitter';

/** Nav column width is persisted under this localStorage key. */
const NAV_WIDTH_KEY = 'mshh_nav_width';
const NAV_WIDTH_MIN = 240;
const NAV_WIDTH_DEFAULT = 300;

const navMaxWidth = (): number => Math.max(NAV_WIDTH_MIN, Math.floor(window.innerWidth / 2));

const clampNavWidth = (width: number): number =>
  Math.min(navMaxWidth(), Math.max(NAV_WIDTH_MIN, Math.round(width)));

const readNavWidth = (): number => {
  const parsed = Number(localStorage.getItem(NAV_WIDTH_KEY));
  return Number.isFinite(parsed) && parsed > 0 ? clampNavWidth(parsed) : NAV_WIDTH_DEFAULT;
};

/**
 * «Чаты» home: the chat list stays visible on the left; the open chat (or the
 * empty placeholder) renders in the right pane. Column width is draggable and
 * persisted.
 */
export function MshhHome() {
  const outlet = useOutlet();
  const location = useLocation();
  const screenSize = useScreenSizeContext();
  const isMobile = screenSize === ScreenSize.Mobile;
  const [navWidth, setNavWidth] = useState(readNavWidth);
  // index route renders the placeholder; only /mshh/chat/... is an open chat
  const chatOpen = location.pathname.startsWith(`${getMshhPath()}/chat/`);

  // Keep the column inside min/max when the viewport shrinks.
  useEffect(() => {
    const onResize = () => setNavWidth(clampNavWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const commitNavWidth = useCallback((width: number) => {
    try {
      localStorage.setItem(NAV_WIDTH_KEY, String(width));
    } catch {
      /* ignore */
    }
  }, []);

  if (isMobile) {
    // No side-by-side panes on phones: an open chat fills the screen.
    if (chatOpen) return outlet;
    return (
      <PageRoot nav={<MshhChatsNav />}>
        <MshhEmpty />
      </PageRoot>
    );
  }

  return (
    <Box grow="Yes" className={ContainerColor({ variant: 'Background' })}>
      <Box shrink="No" direction="Column" style={{ width: toRem(navWidth) }}>
        <MshhChatsNav />
      </Box>
      <Splitter
        label="Ширина списка чатов"
        width={navWidth}
        min={NAV_WIDTH_MIN}
        max={navMaxWidth()}
        onResize={setNavWidth}
        onCommit={commitNavWidth}
      />
      <Box grow="Yes" direction="Column" style={{ minWidth: 0 }}>
        {outlet}
      </Box>
    </Box>
  );
}
