import { forwardRef, useState } from 'react';

import BottomTabs from '../../web-v2/src/BottomTabs.jsx';

// Mirrors how App.jsx owns focusedPanel/onPanelFocus for BottomTabs, so tests
// exercise the same focus feedback loop the real app relies on.
const BottomTabsHarness = forwardRef(function BottomTabsHarness({
  onSidebarFocus = () => false, onToggleSidebar = () => {},
  onFocusedPanelChange, onSessionsChange,
}, ref) {
  const [focusedPanel, setFocusedPanel] = useState(null);
  return (
    <BottomTabs
      ref={ref}
      focusedPanel={focusedPanel}
      onPanelFocus={(panel) => {
        setFocusedPanel(panel);
        onFocusedPanelChange?.(panel);
      }}
      onSidebarFocus={() => {
        setFocusedPanel('sidebar-local-sessions');
        onFocusedPanelChange?.('sidebar-local-sessions');
        return onSidebarFocus();
      }}
      onSessionsChange={onSessionsChange}
      onToggleSidebar={onToggleSidebar}
    />
  );
});

export default BottomTabsHarness;
