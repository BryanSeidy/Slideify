import { Controller, Get, Post, Body, UseGuards, HttpCode, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('magic-link')
  @HttpCode(202)
  async sendMagicLink(@Body('email') email: string) {
    const result = await this.authService.authenticateWithMagicLink(email);
    return { message: 'Lien envoyé', userId: result.userId };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'User info retrieved successfully' })
  async getMe(@Req() req: { user: { userId: string; email: string; credits: number } }) {
    const { userId, email, credits } = req.user;
    return { userId, email, credits };
  }
}