import type { Slide, LLMResponse } from '@slideify/shared';
import type { LLMProvider } from './index';

// Marqueurs de test (uniquement actifs en développement, jamais en production)
const MARKER_TIMEOUT = '__MOCK_TIMEOUT__';
const MARKER_INVALID_JSON = '__MOCK_INVALID_JSON__';
const MARKER_SCHEMA_INVALID = '__MOCK_SCHEMA_INVALID__';

/**
 * Erreur dédiée à une réponse non parsable. Le worker fait exactement un
 * retry silencieux pour cette classe, sans jamais la confondre avec une
 * erreur technique transitoire (BullMQ). Le vrai retry JSON arrive en M008-IA.
 */
export class InvalidJSONResponseError extends Error {
  constructor(message = 'Invalid JSON response') {
    super(message);
    this.name = 'InvalidJSONResponseError';
  }
}

export class MockProvider implements LLMProvider {
  async generate(
    sourceText: string,
    options?: { signal?: AbortSignal },
  ): Promise<LLMResponse> {
    const signal = options?.signal;

    // Simuler un fournisseur qui ne résout jamais, pour tester l'AbortSignal.
    if (process.env.NODE_ENV !== 'production' && sourceText.includes('__MOCK_NEVER_RESOLVES__')) {
      return new Promise<LLMResponse>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('TIMEOUT'));
          return;
        }
        signal?.addEventListener(
          'abort',
          () => reject(new Error('TIMEOUT')),
          { once: true },
        );
      });
    }

    // Simuler un timeout si le marqueur est présent
    if (process.env.NODE_ENV !== 'production' && sourceText.includes(MARKER_TIMEOUT)) {
      throw new Error('Simulated timeout');
    }

    // Générer des slides aléatoires basées sur la longueur du texte
    const words = sourceText.trim().split(/\s+/).filter(Boolean);
    const targetSlides = Math.min(
      Math.max(5, Math.floor(words.length / 50)), // environ 50 mots par slide
      10
    );

    const slides: Slide[] = [];
    const chunkSize = Math.ceil(words.length / targetSlides);

    for (let i = 0; i < targetSlides; i++) {
      const start = i * chunkSize;
      const end = start + chunkSize;
      const chunkWords = words.slice(start, end);
      const text = chunkWords.join(' ').trim() || 'Point important à retenir';

      slides.push({
        order: i + 1,
        title: text.length > 30 ? text.substring(0, 57) + '...' : text,
        body: text.length > 100 ? text.substring(0, 217) + '...' : text,
      });
    }

    // S'assurer d'avoir au minimum 5 slides
    while (slides.length < 5) {
      slides.push({
        order: slides.length + 1,
        title: 'Point important à retenir',
        body: 'Résumé automatique du contenu fourni.',
      });
    }

    const result: LLMResponse = {
      slides,
      meta: {
        slide_count: slides.length,
        source_language: /[àâäéèêëïîôùûüÿç]/i.test(sourceText) ? 'fr' : 'en',
      },
    };

    // Injecter du JSON invalide simulé si le marqueur est présent
    if (process.env.NODE_ENV !== 'production' && sourceText.includes(MARKER_INVALID_JSON)) {
      // Ne pas retourner le résultat réel ; lever une erreur comme si le JSON était invalide
      throw new InvalidJSONResponseError('Invalid JSON simulated');
    }

    // Injecter une réponse qui échouera la validation du schéma si le marqueur est présent
    if (process.env.NODE_ENV !== 'production' && sourceText.includes(MARKER_SCHEMA_INVALID)) {
      // Modifier le résultat pour avoir un nombre de slides invalide
      result.slides = result.slides.slice(0, 4); // 4 slides seulement → échec du min(5)
      result.meta.slide_count = 4;
    }

    return result;
  }
}