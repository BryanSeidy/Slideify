import { Controller, Post, Body, Get, Param, UseGuards, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { GenerationService } from './generation.service';
import { GenerationInput, countWords, LLMResponseSchema } from '@slideify/shared';
import { z } from 'zod';

@ApiTags('generations')
@Controller('generations')
export class GenerationController {
  constructor(private readonly generationService: GenerationService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a new generation' })
  @ApiResponse({ status: 201, description: 'Generation created and queued' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Generation already in progress' })
  @ApiResponse({ status: 402, description: 'No credits' })
  async create(
    @Body() body: { sourceText: string },
    @Req() req: { user: { userId: string } },
  ) {
    // Validation mot-based (même fonction que le front, côté serveur)
    const wordCount = countWords(body.sourceText);
    if (wordCount < 80) {
      return {
        statusCode: 400,
        message: `Texte trop court — minimum 80 mots. Vous manquez de ${80 - wordCount} mot(s).`,
        error: 'INPUT_TOO_SHORT',
      };
    }
    if (wordCount > 3000) {
      return {
        statusCode: 400,
        message: `Texte trop long — maximum 3000 mots. Vous en avez ${wordCount - 3000} de trop.`,
        error: 'INPUT_TOO_LONG',
      };
    }

    // Vérifier qu'il n'y a pas déjà de génération en cours pour cet utilisateur
    const hasInProgress = await this.generationService.hasInProgress(req.user.userId);
    if (hasInProgress) {
      return {
        statusCode: 403,
        message: 'Une génération est déjà en cours.',
        error: 'GENERATION_IN_PROGRESS',
      };
    }

    // Vérifier le solde de crédits
    const hasCredits = await this.generationService.hasCredits(req.user.userId);
    if (!hasCredits) {
      return {
        statusCode: 402,
        message: 'Vous n'avez plus de crédits disponibles.',
        error: 'NO_CREDITS',
      };
    }

    // Création de la génération (passera en QUEUED via le worker)
    await this.generationService.create(req.user.userId, body.sourceText);

    return {
      status: 'QUEUED',
      generationId: '',
    };
  }

  @Get(':id/status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get generation status' })
  @ApiResponse({ status: 200, description: 'Generation status retrieved' })
  @ApiResponse({ status: 404, description: 'Generation not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getStatus(
    @Param('id') id: string,
    @Req() req: { user: { userId: string } },
  ) {
    return this.generationService.getStatus(id, req.user.userId);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get user generations history' })
  @ApiResponse({ status: 200, description: 'User generations history' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async history(@Req() req: { user: { userId: string } }) {
    return this.generationService.history(req.user.userId);
  }
}