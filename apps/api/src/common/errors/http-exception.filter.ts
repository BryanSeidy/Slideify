import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

const logger = new Logger('HttpExceptionFilter');

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    // HttpException (incl. HttpError) — statut et corps déjà structurés
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse() as
        | { statusCode?: number; code: string; message: string }
        | string;

      response.status(status).json({
        statusCode: status,
        code: typeof body === 'string' ? 'INTERNAL_ERROR' : body.code,
        message: typeof body === 'string' ? body : body.message,
        timestamp: new Date().toISOString(),
        path: request.url,
      });
      return;
    }

    // Prisma P2002 — unique constraint violation
    if (
      exception instanceof Prisma.PrismaClientKnownRequestError &&
      exception.code === 'P2002'
    ) {
      logger.error(`Prisma P2002: ${exception.message}`);
      response.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        code: 'UNIQUE_CONSTRAINT_VIOLATION',
        message: 'Une contrainte d\'unicité a été violée.',
        timestamp: new Date().toISOString(),
        path: request.url,
      });
      return;
    }

    // Prisma P2003 — foreign key violation
    if (
      exception instanceof Prisma.PrismaClientKnownRequestError &&
      exception.code === 'P2003'
    ) {
      logger.error(`Prisma P2003: ${exception.message}`);
      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'FOREIGN_KEY_VIOLATION',
        message: 'Référence invalide.',
        timestamp: new Date().toISOString(),
        path: request.url,
      });
      return;
    }

    // Erreur inattendue — ne jamais fuir de stack trace
    logger.error(`Unexpected error: ${exception}`, (exception as Error)?.stack);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Une erreur est survenue. Réessayez.',
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
