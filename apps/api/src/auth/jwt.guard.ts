import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { config } from '@slideify/config';
import { UnauthenticatedError } from '../common/errors/http-error';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers['authorization'];

    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      throw new UnauthenticatedError();
    }

    const token = authorization.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthenticatedError();
    }

    try {
      const payload = this.jwtService.verify<{ sub?: string; email?: string; credits?: number }>(token, {
        secret: config.auth.secret,
      });
      // L'identité vient uniquement du jeton signé. Un jeton valide mais sans
      // sub est traité comme non authentifié (jamais comme un utilisateur fictif).
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new UnauthenticatedError();
      }
      request.user = {
        userId: payload.sub,
        email: payload.email,
        credits: payload.credits,
      };
      return true;
    } catch {
      throw new UnauthenticatedError();
    }
  }
}
