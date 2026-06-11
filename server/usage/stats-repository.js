const TOKEN_COLUMNS = `
  COALESCE(SUM(ul.total_tokens), 0)::bigint AS total_tokens,
  COALESCE(SUM(ul.prompt_tokens), 0)::bigint AS prompt_tokens,
  COALESCE(SUM(ul.completion_tokens), 0)::bigint AS completion_tokens,
  COALESCE(SUM(ul.prompt_cached_tokens), 0)::bigint AS prompt_cached_tokens,
  COALESCE(SUM(ul.completion_reasoning_tokens), 0)::bigint AS completion_reasoning_tokens
`;

const USAGE_START_FILTER = `ul.created_at >= TIMESTAMPTZ '2026-06-01 00:00:00+08'`;

const RANGE_FILTERS = {
  today: `${USAGE_START_FILTER} AND ul.created_at >= CURRENT_DATE::timestamptz AND ul.created_at <= NOW()`,
  yesterday: `${USAGE_START_FILTER} AND ul.created_at >= (CURRENT_DATE - INTERVAL '1 day')::timestamptz AND ul.created_at < CURRENT_DATE::timestamptz`,
  total: USAGE_START_FILTER,
};

function normalizeTokenRow(row = {}) {
  return {
    username: row.username || '',
    project_id: row.project_id === undefined || row.project_id === null ? null : Number(row.project_id),
    project_name: row.project_name || '',
    total_tokens: Number(row.total_tokens) || 0,
    prompt_tokens: Number(row.prompt_tokens) || 0,
    completion_tokens: Number(row.completion_tokens) || 0,
    prompt_cached_tokens: Number(row.prompt_cached_tokens) || 0,
    completion_reasoning_tokens: Number(row.completion_reasoning_tokens) || 0,
    total_percent: Number(row.total_percent) || 0,
  };
}

function normalizeRankingLimit(value) {
  if (value === undefined || value === null || value === '') return null;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return Math.floor(limit);
}

function rankingLimitSql(rankingLimit) {
  return Number.isFinite(rankingLimit) ? 'LIMIT $1' : '';
}

function rankingLimitSqlAt(rankingLimit, index) {
  return Number.isFinite(rankingLimit) ? `LIMIT $${index}` : '';
}

function rankingLimitParams(rankingLimit) {
  return Number.isFinite(rankingLimit) ? [rankingLimit] : [];
}

function normalizeProjectId(projectId) {
  if (projectId === undefined || projectId === null || projectId === '') return null;
  const id = Number(projectId);
  return Number.isFinite(id) ? Math.floor(id) : null;
}

function createUsageStatsRepository(pool, options = {}) {
  const rankingLimit = normalizeRankingLimit(options.rankingLimit || process.env.USAGE_RANKING_LIMIT || process.env.USAGE_STATS_RANKING_LIMIT);

  async function getUserRanking(range, options = {}) {
    const filter = RANGE_FILTERS[range];
    if (!filter) throw new Error(`Unsupported usage range: ${range}`);
    const projectId = normalizeProjectId(options.projectId);
    const params = [];
    const projectFilter = projectId === null ? '' : `AND ak.project_id = $${params.push(projectId)}`;
    const limitClause = rankingLimitSqlAt(rankingLimit, params.length + 1);
    if (Number.isFinite(rankingLimit)) params.push(rankingLimit);
    const sql = `
      SELECT
        COALESCE(ak.name, '') AS username,
        ${TOKEN_COLUMNS}
      FROM usage_logs ul
      INNER JOIN api_keys ak ON ul.api_key_id = ak.id
      WHERE ${filter}
      ${projectFilter}
      GROUP BY ak.name
      ORDER BY total_tokens DESC
      ${limitClause}
    `;
    const result = await pool.query(sql, params);
    return result.rows.map(normalizeTokenRow);
  }

  async function getProjectRanking(range) {
    const filter = RANGE_FILTERS[range];
    if (!filter) throw new Error(`Unsupported usage range: ${range}`);
    const sql = `
      WITH project_usage AS (
        SELECT
          p.id AS project_id,
          COALESCE(p.name, '未分配项目') AS project_name,
          ${TOKEN_COLUMNS}
        FROM usage_logs ul
        INNER JOIN api_keys ak ON ul.api_key_id = ak.id
        LEFT JOIN projects p ON ak.project_id = p.id
        WHERE ${filter}
        GROUP BY p.id, p.name
      )
      SELECT
        project_id,
        project_name,
        total_tokens,
        prompt_tokens,
        completion_tokens,
        prompt_cached_tokens,
        completion_reasoning_tokens,
        CASE
          WHEN SUM(total_tokens) OVER () > 0 THEN total_tokens::numeric / SUM(total_tokens) OVER () * 100
          ELSE 0
        END AS total_percent
      FROM project_usage
      ORDER BY total_tokens DESC
      ${rankingLimitSql(rankingLimit)}
    `;
    const result = await pool.query(sql, rankingLimitParams(rankingLimit));
    return result.rows.map(normalizeTokenRow);
  }

  async function getRanking(range, type = 'user', options = {}) {
    if (type === 'project') return getProjectRanking(range);
    return getUserRanking(range, options);
  }

  async function getApiKeyOwner(apiKey) {
    const result = await pool.query('SELECT COALESCE(name, \'\') AS username FROM api_keys WHERE "key" = $1 LIMIT 1', [apiKey]);
    return String(result.rows?.[0]?.username || '').trim();
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

  return { getRanking, getPersonalRange, getApiKeyOwner };
}

module.exports = { createUsageStatsRepository };
