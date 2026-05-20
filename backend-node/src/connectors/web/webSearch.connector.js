const axios = require('axios');

const WEB_SEARCH_ENABLED = process.env.WEB_SEARCH_ENABLED === 'true';
const WEB_SEARCH_PROVIDER = process.env.WEB_SEARCH_PROVIDER || 'tavily';
const WEB_SEARCH_API_KEY = process.env.WEB_SEARCH_API_KEY || '';
const WEB_SEARCH_TIMEOUT_MS = 10000;

const UNAVAILABLE_RESPONSE = {
  success: false,
  unavailable: true,
  results: [],
};

const searchViaTavily = async (query) => {
  const response = await axios.post(
    'https://api.tavily.com/search',
    {
      api_key: WEB_SEARCH_API_KEY,
      query,
      search_depth: 'basic',
      max_results: 5,
    },
    { timeout: WEB_SEARCH_TIMEOUT_MS },
  );

  return (response.data.results || []).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.content || '',
    source: r.url || '',
  }));
};

const searchViaSerpApi = async (query) => {
  const response = await axios.get('https://serpapi.com/search', {
    params: {
      q: query,
      api_key: WEB_SEARCH_API_KEY,
      engine: 'google',
      num: 5,
    },
    timeout: WEB_SEARCH_TIMEOUT_MS,
  });

  return (response.data.organic_results || []).map((r) => ({
    title: r.title || '',
    url: r.link || '',
    snippet: r.snippet || '',
    source: r.displayed_link || r.link || '',
  }));
};

const searchViaBing = async (query) => {
  const response = await axios.get(
    'https://api.bing.microsoft.com/v7.0/search',
    {
      params: { q: query, count: 5 },
      headers: { 'Ocp-Apim-Subscription-Key': WEB_SEARCH_API_KEY },
      timeout: WEB_SEARCH_TIMEOUT_MS,
    },
  );

  return ((response.data.webPages || {}).value || []).map((r) => ({
    title: r.name || '',
    url: r.url || '',
    snippet: r.snippet || '',
    source: r.displayUrl || r.url || '',
  }));
};

const searchWeb = async ({ query }) => {
  if (!WEB_SEARCH_ENABLED || !WEB_SEARCH_API_KEY) {
    return UNAVAILABLE_RESPONSE;
  }

  try {
    let results = [];

    if (WEB_SEARCH_PROVIDER === 'serpapi') {
      results = await searchViaSerpApi(query);
    } else if (WEB_SEARCH_PROVIDER === 'bing') {
      results = await searchViaBing(query);
    } else {
      results = await searchViaTavily(query);
    }

    return {
      success: true,
      unavailable: false,
      results,
    };
  } catch (error) {
    return {
      success: false,
      unavailable: false,
      error: error.message,
      results: [],
    };
  }
};

module.exports = {
  searchWeb,
};
