import { Slide, LLMResponse } from '@slideify/shared';
import { config } from '@slideify/config';

export class MockProvider implements LLMProvider {
  async generate(sourceText: string): Promise<LLMResponse> {
    // Generate random slides based on source text length
    const words = sourceText.trim().split(/\s+/).filter(Boolean);
    const targetSlides = Math.min(
      Math.max(5, Math.floor(words.length / 50)), // roughly 50 words per slide
      10
    );

    const slides: Slide[] = [];
    const chunkSize = Math.ceil(words.length / targetSlides);

    for (let i = 0; i < targetSlides; i++) {
      const start = i * chunkSize;
      const end = start + chunkSize;
      const chunkWords = words.slice(start, end);
      const text = chunkWords.join(' ');

      slides.push({
        order: i + 1,
        title: text.length > 30 ? text.substring(0, 57) + '...' : text,
        body: text.length > 100 ? text.substring(0, 217) + '...' : text,
      });
    }

    // Ensure we have at least 5 slides
    while (slides.length < 5) {
      slides.push({
        order: slides.length + 1,
        title: 'Point important à retenir',
        body: 'Résumé automatique du contenu fourni.',
      });
    }

    return {
      slides,
      meta: {
        slide_count: slides.length,
        source_language: /[àâäéèêëïîôùûüÿç]/i.test(sourceText) ? 'fr' : 'en',
      },
    };
  }
}

export class OpenRouterProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private siteUrl?: string;
  private siteName?: string;

  constructor(apiKey: string, model: string, siteUrl?: string, siteName?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.siteUrl = siteUrl;
    this.siteName = siteName;
  }

  async generate(sourceText: string): Promise<LLMResponse> {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'HTTP-Referer': this.siteUrl || '',
        'X-Title': this.siteName || 'Slideify',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: `
Tu es un assistant spécialisé dans la structuration de contenu pour carrousels
professionnels destinés à LinkedIn et Instagram.

À partir d'un texte source, tu dois produire une séquence de slides qui :
- capture les idées clés du texte, dans un ordre logique et progressif
- commence par une slide d'accroche (hook) qui donne envie de swiper
- termine par une slide de conclusion ou d'appel à l'action clair
- utilise un langage direct, concis, sans jargon inutile
- ne recopie jamais le texte source mot pour mot : reformule et condense

Contraintes strictes de format :
- Titre de slide : 60 caractères maximum
- Corps de slide : 220 caractères maximum
- Nombre de slides : entre 5 et 10
- Réponds UNIQUEMENT avec un objet JSON valide respectant exactement ce schéma,
  sans aucun texte, explication ou balise markdown autour :

{
  "slides": [{"order": number, "title": string, "body": string}],
  "meta": {"slide_count": number, "source_language": string}}
}`,
          },
          {
            role: 'user',
            content: `Texte source :
"""
${sourceText}
"""

Structure ce texte en carrousel selon les règles du système.`,
          },
        ],
        temperature: 0.3,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        `OpenRouter API error: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`
      );
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from OpenRouter');
    }

    let parsed: LLMResponse;

    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new Error(
        `Invalid JSON from OpenRouter: ${e.message}. Response: ${content.substring(
          0,
          200
        )}...`
      );
    }

    return parsed;
  }
}