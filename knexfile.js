
module.exports = {
  effiweb: {
    client: 'postgresql',
    connection: {
      host: 'localhost',
      port: 5431,
      database: 'effiweb',
      user:     'effiweb',
      password: process.env.EFFIWEB_PASSWORD
    },
    pool: {
      min: 1,
      max: 3
    }
  },

  efficms: {
    client: 'postgresql',
    connection: {
      host: 'localhost',
      port: 5431,
      database: 'efficms',
      user: 'effiweb',
      password: process.env.EFFIWEB_PASSWORD
    },
    pool: {
      min: 1,
      max: 3
    }
  },

  effiwp: {
    client: 'mysql',
    connection: {
      database: 'effiwp',
      user:     'effiwp',
      password: process.env.EFFIWP_PASSWORD
    },
    pool: {
      min: 1,
      max: 3
    }
  }

};
