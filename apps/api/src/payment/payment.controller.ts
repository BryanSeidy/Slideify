import {
  Controller,
  Get,
  Post,
  Body,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { config } from '@slideify/config';

@ApiTags('payment')
@Controller('payment')
export class PaymentController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('checkout')
  async createCheckout(@Body() body: { userId: string; planId: string }) {
    const { userId, planId } = body;

    // Validate user and credits
    const credits = await this.prisma.credit.findUnique({
      where: { userId },
    });

    if (!credits || credits.balance > 0) {
      return { error: 'ALREADY_HAS_CREDITS' };
    }

    // Create Stripe checkout session (mock for dev)
    const sessionId = `cs_test_${Date.now()}`;
    const sessionUrl = `${config.appUrl}/checkout/${sessionId}`;

    return { sessionId, url: sessionUrl };
  }

  @Post('webhook')
  async handleWebhook(@Body() payload: any) {
    // Idempotent webhook processing
    const eventId = payload.id;
    const existing = await this.prisma.webhookEvent.findUnique({
      where: { provider_eventType_id: { provider: 'stripe', eventType: payload.type, id: eventId } },
    });

    if (existing) return { processed: true }; // Already processed

    // Record the webhook event
    await this.prisma.webhookEvent.create({
      data: {
        provider: 'stripe',
        eventType: payload.type,
        payload,
      },
    });

    if (payload.type === 'checkout.session.completed') {
      const userId = payload.data?.object?.metadata?.userId;
      if (userId) {
        await this.prisma.credit.update({
          where: { userId },
          data: { balance: { increment: 20 } }, // 20 credits per pack
        });
      }
    }

    return { processed: true };
  }
}