import { LLMProvider } from './index';
import { config } from '@slideify/config';
import { MockProvider } from './providers';
import { OpenRouterProvider } from './providers';

export function createLLMProvider(): LLMProvider {
  const llmConfig = config.llm;

  if (llmConfig.mock || !llmConfig.apiKey) {
    return new MockProvider();
  }

  return new OpenRouterProvider(
    llmConfig.apiKey,
    llmConfig.model,
    llmConfig.siteUrl,
    llmConfig.siteName
  );
}