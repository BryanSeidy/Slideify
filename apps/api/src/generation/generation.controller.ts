import { Controller, Post, Body, Get, Param, UseGuards, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { GenerationService } from './generation/generation.service';
import { GenerationInput } from '@slideify/shared';
import { z } from 'zod';

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
  async create(
    @Body() body: { sourceText: string },
    @Req() req: { user: { userId: string } },
  ) {
    const validated = GenerationInput.parse(body);
    return this.generationService.create(req.user.userId, validated.sourceText);
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