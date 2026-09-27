import { Controller, Get, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { GenerationService } from './generation/generation.service';
import { CreditsService } from './credits/credits.service';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('generations')
@Controller('generations')
export class GenerationController {
  constructor(
    private readonly generationService: GenerationService,
    private readonly creditsService: CreditsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  async create(@Body() body: { sourceText: string; userId: string }) {
    const { sourceText, userId } = body;

    // Check credits
    const credits = await this.creditsService.getBalance(userId);
    if (credits <= 0) {
      return { error: 'NO_CREDITS', requiresPurchase: true };
    }

    // Create generation record
    const generation = await this.prisma.generation.create({
      data: { userId, sourceText, status: 'QUEUED' },
    });

    return { generationId: generation.id };
  }

  @Get(':id/status')
  async getStatus(@Body('id') id: string) {
    const gen = await this.prisma.generation.findUnique({
      where: { id },
    });
    return {
      id: gen?.id,
      status: gen?.status,
      slideCount: gen?.slideCount,
      error: gen?.error,
    };
  }

  @Get()
  async history(@Body('userId') userId: string) {
    const generations = await this.prisma.generation.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { outputs: true },
    });
    return generations;
  }
}