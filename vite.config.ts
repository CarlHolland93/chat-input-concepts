import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/chat-input-concepts/',
  plugins: [react(), tailwindcss()],
  server: { port: 5180, strictPort: false },
});
