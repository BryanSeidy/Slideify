import type { LLMProvider } from './index';
import { config } from '@slideify/config';
import { MockProvider } from './providers';

export function createLLMProvider(): LLMProvider {
  const llmConfig = config.llm;

  if (llmConfig.provider === 'mock') {
    return new MockProvider();
  }

  // Aucun provider payant n'est implémenté dans le MVP : refuser un
  // démarrage silencieux en mode réel plutôt que de retomber sur le mock.
  throw new Error(
    'AI_PROVIDER=openrouter n\'est pas disponible dans le MVP (M008-IA). Utilisez AI_PROVIDER=mock.',
  );
}
