import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { config } from '@slideify/config';

/** bcrypt cost factor: 10 is the local-MVP tradeoff (higher = slower logins/tests). */
export const BCRYPT_COST = 10;

/**
 * Precomputed dummy hash used so that a login for an unknown email still pays
 * one bcrypt comparison — the response time then reveals nothing about whether
 * the account exists (timing/enumeration mitigation, M004.3).
 */
const DUMMY_HASH = '$2b$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV0123456789ab';

export interface AuthResult {
  userId: string;
  email: string;
  credits: number;
}

export interface LoginResult extends AuthResult {
  accessToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  private async balanceOf(userId: string): Promise<number> {
    const balance = await this.prisma.creditTransaction.aggregate({
      _sum: { amount: true },
      where: { userId },
    });
    return balance._sum.amount ?? 0;
  }

  private signToken(userId: string, email: string, credits: number): string {
    return this.jwtService.sign({ sub: userId, email, credits });
  }

  /**
   * Creates an account AND its one-time welcome grant atomically.
   * The grant (+3 MANUAL_GRANT/signup_bonus) is part of the same transaction:
   * either both rows exist or none. Re-registering the same email fails on the
   * unique constraint — no second grant is possible.
   */
  async register(email: string, password: string): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException({ code: 'EMAIL_TAKEN', message: 'Un compte existe déjà pour cet email.' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    return this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: { email, passwordHash },
      });

      await tx.creditTransaction.create({
        data: {
          userId: newUser.id,
          amount: config.freeCredits,
          type: 'MANUAL_GRANT',
          reference: 'signup_bonus',
        },
      });

      return { userId: newUser.id, email: newUser.email, credits: config.freeCredits };
    });
  }

  /**
   * Issues a JWT only after proving possession of the password.
   * Unknown email and wrong password produce the IDENTICAL 401 response
   * (same status, same code, same message, same bcrypt work) so callers
   * cannot enumerate accounts.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Always pay for exactly one comparison, even when the user is unknown.
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Email ou mot de passe invalide.' });
    }

    const credits = await this.balanceOf(user.id);
    return {
      accessToken: this.signToken(user.id, user.email, credits),
      userId: user.id,
      email: user.email,
      credits,
    };
  }
}
