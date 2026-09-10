import { useState } from 'react';

import SessionWorkspace from '../../web-v2/src/SessionWorkspace.jsx';

export default function SessionWorkspaceHarness({ onSidebarFocus = () => {} }) {
  const session = {
    id: 'workspace-test',
    type: 'misc',
    status: 'paused',
    closeable: false,
    name: 'Workspace test',
    branch: 'workspace-test',
    path: '/tmp/workspace-test',
    agent: 'claude',
    issues: [],
    notesPath: null,
  };
  const [focusedPanel, setFocusedPanel] = useState('workspace-local-workspace-test-shell');
  return (
    <SessionWorkspace
      session={session}
      target={{ id: 'local', name: 'Local' }}
      visible
      focusedPanel={focusedPanel}
      onPanelFocus={setFocusedPanel}
      onDetails={() => {}}
      onArchive={() => {}}
      onClose={() => {}}
      onAgentChange={() => {}}
      onReset={() => {}}
      panelMode="two"
      onPanelModeChange={() => {}}
      onOpenNotes={() => {}}
      terminalMode="dark"
      fontFamily="monospace"
      onSidebarFocus={onSidebarFocus}
      onFullscreenChange={() => {}}
      fullscreenExitRevision={0}
      onToggleSidebar={() => {}}
      onNewTerminal={() => {}}
    />
  );
}
