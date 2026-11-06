// Isolated visual QA entry; never an application route and never uses operational data.
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../',import.meta.url));
export default defineConfig({root:fileURLToPath(new URL('./ui-qa/',import.meta.url)),plugins:[react(),tailwindcss()],resolve:{alias:[{find:'@/lib/auth',replacement:fileURLToPath(new URL('./ui-qa/auth.ts',import.meta.url))},{find:'@',replacement:repo+'src'}],dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:4189,strictPort:true,fs:{allow:[repo]}}});