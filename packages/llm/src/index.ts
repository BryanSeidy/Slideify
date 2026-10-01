import { LLMProvider } from './index';
export { createLLMProvider } from './factory';
export { MockProvider } from './providers';
export { OpenRouterProvider } from './providers';

export interface LLMProvider {
  generate(sourceText: string): Promise<LLMResponse>;
}

export interface LLMConfig {
  apiKey: string;
  model: string;
  siteUrl?: string;
  siteName?: string;
}

export type { Slide, LLMResponse, GenerationJob };