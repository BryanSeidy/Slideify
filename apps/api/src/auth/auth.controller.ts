import { Controller, Get, Post, Body, UseGuards, HttpCode, Req, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt.guard';

function assertEmail(email: unknown): asserts email is string {
  if (typeof email !== 'string' || !email.includes('@') || email.length > 320) {
    throw new BadRequestException({ code: 'INVALID_EMAIL', message: 'Adresse email invalide.' });
  }
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('magic-link')
  @HttpCode(202)
  @ApiOperation({ summary: 'Request a magic link (creates the account on first use)' })
  async sendMagicLink(@Body('email') email: string) {
    assertEmail(email);
    const result = await this.authService.authenticateWithMagicLink(email);
    return { message: 'Lien envoyé', userId: result.userId };
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Register-or-login with email, returns a JWT' })
  @ApiResponse({ status: 200, description: 'JWT issued' })
  @ApiResponse({ status: 400, description: 'Invalid email' })
  async login(@Body('email') email: string) {
    assertEmail(email);
    const identified = await this.authService.authenticateWithMagicLink(email);
    return this.authService.login(identified.userId, identified.email);
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
