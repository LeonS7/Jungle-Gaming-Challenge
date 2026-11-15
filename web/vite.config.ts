/** Esta página configura o proxy da API e o controle local do benchmark no painel.
 */
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv } from 'vite';
import { createLoadTestControlPlugin } from './load-test-control';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), 'VITE_');
  const apiTarget = environment.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3000';
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const serverEnvironment = loadEnv(mode, repositoryRoot, '');

  return {
    plugins: [vue(), createLoadTestControlPlugin(resolve(repositoryRoot), serverEnvironment, apiTarget)],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      host: '127.0.0.1',
      strictPort: true,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  };
});
