import { Inngest } from 'inngest';

/**
 * One Inngest client for the API. In production it reads INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY
 * from the environment (set in the Vercel dashboard, never in the repository). For local work,
 * set INNGEST_DEV=1 and run `npx inngest-cli@latest dev`.
 */
export const inngest = new Inngest({ id: 'littleboss' });
