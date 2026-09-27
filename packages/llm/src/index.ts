import { Slide, LLMResponse, GenerationJob } from '@slideify/shared';

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