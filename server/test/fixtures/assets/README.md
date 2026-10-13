Stand-in for the Angular build (`../client/dist/unibooks/browser`) in server
tests, so `npm test` needs no client build. `vitest.config.ts` serves this
directory as `env.ASSETS`; it holds only what the frontend route tests read.
