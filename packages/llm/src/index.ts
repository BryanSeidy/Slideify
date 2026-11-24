import type { LLMResponse } from '@slideify/shared';

export type { Slide, LLMResponse, GenerationJob } from '@slideify/shared';

export interface LLMProvider {
  generate(
    sourceText: string,
    options?: { signal?: AbortSignal },
  ): Promise<LLMResponse>;
}

export interface LLMConfig {
  apiKey: string;
  model: string;
  siteUrl?: string;
  siteName?: string;
}

export { createLLMProvider } from './factory';
export { MockProvider, InvalidJSONResponseError } from './providers';