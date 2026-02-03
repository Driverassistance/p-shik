import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export const config = {
  env: process.env.ENV ?? 'dev',
  port: Number(process.env.PORT ?? 3000),

  botToken: req('BOT_TOKEN'),
  botUsername: process.env.BOT_USERNAME ?? 'pshikapp_bot',
  botKey: req('BOT_KEY'),
  tgSecretToken: req('TG_SECRET_TOKEN'),

  baseUrl: process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
};
