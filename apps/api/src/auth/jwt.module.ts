import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { config } from '@slideify/config';
import { JwtAuthGuard } from './jwt.guard';
import { AuthService } from './auth.service';

@Module({
  imports: [
    JwtModule.register({
      secret: config.auth.secret,
      signOptions: { expiresIn: '7d' },
    }),
  ],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard],
})
export class JwtModuleNest {}