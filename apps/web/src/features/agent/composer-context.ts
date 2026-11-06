import { createContext, useContext } from 'react';

/** Lets a card (refusal suggestion chip) put text into the chat composer. */
export interface ComposerApi {
  prefill(text: string): void;
}

export const ComposerContext = createContext<ComposerApi | null>(null);

export function useComposer(): ComposerApi | null {
  return useContext(ComposerContext);
}
