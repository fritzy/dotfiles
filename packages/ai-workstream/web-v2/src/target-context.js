import { createContext, useContext } from 'react';

// The daemon a given DaemonPane subtree talks to: null/{ url: null } for the
// local daemon (same-origin), or a { id, name, url } entry from /daemons.
const TargetContext = createContext(null);

export const TargetProvider = TargetContext.Provider;

export function useTarget() {
  return useContext(TargetContext);
}
