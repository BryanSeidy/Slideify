import { Controller, Get, Post, Body, UseGuards, HttpCode, Req, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt.guard';

function assertEmail(email: unknown): asserts email is string {
  if (typeof email !== 'string' || !email.includes('@') || email.length > 320) {
    throw new BadRequestException({ code: 'INVALID_EMAIL', message: 'Adresse email invalide.' });
  }
}

function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new BadRequestException({
      code: 'INVALID_PASSWORD',
      message: 'Le mot de passe doit contenir entre 8 et 128 caractères.',
    });
  }
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an account (email + password). Does not log in.' })
  @ApiResponse({ status: 201, description: 'Account created with welcome credits' })
  @ApiResponse({ status: 400, description: 'Invalid email or password' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async register(@Body('email') email: string, @Body('password') password: string) {
    assertEmail(email);
    assertPassword(password);
    const result = await this.authService.register(email, password);
    return result;
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Log in with email + password, returns a JWT' })
  @ApiResponse({ status: 200, description: 'JWT issued' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 401, description: 'Invalid credentials (email and password are both required and verified)' })
  async login(@Body('email') email: string, @Body('password') password: string) {
    assertEmail(email);
    assertPassword(password);
    return this.authService.login(email, password);
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
