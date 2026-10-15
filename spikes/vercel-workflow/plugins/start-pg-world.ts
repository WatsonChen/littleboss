import { definePlugin } from 'nitro';

// The Postgres World runs a background worker; it must be started when the server boots so that
// jobs left in the database by a previous process are picked up again.
export default definePlugin(async () => {
  const { getWorld } = await import('workflow/runtime');
  const world = await getWorld();
  await world.start?.();
});
