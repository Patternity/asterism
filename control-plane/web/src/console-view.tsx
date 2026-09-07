import { createContext, useContext } from 'react';

export type ConsoleView = 'classic' | 'conversation';

export const CONSOLE_VIEW_STORAGE_KEY = 'asterism-console-view';

export interface ConsoleViewContextValue {
  view: ConsoleView;
  setView: (view: ConsoleView) => void;
}

export const ConsoleViewContext = createContext<ConsoleViewContextValue>({
  view: 'classic',
  setView: () => undefined,
});

export function storedConsoleView(): ConsoleView {
  return globalThis.localStorage?.getItem(CONSOLE_VIEW_STORAGE_KEY) === 'conversation'
    ? 'conversation'
    : 'classic';
}

export function useConsoleView() {
  return useContext(ConsoleViewContext);
}
