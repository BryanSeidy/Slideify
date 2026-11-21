import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { GenerationService } from './generation.service';
import { countWords } from '@slideify/shared';
import {
  InputTooShortError,
  InputTooLongError,
  GenerationInProgressError,
  NoCreditsError,
} from '../common/errors/http-error';

@ApiTags('generations')
@Controller('generations')
export class GenerationController {
  constructor(private readonly generationService: GenerationService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new generation' })
  @ApiResponse({ status: 201, description: 'Generation created and queued' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 402, description: 'No credits' })
  @ApiResponse({ status: 409, description: 'Generation already in progress' })
  async create(
    @Body() body: { sourceText: string },
    @Req() req: { user: { userId: string } },
  ) {
    const sourceText = body.sourceText ?? '';
    const wordCount = countWords(sourceText);

    if (wordCount < 80) {
      throw new InputTooShortError(
        `Texte trop court — minimum 80 mots. Vous manquez de ${
          80 - wordCount
        } mot(s).`,
      );
    }
    if (wordCount > 3000) {
      throw new InputTooLongError(
        `Texte trop long — maximum 3000 mots. Vous en avez ${
          wordCount - 3000
        } de trop.`,
      );
    }

    // Le service vérifie hasInProgress et hasCredits dans un verrou sérialisé
    const { generationId, status } = await this.generationService.create(
      req.user.userId,
      sourceText,
    );

    return {
      status,
      generationId,
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
