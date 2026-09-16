import { createContext, useContext } from 'react';

const MarkdownWatchContext = createContext(null);

export const MarkdownWatchProvider = MarkdownWatchContext.Provider;

export function useMarkdownWatch() {
  return useContext(MarkdownWatchContext);
}
