// Vercel serverless entry for the ops API.
//
// The console (web/dist, static) and this API deploy together as ONE Vercel
// project, so they share an origin. That is why web/.env leaves VITE_API_URL
// empty in production: the browser calls /api/admin/... on its own origin and
// CORS never enters the picture.
//
// .mjs rather than .js: this repo's package.json has no "type": "module", so a
// .js file here would be treated as CommonJS and `export default` would fail.
// Importing the CommonJS Express app from ESM yields module.exports as the
// default export, which is exactly the handler Vercel wants.
import app from '../server/index.js';

// Vercel's Node runtime parses the request body itself by default, consuming
// the stream before Express's own express.json() can read it — leaving
// req.body empty on every POST. Disabling it hands parsing back to Express.
export const config = { api: { bodyParser: false } };

export default app;
