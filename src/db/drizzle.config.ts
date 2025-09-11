export default {
  out: './migrations',
  schema: './schema.ts',
  driver: 'better-sqlite',
  dbCredentials: {
    url: './data/stupid_meter.db',
  },
};
