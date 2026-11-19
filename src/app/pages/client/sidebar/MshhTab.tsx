import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icon, Icons } from 'folds';

import { SidebarAvatar, SidebarItem, SidebarItemTooltip } from '../../../components/sidebar';
import { getMshhPath } from '../../pathUtils';

// MSHH: top-level tab that leads to the unified profiles & chats surface.
// Added beside the existing Cinny tabs; no existing behavior is replaced.
export function MshhTab() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <SidebarItem active={location.pathname.startsWith(getMshhPath())}>
      <SidebarItemTooltip tooltip="MSHH — все чаты и профили">
        {(triggerRef) => (
          <SidebarAvatar
            as="button"
            ref={triggerRef}
            outlined
            onClick={() => navigate(getMshhPath())}
          >
            <Icon src={Icons.Message} size="400" />
          </SidebarAvatar>
        )}
      </SidebarItemTooltip>
    </SidebarItem>
  );
}
