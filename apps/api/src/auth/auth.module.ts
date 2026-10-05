import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { config } from '@slideify/config';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt.guard';

@Module({
  imports: [
    PrismaModule,
    JwtModule.register({
      secret: config.auth.secret,
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard],
})
export class AuthModule {}
