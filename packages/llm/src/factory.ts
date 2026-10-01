import { LLMProvider } from './index';
import { config } from '@slideify/config';
import { MockProvider } from './providers';

export function createLLMProvider(): LLMProvider {
  const llmConfig = config.llm;

  if (llmConfig.mock || !llmConfig.apiKey) {
    return new MockProvider();
  }

  // Provider réel non disponible : retour Mock en développement.
  // En production, l'appelant doit gérer le cas d'absence de clé.
  return new MockProvider();
}