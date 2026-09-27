import { Controller, Get, Post, Body, UseGuards, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AuthService } from './auth/auth.service';
import { GenerationService } from './generation/generation.service';
import { CreditsService } from './credits/credits.service';
import { config } from '@slideify/config';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly creditsService: CreditsService,
  ) {}

  @Post('magic-link')
  @HttpCode(202)
  async sendMagicLink(@Body('email') email: string) {
    const result = await this.authService.authenticateWithMagicLink(email);
    return { message: 'Lien envoyé', userId: result.userId };
  }

  @Get('me')
  async getMe(@Body('userId') userId: string) {
    const credits = await this.creditsService.getBalance(userId);
    return { credits };
  }
}