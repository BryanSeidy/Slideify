import 'dotenv/config';
import { getEnv } from './env';

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  isDev: boolean;
  isProd: boolean;
  isTest: boolean;
  databaseUrl: string;
  directUrl: string | undefined;
  redis: {
    host: string;
    port: number;
    password?: string;
  };
  llm: {
    apiKey: string | undefined;
    model: string;
    siteUrl: string | undefined;
    siteName: string;
    mock: boolean;
  };
  auth: {
    secret: string;
  };
  storage: {
    endpoint: string | undefined;
    bucket: string | undefined;
    region: string | undefined;
    publicUrl: string | undefined;
  };
  payments: {
    provider: string;
    secretKey: string | undefined;
    webhookSecret: string | undefined;
  };
  appUrl: string;
  apiPrefix: string;
  freeCredits: number;
}

function buildConfig(): Config {
  const env = getEnv();
  return {
    nodeEnv: env.NODE_ENV,
    isDev: env.NODE_ENV === 'development',
    isProd: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    databaseUrl: env.DATABASE_URL,
    directUrl: env.DIRECT_URL,
    redis: {
      host: env.REDIS_HOST,
      port: Number(env.REDIS_PORT),
      password: env.REDIS_PASSWORD,
    },
    llm: {
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL,
      siteUrl: env.OPENROUTER_SITE_URL,
      siteName: env.OPENROUTER_SITE_NAME,
      mock: !env.OPENROUTER_API_KEY,
    },
    auth: {
      secret: env.AUTH_SECRET,
    },
    storage: {
      endpoint: env.STORAGE_ENDPOINT,
      bucket: env.STORAGE_BUCKET,
      region: env.STORAGE_REGION,
      publicUrl: env.STORAGE_PUBLIC_URL,
    },
    payments: {
      provider: env.PAYMENT_PROVIDER,
      secretKey: env.PAYMENT_SECRET_KEY,
      webhookSecret: env.PAYMENT_WEBHOOK_SECRET,
    },
    appUrl: env.NEXT_PUBLIC_APP_URL,
    apiPrefix: env.API_PREFIX,
    freeCredits: Number(env.SLIDEIFY_CREDITS_FREE),
  };
}

export const config = buildConfig();
export const isMockProvider = config.llm.mock;