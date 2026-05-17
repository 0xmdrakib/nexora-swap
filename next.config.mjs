import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const emptyModule = path.resolve(__dirname, 'src/lib/server/emptyModule.js');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      '@react-native-async-storage/async-storage': emptyModule,
      'pino-pretty': emptyModule,
    };
    return config;
  },
};
export default nextConfig;
