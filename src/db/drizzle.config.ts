export default {
  out: './src/db/migrations',
  schema: './src/db/schema.ts',
  driver: 'better-sqlite',
  dbCredentials: {
    url: './data/stupid_meter.db',
  },
};
