import { forwardRef, useState } from 'react';

import BottomTabs from '../../web-v2/src/BottomTabs.jsx';

// Mirrors how App.jsx owns focusedPanel/onPanelFocus for BottomTabs, so tests
// exercise the same feedback loop the real app relies on (e.g. the effect that
// hides the drawer once focusedPanel points somewhere else).
const BottomTabsHarness = forwardRef(function BottomTabsHarness({
  onSidebarFocus = () => false, onWorkspaceFocus = () => false, onToggleSidebar = () => {},
  onFocusedPanelChange,
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
      onSidebarFocus={onSidebarFocus}
      onWorkspaceFocus={onWorkspaceFocus}
      onToggleSidebar={onToggleSidebar}
    />
  );
});

export default BottomTabsHarness;
