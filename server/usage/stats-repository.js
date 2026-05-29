const TOKEN_COLUMNS = `
  COALESCE(SUM(ul.total_tokens), 0)::bigint AS total_tokens,
  COALESCE(SUM(ul.prompt_tokens), 0)::bigint AS prompt_tokens,
  COALESCE(SUM(ul.completion_tokens), 0)::bigint AS completion_tokens,
  COALESCE(SUM(ul.prompt_cached_tokens), 0)::bigint AS prompt_cached_tokens,
  COALESCE(SUM(ul.completion_reasoning_tokens), 0)::bigint AS completion_reasoning_tokens
`;

const RANGE_FILTERS = {
  today: `ul.created_at >= CURRENT_DATE::timestamptz AND ul.created_at <= NOW()`,
  yesterday: `ul.created_at >= (CURRENT_DATE - INTERVAL '1 day')::timestamptz AND ul.created_at < CURRENT_DATE::timestamptz`,
  total: `TRUE`,
};

function normalizeTokenRow(row = {}) {
  return {
    username: row.username || '',
    total_tokens: Number(row.total_tokens) || 0,
    prompt_tokens: Number(row.prompt_tokens) || 0,
    completion_tokens: Number(row.completion_tokens) || 0,
    prompt_cached_tokens: Number(row.prompt_cached_tokens) || 0,
    completion_reasoning_tokens: Number(row.completion_reasoning_tokens) || 0,
  };
}

function normalizeRankingLimit(value, fallback = 10) {
  const limit = Number(value || fallback);
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), 100);
}

function createUsageStatsRepository(pool, options = {}) {
  const rankingLimit = normalizeRankingLimit(options.rankingLimit || process.env.USAGE_RANKING_LIMIT || process.env.USAGE_STATS_RANKING_LIMIT);

  async function getRanking(range) {
    const filter = RANGE_FILTERS[range];
    if (!filter) throw new Error(`Unsupported usage range: ${range}`);
    const sql = `
      SELECT
        COALESCE(ak.name, '') AS username,
        ${TOKEN_COLUMNS}
      FROM usage_logs ul
      INNER JOIN api_keys ak ON ul.api_key_id = ak.id
      WHERE ${filter}
      GROUP BY ak.name
      ORDER BY total_tokens DESC
      LIMIT $1
    `;
    const result = await pool.query(sql, [rankingLimit]);
    return result.rows.map(normalizeTokenRow);
  }

  async function getPersonalRange(apiKey, range) {
    const filter = RANGE_FILTERS[range];
    if (!filter) throw new Error(`Unsupported usage range: ${range}`);
    const sql = `
      SELECT
        COALESCE(MAX(ak.name), '') AS username,
        ${TOKEN_COLUMNS}
      FROM usage_logs ul
      INNER JOIN api_keys ak ON ul.api_key_id = ak.id
      WHERE ak."key" = $1 AND ${filter}
    `;
    const result = await pool.query(sql, [apiKey]);
    return normalizeTokenRow(result.rows[0]);
  }

  return { getRanking, getPersonalRange };
}

module.exports = { createUsageStatsRepository, normalizeRankingLimit };
