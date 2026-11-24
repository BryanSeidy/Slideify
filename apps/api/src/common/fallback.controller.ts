import { All, Controller } from '@nestjs/common';
import { NotFoundError } from './errors/http-error';

@Controller()
export class FallbackController {
  @All('*')
  notFound() {
    throw new NotFoundError('Ressource introuvable.');
  }
}