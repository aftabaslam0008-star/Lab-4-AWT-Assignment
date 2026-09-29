const list = (v) => (v || '*').split(',').map((s) => s.trim()).filter(Boolean);

module.exports = {
  PORT: Number(process.env.PORT) || 4000,
  CORS_ORIGINS: list(process.env.CORS_ORIGIN),
  AGENT_KEY: process.env.AGENT_KEY || 'support123',
  SIMULATE: process.env.SIMULATE_PROGRESS !== 'false',
  STEP_SECONDS: Number(process.env.STEP_SECONDS) || 30,
};
