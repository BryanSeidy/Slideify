import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { config } from '@slideify/config';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers['authorization'];

    if (!authorization || !authorization.startsWith('Bearer ')) {
      return false;
    }

    const token = authorization.split(' ')[1];

    try {
      const payload = this.jwtService.verify(token, {
        secret: config.auth.secret,
      });
      request.user = {
        userId: payload.sub,
        email: payload.email,
        credits: payload.credits,
      };
      return true;
    } catch (error) {
      return false;
    }
  }
}