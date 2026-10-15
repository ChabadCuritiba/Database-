// Runs the app locally with demo data and the development login.
// Usage: npm run demo   then open http://localhost:3000
import { spawnSync, spawn } from 'node:child_process';

const env = { ...process.env, NODE_ENV: 'development', DEV_LOGIN: '1' };
const seed = spawnSync(process.execPath, ['scripts/seed.js'], { env, stdio: 'inherit' });
if (seed.status !== 0) process.exit(seed.status ?? 1);
spawn(process.execPath, ['src/server.js'], { env, stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 0));
