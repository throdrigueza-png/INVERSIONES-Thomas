import { defineConfig } from '@prisma/config';
import 'dotenv/config'; // Asegura que lea tu archivo .env

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL as string,
  }
});