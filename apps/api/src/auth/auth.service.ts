import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { config } from '@slideify/config';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async authenticateWithMagicLink(email: string): Promise<{ userId: string; email: string; credits: number }> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (user) {
      const balance = await this.prisma.creditTransaction.aggregate({
        _sum: { amount: true },
        where: { userId: user.id },
      });
      return { userId: user.id, email: user.email, credits: balance._sum.amount ?? 0 };
    }

    // New user — create with free credits via append-only ledger
    const result = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: { email },
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

    return result;
  }

  async login(userId: string, email: string): Promise<{ accessToken: string; userId: string; email: string; credits: number }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new Error('User not found');
    }

    const balance = await this.prisma.creditTransaction.aggregate({
      _sum: { amount: true },
      where: { userId: user.id },
    });

    const payload = {
      sub: userId,
      email: user.email,
      credits: balance._sum.amount ?? 0,
    };

    const accessToken = this.jwtService.sign(payload);

    return { accessToken, userId, email: user.email, credits: balance._sum.amount ?? 0 };
  }
}