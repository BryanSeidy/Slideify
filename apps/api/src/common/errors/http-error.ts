import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes';

export class HttpError extends HttpException {
  constructor(
    code: ErrorCode,
    message: string,
    statusCode: HttpStatus,
  ) {
    super(
      { statusCode, code, message },
      statusCode,
    );
  }
}

export class UnauthenticatedError extends HttpError {
  constructor(message = 'Jeton absent, invalide ou expiré.') {
    super(ErrorCode.UNAUTHENTICATED, message, HttpStatus.UNAUTHORIZED);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Ressource introuvable.') {
    super(ErrorCode.NOT_FOUND, message, HttpStatus.NOT_FOUND);
  }
}

export class InputTooShortError extends HttpError {
  constructor(message: string) {
    super(ErrorCode.INPUT_TOO_SHORT, message, HttpStatus.BAD_REQUEST);
  }
}

export class InputTooLongError extends HttpError {
  constructor(message: string) {
    super(ErrorCode.INPUT_TOO_LONG, message, HttpStatus.BAD_REQUEST);
  }
}

export class NoCreditsError extends HttpError {
  constructor(message = 'Vous n\'avez plus de crédits disponibles.') {
    super(ErrorCode.NO_CREDITS, message, HttpStatus.PAYMENT_REQUIRED);
  }
}

export class GenerationInProgressError extends HttpError {
  constructor(message: string) {
    super(ErrorCode.GENERATION_IN_PROGRESS, message, HttpStatus.CONFLICT);
  }
}

export class QueueUnavailableError extends HttpError {
  constructor(message = 'File de génération temporairement indisponible.') {
    super(ErrorCode.QUEUE_UNAVAILABLE, message, HttpStatus.SERVICE_UNAVAILABLE);
  }
}

export class InvalidResponseError extends HttpError {
  constructor(message = 'Réponse du fournisseur IA invalide.') {
    super(ErrorCode.INVALID_RESPONSE, message, HttpStatus.BAD_GATEWAY);
  }
}

export class MalformedOutputError extends HttpError {
  constructor(message = 'Structure de réponse IA invalide.') {
    super(ErrorCode.MALFORMED_OUTPUT, message, HttpStatus.BAD_GATEWAY);
  }
}

export class TooManySlidesError extends HttpError {
  constructor(message = 'Nombre de slides invalide.') {
    super(ErrorCode.TOO_MANY_SLIDES, message, HttpStatus.BAD_GATEWAY);
  }
}

export class EmailTakenError extends HttpError {
  constructor(message = 'Un compte existe déjà pour cet email.') {
    super(ErrorCode.EMAIL_TAKEN, message, HttpStatus.CONFLICT);
  }
}

export class InvalidEmailError extends HttpError {
  constructor(message = 'Adresse email invalide.') {
    super(ErrorCode.INVALID_EMAIL, message, HttpStatus.BAD_REQUEST);
  }
}

export class InvalidPasswordError extends HttpError {
  constructor(message = 'Le mot de passe doit contenir entre 8 et 128 caractères.') {
    super(ErrorCode.INVALID_PASSWORD, message, HttpStatus.BAD_REQUEST);
  }
}
