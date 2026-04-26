import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
	root: '.',
	server: {
		port: 5173,
		open: false
	},
	build: {
		target: 'esnext',
		rollupOptions: {
			input: {
				main: resolve( __dirname, 'index.html' ),
				legacy: resolve( __dirname, 'examples/01-legacy-baked.html' ),
				hillaire: resolve( __dirname, 'examples/02-hillaire-baked.html' ),
				ap_demo: resolve( __dirname, 'examples/03-aerial-perspective.html' ),
				transmittance: resolve( __dirname, 'examples/10-transmittance-lut.html' ),
				multiscatter: resolve( __dirname, 'examples/11-multiscatter-lut.html' ),
				skyview: resolve( __dirname, 'examples/12-skyview-lut.html' ),
				aerial: resolve( __dirname, 'examples/13-aerial-perspective-lut.html' )
			}
		}
	}
});
