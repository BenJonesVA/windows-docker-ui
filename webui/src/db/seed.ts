import { nanoid } from 'nanoid';
import { db } from './client.js';
import { users } from './schema.js';
import { hashPassword } from '../auth/password.js';

// Stand-in for the real admin-invite-only flow (remaining plan #6 scope) —
// useful for scripted/non-interactive deploys. The interactive path for a
// fresh deploy's very first admin is the Setup screen instead (plan #5,
// api/setup.ts). Usage: SEED_EMAIL=... SEED_PASSWORD=... npm run db:seed
const email = process.env.SEED_EMAIL;
const password = process.env.SEED_PASSWORD;
if (!email || !password) {
  console.error('Set SEED_EMAIL and SEED_PASSWORD env vars.');
  process.exit(1);
}

const passwordHash = await hashPassword(password);
await db.insert(users).values({
  id: nanoid(16),
  email,
  passwordHash,
  role: 'admin',
});
console.log(`Seeded admin user ${email}`);
