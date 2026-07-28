const {
  RANGE_FILTERS,
  DEPARTMENT_RANGE_FILTERS,
  DEPARTMENT_RANGE_BOUNDS_SQL,
} = require('./ranges');

const TOKEN_COLUMNS = `
  COALESCE(SUM(ul.total_tokens), 0)::bigint AS total_tokens,
  COALESCE(SUM(ul.prompt_tokens), 0)::bigint AS prompt_tokens,
  COALESCE(SUM(ul.completion_tokens), 0)::bigint AS completion_tokens,
  COALESCE(SUM(ul.prompt_cached_tokens), 0)::bigint AS prompt_cached_tokens,
  COALESCE(SUM(ul.completion_reasoning_tokens), 0)::bigint AS completion_reasoning_tokens
`;

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

function normalizeDepartmentRow(row = {}) {
  return {
    department_id: row.department_id == null ? '' : String(row.department_id),
    department_name: row.department_name || '',
    total_tokens: Number(row.total_tokens) || 0,
    prompt_tokens: Number(row.prompt_tokens) || 0,
    completion_tokens: Number(row.completion_tokens) || 0,
    prompt_cached_tokens: Number(row.prompt_cached_tokens) || 0,
    completion_reasoning_tokens: Number(row.completion_reasoning_tokens) || 0,
  };
}

function normalizeDepartmentUserRow(row = {}) {
  return {
    department_id: row.department_id == null ? '' : String(row.department_id),
    ...normalizeTokenRow(row),
  };
}

function normalizeRankingLimit(value, fallback = 10) {
  const limit = Number(value || fallback);
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), 100);
}

function normalizeRangeBounds(row = {}) {
  return {
    start_time: row.start_time || null,
    end_time: row.end_time || null,
  };
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

  async function getUserByApiKey(apiKey) {
    const result = await pool.query('SELECT COALESCE(name, \'\') AS username FROM api_keys WHERE "key" = $1 LIMIT 1', [apiKey]);
    return { username: String(result.rows[0]?.username || '').trim() };
  }

  async function getDepartmentRanking(range) {
    const filter = DEPARTMENT_RANGE_FILTERS[range];
    if (!filter) throw new Error(`Unsupported department usage range: ${range}`);
    const sql = `
      SELECT
        dept."id" AS department_id,
        COALESCE(dept."name", '') AS department_name,
        ${TOKEN_COLUMNS}
      FROM usage_logs ul
      INNER JOIN projects dept ON dept."id" = ul.project_id
      WHERE ${filter}
      GROUP BY dept."id", dept."name"
      ORDER BY total_tokens DESC
    `;
    const result = await pool.query(sql);
    return result.rows.map(normalizeDepartmentRow);
  }

  async function getDepartmentUsers(departmentId, range) {
    const filter = DEPARTMENT_RANGE_FILTERS[range];
    if (!filter) throw new Error(`Unsupported department usage range: ${range}`);
    const sql = `
      SELECT
        COALESCE(ak."name", '') AS username,
        ${TOKEN_COLUMNS}
      FROM usage_logs ul
      INNER JOIN api_keys ak ON ul.api_key_id = ak.id
      WHERE ${filter} AND ul.project_id::text = $1
      GROUP BY ak."name"
      ORDER BY total_tokens DESC
    `;
    const result = await pool.query(sql, [String(departmentId)]);
    return result.rows.map(normalizeTokenRow);
  }

  async function getAllDepartmentUsers(range) {
    const filter = DEPARTMENT_RANGE_FILTERS[range];
    if (!filter) throw new Error(`Unsupported department usage range: ${range}`);
    const sql = `
      SELECT
        ul.project_id::text AS department_id,
        COALESCE(ak."name", '') AS username,
        ${TOKEN_COLUMNS}
      FROM usage_logs ul
      INNER JOIN api_keys ak ON ul.api_key_id = ak.id
      WHERE ${filter}
      GROUP BY ul.project_id, ak."name"
      ORDER BY ul.project_id, total_tokens DESC
    `;
    const result = await pool.query(sql);
    return result.rows.map(normalizeDepartmentUserRow);
  }

  async function getDepartmentRangeBounds(range) {
    const sql = DEPARTMENT_RANGE_BOUNDS_SQL[range];
    if (!sql) throw new Error(`Unsupported department usage range: ${range}`);
    const result = await pool.query(sql);
    return normalizeRangeBounds(result.rows[0]);
  }

  return { getRanking, getPersonalRange, getUserByApiKey, getDepartmentRanking, getDepartmentUsers, getAllDepartmentUsers, getDepartmentRangeBounds };
}

module.exports = { createUsageStatsRepository };
