import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  HttpCode,
  Req,
  ConflictException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt.guard';
import {
  InvalidEmailError,
  InvalidPasswordError,
  EmailTakenError,
} from '../common/errors/http-error';

function assertEmail(email: unknown): asserts email is string {
  if (typeof email !== 'string' || !email.includes('@') || email.length > 320) {
    throw new InvalidEmailError();
  }
}

function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string') {
    throw new InvalidPasswordError();
  }
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes < 8 || bytes > 72) {
    throw new InvalidPasswordError(
      'Le mot de passe doit contenir entre 8 et 72 octets UTF-8.',
    );
  }
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(201)
  @ApiOperation({ summary: 'Créer un compte (email + mot de passe). Ne connecte pas.' })
  @ApiResponse({ status: 201, description: 'Compte créé avec crédits de bienvenue' })
  @ApiResponse({ status: 400, description: 'Email ou mot de passe invalide' })
  @ApiResponse({ status: 409, description: 'Email déjà enregistré' })
  async register(@Body('email') email: string, @Body('password') password: string) {
    assertEmail(email);
    assertPassword(password);
    return this.authService.register(email, password);
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Se connecter avec email + mot de passe, retourne un JWT' })
  @ApiResponse({ status: 200, description: 'JWT délivré' })
  @ApiResponse({ status: 400, description: 'Input invalide' })
  @ApiResponse({ status: 401, description: 'Identifiants invalides' })
  async login(@Body('email') email: string, @Body('password') password: string) {
    assertEmail(email);
    assertPassword(password);
    return this.authService.login(email, password);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'Infos utilisateur (crédits lus dans le ledger)' })
  async getMe(@Req() req: { user: { userId: string; email: string } }) {
    const credits = await this.authService.getBalance(req.user.userId);
    return {
      userId: req.user.userId,
      email: req.user.email,
      credits,
    };
  }
}
