import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { config } from '@slideify/config';

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService) {}

  async authenticateWithMagicLink(email: string): Promise<{ userId: string; email: string; credits: number }> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (user) {
      const credit = await this.prisma.creditTransaction.findFirst({
        where: { userId: user.id, type: 'MANUAL_GRANT' },
        orderBy: { createdAt: 'desc' },
      });
      const balance = credit ? credit.amount : 0;
      return { userId: user.id, email: user.email, credits: balance };
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
}