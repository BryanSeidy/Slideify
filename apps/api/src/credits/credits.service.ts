import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CreditsService {
  constructor(private prisma: PrismaService) {}

  async getBalance(userId: string): Promise<number> {
    const total = await this.prisma.creditTransaction.aggregate({
      _sum: { amount: true },
      where: { userId },
    });
    return total._sum.amount ?? 0;
  }

  async consume(userId: string): Promise<void> {
    await this.prisma.creditTransaction.create({
      data: {
        userId,
        amount: -1,
        type: 'GENERATION_DEBIT',
        reference: undefined,
        metadata: undefined,
      },
    });
  }

  async addCredits(userId: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    await this.prisma.creditTransaction.create({
      data: {
        userId,
        amount,
        type: amount > 0 ? 'MANUAL_GRANT' : 'ADJUSTMENT',
        reference: undefined,
        metadata: undefined,
      },
    });
  }
}