import {defineConfig} from 'vite';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
const root=path.resolve(import.meta.dirname,'../..');
export default defineConfig({plugins:[tailwindcss()],root:path.resolve(import.meta.dirname),resolve:{alias:[...['@/hooks/use-settings','@/hooks/use-threads','@/hooks/use-optimistic-actions','@/hooks/use-templates','nuqs'].map(find=>({find,replacement:path.resolve(import.meta.dirname,'edges.ts')})),{find:'@/providers/query-provider',replacement:path.resolve(import.meta.dirname,'rpc.ts')},{find:'@/lib/auth-client',replacement:path.resolve(import.meta.dirname,'auth.ts')},{find:'@',replacement:root}]},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:39281,strictPort:true,fs:{allow:[path.resolve(root,'../..')]}}});
