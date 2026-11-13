import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { config } from '@slideify/config';

/**
 * bcrypt cost factor : 12 pour les nouveaux mots de passe (M004.3 P1.6).
 * bcrypt ne traite que les 72 premiers octets UTF-8 : on limite
 * explicitement les mots de passe à 72 octets pour éviter que deux
 * mots de passe différents dépassant cette limite deviennent équivalents.
 */
export const BCRYPT_COST = 12;
export const MAX_PASSWORD_BYTES = 72;

/**
 * Dummy hash bcrypt valide (60 caractères, coût 12) utilisé pour que le
 * login d'un email inconnu paie exactement le même coût bcrypt qu'un
 * login d'un email connu — protection contre l'énumération par le temps.
 * Format : $2b$<cost>$<22 salt chars><31 hash chars> = 60 caractères.
 */
const DUMMY_HASH =
  '$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export interface AuthResult {
  userId: string;
  email: string;
  credits: number;
}

export interface LoginResult extends AuthResult {
  accessToken: string;
}

/**
 * Valide AUTH_SECRET au démarrage : 32 caractères minimum.
 * Appelé depuis le module Auth pour fail-fast en cas de secret trop court.
 */
export function validateAuthSecret(secret: string): void {
  if (!secret || secret.length < 32) {
    throw new Error(
      'AUTH_SECRET doit contenir au moins 32 caractères (sécurité JWT).',
    );
  }
}

/**
 * Normalise un email : trim + minuscules. L'unicité en base est donc
 * appliquée sur la forme normalisée (évite Victim@Example.com ≠ victim@example.com).
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {
    validateAuthSecret(config.auth.secret);
  }

  private async balanceOf(userId: string): Promise<number> {
    const balance = await this.prisma.creditTransaction.aggregate({
      _sum: { amount: true },
      where: { userId },
    });
    return balance._sum.amount ?? 0;
  }

  private signToken(userId: string, email: string, credits: number): string {
    return this.jwtService.sign({ sub: userId, email, credits });
  }

  /**
   * Crée un compte et son crédit de bienvenue (+3) de façon atomique.
   * L'email est normalisé avant l'insertion ; l'unicité de l'email en base
   * empêche tout double crédit d'inscription.
   */
  async register(email: string, password: string): Promise<AuthResult> {
    const normalizedEmail = normalizeEmail(email);

    const passwordBytes = Buffer.byteLength(password, 'utf8');
    if (passwordBytes > MAX_PASSWORD_BYTES) {
      throw new ConflictException({
        code: 'PASSWORD_TOO_LONG',
        message:
          'Le mot de passe dépasse 72 octets UTF-8 (limite bcrypt).',
      });
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      throw new ConflictException({
        code: 'EMAIL_TAKEN',
        message: 'Un compte existe déjà pour cet email.',
      });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    return this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: { email: normalizedEmail, passwordHash },
      });

      await tx.creditTransaction.create({
        data: {
          userId: newUser.id,
          amount: config.freeCredits,
          type: 'MANUAL_GRANT',
          reference: 'signup_bonus',
        },
      });

      return {
        userId: newUser.id,
        email: newUser.email,
        credits: config.freeCredits,
      };
    });
  }

  /**
   * Délivre un JWT uniquement après preuve de possession du mot de passe.
   * Email inconnu et mauvais mot de passe produisent IDENTIQUEMENT une 401
   * (même statut, même code, même message, même coût bcrypt) : pas
   * d'énumération de comptes.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const normalizedEmail = normalizeEmail(email);

    const passwordBytes = Buffer.byteLength(password, 'utf8');
    if (passwordBytes > MAX_PASSWORD_BYTES) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Email ou mot de passe invalide.',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    // Toujours exactement une comparaison bcrypt, même quand l'utilisateur
    // est inconnu (hash fictique valide de 60 caractères).
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Email ou mot de passe invalide.',
      });
    }

    const credits = await this.balanceOf(user.id);
    return {
      accessToken: this.signToken(user.id, user.email, credits),
      userId: user.id,
      email: user.email,
      credits,
    };
  }

  /**
   * Lit le solde depuis le ledger (pas depuis le JWT, qui peut être obsolète).
   * Utilisé par /auth/me.
   */
  async getBalance(userId: string): Promise<number> {
    return this.balanceOf(userId);
  }
}
