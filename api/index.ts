/**
 * Vercel serverless entry: serves every /api/* route (see vercel.json rewrites)
 * with the same Express app used locally. The frontend is served by Vercel's
 * static hosting from the Vite build in dist/.
 */
import { createApp } from '../server.js';

const app = createApp();

export default app;
